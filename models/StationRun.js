const mongoose = require('mongoose');

/**
 * StationRun — one live inspection run from a Vision-M Station (Windows desktop app).
 *
 * The station runs inference locally and uploads the run here afterwards (and
 * periodically while it is live). `clientRunId` is the station's own run id and
 * makes uploads idempotent: re-sending a run updates it instead of duplicating.
 *
 * Scoped by plain `company`/`project` strings like InferenceJob.
 */
const stationRunSchema = new mongoose.Schema(
  {
    clientRunId: { type: String, required: true, unique: true, index: true },
    stationName: { type: String, default: null },
    name: { type: String, default: null, maxlength: 120 },
    notes: { type: String, default: null, maxlength: 2000 },

    company: { type: String, required: true, index: true },
    project: { type: String, default: null, index: true },
    projectId: { type: String, default: null },

    modelId: { type: String, default: null, index: true }, // Model.modelId
    modelName: { type: String, default: null },
    modelType: { type: String, default: null },
    cameraName: { type: String, default: null },

    status: { type: String, enum: ['running', 'completed', 'interrupted'], required: true },
    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, default: null },

    analytics: {
      totalProducts: { type: Number, default: 0 },
      goodProducts: { type: Number, default: 0 },
      badProducts: { type: Number, default: 0 },
      classCounts: { type: Map, of: Number, default: {} },
    },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    stats: { type: mongoose.Schema.Types.Mixed, default: {} },

    operator: {
      id: { type: String, default: null },
      email: { type: String, default: null },
      role: { type: String, default: null },
    },
    createdBy: { type: String, default: null },
    defectCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

stationRunSchema.index({ company: 1, project: 1, startedAt: -1 });

module.exports = mongoose.model('StationRun', stationRunSchema);
