import mongoose from "mongoose";

const AddressSchema = new mongoose.Schema(
  {
    placeId: { type: String },
    formatted: { type: String, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    zone: { id: String, name: String },
  },
  { _id: false }
);

const BookingSchema = new mongoose.Schema(
  {
    wardName: { type: String, required: true },
    wardPhone: { type: String, required: true },
    staffName: { type: String, required: true },
    staffPhone: { type: String, required: true },

    shiftType: { type: String, enum: ["start", "finish"], required: true },
    onOffDutyTime: { type: String, required: true },    // 'HH:mm'
    pickupDateISO: { type: String, required: true },    // 'YYYY-MM-DD'

    pickup: { type: AddressSchema, required: true },
    destination: { type: AddressSchema, required: true },

    requireReturn: { type: Boolean, default: false },
    returnDateISO: { type: String },

    reasonCode: { type: String, required: true },
    budgetNumber: { type: String, required: true },
    budgetHolderName: { type: String, required: true },
    budgetHolderSignatureDataURL: { type: String, required: false },

    // NEW
    status: { type: String, enum: ["pending", "approved", "declined"], default: "pending", index: true },
    shortRef: { type: String, index: true },   // e.g. NAC001 (unique via partial index below)
    declineReason: { type: String },

    isReturn: { type: Boolean, default: false },
    reference: { type: String, required: true }, // your existing customer ref stays
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "derriford_staff_bookings" }
);

// ---- Indexes ----
// Make shortRef unique only when present, so legacy rows without shortRef don't block index creation
BookingSchema.index({ shortRef: 1 }, { unique: true, partialFilterExpression: { shortRef: { $type: "string" } } });
// Helpful query indexes (lightweight; safe to keep)
BookingSchema.index({ pickupDateISO: 1, onOffDutyTime: 1 });
BookingSchema.index({ reference: 1 });
BookingSchema.index({ "pickup.zone.name": 1 });
BookingSchema.index({ "destination.zone.name": 1 });
BookingSchema.index({ createdAt: -1 });

export default mongoose.model("Booking", BookingSchema);
