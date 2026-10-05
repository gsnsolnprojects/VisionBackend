const mongoose = require('mongoose');

/** Per-vessel running number used to mint observation IDs (OBS-0001, OBS-0002, ...). */
const observationCounterSchema = new mongoose.Schema({
  company: { type: String, required: true },
  project: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

observationCounterSchema.index({ company: 1, project: 1 }, { unique: true });

module.exports = mongoose.model('ObservationCounter', observationCounterSchema);
