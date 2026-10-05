/**
 * One-off, idempotent backfill: links every existing completed mobile-inspect
 * visit to the previous completed visit of the same observation, so any visit
 * can be compared with the one before it. New visits get this automatically.
 *
 *   node scripts/backfill-previous-visits.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const InferenceJob = require('../models/InferenceJob');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/visiondb');

  const jobs = await InferenceJob.find({
    sourceType: 'custom_folder',
    status: 'completed',
    observationId: { $nin: [null, ''] },
  })
    .select('inferenceId company project observationId createdAt previousInferenceId')
    .sort({ createdAt: 1 })
    .lean();

  const lastByObservation = new Map();
  let linked = 0;
  for (const job of jobs) {
    const key = `${job.company}\u0000${job.project}\u0000${job.observationId}`;
    const previous = lastByObservation.get(key);
    if (previous && !job.previousInferenceId) {
      await InferenceJob.updateOne({ inferenceId: job.inferenceId }, { $set: { previousInferenceId: previous } });
      linked += 1;
    }
    lastByObservation.set(key, job.inferenceId);
  }

  console.log(`Done. ${linked} visit(s) linked to their previous visit.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
