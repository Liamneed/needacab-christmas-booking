import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Booking from "./models/Booking.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --- Serve static frontend pages ---
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/bookings", (_req, res) => res.sendFile(path.join(__dirname, "public", "bookings.html")));
app.get("/staff_booker.html", (_req, res) => res.sendFile(path.join(__dirname, "public", "staff_booker.html")));
app.get("/chat", (_req, res) => res.sendFile(path.join(__dirname, "public", "chat.html")));
// -----------------------------------

const {
  MONGODB_URI,
  AUTOCAB_BASE,
  AUTOCAB_COMPANY_ID,
  AUTOCAB_SUBSCRIPTION_KEY,
  GOOGLE_MAPS_KEY,
  PORT
} = process.env;

if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");
if (!AUTOCAB_BASE) throw new Error("Missing AUTOCAB_BASE in .env");
if (!AUTOCAB_COMPANY_ID) throw new Error("Missing AUTOCAB_COMPANY_ID in .env");
if (!AUTOCAB_SUBSCRIPTION_KEY) console.warn("WARNING: Missing AUTOCAB_SUBSCRIPTION_KEY in .env");

await mongoose.connect(MONGODB_URI);

// ===== Helpers =====
const Counter = mongoose.model(
  "Counter",
  new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { collection: "counters" })
);

async function nextShortRef() {
  const c = await Counter.findOneAndUpdate(
    { _id: "booking_short_ref" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  ).lean();
  return `NAC${String(c.seq).padStart(3, "0")}`;
}

function normalizeUKMobile(input) {
  if (!input) return input;
  let p = String(input).replace(/\s+/g, "").replace(/[()\-]/g, "");
  if (/^07\d{9}$/.test(p)) return "+44" + p.slice(1);
  if (/^7\d{9}$/.test(p)) return "+44" + p;
  if (/^00447\d{9}$/.test(p)) return "+" + p.slice(2);
  return p;
}

const ORION_BASE = "https://orionconnect.co.uk/api/endpoint/webhook";
const ORION_QS =
  "endpoint_id=57&signature=ab8d73fb3e048d2c259e05946482e69400d6879e1338ab8b7a1e66b7efd8ae19";

async function sendSMS(customerPhone, message) {
  try {
    if (!customerPhone || !message) return { ok: false, error: "missing phone/message" };
    const phone = normalizeUKMobile(customerPhone);

    // Try POST first
    const postUrl = `${ORION_BASE}?${ORION_QS}`;
    const postBody = new URLSearchParams({ customer_phone: phone, message });
    let r = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: postBody
    });
    let text = await r.text();
    if (r.ok) return { ok: true, method: "POST", status: r.status, body: text };

    // Fallback to GET
    const getUrl = `${ORION_BASE}?${ORION_QS}&customer_phone=${encodeURIComponent(phone)}&message=${encodeURIComponent(message)}`;
    r = await fetch(getUrl, { method: "GET" });
    text = await r.text();
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, body: text };
    return { ok: true, method: "GET", status: r.status, body: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function toNumber(x) {
  const n = Number(x);
  if (Number.isNaN(n)) throw new Error("Invalid number");
  return n;
}

function withinMeters(lat1, lng1, lat2, lng2, meters) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c <= meters;
}

function isDerriford(lat, lng) {
  const DH_LAT = 50.4195;
  const DH_LNG = -4.1090;
  return withinMeters(lat, lng, DH_LAT, DH_LNG, 900);
}

function makeReference(reasonCode, budgetNumber, budgetHolderName) {
  return `${reasonCode}/${budgetNumber}/${budgetHolderName}`.trim();
}

async function lookupZone(lat, lng) {
  const url = `${AUTOCAB_BASE}/booking/v1/zone?latitude=${lat}&longitude=${lng}&companyId=${AUTOCAB_COMPANY_ID}`;
  const r = await fetch(url, {
    headers: {
      "Cache-Control": "no-cache",
      "Ocp-Apim-Subscription-Key": AUTOCAB_SUBSCRIPTION_KEY,
    },
  });
  if (!r.ok) return null;
  const data = await r.json();
  const zone = data?.zone || data || null;
  return zone
    ? { id: String(zone.id ?? zone.zoneId ?? ""), name: String(zone.name ?? zone.zoneName ?? "") }
    : null;
}

