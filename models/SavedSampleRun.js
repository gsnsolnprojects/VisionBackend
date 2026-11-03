const mongoose = require('mongoose');

/**
 * A finished run of GSN's model on a GSN sample's photos, kept so later students get the same real
 * results at once instead of running the model again (services/sampleRunService.js).
 */
const savedSampleRunSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    folder: { type: String, required: true },
    results: { type: mongoose.Schema.Types.Mixed, required: true },
    totalImages: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SavedSampleRun', savedSampleRunSchema);
