// models/BookingLog.js
const mongoose = require("mongoose");

const BookingLogSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", index: true, required: true },
    action:    { type: String, required: true }, // approved | declined | updated | cancelled | created | text-sent
    actor:     { type: String, default: "" },
    role:      { type: String, default: "" },    // Admin, Budget approver, System
    source:    { type: String, default: "" },    // admin | budget-portal | staff-update | sms | system
    note:      { type: String, default: "" },
    diff:      { type: Object, default: null },  // { field: { from, to }, ... }
    at:        { type: Date, default: Date.now }
  },
  { timestamps: false }
);

module.exports = mongoose.model("BookingLog", BookingLogSchema);
