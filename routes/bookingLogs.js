// routes/bookingLogs.js
const express = require("express");
const router = express.Router({ mergeParams: true });
const BookingLog = require("../models/BookingLog");

// GET /api/bookings/:id/logs  -> newest first
router.get("/", async (req, res) => {
  const { id } = req.params;
  const items = await BookingLog.find({ bookingId: id }).sort({ at: -1 }).lean();
  res.json({ items });
});

// POST /api/bookings/:id/logs -> append one log (optional helper)
router.post("/", async (req, res) => {
  const { id } = req.params;
  const { action, actor = "", role = "", source = "", note = "", diff = null, at = new Date() } = req.body || {};
  if (!action) return res.status(400).json({ error: "action is required" });

  const created = await BookingLog.create({ bookingId: id, action, actor, role, source, note, diff, at });
  res.status(201).json({ ok: true, item: created });
});

module.exports = router;
