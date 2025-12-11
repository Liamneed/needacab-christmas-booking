import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Booking from "./models/Booking.js";
import cookieParser from "cookie-parser";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- Middleware (CORS with cookies) ---
app.use(
  cors({
    origin: true,          // reflect request origin
    credentials: true,     // allow cookies
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

// --- Serve static frontend pages ---
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);
app.get("/bookings", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "bookings.html"))
);
app.get("/staff_booker.html", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "staff_booker.html"))
);
app.get("/chat", (_req, res) => res.sendFile(path.join(__dirname, "public", "chat.html")));
app.get("/bulk_staff_booker.html", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "bulk_staff_booker.html"))
);
app.get("/staff-update.html", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "staff-update.html"))
);
// -----------------------------------

const {
  MONGODB_URI,
  AUTOCAB_BASE,
  AUTOCAB_COMPANY_ID,
  AUTOCAB_SUBSCRIPTION_KEY,
  GOOGLE_MAPS_KEY,
  PORT,
  PUBLIC_CUSTOMER_BASE,
  NODE_ENV,
  BUDGET_COOKIE_SECRET,
  BUDGET_SESSION_TTL_DAYS,
  BUDGET_PORTAL_PIN,
} = process.env;

if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in .env");
if (!AUTOCAB_BASE) throw new Error("Missing AUTOCAB_BASE in .env");
if (!AUTOCAB_COMPANY_ID) throw new Error("Missing AUTOCAB_COMPANY_ID in .env");
if (!AUTOCAB_SUBSCRIPTION_KEY)
  console.warn("WARNING: Missing AUTOCAB_SUBSCRIPTION_KEY in .env");

await mongoose.connect(MONGODB_URI);

// Autocab booking endpoint (for Smart Pack → Book Taxi)
const AUTOCAB_BOOKING_URL = `${AUTOCAB_BASE}/booking/v1/booking`;

// Derriford constants
const DH_LAT = 50.4195;
const DH_LNG = -4.109;
const DERRIFORD_TEXT = "Derriford Hospital, Derriford Road, Plymouth PL6 8DH";
const DERRIFORD_POSTCODE = "PL6 8DH";

// Derriford Autocab customer/account ID for Smart Pack jobs
// Defaults to 2139 but can be overridden via DERRIFORD_CUSTOMER_ID in .env
const DERRIFORD_CUSTOMER_ID = Number(process.env.DERRIFORD_CUSTOMER_ID || "2139");

// Base URL for staff self-service links
const PUBLIC_CUSTOMER_BASE_URL = (PUBLIC_CUSTOMER_BASE || "").replace(/\/+$/, "");

// ===== Helpers / Models =====
const Counter = mongoose.model(
  "Counter",
  new mongoose.Schema(
    { _id: String, seq: { type: Number, default: 0 } },
    { collection: "counters" }
  )
);

// Lightweight log model so you can see all SMS / link events per booking
const BookingLog = mongoose.model(
  "BookingLog",
  new mongoose.Schema(
    {
      bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", index: true },
      type: { type: String, required: true }, // e.g. "edit_link_sms", "generic_sms"
      phone: String,
      message: String,
      smsStatus: mongoose.Schema.Types.Mixed,
      meta: mongoose.Schema.Types.Mixed
    },
    { collection: "booking_logs", timestamps: true }
  )
);

// Centralised audit helper
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
    console.warn("Failed to add audit entry", bookingId, err.message || err);
  }
}

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
    if (!customerPhone || !message)
      return { ok: false, error: "missing phone/message" };
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
    if (r.ok) return { ok: true, method: "POST", status: r.status, body: text, to: phone };

    // Fallback to GET
    const getUrl = `${ORION_BASE}?${ORION_QS}&customer_phone=${encodeURIComponent(
      phone
    )}&message=${encodeURIComponent(message)}`;
    r = await fetch(getUrl, { method: "GET" });
    text = await r.text();
    if (!r.ok)
      return { ok: false, error: `HTTP ${r.status}`, body: text, to: phone };
    return { ok: true, method: "GET", status: r.status, body: text, to: phone };
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
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c <= meters;
}

function isDerriford(lat, lng) {
  return withinMeters(lat, lng, DH_LAT, DH_LNG, 900);
}

// --- Distance + simple route optimiser helpers ---
function haversineDistance(lat1, lng1, lat2, lng2) {
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
  return R * c;
}

/**
 * stops: [{ lat, lng, ... }]
 * direction: "inbound"  -> heading TO Derriford
 *            "outbound" -> heading FROM Derriford
 */
function optimiseRoute(stops, direction = "inbound") {
  if (!stops || stops.length <= 1) return stops || [];

  const remaining = [...stops];
  const ordered = [];

  if (direction === "inbound") {
    // Start with the FURTHEST stop from Derriford
    let startIdx = 0;
    let maxDist = -1;
    remaining.forEach((s, i) => {
      if (typeof s.lat !== "number" || typeof s.lng !== "number") return;
      const d = haversineDistance(s.lat, s.lng, DH_LAT, DH_LNG);
      if (d > maxDist) {
        maxDist = d;
        startIdx = i;
      }
    });
    let current = remaining.splice(startIdx, 1)[0];
    ordered.push(current);

    // Then always go to the nearest next stop
    while (remaining.length) {
      let bestIdx = 0;
      let bestDist = Infinity;
      remaining.forEach((s, i) => {
        if (typeof s.lat !== "number" || typeof s.lng !== "number") return;
        const d = haversineDistance(current.lat, current.lng, s.lat, s.lng);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      });
      current = remaining.splice(bestIdx, 1)[0];
      ordered.push(current);
    }
  } else {
    // OUTBOUND: start at Derriford, then go to nearest next stop
    let currentPos = { lat: DH_LAT, lng: DH_LNG };

    while (remaining.length) {
      let bestIdx = 0;
      let bestDist = Infinity;
      remaining.forEach((s, i) => {
        if (typeof s.lat !== "number" || typeof s.lng !== "number") return;
        const d = haversineDistance(currentPos.lat, currentPos.lng, s.lat, s.lng);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      });
      const next = remaining.splice(bestIdx, 1)[0];
      ordered.push(next);
      currentPos = { lat: next.lat, lng: next.lng };
    }
  }

  return ordered;
}

function makeReference(reasonCode, budgetNumber, budgetHolderName) {
  return `${reasonCode}/${budgetNumber}/${budgetHolderName}`.trim();
}

// 🔧 FAIL-SOFT zone lookup
async function lookupZone(lat, lng) {
  const url = `${AUTOCAB_BASE}/booking/v1/zone?latitude=${lat}&longitude=${lng}&companyId=${AUTOCAB_COMPANY_ID}`;

  try {
    const r = await fetch(url, {
      headers: {
        "Cache-Control": "no-cache",
        "Ocp-Apim-Subscription-Key": AUTOCAB_SUBSCRIPTION_KEY
      }
    });

    if (!r.ok) {
      console.warn("lookupZone HTTP error:", r.status, url);
      return null;
    }

    const data = await r.json();
    const zone = data?.zone || data || null;
    return zone
      ? {
          id: String(zone.id ?? zone.zoneId ?? ""),
          name: String(zone.name ?? zone.zoneName ?? "")
        }
      : null;
  } catch (err) {
    console.error("lookupZone failed:", url, err.message || err);
    return null;
  }
}

const flipShift = (s) => (s === "start" ? "finish" : "start");

function toDDMMYY(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y.slice(2)}`;
}

/* ===== Bulk CSV helper functions ===== */

// Convert Excel serial date (e.g. 45992) -> "YYYY-MM-DD"
function excelSerialDateToISO(serial) {
  const base = Date.UTC(1899, 11, 30);
  const days = Math.floor(serial);
  const ms = days * 24 * 60 * 60 * 1000;
  const d = new Date(base + ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toISODateFromCell(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "number") {
    if (v > 30000 && v < 60000) {
      return excelSerialDateToISO(v);
    }
  }
  const raw = String(v ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && asNum > 30000 && asNum < 60000) {
    return excelSerialDateToISO(asNum);
  }
  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    return `${y.padStart(4, "0")}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return raw;
}

// Convert Excel time fraction / simple text -> "HH:MM"
function toTimeFromCell(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    let totalMinutes = Math.round(v * 24 * 60);
    const minutesPerDay = 24 * 60;
    totalMinutes = ((totalMinutes % minutesPerDay) + minutesPerDay) % minutesPerDay;
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
    const mm = String(totalMinutes % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) {
    let hh = Number(m[1]);
    let mm = m[2] != null ? Number(m[2]) : 0;
    if (Number.isNaN(hh) || Number.isNaN(mm)) return s;
    hh = ((hh % 24) + 24) % 24;
    mm = ((mm % 60) + 60) % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  return s;
}

function cellToBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return ["y", "yes", "true", "1"].includes(s);
}

