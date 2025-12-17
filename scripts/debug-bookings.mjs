import dotenv from "dotenv";
import mongoose from "mongoose";
dotenv.config();

const { MONGODB_URI } = process.env;
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI");

await mongoose.connect(MONGODB_URI);

const Booking = (await import("../models/Booking.js")).default;

const total = await Booking.countDocuments();
const withBudget = await Booking.countDocuments({ budgetNumber: { $exists: true, $ne: null } });
const sample = await Booking.findOne({}, { budgetNumber: 1, budgetHolderName: 1 }).lean();

const distinctBudgets = await Booking.distinct("budgetNumber");

console.log({ total, withBudget, sample, distinctBudgets: distinctBudgets.slice(0, 20) });

await mongoose.disconnect();
