// routes/budget.js
import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import fetch from "node-fetch";
import Booking from "../models/Booking.js";

/* ---------------- Models ---------------- */
const BudgetHolder =
  mongoose.models.BudgetHolder ||
  mongoose.model(
    "BudgetHolder",
    new mongoose.Schema(
      {
        budgetNumber: { type: String, required: true, index: true },
        holderName: { type: String, required: true },
        pin: { type: String, required: true }, // bcrypt hash or plain
        active: { type: Boolean, default: true }
      },
      { collection: "budget_holders" }
    )
  );

/* ------------- Audit helper (local) ------------- */
async function addAuditEntry(bookingId, entry) {
  if (!bookingId) return;
  try {
    const payload = {
      at: entry.at || new Date(),
      actorType: entry.actorType || "system",
      source: entry.source || "system",
      action: entry.action || undefined,
      oldStatus: entry.oldStatus,
      newStatus: entry.newStatus,
      details: entry.details ?? null
    };
    await Booking.findByIdAndUpdate(bookingId, { $push: { auditLog: payload } }).lean();
  } catch (err) {
    console.warn("budget.addAuditEntry failed", bookingId, err?.message || err);
  }
}

/* -------------- Env + helpers -------------- */
const {
  AUTOCAB_BASE,
  AUTOCAB_COMPANY_ID,
  AUTOCAB_SUBSCRIPTION_KEY,
  GOOGLE_MAPS_KEY
} = process.env;

const DH_LAT = 50.4195;
const DH_LNG = -4.109;

function withinMeters(lat1, lng1, lat2, lng2, meters) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c <= meters;
}
function isDerriford(lat, lng) {
  return withinMeters(lat, lng, DH_LAT, DH_LNG, 900);
}
function toDDMMYY(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y.slice(2)}`;
}

async function lookupZone(lat, lng) {
  if (!AUTOCAB_BASE || !AUTOCAB_COMPANY_ID) return null;
  const url = `${AUTOCAB_BASE}/booking/v1/zone?latitude=${lat}&longitude=${lng}&companyId=${AUTOCAB_COMPANY_ID}`;
  try {
    const r = await fetch(url, {
      headers: {
        "Cache-Control": "no-cache",
        "Ocp-Apim-Subscription-Key": AUTOCAB_SUBSCRIPTION_KEY || ""
      }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const zone = data?.zone || data || null;
    return zone
      ? { id: String(zone.id ?? zone.zoneId ?? ""), name: String(zone.name ?? zone.zoneName ?? "") }
      : null;
  } catch {
    return null;
  }
}

function normaliseAddressShape(raw) {
  if (!raw) return null;
  const lat = typeof raw.lat === "number" ? raw.lat : Number(raw.lat);
  const lng = typeof raw.lng === "number" ? raw.lng : Number(raw.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const formatted =
    raw.formatted || raw.text || raw.description || raw.street || raw.placeId || "";
  return {
    formatted,
    text: raw.text || raw.description || formatted,
    placeId: raw.placeId || null,
    houseNumber: raw.houseNumber || "",
    street: raw.street || "",
    town: raw.town || "Plymouth",
    postCode: raw.postCode || "",
    lat,
    lng,
    zone: raw.zone || null
  };
}

async function geocodeAddress(text, postCode) {
  if (!GOOGLE_MAPS_KEY) {
    throw new Error(
      "Address lookup is not configured. Please contact the ward or switchboard."
    );
  }
  const query = [text, postCode].filter(Boolean).join(", ");
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    query
  )}&key=${GOOGLE_MAPS_KEY}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Address lookup failed (HTTP ${r.status}). Please try again.`);
  const data = await r.json();
  if (!data.results || !data.results.length || data.status !== "OK") {
    throw new Error("We couldn't find that address. Please check and try again.");
  }
  const result = data.results[0];
  const loc = result.geometry?.location || {};
  const components = result.address_components || [];
  const pcComp = components.find((c) => c.types && c.types.includes("postal_code"));
  return {
    lat: Number(loc.lat),
    lng: Number(loc.lng),
    formatted: result.formatted_address,
    postCode: pcComp?.long_name || postCode || ""
  };
}