// Simple Google geocoding helper for bulk imports & self-service
async function geocodeAddress(text, postCode) {
  if (!GOOGLE_MAPS_KEY) {
    throw new Error("Address lookup is not configured. Please contact the ward or switchboard.");
  }

  const query = [text, postCode].filter(Boolean).join(", ");
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    query
  )}&key=${GOOGLE_MAPS_KEY}`;

  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`Address lookup failed (HTTP ${r.status}). Please try again.`);
  }
  const data = await r.json();
  if (!data.results || !data.results.length || data.status !== "OK") {
    throw new Error(`We couldn't find that address. Please check and try again.`);
  }

  const result = data.results[0];
  const loc = result.geometry?.location || {};
  const components = result.address_components || [];
  const pcComp = components.find(
    (c) => c.types && c.types.includes("postal_code")
  );

  return {
    lat: Number(loc.lat),
    lng: Number(loc.lng),
    formatted: result.formatted_address,
    postCode: pcComp?.long_name || postCode || ""
  };
}

// Map one bulk CSV row → /api/bookings payload
function mapBulkRowToPayload(row) {
  const getRaw = (key) =>
    row && Object.prototype.hasOwnProperty.call(row, key)
      ? row[key]
      : undefined;
  const get = (key) =>
    row && row[key] !== undefined && row[key] !== null
      ? String(row[key]).trim()
      : "";

  const wardName = get("WardName");
  const wardPhone = get("WardPhone");
  const staffName = get("StaffName");
  const staffPhone = get("StaffPhone");
  const shiftTypeRaw = get("ShiftType").toLowerCase();
  const shiftType = shiftTypeRaw === "finish" ? "finish" : "start";

  const pickupDateISO = toISODateFromCell(getRaw("PickupDate"));
  const onOffDutyTime = toTimeFromCell(getRaw("OnOffDutyTime"));

  const pickupText = get("PickupText") || get("PickupAddress");
  const pickupPostCode = get("PickupPostCode");

  const destText =
    get("DestText") || get("DestinationText") || get("DestAddress");
  const destPostCode =
    get("DestPostCode") || get("DestinationPostCode");

  const reasonCode = get("ReasonCode");
  const budgetNumber = get("BudgetNumber");
  const budgetHolderName = get("BudgetHolderName");

  const pickup = {
    formatted: pickupText,
    text: pickupText,
    postCode: pickupPostCode
  };

  const destination = {
    formatted: destText,
    text: destText,
    postCode: destPostCode
  };

  return {
    wardName,
    wardPhone,
    staffName,
    staffPhone,
    shiftType,
    pickupDateISO,
    onOffDutyTime,
    pickup,
    destination,
    requireReturn: false,
    reasonCode,
    budgetNumber,
    budgetHolderName
  };
}

/* ===== SMS TEMPLATE SETTINGS ===== */
const SETTINGS_FILE =
  process.env.SETTINGS_FILE || path.join(__dirname, "settings.json");
const ZONE_PICKUPS_FILE =
  process.env.ZONE_PICKUPS_FILE ||
  path.join(__dirname, "zone-pickups.json");

let smsTemplates = {
  approve:
    "Your request for your Christmas staff booking for Derriford Hospital on {{date}} at {{time}}. " +
    "Pick up: {{pickup}}. Drop off: {{destination}}. " +
    "In the name {{staff}} has been approved. " +
    "Your reference number is {{ref}}. Thanks Need-A-Cab Taxis",
  decline:
    "Unfortunately your Christmas staff booking on {{date}} at {{time}} " +
    "({{pickup}} to {{destination}}) has been declined. Reason: {{reason}}.  Need-A-Cab Taxis"
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
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify(smsTemplates, null, 2),
      "utf8"
    );
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

  return String(tpl || "").replace(
    /{{\s*(\w+)\s*}}/g,
    (_m, key) => (map[key] != null ? String(map[key]) : "")
  );
}

loadSmsTemplatesFromFile();

/* ===== Zone pickups helpers ===== */

