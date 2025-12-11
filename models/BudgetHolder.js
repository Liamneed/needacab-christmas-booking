import mongoose from "mongoose";

const BudgetHolderSchema = new mongoose.Schema(
  {
    budgetNumber: { type: String, required: true, unique: true, index: true },
    pin: { type: String, required: true },          // NOTE: plain text for MVP
    holderName: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Default pluralised collection name will be "budgetholders" (matches your seeded doc)
export default mongoose.models.BudgetHolder
  || mongoose.model("BudgetHolder", BudgetHolderSchema);
