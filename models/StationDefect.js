const mongoose = require('mongoose');

/**
 * StationDefect — one NOT_OK defect log entry (with annotated snapshot) from a StationRun.
 * `clientDefectId` is the station's local id and makes uploads idempotent.
 */
const stationDefectSchema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'StationRun', required: true, index: true },
    clientDefectId: { type: String, required: true, unique: true },
    company: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true },
    verdict: { type: String, enum: ['NOT_OK'], default: 'NOT_OK' },
    defectClasses: { type: [String], default: [] },
    imagePath: { type: String, required: true },
  },
  { timestamps: true }
);

stationDefectSchema.index({ run: 1, timestamp: 1 });

module.exports = mongoose.model('StationDefect', stationDefectSchema);
