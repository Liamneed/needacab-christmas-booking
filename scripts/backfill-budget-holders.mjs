import dotenv from "dotenv";
import mongoose from "mongoose";
import crypto from "crypto";
import bcrypt from "bcrypt";
dotenv.config();

const { MONGODB_URI } = process.env;
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI");

await mongoose.connect(MONGODB_URI);

// Use your real Booking model (so we hit the right collection/fields)
const Booking = (await import("../models/Booking.js")).default;

// Lightweight BudgetHolder model (matches routes/budget expectations)
const budgetHolderSchema = new mongoose.Schema(
  {
    budgetNumber: { type: String, unique: true, index: true },
    holderName: String,
    active: { type: Boolean, default: true },
    pin: String,         // if your router uses plaintext (dev)
    hashedPin: String,   // if your router uses bcrypt (prod)
  },
  { collection: "budget_holders" }
);
const BudgetHolder = mongoose.model("BudgetHolder", budgetHolderSchema);

function toBudgetString(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  // accept 6-digit only; relax if your data has other formats:
  return s; // keep as-is; server validates 6 digits on create anyway
}

function randomPin(digits = 6) {
  const n = crypto.randomInt(0, 10 ** digits);
  return String(n).padStart(digits, "0");
}

async function main() {
  // Pull only the fields we need
  const rows = await Booking.find(
    { budgetNumber: { $exists: true, $ne: null } },
    { budgetNumber: 1, budgetHolderName: 1 }
  ).lean();

  // Map: budgetNumber(string) -> name frequency map
  const byBudget = new Map();
  for (const r of rows) {
    const bn = toBudgetString(r.budgetNumber);
    if (!bn) continue;

    const name = (r.budgetHolderName || "").toString().trim();
    if (!byBudget.has(bn)) byBudget.set(bn, new Map());
    const nameMap = byBudget.get(bn);
    const key = name || "(Unknown)";
    nameMap.set(key, (nameMap.get(key) || 0) + 1);
  }

  if (byBudget.size === 0) {
    console.log("budgetNumber,holderName,pin");
    console.error("No bookings with budgetNumber found.");
    await mongoose.disconnect();
    return;
  }

  // Do we use hashedPin or pin?
  const sample = await BudgetHolder.findOne().lean();
  const USE_HASH = sample?.hashedPin !== undefined || sample?.pin === undefined;

  const out = [];
  for (const [budgetNumber, nameMap] of byBudget.entries()) {
    // pick most frequent holderName (or first entry)
    let holderName = "(Unknown)";
    let max = -1;
    for (const [n, c] of nameMap.entries()) {
      if (c > max) { max = c; holderName = n; }
    }

    let doc = await BudgetHolder.findOne({ budgetNumber });
    if (!doc) doc = new BudgetHolder({ budgetNumber });

    // Set name if empty
    if (!doc.holderName) doc.holderName = holderName;
    if (doc.active === undefined) doc.active = true;

    // Assign PIN only if missing
    let plainPin = null;
    if (USE_HASH) {
      if (!doc.hashedPin) {
        plainPin = randomPin(6);
        doc.hashedPin = await bcrypt.hash(plainPin, 10);
      }
    } else {
      if (!doc.pin) {
        plainPin = randomPin(6);
        doc.pin = plainPin;
      }
    }

    await doc.save();

    out.push({
      budgetNumber,
      holderName: doc.holderName,
      pin: plainPin || (USE_HASH ? "(kept existing hashed PIN)" : "(kept existing PIN)")
    });
  }

  // CSV to stdout
  console.log("budgetNumber,holderName,pin");
  for (const r of out) {
    console.log(`${r.budgetNumber},"${(r.holderName || "").replace(/"/g, '""')}",${r.pin}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error("❌ Backfill failed:", e); process.exit(1); });
