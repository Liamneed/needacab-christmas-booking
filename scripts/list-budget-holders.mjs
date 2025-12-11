import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const { MONGODB_URI } = process.env;

const budgetHolderSchema = new mongoose.Schema(
  {
    budgetNumber: String,
    holderName: String,
    active: Boolean,
    pin: String,
    hashedPin: String,
  },
  { collection: "budget_holders" }
);

const BudgetHolder = mongoose.model("BudgetHolder", budgetHolderSchema);

async function main() {
  await mongoose.connect(MONGODB_URI);
  const docs = await BudgetHolder.find().sort({ budgetNumber: 1 }).lean();
  console.table(
    docs.map(d => ({
      budgetNumber: d.budgetNumber,
      holderName: d.holderName,
      active: d.active,
      hasPlainPin: d.pin ? "yes" : "no",
      hasHashedPin: d.hashedPin ? "yes" : "no",
    }))
  );
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