/* ------------- Router + session ------------- */
const router = express.Router();

/* TEMP: log every request that reaches this router */
router.use((req, _res, next) => {
  console.log("[budget-router]", req.method, req.path);
  next();
});

/* Read either cookie:
   - bh: JSON stringified session {budgetNumber, holderName}
   - budgetSess: our base64url.payload.signature (we decode payload only) */
function decodeBudgetSess(token) {
  try {
    const [b64, sig] = String(token).split(".");
    if (!b64 || !sig) return null;
    const json = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
function readSession(req) {
  if (req.cookies?.budgetSess) {
    const p = decodeBudgetSess(req.cookies.budgetSess);
    if (p && p.budgetNumber && p.holderName) {
      return { budgetNumber: String(p.budgetNumber), holderName: String(p.holderName) };
    }
  }
  if (req.cookies?.bh) {
    try {
      const obj = JSON.parse(req.cookies.bh);
      if (obj?.budgetNumber && obj?.holderName) return obj;
    } catch {}
  }
  return null;
}
function requireLogin(req, res, next) {
  const sess = readSession(req);
  if (!sess) return res.status(401).json({ error: "Unauthorised" });
  req.budget = sess;
  next();
}

/* --------- small helper: load & authorise booking --------- */
async function loadBookingForBudget(req, res) {
  const b = await Booking.findById(req.params.id);
  if (!b) {
    res.status(404).json({ error: "Booking not found" });
    return null;
  }
  if (b.budgetNumber !== req.budget.budgetNumber) {
    res.status(403).json({
      error: "This booking is not under your budget",
      bookingBudgetNumber: b.budgetNumber,
      yourBudgetNumber: req.budget.budgetNumber
    });
    return null;
  }
  return b;
}

/* ---------------- Auth ---------------- */
router.post("/login", async (req, res) => {
  try {
    const { budgetNumber, holderName, pin } = req.body || {};
    if (!budgetNumber || !holderName || !pin) {
      return res
        .status(400)
        .json({ error: "Missing budgetNumber, holderName or pin" });
    }

    const doc = await BudgetHolder.findOne({
      budgetNumber: String(budgetNumber).trim(),
      active: true
    }).lean();

    if (!doc) return res.status(401).json({ error: "Invalid budget or PIN" });

    const ok =
      (doc.pin?.startsWith("$2") && (await bcrypt.compare(String(pin), doc.pin))) ||
      String(pin) === String(doc.pin);

    const nameOk =
      !doc.holderName ||
      String(doc.holderName).trim().toLowerCase() ===
        String(holderName).trim().toLowerCase();

    if (!ok || !nameOk) return res.status(401).json({ error: "Invalid budget or PIN" });

    const session = {
      budgetNumber: doc.budgetNumber,
      holderName: holderName.trim(),
      holderId: String(doc._id)
    };
    res.cookie("bh", JSON.stringify(session), {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true on HTTPS
      maxAge: 1000 * 60 * 60 * 8
    });

    return res.json({ ok: true, session });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Login failed" });
  }
});

router.get("/me", (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorised" });
  res.json({ ok: true, session });
});

router.post("/logout", (_req, res) => {
  res.clearCookie("bh", { httpOnly: true, sameSite: "lax" });
  res.clearCookie("budgetSess", { httpOnly: true, sameSite: "lax" });
  res.json({ ok: true });
});

/* -------------- Booking queries -------------- */
router.get("/bookings", requireLogin, async (req, res) => {
  try {
    const { dateFrom, dateTo, status, page = "1", limit = "50" } = req.query;
    const q = { budgetNumber: req.budget.budgetNumber };

    if (dateFrom || dateTo) {
      q.pickupDateISO = {};
      if (dateFrom) q.pickupDateISO.$gte = String(dateFrom);
      if (dateTo) q.pickupDateISO.$lte = String(dateTo);
    }
    if (status && ["pending", "approved", "declined"].includes(String(status)))
      q.status = status;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      Booking.find(q)
        .sort({ pickupDateISO: 1, onOffDutyTime: 1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Booking.countDocuments(q)
    ]);

    res.json({ ok: true, total, page: pageNum, limit: limitNum, items });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to load bookings" });
  }
});

router.get("/bookings/:id", requireLogin, async (req, res) => {
  const b = await Booking.findById(req.params.id).lean();
  if (!b) return res.status(404).json({ error: "Booking not found" });
  if (b.budgetNumber !== req.budget.budgetNumber) {
    return res.status(403).json({
      error: "This booking is not under your budget",
      bookingBudgetNumber: b.budgetNumber,
      yourBudgetNumber: req.budget.budgetNumber
    });
  }
  res.json({ ok: true, booking: b });
});

/* ----------- Approve / Decline ----------- */
async function doApprove(req, res) {
  try {
    const b = await loadBookingForBudget(req, res);
    if (!b) return;
    const prev = b.status;
    b.status = "approved";
    await b.save();

    await addAuditEntry(b._id, {
      actorType: "budget",
      source: req.query.source || "budget-portal",
      action: "status-changed",
      oldStatus: prev,
      newStatus: "approved",
      details: {
        holderName: req.budget.holderName,
        budgetNumber: req.budget.budgetNumber
      }
    });

    res.json({ ok: true, booking: b.toObject() });
  } catch (err) {
    res.status(400).json({ error: err.message || "Approve failed" });
  }
}
async function doDecline(req, res) {
  try {
    const b = await loadBookingForBudget(req, res);
    if (!b) return;

    const reasonRaw = req.body?.reason;
    const reason = reasonRaw == null ? "" : String(reasonRaw).trim();

    const prev = b.status;
    b.status = "declined";
    b.declineReason = reason;
    await b.save();

    await addAuditEntry(b._id, {
      actorType: "budget",
      source: req.query.source || "budget-portal",
      action: "status-changed",
      oldStatus: prev,
      newStatus: "declined",
      details: {
        holderName: req.budget.holderName,
        budgetNumber: req.budget.budgetNumber,
        reason
      }
    });

    res.json({ ok: true, booking: b.toObject() });
  } catch (err) {
    res.status(400).json({ error: err.message || "Decline failed" });
  }
}

router.patch("/bookings/:id/approve", requireLogin, doApprove);
router.post ("/bookings/:id/approve", requireLogin, doApprove);
router.all  ("/bookings/:id/approve", requireLogin, (_req,res)=> res.status(405).json({ error: "Method not allowed" }));

router.patch("/bookings/:id/decline", requireLogin, doDecline);
router.post ("/bookings/:id/decline", requireLogin, doDecline);
router.all  ("/bookings/:id/decline", requireLogin, (_req,res)=> res.status(405).json({ error: "Method not allowed" }));

/* ---- Edit core details (no geocoding) ---- */
router.put("/bookings/:id", requireLogin, async (req, res) => {
  try {
    const b = await loadBookingForBudget(req, res);
    if (!b) return;

    const payload = req.body || {};
    const editable = [
      "wardName",
      "wardPhone",
      "staffName",
      "staffPhone",
      "shiftType",
      "onOffDutyTime",
      "pickupDateISO",
      "reasonCode"
    ];
    for (const k of editable) {
      if (payload[k] !== undefined) {
        b[k] = typeof payload[k] === "string" ? payload[k].trim() : payload[k];
      }
    }

    const required = [
      "wardName",
      "wardPhone",
      "staffName",
      "staffPhone",
      "shiftType",
      "onOffDutyTime",
      "pickupDateISO",
      "reasonCode",
      "budgetNumber",
      "budgetHolderName"
    ];
    for (const k of required) {
      if (!b[k] || String(b[k]).trim() === "") {
        return res.status(400).json({ error: `Missing required field: ${k}` });
      }
    }

    if (!/^[A-Z0-9]{2}$/.test(String(b.reasonCode).toUpperCase())) {
      return res.status(400).json({
        error: "Reason Code must be exactly 2 alphanumeric characters (e.g., P1)."
      });
    }
    b.reasonCode = String(b.reasonCode).toUpperCase();

    if (!b.pickup || typeof b.pickup.lat !== "number" || typeof b.pickup.lng !== "number") {
      return res
        .status(400)
        .json({ error: "Booking pickup address is invalid, cannot update." });
    }
    if (!b.destination || typeof b.destination.lat !== "number" || typeof b.destination.lng !== "number") {
      return res
        .status(400)
        .json({ error: "Booking destination address is invalid, cannot update." });
    }

    if (b.shiftType === "start") {
      if (!isDerriford(b.destination.lat, b.destination.lng)) {
        return res
          .status(400)
          .json({ error: "For Shift Start, the drop-off must be Derriford Hospital." });
      }
    } else {
      if (!isDerriford(b.pickup.lat, b.pickup.lng)) {
        return res
          .status(400)
          .json({ error: "For Shift Finish, the pickup must be Derriford Hospital." });
      }
    }

    await b.save();

    await addAuditEntry(b._id, {
      actorType: "budget",
      source: req.query.source || "budget-portal",
      action: "updated",
      details: {
        holderName: req.budget.holderName,
        budgetNumber: req.budget.budgetNumber,
        summary: `Budget updated details via portal for ${toDDMMYY(
          b.pickupDateISO
        )} ${b.onOffDutyTime}`
      }
    });

    res.json({ ok: true, booking: b.toObject() });
  } catch (err) {
    res.status(400).json({ error: err.message || "Update failed" });
  }
});

/* -- Edit with address geocoding (customer-update parity) -- */
router.post("/bookings/:id/customer-update", requireLogin, async (req, res) => {
  try {
    const booking = await loadBookingForBudget(req, res);
    if (!booking) return;

    const {
      pickupDateISO,
      onOffDutyTime,
      staffPhone,
      pickup,
      destination,
      pickupText,
      pickupPostCode,
      destinationText,
      destinationPostCode
    } = req.body || {};

    const changedFields = [];
    let changed = false;

    if (pickupDateISO && pickupDateISO !== booking.pickupDateISO) {
      booking.pickupDateISO = pickupDateISO;
      changedFields.push("date");
      changed = true;
    }
    if (onOffDutyTime && onOffDutyTime !== booking.onOffDutyTime) {
      booking.onOffDutyTime = onOffDutyTime;
      changedFields.push("time");
      changed = true;
    }
    if (staffPhone && staffPhone !== booking.staffPhone) {
      booking.staffPhone = staffPhone;
      changedFields.push("phone");
      changed = true;
    }

    // Pickup
    if (pickup || pickupText || pickupPostCode) {
      if (pickup) {
        const normPickup = normaliseAddressShape(pickup);
        if (!normPickup) {
          return res.status(400).json({
            error: "Invalid pickup address. Please select from suggestions."
          });
        }
        const current =
          typeof booking.pickup?.toObject === "function"
            ? booking.pickup.toObject()
            : booking.pickup || {};
        booking.pickup = { ...current, ...normPickup };
        if (typeof booking.pickup.lat === "number" && typeof booking.pickup.lng === "number") {
          booking.pickup.zone = await lookupZone(booking.pickup.lat, booking.pickup.lng);
        }
      } else {
        const baseStreet = pickupText || booking.pickup?.text || booking.pickup?.formatted || "";
        const basePost = pickupPostCode || booking.pickup?.postCode || "";
        const query = [baseStreet, basePost].filter(Boolean).join(", ");
        if (!query) {
          return res.status(400).json({
            error: "Invalid pickup address. Please enter a full address and postcode."
          });
        }
        const geo = await geocodeAddress(query, basePost);
        const current =
          typeof booking.pickup?.toObject === "function"
            ? booking.pickup.toObject()
            : booking.pickup || {};
        booking.pickup = {
          ...current,
          formatted: geo.formatted,
          text: geo.formatted,
          postCode: geo.postCode || basePost,
          lat: geo.lat,
          lng: geo.lng
        };
        booking.pickup.zone = await lookupZone(geo.lat, geo.lng);
      }
      changedFields.push("pickupAddress");
      changed = true;
    }

    // Destination
    if (destination || destinationText || destinationPostCode) {
      if (destination) {
        const normDest = normaliseAddressShape(destination);
        if (!normDest) {
          return res.status(400).json({
            error: "Invalid destination address. Please select from suggestions."
          });
        }
        const current =
          typeof booking.destination?.toObject === "function"
            ? booking.destination.toObject()
            : booking.destination || {};
        booking.destination = { ...current, ...normDest };
        if (typeof booking.destination.lat === "number" && typeof booking.destination.lng === "number") {
          booking.destination.zone = await lookupZone(booking.destination.lat, booking.destination.lng);
        }
      } else {
        const baseStreet =
          destinationText || booking.destination?.text || booking.destination?.formatted || "";
        const basePost = destinationPostCode || booking.destination?.postCode || "";
        const query = [baseStreet, basePost].filter(Boolean).join(", ");
        if (!query) {
          return res.status(400).json({
            error: "Invalid destination address. Please enter a full address and postcode."
          });
        }
        const geo = await geocodeAddress(query, basePost);
        const current =
          typeof booking.destination?.toObject === "function"
            ? booking.destination.toObject()
            : booking.destination || {};
        booking.destination = {
          ...current,
          formatted: geo.formatted,
          text: geo.formatted,
          postCode: geo.postCode || basePost,
          lat: geo.lat,
          lng: geo.lng
        };
        booking.destination.zone = await lookupZone(geo.lat, geo.lng);
      }
      changedFields.push("destinationAddress");
      changed = true;
    }

    if (!changed) {
      return res.status(400).json({ error: "No update fields provided" });
    }

    if (!booking.pickup || typeof booking.pickup.lat !== "number" || typeof booking.pickup.lng !== "number") {
      return res.status(400).json({
        error: "Updated booking must have a valid pickup address (with map location)."
      });
    }
    if (!booking.destination || typeof booking.destination.lat !== "number" || typeof booking.destination.lng !== "number") {
      return res.status(400).json({
        error: "Updated booking must have a valid destination address (with map location)."
      });
    }

    if (booking.shiftType === "start") {
      if (!isDerriford(booking.destination.lat, booking.destination.lng)) {
        return res.status(400).json({
          error: "For Shift Start, the drop-off must be Derriford Hospital."
        });
      }
    } else {
      if (!isDerriford(booking.pickup.lat, booking.pickup.lng)) {
        return res.status(400).json({
          error: "For Shift Finish, the pickup must be Derriford Hospital."
        });
      }
    }

    const now = new Date();
    booking.updatedByStaffAt = now;
    booking.updatedByStaffSource = "budget-portal";

    const parts = [];
    if (changedFields.includes("date")) parts.push(`date to ${toDDMMYY(booking.pickupDateISO)}`);
    if (changedFields.includes("time")) parts.push(`time to ${booking.onOffDutyTime}`);
    if (changedFields.includes("phone")) parts.push("contact number");
    if (changedFields.includes("pickupAddress")) parts.push("pickup address");
    if (changedFields.includes("destinationAddress")) parts.push("destination address");

    const summary = parts.length
      ? `Budget holder updated ${parts.join(", ")}`
      : "Budget holder update";
    booking.updatedByStaffSummary = summary;

    await booking.save();

    await addAuditEntry(booking._id, {
      actorType: "budget",
      source: req.query.source || "budget-portal",
      action: "customer-updated",
      details: {
        holderName: req.budget.holderName,
        budgetNumber: req.budget.budgetNumber,
        changedFields,
        summary
      }
    });

    res.json({ ok: true, booking: booking.toObject() });
  } catch (err) {
    res.status(400).json({ error: err.message || "Update failed" });
  }
});

/* -------- Optional debug / introspection -------- */
router.get("/debug/:id", requireLogin, async (req, res) => {
  const b = await Booking.findById(req.params.id).lean();
  if (!b) return res.status(404).json({ error: "Booking not found" });
  res.json({
    ok: true,
    yourBudgetNumber: req.budget.budgetNumber,
    bookingBudgetNumber: b.budgetNumber,
    same: b.budgetNumber === req.budget.budgetNumber
  });
});

/* list all routes exposed by this router (to prove it’s mounted) */
router.get("/__routes", (_req, res) => {
  const stack = router.stack
    .filter(l => l.route)
    .map(l => ({
      path: l.route?.path,
      methods: Object.keys(l.route?.methods || {}).sort()
    }));
  res.json({ ok: true, routes: stack });
});

export default router;