const flipShift = (s) => (s === "start" ? "finish" : "start");

function toDDMMYY(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y.slice(2)}`;
}

/* ===== SMS TEMPLATE SETTINGS ===== */
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(__dirname, "settings.json");

let smsTemplates = {
  approve:
    "Your request for your Christmas staff booking for Derriford Hospital on {{date}} at {{time}}. " +
    "Pick up: {{pickup}}. Drop off: {{destination}}. " +
    "In the name {{staff}} has been approved. " +
    "Your reference number is {{ref}}. Thanks Need-A-Cab Taxis",
  decline:
    "Unfortunately your Christmas staff booking on {{date}} at {{time}} " +
    "({{pickup}} to {{destination}}) has been declined. Reason: {{reason}}. — Need-A-Cab Taxis"
};

function loadSmsTemplatesFromFile() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        smsTemplates = {
          approve: parsed.approve || smsTemplates.approve,
          decline: parsed.decline || smsTemplates.decline
        };
      }
    }
  } catch (err) {
    console.error("Failed to load SMS templates", err);
  }
}

function saveSmsTemplatesToFile() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(smsTemplates, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save SMS templates", err);
  }
}

function renderTemplate(tpl, booking, extra = {}) {
  const map = {
    date: toDDMMYY(booking.pickupDateISO),
    time: booking.onOffDutyTime,
    pickup: booking.pickup?.formatted ?? "",
    destination: booking.destination?.formatted ?? "",
    staff: booking.staffName ?? "",
    ref: booking.shortRef ?? booking.reference ?? "",
    reason: extra.reason ?? booking.declineReason ?? ""
  };

  return String(tpl || "").replace(/{{\s*(\w+)\s*}}/g, (_m, key) => {
    return map[key] != null ? String(map[key]) : "";
  });
}

loadSmsTemplatesFromFile();

// ---------------------- Health ----------------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------------------- SMS TEMPLATE SETTINGS API ----------------------
app.get("/api/settings/sms-templates", (_req, res) => {
  res.json(smsTemplates);
});

app.put("/api/settings/sms-templates", (req, res) => {
  try {
    const approve = String(req.body?.approve ?? "").trim();
    const decline = String(req.body?.decline ?? "").trim();
    if (!approve || !decline) {
      return res.status(400).json({ error: "Both approve and decline templates are required" });
    }
    smsTemplates.approve = approve;
    smsTemplates.decline = decline;
    saveSmsTemplatesToFile();
    res.json({ ok: true, approve, decline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------- Zone lookup proxy ----------------------
app.get("/api/zone", async (req, res) => {
  try {
    const lat = toNumber(req.query.lat);
    const lng = toNumber(req.query.lng);
    const zone = await lookupZone(lat, lng);
    return res.json(zone);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ---------------------- Create booking ----------------------
app.post("/api/bookings", async (req, res) => {
  try {
    const b = req.body;
    const requiredText = [
      "wardName", "wardPhone", "staffName", "staffPhone",
      "shiftType", "onOffDutyTime", "pickupDateISO",
      "reasonCode", "budgetNumber", "budgetHolderName"
    ];
    for (const k of requiredText) {
      if (!b?.[k] || String(b[k]).trim() === "") {
        return res.status(400).json({ error: `Missing required field: ${k}` });
      }
    }
    if (!/^[A-Z0-9]{2}$/.test(String(b.reasonCode).toUpperCase())) {
      return res.status(400).json({ error: "Reason Code must be exactly 2 alphanumeric characters (e.g., P1)." });
    }
    b.reasonCode = String(b.reasonCode).toUpperCase();
    if (!/^\d{6}$/.test(String(b.budgetNumber))) {
      return res.status(400).json({ error: "Budget number must be 6 digits." });
    }
    if (b.budgetHolderSignatureDataURL) {
      if (!/^data:image\/png;base64,/.test(b.budgetHolderSignatureDataURL)) {
        return res.status(400).json({ error: "Invalid signature format (must be PNG data URL) or leave blank." });
      }
    }
    for (const f of ["pickup", "destination"]) {
      const a = b?.[f];
      if (!a?.formatted || typeof a.lat !== "number" || typeof a.lng !== "number") {
        return res.status(400).json({ error: `Invalid ${f} address. Please select from suggestions.` });
      }
    }
    if (b.shiftType === "start") {
      if (!isDerriford(b.destination.lat, b.destination.lng)) {
        return res.status(400).json({ error: "For Shift Start, the drop-off must be Derriford Hospital." });
      }
    } else {
      if (!isDerriford(b.pickup.lat, b.pickup.lng)) {
        return res.status(400).json({ error: "For Shift Finish, the pickup must be Derriford Hospital." });
      }
    }
    if (!b.pickup.zone) b.pickup.zone = await lookupZone(b.pickup.lat, b.pickup.lng);
    if (!b.destination.zone) b.destination.zone = await lookupZone(b.destination.lat, b.destination.lng);

    b.reference = makeReference(b.reasonCode, b.budgetNumber, b.budgetHolderName);
    b.status = "pending";
    b.shortRef = await nextShortRef();

    const saved = await Booking.create({ ...b, isReturn: false });

    let savedReturn = null;
    if (b.requireReturn) {
      if (!b.returnDateISO || String(b.returnDateISO).trim() === "") {
        return res.status(400).json({ error: "Return date is required when return booking is requested." });
      }
      const returnTime =
        typeof b.returnOnOffDutyTime === "string" && b.returnOnOffDutyTime.trim() !== ""
          ? b.returnOnOffDutyTime.trim()
          : b.onOffDutyTime;

      const rb = {
        wardName: b.wardName,
        wardPhone: b.wardPhone,
        staffName: b.staffName,
        staffPhone: b.staffPhone,
        shiftType: flipShift(b.shiftType),
        onOffDutyTime: returnTime,
        pickupDateISO: b.returnDateISO,
        pickup: { ...b.destination },
        destination: { ...b.pickup },
        requireReturn: false,
        reasonCode: b.reasonCode,
        budgetNumber: b.budgetNumber,
        budgetHolderName: b.budgetHolderName,
        ...(b.budgetHolderSignatureDataURL ? { budgetHolderSignatureDataURL: b.budgetHolderSignatureDataURL } : {}),
        reference: b.reference,
        isReturn: true,
        status: "pending",
        shortRef: await nextShortRef(),
      };

      if (rb.shiftType === "start") {
        if (!isDerriford(rb.destination.lat, rb.destination.lng)) {
          return res.status(400).json({ error: "Auto-return (Shift Start) must drop at Derriford Hospital." });
        }
      } else {
        if (!isDerriford(rb.pickup.lat, rb.pickup.lng)) {
          return res.status(400).json({ error: "Auto-return (Shift Finish) must pick up at Derriford Hospital." });
        }
      }
      if (!rb.pickup.zone) rb.pickup.zone = await lookupZone(rb.pickup.lat, rb.pickup.lng);
      if (!rb.destination.zone) rb.destination.zone = await lookupZone(rb.destination.lat, rb.destination.lng);

      savedReturn = await Booking.create(rb);
    }

    return res.json({ ok: true, booking: saved, returnBooking: savedReturn });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: err.message });
  }
});

// ---------------------- Queryable bookings ----------------------
app.get("/api/bookings", async (req, res) => {
  const {
    dateFrom, dateTo, shiftType, time, zone, ward, staff, reference,
    requireReturn, isReturn, status, page = "1", limit = "50", sort
  } = req.query;

  const q = {};
  if (dateFrom || dateTo) {
    q.pickupDateISO = {};
    if (dateFrom) q.pickupDateISO.$gte = String(dateFrom);
    if (dateTo) q.pickupDateISO.$lte = String(dateTo);
  }
  if (shiftType && (shiftType === "start" || shiftType === "finish")) q.shiftType = shiftType;
  if (time) q.onOffDutyTime = time;

  if (zone && zone.trim() !== "") {
    const regex = new RegExp(zone.trim(), "i");
    if (shiftType === "start")      q["pickup.zone.name"] = regex;
    else if (shiftType === "finish") q["destination.zone.name"] = regex;
    else q.$or = [{ "pickup.zone.name": regex }, { "destination.zone.name": regex }];
  }

  if (ward && ward.trim() !== "") q.wardName = new RegExp(ward.trim(), "i");
  if (staff && staff.trim() !== "") q.staffName = new RegExp(staff.trim(), "i");
  if (reference && reference.trim() !== "") q.reference = new RegExp(reference.trim(), "i");

  if (requireReturn === "true") q.requireReturn = true;
  if (requireReturn === "false") q.requireReturn = false;
  if (isReturn === "true") q.isReturn = true;
  if (isReturn === "false") q.isReturn = false;
  if (status && ["pending", "approved", "declined"].includes(String(status))) q.status = status;

  const sortObj = {};
  if (sort) {
    for (const part of String(sort).split(",")) {
      const [k, dir] = part.split(":");
      if (k) sortObj[k] = (dir === "desc" ? -1 : 1);
    }
  } else {
    sortObj.pickupDateISO = 1;
    sortObj.onOffDutyTime = 1;
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  const skip = (pageNum - 1) * limitNum;

  const [items, total] = await Promise.all([
    Booking.find(q).sort(sortObj).skip(skip).limit(limitNum),
    Booking.countDocuments(q)
  ]);

  res.json({ total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), items });
});

// ---------------------- CSV export ----------------------
app.get("/api/bookings/export", async (req, res) => {
  req.query.page = "1";
  req.query.limit = "5000";
  const url = new URL(req.protocol + "://" + req.get("host") + req.originalUrl.replace("/export",""));
  const qp = new URLSearchParams(url.search);
  const r = await fetch(req.protocol + "://" + req.get("host") + "/api/bookings?" + qp.toString());
  const data = await r.json();

  const rows = data.items || [];
  const header = [
    "pickupDateISO","onOffDutyTime","shiftType","wardName","staffName","staffPhone",
    "pickup.formatted","pickup.zone.name","destination.formatted","destination.zone.name",
    "reference","requireReturn","isReturn","status","shortRef","declineReason"
  ];

  const csv = [
    header.join(","),
    ...rows.map(b => [
      toDDMMYY(b.pickupDateISO),
      b.onOffDutyTime,
      b.shiftType,
      (b.wardName||"").replace(/,/g," "),
      (b.staffName||"").replace(/,/g," "),
      (b.staffPhone||""),
      (b.pickup?.formatted||"").replace(/,/g," "),
      (b.pickup?.zone?.name||"").replace(/,/g," "),
      (b.destination?.formatted||"").replace(/,/g," "),
      (b.destination?.zone?.name||"").replace(/,/g," "),
      (b.reference||""),
      b.requireReturn ? "TRUE" : "FALSE",
      b.isReturn ? "TRUE" : "FALSE",
      b.status||"",
      b.shortRef||"",
      (b.declineReason||"").replace(/,/g," ")
    ].join(","))
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=bookings_export.csv");
  res.send(csv);
});

// ---------------------- Legacy summaries ----------------------
app.get("/api/reports/by-zone", async (req, res) => {
  const date = (req.query.date || "").trim();
  const pipeline = [];
  if (date) pipeline.push({ $match: { pickupDateISO: date } });
  pipeline.push(
    {
      $group: {
        _id: { zoneName: "$pickup.zone.name" },
        count: { $sum: 1 },
        items: {
          $push: {
            pickupDateISO: "$pickupDateISO",
            ward: "$wardName",
            staff: "$staffName",
            shiftType: "$shiftType",
            onOffDutyTime: "$onOffDutyTime",
            reference: "$reference",
          },
        },
      },
    },
    { $sort: { "_id.zoneName": 1 } }
  );

  const raw = await Booking.aggregate(pipeline);
  const result = raw.map(z => ({
    zoneName: z._id.zoneName || "(unknown)",
    count: z.count,
    items: (z.items || []).map(it => ({
      ...it,
      pickupDateISO: toDDMMYY(it.pickupDateISO),
    })),
  }));

  res.json(result);
});

app.get("/api/reports/by-shift", async (req, res) => {
  const date = (req.query.date || "").trim();
  const pipeline = [];
  if (date) pipeline.push({ $match: { pickupDateISO: date } });
  pipeline.push(
    {
      $group: {
        _id: { shiftType: "$shiftType", onOffDutyTime: "$onOffDutyTime" },
        count: { $sum: 1 },
        zones: { $addToSet: "$pickup.zone.name" },
      },
    },
    { $sort: { "_id.shiftType": 1, "_id.onOffDutyTime": 1 } }
  );
  const result = await Booking.aggregate(pipeline);
  res.json(result);
});

// ---------------------- Shift grouping ----------------------
app.get("/api/reports/shift-groups", async (req, res) => {
  try {
    const type = (req.query.type || "start").toLowerCase();
    const date = (req.query.date || "").trim();

    const match = {};
    if (type === "start") match.shiftType = "start";
    else if (type === "finish") match.shiftType = "finish";
    if (date) match.pickupDateISO = date;

    const zoneField = type === "finish" ? "$destination.zone.name" : "$pickup.zone.name";

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: {
            date: "$pickupDateISO",
            time: "$onOffDutyTime",
            zone: zoneField,
          },
          count: { $sum: 1 },
          addresses: {
            $push: {
              formatted: type === "finish" ? "$destination.formatted" : "$pickup.formatted",
              lat: type === "finish" ? "$destination.lat" : "$pickup.lat",
              lng: type === "finish" ? "$destination.lng" : "$pickup.lng",
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          pickupDateISO: "$_id.date",
          onOffDutyTime: "$_id.time",
          zoneName: { $ifNull: ["$_id.zone", "(unknown)"] },
          count: 1,
          addresses: 1,
        },
      },
      { $sort: { pickupDateISO: 1, onOffDutyTime: 1, zoneName: 1 } },
    ];

    const groups = await Booking.aggregate(pipeline);
    const formatted = groups.map(g => ({
      ...g,
      pickupDateISO: toDDMMYY(g.pickupDateISO),
    }));

    res.json({ type, groups: formatted });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// ===== Actions: Approve / Decline / Delete =====
app.patch("/api/bookings/:id/approve", async (req, res) => {
  try {
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    b.status = "approved";
    await b.save();

    const templateFromBody = req.body?.message && String(req.body.message).trim();
    const template = templateFromBody || smsTemplates.approve;
    const msg = renderTemplate(template, b);

    const sms = await sendSMS(b.staffPhone, msg);
    res.json({ ok: true, booking: b, sms });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/bookings/:id/decline", async (req, res) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "Decline reason is required" });

    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    b.status = "declined";
    b.declineReason = reason;
    await b.save();

    const templateFromBody = req.body?.message && String(req.body.message).trim();
    const template = templateFromBody || smsTemplates.decline;
    const msg = renderTemplate(template, b, { reason });

    const sms = await sendSMS(b.staffPhone, msg);
    res.json({ ok: true, booking: b, sms });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/bookings/:id", async (req, res) => {
  try {
    const b = await Booking.findByIdAndDelete(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, deletedId: req.params.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const listenPort = Number(PORT) || 4000;
app.listen(listenPort, () => console.log(`🚖 API + UI running at http://localhost:${listenPort}`));
