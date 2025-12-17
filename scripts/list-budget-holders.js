import dotenv from "dotenv";
import mongoose from "mongoose";
dotenv.config();

const BudgetHolderSchema = new mongoose.Schema(
  { budgetNumber: String, pin: String, holderName: String, active: Boolean },
  { collection: "budget_holders" }
);
const BudgetHolder = mongoose.models.BudgetHolder || mongoose.model("BudgetHolder", BudgetHolderSchema);

await mongoose.connect(process.env.MONGODB_URI);
const docs = await BudgetHolder.find().select("-__v").lean();
console.table(docs.map(d => ({
  id: String(d._id),
  budgetNumber: d.budgetNumber,
  pin: d.pin,
  holderName: d.holderName,
  active: d.active
})));
await mongoose.disconnect();
process.exit(0);
