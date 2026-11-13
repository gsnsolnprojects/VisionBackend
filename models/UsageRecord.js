const mongoose = require('mongoose');

/**
 * Settings -> Usage history that outlives what it describes. Two kinds of row:
 *  - 'training' / 'inference': a copy of a job, saved just before the job is deleted (one test, or a
 *    whole project), so Usage still lists it, marked deleted. `data` holds the job's fields.
 *  - 'more-photos': a customer's set of extra training photos. Those go into their own dataset
 *    (no new dataset to list), so the run is recorded here as it starts and updated when it ends.
 * `at` is when the work started, which decides the month it belongs to.
 */
const usageRecordSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['training', 'inference', 'more-photos'], required: true },
    refId: { type: String, required: true },
    company: { type: String, required: true },
    project: { type: String, default: null },
    userId: { type: String, default: null },
    at: { type: Date, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

usageRecordSchema.index({ kind: 1, refId: 1 }, { unique: true });
usageRecordSchema.index({ company: 1, at: 1 });

module.exports = mongoose.model('UsageRecord', usageRecordSchema);