function loadZonePickupsSafe() {
  try {
    if (!fs.existsSync(ZONE_PICKUPS_FILE)) return {};
    const raw = fs.readFileSync(ZONE_PICKUPS_FILE, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    console.error("Failed to load zone pickups", err);
    return {};
  }
}

function saveZonePickupsSafe(data) {
  try {
    fs.writeFileSync(
      ZONE_PICKUPS_FILE,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("Failed to save zone pickups", err);
  }
}

// Apply zone pickup-point labels to a list of addresses for a given zone
function applyZonePickupPointsToAddresses(addresses, zoneName) {
  const config = loadZonePickupsSafe();
  if (!config || typeof config !== "object") return addresses || [];

  const zone = String(zoneName || "").trim();
  if (!zone) return addresses || [];

  const zoneKey = Object.keys(config).find(
    (k) => k.toLowerCase() === zone.toLowerCase()
  );
  if (!zoneKey) return addresses || [];

  const entries = config[zoneKey];
  if (!Array.isArray(entries)) return addresses || [];

  return (addresses || []).map((addr) => {
    const out = { ...addr };

    const addrText = String(out.formatted || out.text || "").toLowerCase();
    const addrPostCode = String(out.postCode || "")
      .replace(/\s+/g, "")
      .toLowerCase();

    if (!addrText && !addrPostCode) return out;

    for (const entry of entries) {
      let label = "";
      let match = false;

      if (typeof entry === "string") {
        label = entry;
        const needle = entry.toLowerCase();
        if (addrText.includes(needle)) {
          match = true;
        }
      } else if (entry && typeof entry === "object") {
        label = entry.label || entry.name || entry.title || "";
        const contains = entry.contains || entry.matchContains;
        const exact = entry.exact || entry.matchExact;
        const postcodes =
          entry.postcodes ||
          entry.postCodes ||
          entry.postcode ||
          entry.postCode;

        if (typeof exact === "string" && addrText === exact.toLowerCase()) {
          match = true;
        }
        if (!match && typeof contains === "string") {
          if (addrText.includes(contains.toLowerCase())) {
            match = true;
          }
        }
        if (!match && Array.isArray(postcodes)) {
          const cleaned = postcodes.map((p) =>
            String(p).replace(/\s+/g, "").toLowerCase()
          );
          if (cleaned.includes(addrPostCode)) {
            match = true;
          }
        }
      }

      if (match && label) {
        out.pickupPointLabel = label;
        out.pickupPointZone = zoneKey;
        break;
      }
    }

    return out;
  });
}

/* ===== Address normaliser (handles placeId-only payloads) ===== */
function normaliseAddressShape(raw, label) {
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

// ---------------------- Health ----------------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* =========================
   INLINE BUDGET PORTAL API
   ========================= */
const BUDGET_COOKIE_NAME = "budgetSess";
const SESSION_TTL_DAYS = Math.max(1, parseInt(BUDGET_SESSION_TTL_DAYS || "7", 10));
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const SESSION_SECRET = BUDGET_COOKIE_SECRET || crypto.randomBytes(32).toString("hex");

function sign(data) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("hex");
}

function encodeSession(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  const sig = sign(b64);
  return `${b64}.${sig}`;
}

function decodeSession(token) {
  if (!token) return null;
  const [b64, sig] = String(token).split(".");
  if (!b64 || !sig) return null;
  if (sign(b64) !== sig) return null;
  try {
    const json = Buffer.from(b64, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function setBudgetCookie(res, sess) {
  res.cookie(BUDGET_COOKIE_NAME, encodeSession(sess), {
    httpOnly: true,
    sameSite: "lax",
    secure: NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

function clearBudgetCookie(res) {
  res.clearCookie(BUDGET_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: NODE_ENV === "production",
    path: "/",
  });
}

function requireBudgetAuth(req, res, next) {
  const token = req.cookies?.[BUDGET_COOKIE_NAME];
  const sess = decodeSession(token);
  if (!sess || !sess.exp || Date.now() > sess.exp) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  req.budgetSession = sess;
  next();
}

// Helper: find booking belonging to the session budget
async function findBudgetBooking(req, bookingId) {
  const { budgetNumber } = req.budgetSession || {};
  if (!budgetNumber) return null;
  return Booking.findOne({
    _id: bookingId,
    budgetNumber,
  });
}

// POST /api/budget/login
app.post("/api/budget/login", async (req, res) => {
  try {
    const budgetNumber = String(req.body?.budgetNumber || "").trim();
    const holderName = String(req.body?.holderName || req.body?.holder || "").trim();
    const pin = req.body?.pin != null ? String(req.body.pin).trim() : "";

    if (!/^\d{6}$/.test(budgetNumber)) {
      return res.status(400).json({ error: "Budget number must be 6 digits." });
    }
    if (!holderName) {
      return res.status(400).json({ error: "Budget holder name is required." });
    }
    if (BUDGET_PORTAL_PIN && pin !== BUDGET_PORTAL_PIN) {
      return res.status(401).json({ error: "Invalid PIN." });
    }

    // Optional soft validation
    const exists = await Booking.exists({
      budgetNumber,
      budgetHolderName: new RegExp(`^${holderName}$`, "i"),
    });

    const sess = {
      budgetNumber,
      holderName,
      iat: Date.now(),
      exp: Date.now() + SESSION_TTL_MS,
    };
    setBudgetCookie(res, sess);
    res.json({ ok: true, budgetNumber, holderName, hasBookings: !!exists });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/budget/me
app.get("/api/budget/me", (req, res) => {
  const sess = decodeSession(req.cookies?.[BUDGET_COOKIE_NAME]);
  if (!sess || !sess.exp || Date.now() > sess.exp) {
    return res.status(200).json({ ok: false, session: null });
  }
  res.json({ ok: true, session: { budgetNumber: sess.budgetNumber, holderName: sess.holderName, exp: sess.exp } });
});

// POST /api/budget/logout
app.post("/api/budget/logout", (req, res) => {
  clearBudgetCookie(res);
  res.json({ ok: true });
});

// GET /api/budget/bookings (restricted to session budget)
app.get("/api/budget/bookings", requireBudgetAuth, async (req, res) => {
  const { budgetNumber } = req.budgetSession;
  const { dateFrom, dateTo, status, page = "1", limit = "50" } = req.query;

  const q = { budgetNumber };
  if (status && ["pending", "approved", "declined"].includes(String(status))) q.status = status;
  if (dateFrom || dateTo) {
    q.pickupDateISO = {};
    if (dateFrom) q.pickupDateISO.$gte = String(dateFrom);
    if (dateTo) q.pickupDateISO.$lte = String(dateTo);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const skip = (pageNum - 1) * limitNum;

  const [items, total] = await Promise.all([
    Booking.find(q)
      .sort({ pickupDateISO: 1, onOffDutyTime: 1 })
      .skip(skip)
      .limit(limitNum)
      .select({
        pickupDateISO: 1,
        onOffDutyTime: 1,
        shiftType: 1,
        wardName: 1,
        staffName: 1,
        staffPhone: 1,
        pickup: 1,
        destination: 1,
        status: 1,
        shortRef: 1,
        reference: 1,
        declineReason: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .lean(),
    Booking.countDocuments(q),
  ]);

  res.json({
    ok: true,
    total,
    page: pageNum,
    limit: limitNum,
    pages: Math.ceil(total / limitNum),
    items,
  });
});

// GET /api/budget/bookings/:id (own budget only)
app.get("/api/budget/bookings/:id", requireBudgetAuth, async (req, res) => {
  const { budgetNumber } = req.budgetSession;
  const b = await Booking.findOne({
    _id: req.params.id,
    budgetNumber,
  }).lean();
  if (!b) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, booking: b });
});

// PATCH /api/budget/bookings/:id/approve (budget-scoped)
app.patch("/api/budget/bookings/:id/approve", requireBudgetAuth, async (req, res) => {
  try {
    const b = await findBudgetBooking(req, req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    const prev = b.status;
    b.status = "approved";
    await b.save();

    await addAuditEntry(b._id, {
      actorType: "budget-user",
      source: "budget-portal",
      action: "status-changed",
      oldStatus: prev,
      newStatus: "approved",
      details: {
        holderName: req.budgetSession.holderName,
        budgetNumber: req.budgetSession.budgetNumber,
      },
    });

    res.json({ ok: true, booking: b });
  } catch (e) {
    res.status(400).json({ error: e.message || "Approve failed" });
  }
});

// PATCH /api/budget/bookings/:id/decline (budget-scoped)
app.patch("/api/budget/bookings/:id/decline", requireBudgetAuth, async (req, res) => {
  try {
    const b = await findBudgetBooking(req, req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    const reasonRaw = req.body?.reason;
    const reason = reasonRaw == null ? "" : String(reasonRaw).trim();

    const prev = b.status;
    b.status = "declined";
    b.declineReason = reason;
    await b.save();

    await addAuditEntry(b._id, {
      actorType: "budget-user",
      source: "budget-portal",
      action: "status-changed",
      oldStatus: prev,
      newStatus: "declined",
      details: {
        holderName: req.budgetSession.holderName,
        budgetNumber: req.budgetSession.budgetNumber,
        reason,
      },
    });

    res.json({ ok: true, booking: b });
  } catch (e) {
    res.status(400).json({ error: e.message || "Decline failed" });
  }
});

// PATCH /api/budget/bookings/:id/cancel
app.patch("/api/budget/bookings/:id/cancel", requireBudgetAuth, async (req, res) => {
  const { budgetNumber } = req.budgetSession;
  const reasonRaw = req.body?.reason;
  const reason = reasonRaw == null ? "" : String(reasonRaw).trim();

  const b = await Booking.findOne({
    _id: req.params.id,
    budgetNumber,
  });
  if (!b) return res.status(404).json({ error: "Not found" });

  const prev = b.status;
  b.status = "declined";
  b.declineReason = reason || "Cancelled via budget portal";
  await b.save();

  if (prev !== "declined") {
    await addAuditEntry(b._id, {
      actorType: "budget-user",
      source: "budget-portal",
      action: "status-changed",
      oldStatus: prev,
      newStatus: "declined",
      details: { via: "PATCH /api/budget/bookings/:id/cancel", reason: b.declineReason },
    });
  }

  res.json({ ok: true, booking: b });
});

// Optional debug: see if a booking belongs to your session budget
app.get("/api/budget/debug/:id", requireBudgetAuth, async (req, res) => {
  const { budgetNumber } = req.budgetSession;
  const b = await Booking.findById(req.params.id).lean();
  if (!b) return res.status(404).json({ error: "Booking not found" });
  res.json({
    ok: true,
    yourBudgetNumber: budgetNumber,
    bookingBudgetNumber: b.budgetNumber,
    same: b.budgetNumber === budgetNumber,
    budgetHolderName: b.budgetHolderName || null,
    status: b.status || null,
  });
});

// Debug list of budget routes
app.get("/api/budget/__routes", (_req, res) => {
  res.json({
    ok: true,
    routes: [
      "POST   /api/budget/login",
      "GET    /api/budget/me",
      "POST   /api/budget/logout",
      "GET    /api/budget/bookings",
      "GET    /api/budget/bookings/:id",
      "PATCH  /api/budget/bookings/:id/approve",
      "PATCH  /api/budget/bookings/:id/decline",
      "PATCH  /api/budget/bookings/:id/cancel",
      "GET    /api/budget/debug/:id",
    ],
  });
});

/* =========================
   END INLINE BUDGET API
   ========================= */

// ---------------------- SMS TEMPLATE SETTINGS API ----------------------
app.get("/api/settings/sms-templates", (_req, res) => {
  res.json(smsTemplates);
});

app.put("/api/settings/sms-templates", (req, res) => {
  try {
    const approve = String(req.body?.approve ?? "").trim();
    const decline = String(req.body?.decline ?? "").trim();
    if (!approve || !decline) {
      return res
        .status(400)
        .json({ error: "Both approve and decline templates are required" });
    }
    smsTemplates.approve = approve;
    smsTemplates.decline = decline;
    saveSmsTemplatesToFile();
    res.json({ ok: true, approve, decline });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------- ZONE PICKUPS SETTINGS API ----------------------
app.get("/api/settings/zone-pickups", (_req, res) => {
  const config = loadZonePickupsSafe();
  res.json(config);
});

app.put("/api/settings/zone-pickups", (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res
        .status(400)
        .json({ error: "Zone pickups must be an object keyed by zone" });
    }
    saveZonePickupsSafe(body);
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to save zone pickups", err);
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
    for (const k of requiredText) {
      if (!b?.[k] || String(b[k]).trim() === "") {
        return res.status(400).json({ error: `Missing required field: ${k}` });
      }
    }
    if (!/^[A-Z0-9]{2}$/.test(String(b.reasonCode).toUpperCase())) {
      return res.status(400).json({
        error:
          "Reason Code must be exactly 2 alphanumeric characters (e.g., P1)."
      });
    }
    b.reasonCode = String(b.reasonCode).toUpperCase();
    if (!/^\d{6}$/.test(String(b.budgetNumber))) {
      return res
        .status(400)
        .json({ error: "Budget number must be 6 digits." });
    }
    if (b.budgetHolderSignatureDataURL) {
      if (!/^data:image\/png;base64,/.test(b.budgetHolderSignatureDataURL)) {
        return res.status(400).json({
          error:
            "Invalid signature format (must be PNG data URL) or leave blank."
        });
      }
    }

    const normPickup = normaliseAddressShape(b.pickup, "pickup");
    const normDest = normaliseAddressShape(b.destination, "destination");
    if (!normPickup) {
      return res.status(400).json({
        error: "Invalid pickup address. Please select from suggestions."
      });
    }
    if (!normDest) {
      return res.status(400).json({
        error: "Invalid destination address. Please select from suggestions."
      });
    }

    b.pickup = normPickup;
    b.destination = normDest;

    // Derriford rules
    if (b.shiftType === "start") {
      if (!isDerriford(b.destination.lat, b.destination.lng)) {
        return res.status(400).json({
          error: "For Shift Start, the drop-off must be Derriford Hospital."
        });
      }
    } else {
      if (!isDerriford(b.pickup.lat, b.pickup.lng)) {
        return res.status(400).json({
          error: "For Shift Finish, the pickup must be Derriford Hospital."
        });
      }
    }

    if (!b.pickup.zone)
      b.pickup.zone = await lookupZone(b.pickup.lat, b.pickup.lng);
    if (!b.destination.zone)
      b.destination.zone = await lookupZone(
        b.destination.lat,
        b.destination.lng
      );

    b.reference = makeReference(
      b.reasonCode,
      b.budgetNumber,
      b.budgetHolderName
    );
    b.status = "pending";
    b.shortRef = await nextShortRef();

    const saved = await Booking.create({ ...b, isReturn: false });

    await addAuditEntry(saved._id, {
      actorType: "staff",
      source: "staff-booker",
      action: "booking-created",
      details: { via: "/api/bookings", isReturn: false }
    });

    let savedReturn = null;
    if (b.requireReturn) {
      if (!b.returnDateISO || String(b.returnDateISO).trim() === "") {
        return res.status(400).json({
          error: "Return date is required when return booking is requested."
        });
      }
      const returnTime =
        typeof b.returnOnOffDutyTime === "string" &&
        b.returnOnOffDutyTime.trim() !== ""
          ? b.returnOnOffDutyTime.trim()
          : b.onOffDutyTime;

      const rbPickup = normaliseAddressShape(b.destination, "returnPickup");
      const rbDest = normaliseAddressShape(b.pickup, "returnDestination");
      if (!rbPickup || !rbDest) {
        return res
          .status(400)
          .json({ error: "Return booking addresses invalid." });
      }

      const rb = {
        wardName: b.wardName,
        wardPhone: b.wardPhone,
        staffName: b.staffName,
        staffPhone: b.staffPhone,
        shiftType: flipShift(b.shiftType),
        onOffDutyTime: returnTime,
        pickupDateISO: b.returnDateISO,
        pickup: rbPickup,
        destination: rbDest,
        requireReturn: false,
        reasonCode: b.reasonCode,
        budgetNumber: b.budgetNumber,
        budgetHolderName: b.budgetHolderName,
        ...(b.budgetHolderSignatureDataURL
          ? { budgetHolderSignatureDataURL: b.budgetHolderSignatureDataURL }
          : {}),
        reference: b.reference,
        isReturn: true,
        status: "pending",
        shortRef: await nextShortRef()
      };

      if (rb.shiftType === "start") {
        if (!isDerriford(rb.destination.lat, rb.destination.lng)) {
          return res.status(400).json({
            error:
              "Auto-return (Shift Start) must drop at Derriford Hospital."
          });
        }
      } else {
        if (!isDerriford(rb.pickup.lat, rb.pickup.lng)) {
          return res.status(400).json({
            error:
              "Auto-return (Shift Finish) must pick up at Derriford Hospital."
          });
        }
      }
      if (!rb.pickup.zone)
        rb.pickup.zone = await lookupZone(rb.pickup.lat, rb.pickup.lng);
      if (!rb.destination.zone)
        rb.destination.zone = await lookupZone(
          rb.destination.lat,
          rb.destination.lng
        );

      savedReturn = await Booking.create(rb);

      await addAuditEntry(savedReturn._id, {
        actorType: "staff",
        source: "staff-booker",
        action: "booking-created",
        details: { via: "/api/bookings", isReturn: true }
      });
    }

    return res.json({ ok: true, booking: saved, returnBooking: savedReturn });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: err.message });
  }
});

// ---------------------- Bulk bookings from CSV ----------------------
app.post("/api/bulk-bookings", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      return res.status(400).json({ error: "No rows provided" });
    }

    const baseUrl = `http://127.0.0.1:${Number(PORT) || 4000}`;
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      try {
        const wardNameRaw =
          row.WardName !== undefined && row.WardName !== null
            ? String(row.WardName).trim().toLowerCase()
            : "";
        if (wardNameRaw.startsWith("example")) {
          results.push({
            index: i,
            ok: true,
            skipped: true,
            status: 0,
            reference: null,
            returnReference: null,
            error: null
          });
          continue;
        }

        const payload = mapBulkRowToPayload(row);

        const pickupFull = [payload.pickup.text, payload.pickup.postCode]
          .filter(Boolean)
          .join(", ");
        const destFull = [payload.destination.text, payload.destination.postCode]
          .filter(Boolean)
          .join(", ");

        const pickupGeo = await geocodeAddress(
          pickupFull,
          payload.pickup.postCode
        );
        const destGeo = await geocodeAddress(
          destFull,
          payload.destination.postCode
        );

        payload.pickup.lat = pickupGeo.lat;
        payload.pickup.lng = pickupGeo.lng;
        payload.pickup.formatted = pickupGeo.formatted;
        payload.pickup.postCode = pickupGeo.postCode || payload.pickup.postCode;

        payload.destination.lat = destGeo.lat;
        payload.destination.lng = destGeo.lng;
        payload.destination.formatted = destGeo.formatted;
        payload.destination.postCode =
          destGeo.postCode || payload.destination.postCode;

        payload.requireReturn = false;
        delete payload.returnDateISO;
        delete payload.returnOnOffDutyTime;

        const r = await fetch(`${baseUrl}/api/bookings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const data = await r.json().catch(() => ({}));
        const ok = r.ok && !data?.error;

        results.push({
          index: i,
          ok,
          skipped: false,
          status: r.status,
          reference: data?.booking?.reference || null,
          returnReference: null,
          error: ok ? null : data?.error || `HTTP ${r.status}`
        });
      } catch (err) {
        results.push({
          index: i,
          ok: false,
          skipped: false,
          status: 0,
          reference: null,
          returnReference: null,
          error: err.message || "Row failed"
        });
      }
    }

    res.json({
      ok: true,
      count: results.length,
      results
    });
  } catch (err) {
    console.error("Error in /api/bulk-bookings:", err);
    res
      .status(500)
      .json({ error: "Server error while processing bulk bookings" });
  }
});

// ---------------------- Queryable bookings ----------------------
app.get("/api/bookings", async (req, res) => {
  const {
    dateFrom,
    dateTo,
    shiftType,
    time,
    zone,
    ward,
    staff,
    reference,
    requireReturn,
    isReturn,
    status,
    page = "1",
    limit = "50",
    sort
  } = req.query;

  const q = {};
  if (dateFrom || dateTo) {
    q.pickupDateISO = {};
    if (dateFrom) q.pickupDateISO.$gte = String(dateFrom);
    if (dateTo) q.pickupDateISO.$lte = String(dateTo);
  }
  if (shiftType && (shiftType === "start" || shiftType === "finish"))
    q.shiftType = shiftType;
  if (time) q.onOffDutyTime = time;

  if (zone && zone.trim() !== "") {
    const regex = new RegExp(zone.trim(), "i");
    if (shiftType === "start") q["pickup.zone.name"] = regex;
    else if (shiftType === "finish") q["destination.zone.name"] = regex;
    else
      q.$or = [
        { "pickup.zone.name": regex },
        { "destination.zone.name": regex }
      ];
  }

  if (ward && ward.trim() !== "") q.wardName = new RegExp(ward.trim(), "i");
  if (staff && staff.trim() !== "")
    q.staffName = new RegExp(staff.trim(), "i");
  if (reference && reference.trim() !== "")
    q.reference = new RegExp(reference.trim(), "i");

  if (requireReturn === "true") q.requireReturn = true;
  if (requireReturn === "false") q.requireReturn = false;
  if (isReturn === "true") q.isReturn = true;
  if (isReturn === "false") q.isReturn = false;
  if (status && ["pending", "approved", "declined"].includes(String(status)))
    q.status = status;

  const sortObj = {};
  if (sort) {
    for (const part of String(sort).split(",")) {
      const [k, dir] = part.split(":");
      if (k) sortObj[k] = dir === "desc" ? -1 : 1;
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

  res.json({
    total,
    page: pageNum,
    limit: limitNum,
    pages: Math.ceil(total / limitNum),
    items
  });
});

// ---------------------- CSV export ----------------------
app.get("/api/bookings/export", async (req, res) => {
  req.query.page = "1";
  req.query.limit = "5000";
  const url = new URL(
    req.protocol +
      "://" +
      req.get("host") +
      req.originalUrl.replace("/export", "")
  );
  const qp = new URLSearchParams(url.search);
  const r = await fetch(
    req.protocol +
      "://" +
      req.get("host") +
      "/api/bookings?" +
      qp.toString()
  );
  const data = await r.json();

  const rows = data.items || [];
  const header = [
    "pickupDateISO",
    "onOffDutyTime",
    "shiftType",
    "wardName",
    "staffName",
    "staffPhone",
    "pickup.formatted",
    "pickup.zone.name",
    "destination.formatted",
    "destination.zone.name",
    "reference",
    "requireReturn",
    "isReturn",
    "status",
    "shortRef",
    "declineReason"
  ];

  const csv = [
    header.join(","),
    ...rows.map((b) =>
      [
        toDDMMYY(b.pickupDateISO),
        b.onOffDutyTime,
        b.shiftType,
        (b.wardName || "").replace(/,/g, " "),
        (b.staffName || "").replace(/,/g, " "),
        b.staffPhone || "",
        (b.pickup?.formatted || "").replace(/,/g, " "),
        (b.pickup?.zone?.name || "").replace(/,/g, " "),
        (b.destination?.formatted || "").replace(/,/g, " "),
        (b.destination?.zone?.name || "").replace(/,/g, " "),
        b.reference || "",
        b.requireReturn ? "TRUE" : "FALSE",
        b.isReturn ? "TRUE" : "FALSE",
        b.status || "",
        b.shortRef || "",
        (b.declineReason || "").replace(/,/g, " ")
      ].join(",")
    )
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=bookings_export.csv"
  );
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
            reference: "$reference"
          }
        }
      }
    },
    { $sort: { "_id.zoneName": 1 } }
  );

  const raw = await Booking.aggregate(pipeline);
  const result = raw.map((z) => ({
    zoneName: z._id.zoneName || "(unknown)",
    count: z.count,
    items: (z.items || []).map((it) => ({
      ...it,
      pickupDateISO: toDDMMYY(it.pickupDateISO)
    }))
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
        zones: { $addToSet: "$pickup.zone.name" }
      }
    },
    { $sort: { "_id.shiftType": 1, "_id.onOffDutyTime": 1 } }
  );
  const result = await Booking.aggregate(pipeline);
  res.json(result);
});

/* ====== SMART PACK ZONE CLUSTERING ====== */
const ZONE_CLUSTERS = [
  {
    label: "Mutley / Greenbank / Lipson / St Judes / Mount Gould",
    zones: [
      "Mutley",
      "Greenbank",
      "St Judes, Lipson",
      "St Judes",
      "St Jude's",
      "Lipson",
      "Mount Gould",
      "North Cross",
      "North Hill"
    ]
  }
];

function getZoneClusterName(zoneName) {
  const name = String(zoneName || "").trim();
  if (!name) return "(unknown)";
  const lower = name.toLowerCase();

  for (const cluster of ZONE_CLUSTERS) {
    for (const z of cluster.zones) {
      if (lower === String(z).toLowerCase()) {
        return cluster.label;
      }
    }
  }
  return name;
}

// ---------------------- Shift grouping (clustered + pickup points) ----------------------
app.get("/api/reports/shift-groups", async (req, res) => {
  try {
    const type = (req.query.type || "start").toLowerCase();
    const date = (req.query.date || "").trim();

    const match = {};
    if (type === "start") match.shiftType = "start";
    else if (type === "finish") match.shiftType = "finish";
    if (date) match.pickupDateISO = date;

    const zoneField =
      type === "finish" ? "$destination.zone.name" : "$pickup.zone.name";

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: {
            date: "$pickupDateISO",
            time: "$onOffDutyTime",
            zone: zoneField
          },
          count: { $sum: 1 },
          addresses: {
            $push: {
              formatted:
                type === "finish"
                  ? "$destination.formatted"
                  : "$pickup.formatted",
              text: type === "finish" ? "$destination.text" : "$pickup.text",
              houseNumber:
                type === "finish"
                  ? "$destination.houseNumber"
                  : "$pickup.houseNumber",
              street:
                type === "finish"
                  ? "$destination.street"
                  : "$pickup.street",
              town: type === "finish" ? "$destination.town" : "$pickup.town",
              postCode:
                type === "finish"
                  ? "$destination.postCode"
                  : "$pickup.postCode",
              lat: type === "finish" ? "$destination.lat" : "$pickup.lat",
              lng: type === "finish" ? "$destination.lng" : "$pickup.lng",

              staffName: "$staffName",
              staffPhone: "$staffPhone"
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          pickupDateISO: "$_id.date",
          onOffDutyTime: "$_id.time",
          zoneName: { $ifNull: ["$_id.zone", "(unknown)"] },
          count: 1,
          addresses: 1
        }
      },
      { $sort: { pickupDateISO: 1, onOffDutyTime: 1, zoneName: 1 } }
    ];

    const groups = await Booking.aggregate(pipeline);

    const direction = type === "finish" ? "outbound" : "inbound";

    // 1) pickup points per original zone
    const withPickupPointsByZone = groups.map((g) => {
      const withPickupPoints = applyZonePickupPointsToAddresses(
        g.addresses || [],
        g.zoneName
      );
      return { ...g, addresses: withPickupPoints };
    });

    // 2) merge neighbouring zones into clusters
    const bucketMap = new Map();

    for (const g of withPickupPointsByZone) {
      const isoDate = g.pickupDateISO;
      const time = g.onOffDutyTime;
      const originalZone = g.zoneName || "(unknown)";
      const clusterName = getZoneClusterName(originalZone);

      const bucketKey = `${isoDate}__${time}__${clusterName}`;
      if (!bucketMap.has(bucketKey)) {
        bucketMap.set(bucketKey, {
          pickupDateISO: isoDate,
          onOffDutyTime: time,
          clusterName,
          zones: new Set(),
          count: 0,
          addresses: []
        });
      }

      const bucket = bucketMap.get(bucketKey);
      bucket.zones.add(originalZone);
      bucket.count += g.count || 0;
      bucket.addresses.push(...(g.addresses || []));
    }

    // 3) optimise combined route per cluster
    const formatted = Array.from(bucketMap.values()).map((b) => {
      const orderedAddresses = optimiseRoute(b.addresses, direction);

      return {
        pickupDateISO: toDDMMYY(b.pickupDateISO),
        onOffDutyTime: b.onOffDutyTime,
        zoneName: b.clusterName,
        zones: Array.from(b.zones).sort(),
        count: b.count,
        addresses: orderedAddresses
      };
    });

    formatted.sort((a, b) => {
      if (a.pickupDateISO !== b.pickupDateISO) {
        return a.pickupDateISO.localeCompare(b.pickupDateISO);
      }
      if (a.onOffDutyTime !== b.onOffDutyTime) {
        return a.onOffDutyTime.localeCompare(b.onOffDutyTime);
      }
      return a.zoneName.localeCompare(b.zoneName);
    });

    res.json({ type, groups: formatted });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// --- Public booking view for staff link (limited fields) ---
app.get("/api/bookings/:id/public", async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).lean();
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json({
      _id: booking._id,
      pickupDateISO: booking.pickupDateISO,
      onOffDutyTime: booking.onOffDutyTime,
      shiftType: booking.shiftType,
      wardName: booking.wardName,
      staffName: booking.staffName,
      staffPhone: booking.staffPhone,
      reference: booking.reference,
      shortRef: booking.shortRef,
      pickup: booking.pickup,
      destination: booking.destination,
      status: booking.status,
      requireReturn: booking.requireReturn,
      manualFlagLabel: booking.manualFlagLabel,
      manualFlagReason: booking.manualFlagReason,
      updatedByStaffAt: booking.updatedByStaffAt,
      cancelledByStaffAt: booking.cancelledByStaffAt
    });
  } catch (err) {
    console.error("public booking error", err);
    res.status(500).json({ error: "Failed to load booking" });
  }
});

// --- Staff link: confirm booking ---
app.post("/api/bookings/:id/customer-confirm", async (req, res) => {
  try {
    const now = new Date();
    const update = {
      confirmedByStaffAt: now,
      confirmedByStaffSource: "staff-link",
      lastCustomerAction: "confirmed",
      lastCustomerActionAt: now,
      lastCustomerActionSource: "sms-link",
      lastCustomerActionSummary: "Confirmed via staff link",
      status: "approved"
    };
    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    ).lean();

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    await addAuditEntry(req.params.id, {
      actorType: "staff",
      source: "sms-link",
      action: "customer-confirmed",
      details: {}
    });

    res.json({ ok: true, booking });
  } catch (err) {
    console.error("customer-confirm error", err);
    res.status(500).json({ error: "Failed to confirm booking" });
  }
});

// --- Staff link: edit booking ---
app.post("/api/bookings/:id/customer-update", async (req, res) => {
  try {
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

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const now = new Date();
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

    // Address updates
    if (pickup || pickupText || pickupPostCode) {
      if (pickup) {
        const normPickup = normaliseAddressShape(pickup, "pickup");
        if (!normPickup) {
          return res.status(400).json({
            error:
              "Invalid pickup address. Please select from suggestions."
          });
        }

        const currentPickup =
          typeof booking.pickup?.toObject === "function"
            ? booking.pickup.toObject()
            : booking.pickup || {};
        booking.pickup = { ...currentPickup, ...normPickup };

        if (
          typeof booking.pickup.lat === "number" &&
          typeof booking.pickup.lng === "number"
        ) {
          booking.pickup.zone = await lookupZone(
            booking.pickup.lat,
            booking.pickup.lng
          );
        }
      } else {
        const baseStreet =
          pickupText ||
          booking.pickup?.text ||
          booking.pickup?.formatted ||
          "";
        const basePostCode =
          pickupPostCode || booking.pickup?.postCode || "";

        const query = [baseStreet, basePostCode].filter(Boolean).join(", ");
        if (!query) {
          return res.status(400).json({
            error:
              "Invalid pickup address. Please enter a full address and postcode."
          });
        }

        const geo = await geocodeAddress(query, basePostCode);

        const currentPickup =
          typeof booking.pickup?.toObject === "function"
            ? booking.pickup.toObject()
            : booking.pickup || {};

        booking.pickup = {
          ...currentPickup,
          formatted: geo.formatted,
          text: geo.formatted,
          postCode:
            geo.postCode ||
            pickupPostCode ||
            currentPickup.postCode ||
            "",
          lat: geo.lat,
          lng: geo.lng
        };

        booking.pickup.zone = await lookupZone(geo.lat, geo.lng);
      }

      changedFields.push("pickupAddress");
      changed = true;
    }

    if (destination || destinationText || destinationPostCode) {
      if (destination) {
        const normDest = normaliseAddressShape(destination, "destination");
        if (!normDest) {
          return res.status(400).json({
            error:
              "Invalid destination address. Please select from suggestions."
          });
        }

        const currentDest =
          typeof booking.destination?.toObject === "function"
            ? booking.destination.toObject()
            : booking.destination || {};
        booking.destination = { ...currentDest, ...normDest };

        if (
          typeof booking.destination.lat === "number" &&
          typeof booking.destination.lng === "number"
        ) {
          booking.destination.zone = await lookupZone(
            booking.destination.lat,
            booking.destination.lng
          );
        }
      } else {
        const baseStreet =
          destinationText ||
          booking.destination?.text ||
          booking.destination?.formatted ||
          "";
        const basePostCode =
          destinationPostCode || booking.destination?.postCode || "";

        const query = [baseStreet, basePostCode].filter(Boolean).join(", ");
        if (!query) {
          return res.status(400).json({
            error:
              "Invalid destination address. Please enter a full address and postcode."
          });
        }

        const geo = await geocodeAddress(query, basePostCode);

        const currentDest =
          typeof booking.destination?.toObject === "function"
            ? booking.destination.toObject()
            : booking.destination || {};

        booking.destination = {
          ...currentDest,
          formatted: geo.formatted,
          text: geo.formatted,
          postCode:
            geo.postCode ||
            destinationPostCode ||
            currentDest.postCode ||
            "",
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

    if (
      !booking.pickup ||
      typeof booking.pickup.lat !== "number" ||
      typeof booking.pickup.lng !== "number"
    ) {
      return res.status(400).json({
        error:
          "Updated booking must have a valid pickup address (with map location)."
      });
    }
    if (
      !booking.destination ||
      typeof booking.destination.lat !== "number" ||
      typeof booking.destination.lng !== "number"
    ) {
      return res.status(400).json({
        error:
          "Updated booking must have a valid destination address (with map location)."
      });
    }

    // Re-enforce Derriford rules
    if (booking.shiftType === "start") {
      if (!isDerriford(booking.destination.lat, booking.destination.lng)) {
        return res.status(400).json({
          error:
            "For Shift Start, the drop-off must be Derriford Hospital."
        });
      }
    } else {
      if (!isDerriford(booking.pickup.lat, booking.pickup.lng)) {
        return res.status(400).json({
          error:
            "For Shift Finish, the pickup must be Derriford Hospital."
        });
      }
    }

    booking.updatedByStaffAt = now;
    booking.updatedByStaffSource = "staff-link";

    const summaryParts = [];
    if (changedFields.includes("date")) {
      summaryParts.push(`date to ${toDDMMYY(booking.pickupDateISO)}`);
    }
    if (changedFields.includes("time")) {
      summaryParts.push(`time to ${booking.onOffDutyTime}`);
    }
    if (changedFields.includes("phone")) {
      summaryParts.push("contact number");
    }
    if (changedFields.includes("pickupAddress")) {
      summaryParts.push("pickup address");
    }
    if (changedFields.includes("destinationAddress")) {
      summaryParts.push("destination address");
    }

    const summary =
      summaryParts.length > 0
        ? `Staff updated ${summaryParts.join(", ")} via link`
        : "Staff updated booking via link";

    booking.updatedByStaffSummary = summary;
    booking.lastCustomerAction = "updated";
    booking.lastCustomerActionAt = now;
    booking.lastCustomerActionSource = "sms-link";
    booking.lastCustomerActionSummary = summary;

    await booking.save();

    await addAuditEntry(booking._id, {
      actorType: "staff",
      source: "sms-link",
      action: "customer-updated",
      details: { changedFields, summary }
    });

    res.json({ ok: true, booking });
  } catch (err) {
    console.error("customer-update error", err);
    res.status(500).json({ error: "Failed to update booking" });
  }
});

// --- Staff link: cancel booking ---
app.post("/api/bookings/:id/customer-cancel", async (req, res) => {
  try {
    const { reason } = req.body || {};
    const now = new Date();

    const set = {
      status: "declined",
      declineReason: reason || "Cancelled by staff via update link",
      cancelledByStaffAt: now,
      cancelledByStaffReason: reason || null,
      cancelledByStaffSource: "staff-link",
      cancelled: true,
      cancelledBy: "staff-link",
      cancelledAt: now,
      cancelReason: reason || "Cancelled by staff via update link",
      lastCustomerAction: "cancelled",
      lastCustomerActionAt: now,
      lastCustomerActionSource: "sms-link",
      lastCustomerActionSummary: "Cancelled via staff link"
    };

    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { $set: set },
      { new: true }
    ).lean();

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    await addAuditEntry(req.params.id, {
      actorType: "staff",
      source: "sms-link",
      action: "customer-cancelled",
      details: { reason: reason || null }
    });

    res.json({ ok: true, booking });
  } catch (err) {
    console.error("customer-cancel error", err);
    res.status(500).json({ error: "Failed to cancel booking" });
  }
});

// ===== Actions: UPDATE / Approve / Decline / Delete =====

// General update for a booking (used by bookings page edit, inline address edit, manual flags)
app.put("/api/bookings/:id", async (req, res) => {
  try {
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    const payload = req.body || {};

    const editableFields = [
      "wardName",
      "wardPhone",
      "staffName",
      "staffPhone",
      "shiftType",
      "onOffDutyTime",
      "pickupDateISO",
      "reasonCode",
      "budgetNumber",
      "budgetHolderName",
      "status"
    ];

    if (payload.manualFlagLabel !== undefined) {
      b.manualFlagLabel =
        payload.manualFlagLabel === null
          ? undefined
          : String(payload.manualFlagLabel).trim();
    }
    if (payload.manualFlagReason !== undefined) {
      b.manualFlagReason =
        payload.manualFlagReason === null
          ? undefined
          : String(payload.manualFlagReason).trim();
    }

    const previousStatus = b.status;

    const isCoreFieldUpdate =
      editableFields.some((field) => payload[field] !== undefined) ||
      !!payload.pickup ||
      !!payload.destination;

    if (!isCoreFieldUpdate) {
      await b.save();
      return res.json({ ok: true, booking: b });
    }

    for (const field of editableFields) {
      if (payload[field] === undefined) continue;

      if (field === "status") {
        const v = String(payload.status ?? "").trim().toLowerCase();
        if (!v) {
          b.status = "pending";
        } else if (["pending", "approved", "declined"].includes(v)) {
          b.status = v;
        }
      } else {
        b[field] =
          typeof payload[field] === "string"
            ? payload[field].trim()
            : payload[field];
      }
    }

    if (payload.pickup || payload.destination) {
      if (payload.pickup) {
        const currentPickup =
          typeof b.pickup?.toObject === "function"
            ? b.pickup.toObject()
            : b.pickup || {};
        b.pickup = { ...currentPickup, ...payload.pickup };
      }
      if (payload.destination) {
        const currentDest =
          typeof b.destination?.toObject === "function"
            ? b.destination.toObject()
            : b.destination || {};
        b.destination = { ...currentDest, ...payload.destination };
      }
    }

    const requiredText = [
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
    for (const k of requiredText) {
      if (!b[k] || String(b[k]).trim() === "") {
        return res
          .status(400)
          .json({ error: `Missing required field: ${k}` });
      }
    }

    if (!/^[A-Z0-9]{2}$/.test(String(b.reasonCode).toUpperCase())) {
      return res.status(400).json({
        error:
          "Reason Code must be exactly 2 alphanumeric characters (e.g., P1)."
      });
    }
    b.reasonCode = String(b.reasonCode).toUpperCase();
    if (!/^\d{6}$/.test(String(b.budgetNumber))) {
      return res
        .status(400)
        .json({ error: "Budget number must be 6 digits." });
    }

    if (
      !b.pickup ||
      typeof b.pickup.lat !== "number" ||
      typeof b.pickup.lng !== "number"
    ) {
      return res.status(400).json({
        error: "Booking pickup address is invalid, cannot update."
      });
    }
    if (
      !b.destination ||
      typeof b.destination.lat !== "number" ||
      typeof b.destination.lng !== "number"
    ) {
      return res.status(400).json({
        error: "Booking destination address is invalid, cannot update."
      });
    }

    if (b.shiftType === "start") {
      if (!isDerriford(b.destination.lat, b.destination.lng)) {
        return res.status(400).json({
          error:
            "For Shift Start, the drop-off must be Derriford Hospital."
        });
      }
    } else {
      if (!isDerriford(b.pickup.lat, b.pickup.lng)) {
        return res.status(400).json({
          error:
            "For Shift Finish, the pickup must be Derriford Hospital."
        });
      }
    }

    b.reference = makeReference(
      b.reasonCode,
      b.budgetNumber,
      b.budgetHolderName
    );

    await b.save();

    if (previousStatus !== b.status) {
      await addAuditEntry(b._id, {
        actorType: "admin",
        source: "admin-dashboard",
        action: "status-changed",
        oldStatus: previousStatus,
        newStatus: b.status,
        details: { via: "PUT /api/bookings/:id" }
      });
    }

    res.json({ ok: true, booking: b });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// ✅ Remove flags (manual + dismiss auto flags)
app.patch("/api/bookings/:id/remove-flag", async (req, res) => {
  try {
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    const rawFlags =
      Array.isArray(req.body?.flags) && req.body.flags.length
        ? req.body.flags
        : req.body?.flag
        ? [req.body.flag]
        : [];

    let codes = rawFlags
      .map((f) => String(f || "").trim())
      .filter(Boolean);

    if (!codes.length) {
      codes = ["manual"];
    }

    const manualKeys = new Set(["manual", "manualFlag", "manual-flag"]);
    const clearManual = codes.some((c) => manualKeys.has(c.toLowerCase()));
    const autoCodes = codes.filter((c) => !manualKeys.has(c.toLowerCase()));

    const hadManual =
      !!(b.manualFlagLabel || b.manualFlagReason);

    if (clearManual) {
      b.manualFlagLabel = undefined;
      b.manualFlagReason = undefined;
    }

    if (autoCodes.length) {
      const existing = Array.isArray(b.dismissedFlags)
        ? b.dismissedFlags
        : [];
      const merged = Array.from(
        new Set([...existing, ...autoCodes])
      ).filter(Boolean);
      b.dismissedFlags = merged;
    }

    await b.save();

    const cleared = {
      manual: clearManual && hadManual,
      autoCodes
    };

    await addAuditEntry(b._id, {
      actorType: "admin",
      source: "admin-dashboard",
      action: "flags-cleared",
      details: {
        via: "PATCH /api/bookings/:id/remove-flag",
        cleared
      }
    });

    res.json({ ok: true, booking: b, cleared });
  } catch (e) {
    console.error("remove-flag error", e);
    res.status(400).json({ error: e.message });
  }
});

// ✅ Approve: just mark as approved (admin)
app.patch("/api/bookings/:id/approve", async (req, res) => {
  try {
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    const previousStatus = b.status;
    b.status = "approved";
    await b.save();

    if (previousStatus !== "approved") {
      await addAuditEntry(b._id, {
        actorType: "admin",
        source: "admin-dashboard",
        action: "status-changed",
        oldStatus: previousStatus,
        newStatus: "approved",
        details: { via: "PATCH /api/bookings/:id/approve" }
      });
    }

    res.json({ ok: true, booking: b });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ✅ Decline: just mark as declined (admin)
app.patch("/api/bookings/:id/decline", async (req, res) => {
  try {
    const reasonRaw = req.body?.reason;
    const reason =
      reasonRaw === undefined || reasonRaw === null
        ? ""
        : String(reasonRaw).trim();

    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    const previousStatus = b.status;
    b.status = "declined";
    b.declineReason = reason || "";
    await b.save();

    if (previousStatus !== "declined") {
      await addAuditEntry(b._id, {
        actorType: "admin",
        source: "admin-dashboard",
        action: "status-changed",
        oldStatus: previousStatus,
        newStatus: "declined",
        details: { via: "PATCH /api/bookings/:id/decline", reason }
      });
    }

    res.json({ ok: true, booking: b });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ✅ Clear status: reset back to 'pending'
app.patch("/api/bookings/:id/clear-status", async (req, res) => {
  try {
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    const previousStatus = b.status;
    b.status = "pending";
    b.declineReason = "";
    await b.save();

    if (previousStatus !== "pending") {
      await addAuditEntry(b._id, {
        actorType: "admin",
        source: "admin-dashboard",
        action: "status-changed",
        oldStatus: previousStatus,
        newStatus: "pending",
        details: { via: "PATCH /api/bookings/:id/clear-status" }
      });
    }

    res.json({ ok: true, booking: b });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/bookings/:id", async (req, res) => {
  try {
    const b = await Booking.findByIdAndDelete(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });

    await addAuditEntry(b._id, {
      actorType: "admin",
      source: "admin-dashboard",
      action: "status-changed",
      oldStatus: b.status,
      newStatus: "deleted",
      details: { via: "DELETE /api/bookings/:id" }
    });

    res.json({ ok: true, deletedId: req.params.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------- Booking logs (for SMS / links, etc.) ---------- */
app.get("/api/bookings/:id/logs", async (req, res) => {
  try {
    const logs = await BookingLog.find({ bookingId: req.params.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ ok: true, items: logs });
  } catch (e) {
    console.error("Error fetching booking logs", e);
    res.status(400).json({ error: e.message });
  }
});

/* ---------- Generic SMS endpoint for dashboard (/send-sms) ---------- */
app.post("/send-sms", async (req, res) => {
  try {
    const { to, message, source, bookingId } = req.body || {};

    if (!to || !message) {
      return res
        .status(400)
        .json({ error: "Missing 'to' or 'message' in body." });
    }

    const smsResult = await sendSMS(to, message);

    if (bookingId) {
      try {
        await BookingLog.create({
          bookingId,
          type: source || "generic_sms",
          phone: smsResult.to || normalizeUKMobile(to),
          message,
          smsStatus: smsResult,
          meta: { source: source || null }
        });
      } catch (logErr) {
        console.warn("Failed to log generic SMS:", logErr.message);
      }

      try {
        const now = new Date();
        const update = {
          lastSmsAt: now,
          lastSmsSource: source || "generic",
          lastSmsPurpose: "generic",
          lastSmsMessagePreview: String(message).trim().slice(0, 200)
        };
        await Booking.findByIdAndUpdate(
          bookingId,
          {
            $set: update,
            $inc: { smsCount: 1 }
          },
          { new: false }
        ).lean();

        await addAuditEntry(bookingId, {
          actorType: "admin",
          source: "admin-dashboard",
          action: "sms-sent",
          details: {
            to: smsResult.to || normalizeUKMobile(to),
            purpose: "generic",
            source: source || "generic",
            ok: smsResult.ok,
            status: smsResult.status,
            messagePreview: String(message).trim().slice(0, 200)
          }
        });
      } catch (err) {
        console.warn(
          "Failed to update booking lastSms* for /send-sms:",
          err.message
        );
      }
    }

    if (!smsResult.ok) {
      return res.status(502).json({
        error: "SMS send failed",
        details: smsResult
      });
    }

    return res.json({
      ok: true,
      to: smsResult.to || normalizeUKMobile(to),
      method: smsResult.method,
      status: smsResult.status
    });
  } catch (err) {
    console.error("Error in /send-sms:", err);
    res.status(500).json({ error: "Failed to send SMS" });
  }
});

/* ---------- Generic SMS to customer (staff/ward) ---------- */
app.post("/api/bookings/:id/sms", async (req, res) => {
  try {
    const { message, phoneSource } = req.body || {};
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Booking not found" });

    let rawPhone = "";
    if (phoneSource === "ward") {
      rawPhone = b.wardPhone || "";
    } else {
      rawPhone = b.staffPhone || b.wardPhone || "";
    }

    if (!rawPhone) {
      return res
        .status(400)
        .json({ error: "No phone number available on this booking" });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "Message text is required" });
    }

    const trimmedMessage = String(message).trim();
    const smsResult = await sendSMS(rawPhone, trimmedMessage);

    const toNumberFinal = smsResult.to || normalizeUKMobile(rawPhone);

    const now = new Date();
    b.lastSmsAt = now;
    b.lastSmsSource = "bookings-page";
    b.lastSmsPurpose = "manual-message";
    b.lastSmsMessagePreview = trimmedMessage.slice(0, 200);
    b.smsCount = (b.smsCount || 0) + 1;
    await b.save();

    await addAuditEntry(b._id, {
      actorType: "admin",
      source: "admin-dashboard",
      action: "sms-sent",
      details: {
        to: toNumberFinal,
        purpose: "manual-message",
        phoneSource: phoneSource || "staff",
        ok: smsResult.ok,
        status: smsResult.status,
        messagePreview: trimmedMessage.slice(0, 200)
      }
    });

    if (!smsResult.ok) {
      return res.status(502).json({
        error: "SMS send failed",
        details: smsResult
      });
    }

    res.json({
      ok: true,
      to: toNumberFinal,
      method: smsResult.method,
      status: smsResult.status
    });
  } catch (err) {
    console.error("Error in /api/bookings/:id/sms:", err);
    res
      .status(500)
      .json({ error: "Server error while sending SMS" });
  }
});

/* ---------- SMS self-service link for flagged bookings ---------- */

function buildCustomerSelfServiceUrl(req, bookingId) {
  const base =
    PUBLIC_CUSTOMER_BASE_URL ||
    `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
  return `${base}/staff-update.html?bookingId=${encodeURIComponent(
    bookingId
  )}`;
}

app.post("/api/bookings/:id/send-edit-link", async (req, res) => {
  try {
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Booking not found" });

    if (!b.staffPhone) {
      return res
        .status(400)
        .json({ error: "Booking has no staffPhone to text" });
    }

    const reasonExtra = (req.body?.reason || "").trim();
    const noteExtra = (req.body?.note || "").trim();

    const link = buildCustomerSelfServiceUrl(req, b._id.toString());

    const dateStr = toDDMMYY(b.pickupDateISO);
    const timeStr = b.onOffDutyTime || "";
    const pickupStr = b.pickup?.formatted || "";
    const destStr = b.destination?.formatted || "";

    let message =
      `There is a query about your Derriford staff taxi booking on ${dateStr} at ${timeStr} ` +
      `(${pickupStr} → ${destStr}). ` +
      `Please tap this link to review, edit or cancel your booking: ${link}`;

    if (reasonExtra) {
      message =
        `There is a query about your Derriford staff taxi booking: ${reasonExtra}. ` +
        `Booking ${dateStr} at ${timeStr} (${pickupStr} → ${destStr}). ` +
        `Please tap this link to review, edit or cancel your booking: ${link}`;
    }

    const smsResult = await sendSMS(b.staffPhone, message);

    await BookingLog.create({
      bookingId: b._id,
      type: "edit_link_sms",
      phone: smsResult.to || normalizeUKMobile(b.staffPhone),
      message,
      smsStatus: smsResult,
      meta: {
        reason: reasonExtra || null,
        note: noteExtra || null,
        manualFlagLabel: b.manualFlagLabel || null,
        manualFlagReason: b.manualFlagReason || null
      }
    });

    try {
      const now = new Date();
      const update = {
        lastSmsAt: now,
        lastSmsSource: "edit-link",
        lastSmsPurpose: "edit-link",
        lastSmsMessagePreview: message.slice(0, 200)
      };
      await Booking.findByIdAndUpdate(
        b._id,
        {
          $set: update,
          $inc: { smsCount: 1 }
        },
        { new: false }
      ).lean();

      await addAuditEntry(b._id, {
        actorType: "admin",
        source: "admin-dashboard",
        action: "sms-sent",
        details: {
          to: smsResult.to || normalizeUKMobile(b.staffPhone),
          purpose: "edit-link",
          ok: smsResult.ok,
          status: smsResult.status,
          messagePreview: message.slice(0, 200),
          reasonExtra: reasonExtra || null
        }
      });
    } catch (err) {
      console.warn(
        "Failed to update booking lastSms* for edit-link SMS:",
        err.message
      );
    }

    if (!smsResult.ok) {
      return res.status(502).json({
        error: "Failed to send SMS",
        smsResult
      });
    }

    res.json({
      ok: true,
      link,
      smsResult
    });
  } catch (e) {
    console.error("Error in /api/bookings/:id/send-edit-link", e);
    res.status(500).json({ error: "Server error while sending edit link" });
  }
});

/* ---------- Smart Pack → Autocab booking ---------- */

function getSmartStopLabel(stop) {
  if (!stop) return "";
  const label =
    stop.pickupLocation ||
    stop.pickupPointLabel ||
    stop.locationLabel ||
    stop.locationName ||
    stop.label ||
    "";
  return String(label || "").trim();
}

function buildSmartStopNote(stop) {
  if (!stop) return "";
  if (stop.note && String(stop.note).trim()) return String(stop.note).trim();

  const label = getSmartStopLabel(stop);
  const staffBits = [
    stop.staffName || stop.name || "",
    stop.staffPhone || stop.phone || ""
  ]
    .filter(Boolean)
    .join(" · ");

  return [label, staffBits].filter(Boolean).join(" — ");
}

function mapSmartStopToAutocabAddress(stop) {
  const baseText = stop.formatted || stop.text || "";
  const label = getSmartStopLabel(stop);

  let combinedText = baseText;
  if (label) {
    const baseLower = baseText.toLowerCase();
    const labelLower = label.toLowerCase();
    if (!baseLower.includes(labelLower)) {
      combinedText = baseText ? `${label} – ${baseText}` : label;
    } else {
      combinedText = baseText || label;
    }
  }

  const text = combinedText || baseText || label || "";

  const hasCoords =
    typeof stop.lat === "number" && typeof stop.lng === "number";
  return {
    bookingPriority: 9,
    coordinate: hasCoords
      ? { latitude: stop.lat, longitude: stop.lng }
      : null,
    id: "-1",
    isCustom: true,
    postCode: stop.postCode || "",
    source: "Custom",
    street: text,
    text,
    town: stop.town || "Plymouth",
    zoneId: null
  };
}

function makeDerrifordAutocabAddress() {
  return {
    bookingPriority: 0,
    coordinate: { latitude: DH_LAT, longitude: DH_LNG },
    id: "-1",
    isCustom: false,
    postCode: DERRIFORD_POSTCODE,
    source: "Custom",
    street: "Derriford Hospital, Derriford Road",
    text: DERRIFORD_TEXT,
    town: "Plymouth",
    zoneId: null
  };
}

function mapCapacityToCapabilities(cap) {
  const n = Number(cap) || 4;
  switch (n) {
    case 4: return [27];
    case 5: return [22];
    case 6: return [4];
    case 7: return [20];
    case 8: return [5];
    case 19: return [27];
    default: return [27];
  }
}

app.post("/api/autocab/book-smartpack", async (req, res) => {
  try {
    const { date, time, passengers, vehicleCapacity, stops, meta } =
      req.body || {};
    if (!date || !time || !Array.isArray(stops) || !stops.length) {
      return res
        .status(400)
        .json({ error: "Missing date, time or stops" });
    }

    const dtLocal = new Date(`${date}T${time}:00`);
    if (isNaN(dtLocal.getTime())) {
      return res.status(400).json({ error: "Invalid date/time" });
    }
    const iso = dtLocal.toISOString();

    const shiftType = (meta?.shiftType || "").toLowerCase(); // "start" or "finish"
    const derrifordAddr = makeDerrifordAutocabAddress();

    let pickupAddress, destinationAddress, viaStops;
    let pickupStop = null;
    let destStop = null;

    if (shiftType === "start") {
      pickupStop = stops[0];
      viaStops = stops.slice(1);
      pickupAddress = mapSmartStopToAutocabAddress(pickupStop);
      destinationAddress = derrifordAddr;
    } else if (shiftType === "finish") {
      destStop = stops[stops.length - 1];
      viaStops = stops.slice(0, -1);
      pickupAddress = derrifordAddr;
      destinationAddress = mapSmartStopToAutocabAddress(destStop);
    } else {
      pickupStop = stops[0];
      destStop = stops[stops.length - 1];
      viaStops = stops.slice(1, -1);
      pickupAddress = mapSmartStopToAutocabAddress(pickupStop);
      destinationAddress = mapSmartStopToAutocabAddress(destStop);
    }

    const capabilities = mapCapacityToCapabilities(vehicleCapacity);

    const payload = {
      capabilities,
      companyId: Number(AUTOCAB_COMPANY_ID),
      customerId: DERRIFORD_CUSTOMER_ID,
      customerEmail: "",
      driverConstraints: {
        forbiddenDrivers: [],
        requestedDrivers: []
      },
      vehicleConstraints: {
        forbiddenVehicles: [],
        requestedVehicles: []
      },
      driverNote: meta?.bucketLabel
        ? `SmartPack ${meta.bucketLabel}`
        : "SmartPack booking",
      officeNote: meta?.shiftType ? `Shift type: ${meta.shiftType}` : "",
      name: "Derriford Staff Taxi",
      passengers: String(passengers || stops.length),
      luggage: 0,
      telephoneNumber: "",
      ourReference: meta?.bucketLabel || "",
      pickup: {
        address: pickupAddress,
        note: buildSmartStopNote(pickupStop),
        passengerDetailsIndex: null,
        type: "Pickup"
      },
      vias: viaStops.map((v) => ({
        address: mapSmartStopToAutocabAddress(v),
        note: buildSmartStopNote(v),
        passengerDetailsIndex: null,
        type: "Via"
      })),
      destination: {
        address: destinationAddress,
        note: buildSmartStopNote(destStop),
        passengerDetailsIndex: null,
        type: "Destination"
      },
      pickupDueTime: iso,
      pickupDueTimeUtc: iso,
      priority: 9,
      priorityOverride: true,
      yourReferences: {
        yourReference1: shiftType || "",
        yourReference2: ""
      },
      hold: false
    };

    if (!AUTOCAB_SUBSCRIPTION_KEY) {
      return res.status(500).json({ error: "Autocab key not configured" });
    }

    const apiRes = await fetch(AUTOCAB_BOOKING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": AUTOCAB_SUBSCRIPTION_KEY
      },
      body: JSON.stringify(payload)
    });

    const body = await apiRes.json().catch(() => ({}));

    if (!apiRes.ok) {
      console.error("Autocab booking failed:", apiRes.status, body);
      return res.status(apiRes.status).json({
        error: "Autocab booking failed",
        details: body
      });
    }

    return res.json({
      ok: true,
      message: "Smart Pack booking created in Autocab.",
      bookingResponse: body
    });
  } catch (err) {
    console.error("Error in /api/autocab/book-smartpack:", err);
    res
      .status(500)
      .json({ error: "Server error while creating booking" });
  }
});

const listenPort = Number(PORT) || 4000;
app.listen(listenPort, () =>
  console.log(`🚖 API + UI running at http://localhost:${listenPort}`)
);
