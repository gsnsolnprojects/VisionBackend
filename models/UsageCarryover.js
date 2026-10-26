const mongoose = require('mongoose');

/**
 * Plan usage kept from training runs and predictions that were deleted (one test, or a whole
 * project), so deleting them doesn't give the monthly allowance back. One row per company per
 * month (India time, "YYYY-MM"); utils/usage.js adds it to the live counts.
 */
const usageCarryoverSchema = new mongoose.Schema(
  {
    company: { type: String, required: true },
    month: { type: String, required: true },
    trainingRuns: { type: Number, default: 0 },
    predictions: { type: Number, default: 0 },
  },
  { timestamps: true }
);

usageCarryoverSchema.index({ company: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('UsageCarryover', usageCarryoverSchema);
