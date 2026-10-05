/**
 * One-off, idempotent backfill for observations:
 *  - gives every existing mobile-inspect job (and action item) an observationId
 *    based on its area (treated as a whole-area observation, no component), and
 *  - fills in inspectorName from the stored createdBy user id.
 *
 * Observation numbers (OBS-0001...) are minted in order of each area's first
 * inspection so they follow the vessel's history. Safe to re-run.
 *
 *   node scripts/backfill-observations.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const InferenceJob = require('../models/InferenceJob');
const ActionItem = require('../models/ActionItem');
const { findOrCreateObservation } = require('../utils/observationService');
const { getUserProfile } = require('../services/supabaseService');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/visiondb');

  const jobs = await InferenceJob.find({
    sourceType: 'custom_folder',
    regionName: { $nin: [null, ''] },
    $or: [{ observationId: null }, { observationId: { $exists: false } }],
  })
    .select('company project regionName createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const seen = new Set();
  let observationsTouched = 0;
  for (const job of jobs) {
    const key = `${job.company}\u0000${job.project}\u0000${job.regionName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const observation = await findOrCreateObservation({
      company: job.company,
      project: job.project,
      regionName: job.regionName,
      componentName: '',
    });
    const res = await InferenceJob.updateMany(
      {
        company: job.company,
        project: job.project,
        regionName: job.regionName,
        sourceType: 'custom_folder',
        $or: [{ observationId: null }, { observationId: { $exists: false } }],
      },
      { $set: { observationId: observation.observationId, componentName: '' } }
    );
    await ActionItem.updateMany(
      {
        company: job.company,
        project: job.project,
        regionName: job.regionName,
        $or: [{ observationId: null }, { observationId: { $exists: false } }],
      },
      { $set: { observationId: observation.observationId } }
    );
    observationsTouched += 1;
    console.log(`${observation.observationId}  ${job.project} / ${job.regionName}  (${res.modifiedCount} job(s))`);
  }

  // Inspector emails for jobs that only have a user id.
  const needInspector = await InferenceJob.find({
    sourceType: 'custom_folder',
    createdBy: { $ne: null },
    $or: [{ inspectorName: null }, { inspectorName: { $exists: false } }],
  })
    .select('createdBy')
    .lean();
  const userIds = [...new Set(needInspector.map((j) => j.createdBy))];
  let inspectorsFilled = 0;
  for (const userId of userIds) {
    const profile = await getUserProfile(userId);
    if (!profile?.email) continue;
    const res = await InferenceJob.updateMany(
      { createdBy: userId, $or: [{ inspectorName: null }, { inspectorName: { $exists: false } }] },
      { $set: { inspectorName: profile.email } }
    );
    inspectorsFilled += res.modifiedCount;
  }

  console.log(`Done. ${observationsTouched} area(s) assigned an observation, ${inspectorsFilled} job(s) got an inspector.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
