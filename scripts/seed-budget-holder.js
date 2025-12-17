import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const { MONGODB_URI } = process.env;
if (!MONGODB_URI) {
  console.error("❌ Missing MONGODB_URI in .env");
  process.exit(1);
}

// Schema: simple MVP (plain-text PIN)
const BudgetHolderSchema = new mongoose.Schema(
  {
    budgetNumber: { type: String, required: true, unique: true, index: true },
    pin: { type: String, required: true },      // MVP: plain text
    holderName: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { collection: "budget_holders", timestamps: true }
);

const BudgetHolder =
  mongoose.models.BudgetHolder ||
  mongoose.model("BudgetHolder", BudgetHolderSchema);

async function main() {
  await mongoose.connect(MONGODB_URI);

  // 👇 Change these values if you want different login details
  const seed = {
    budgetNumber: "123456",
    pin: "1234",
    holderName: "Jane Smith",
    active: true,
  };

  const doc = await BudgetHolder.findOneAndUpdate(
    { budgetNumber: seed.budgetNumber },
    { $set: seed },
    { upsert: true, new: true }
  ).lean();

  console.log("✅ Seeded/updated budget holder:");
  console.log({
    budgetNumber: doc.budgetNumber,
    pin: seed.pin,
    holderName: doc.holderName,
    active: doc.active,
    _id: String(doc._id),
  });

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seeding failed:", err);
  process.exit(1);
});
