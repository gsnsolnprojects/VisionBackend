const mongoose = require('mongoose');

/**
 * Observation — one specific spot on a vessel that gets re-inspected over
 * time, identified by area + optional component (e.g. "Engine room" /
 * "Fuel pump"). The observationId (OBS-0001, ...) is assigned automatically
 * the first time a spot is captured and re-used whenever the same area +
 * component is captured again, so its photo history links up without anyone
 * managing IDs by hand.
 *
 * Scoped by plain `company`/`project` strings (one project = one vessel),
 * same denormalized pattern as InferenceJob/ActionItem.
 */
const observationSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, index: true },
    project: { type: String, required: true, index: true },

    observationId: { type: String, required: true },

    regionName: { type: String, required: true },
    componentName: { type: String, default: '' },

    // Normalized (trimmed, lower-cased, collapsed whitespace) so "Fuel pump"
    // and " fuel  PUMP " resolve to the same observation.
    regionKey: { type: String, required: true },
    componentKey: { type: String, default: '' },

    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

observationSchema.index({ company: 1, project: 1, observationId: 1 }, { unique: true });
observationSchema.index({ company: 1, project: 1, regionKey: 1, componentKey: 1 }, { unique: true });

module.exports = mongoose.model('Observation', observationSchema);
