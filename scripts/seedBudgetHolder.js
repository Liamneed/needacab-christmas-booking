// scripts/seedBudgetHolder.js
import "dotenv/config";
import mongoose from "mongoose";
import BudgetHolder from "../models/BudgetHolder.js";

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI missing in .env");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const seed = {
    budgetNumber: "BUDGET-123",
    pin: "4321",
    holderName: "Budget Holder (Local)",
    active: true,
  };

  const doc = await BudgetHolder.findOneAndUpdate(
    { budgetNumber: seed.budgetNumber },
    seed,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  console.log("Seeded/updated:", {
    budgetNumber: doc.budgetNumber,
    pin: seed.pin,
    holderName: doc.holderName,
  });

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
