import mongoose from "mongoose";

const AddressSchema = new mongoose.Schema(
  {
    placeId: { type: String },

    // Core display fields
    formatted: { type: String, required: true }, // full address string
    text: { type: String }, // short text / label

    // Components (optional – filled by frontend/normaliser where available)
    houseNumber: { type: String },
    street: { type: String },
    town: { type: String },
    postCode: { type: String },

    // Coordinates (required)
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },

    // Zone info from Autocab
    zone: {
      id: { type: String },
      name: { type: String }
    }
  },
  { _id: false }
);

const AuditEntrySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },

    // Who/what made the change
    actorType: {
      type: String,
      enum: ["staff", "admin", "system"],
      default: "staff"
    },
    source: {
      type: String, // e.g. "sms-link", "admin-dashboard", "import"
      default: "sms-link"
    },

    // What happened
    action: {
      type: String,
      enum: [
        "booking-created",
        "customer-confirmed",
        "customer-updated",
        "customer-cancelled",
        "status-changed",
        "sms-sent"
      ]
    },

    // Optional status change info
    oldStatus: { type: String },
    newStatus: { type: String },

    // Free-form detail object (before/after values, notes, etc.)
    details: { type: mongoose.Schema.Types.Mixed }
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
    onOffDutyTime: { type: String, required: true }, // 'HH:mm'
    pickupDateISO: { type: String, required: true }, // 'YYYY-MM-DD'

    pickup: { type: AddressSchema, required: true },
    destination: { type: AddressSchema, required: true },

    requireReturn: { type: Boolean, default: false },
    returnDateISO: { type: String },

    reasonCode: { type: String, required: true },
    budgetNumber: { type: String, required: true },
    budgetHolderName: { type: String, required: true },
    budgetHolderSignatureDataURL: { type: String, required: false },

    // Status of booking from admin perspective
    status: {
      type: String,
      enum: ["pending", "approved", "declined"],
      default: "pending",
      index: true
    },

    // shortRef (e.g. NAC001) – unique via partial index below
    shortRef: { type: String },

    declineReason: { type: String },

    // Manual flags (for admin-only notes / flags)
    manualFlagLabel: { type: String }, // e.g. "Wrong date/time"
    manualFlagReason: { type: String }, // free text notes

    isReturn: { type: Boolean, default: false },

    // Your existing combined customer ref (reason/budget/name)
    reference: { type: String, required: true },

    createdAt: { type: Date, default: Date.now },

    // ===== Staff / customer change tracking (used by server.js) =====

    // Confirmed via staff link
    confirmedByStaffAt: { type: Date },
    confirmedByStaffSource: { type: String }, // e.g. "staff-link"

    // Updated via staff link (or other customer-facing path)
    updatedByStaffAt: { type: Date },
    updatedByStaffSource: { type: String }, // e.g. "staff-link"
    updatedByStaffSummary: { type: String }, // short summary shown in admin UI

    // Cancelled via staff link (server currently sets these)
    cancelledByStaffAt: { type: Date },
    cancelledByStaffReason: { type: String },
    cancelledByStaffSource: { type: String }, // e.g. "staff-link"

    // ===== Optional higher-level summary fields =====
    // (not yet written by server.js, but here if you want to use later)

    lastCustomerAction: {
      type: String,
      enum: ["confirmed", "updated", "cancelled", ""],
      default: ""
    },
    lastCustomerActionAt: { type: Date },
    lastCustomerActionSource: {
      type: String, // e.g. "sms-link", "admin-dashboard", "phone-call"
      default: "sms-link"
    },
    lastCustomerActionSummary: { type: String },

    // Alternative cancellation flags if you ever want them
    cancelled: { type: Boolean, default: false },
    cancelledBy: {
      type: String,
      enum: ["staff-link", "admin", "system", ""],
      default: ""
    },
    cancelledAt: { type: Date },
    cancelReason: { type: String },
    // Optional alias if you ever want to store a generic cancelledReason
    cancelledReason: { type: String },

    // ===== SMS tracking (used by /send-sms and bookings UI) =====
    lastSmsAt: { type: Date },
    lastSmsSource: { type: String },   // e.g. "derr-bookings", "derr-bookings-bulk"
    lastSmsPurpose: { type: String },  // e.g. "booking-confirmation", "flagged-alert"
    lastSmsMessagePreview: { type: String },
    smsCount: { type: Number, default: 0 },

    // Full audit trail for accurate logs
    auditLog: { type: [AuditEntrySchema], default: [] }
  },
  { collection: "derriford_staff_bookings" }
);

// ---- Indexes ----

// Make shortRef unique only when present, so legacy rows without shortRef don't block index creation
BookingSchema.index(
  { shortRef: 1 },
  { unique: true, partialFilterExpression: { shortRef: { $type: "string" } } }
);

// Helpful query indexes (lightweight; safe to keep)
BookingSchema.index({ pickupDateISO: 1, onOffDutyTime: 1 });
BookingSchema.index({ reference: 1 });
BookingSchema.index({ "pickup.zone.name": 1 });
BookingSchema.index({ "destination.zone.name": 1 });
BookingSchema.index({ createdAt: -1 });

// Optional helpful indexes for new fields (you can keep or remove)
BookingSchema.index({ lastCustomerActionAt: -1 });
BookingSchema.index({ cancelled: 1 });

export default mongoose.model("Booking", BookingSchema);
