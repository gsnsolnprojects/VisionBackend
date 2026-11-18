const TrainingJob = require('../models/TrainingJob');
const InferenceJob = require('../models/InferenceJob');
const Dataset = require('../models/Dataset');
const UsageCarryover = require('../models/UsageCarryover');
const UsageRecord = require('../models/UsageRecord');
const AuditLog = require('../models/AuditLog');

/**
 * Plan usage counts for a company, used by the monthly allowances (Playground: 5 training
 * runs and 1,000 image predictions a month) and the overview's allowance meters.
 *
 * Months follow India time. Failed or cancelled training runs and predictions don't use up
 * the allowance. Deleted runs still count: keepDeletedUsage() saves them in UsageCarryover
 * before they're deleted.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Start of the current calendar month in India time (IST, UTC+5:30), as a Date */
function startOfMonthIST(now = Date.now()) {
  const nowIST = new Date(now + IST_OFFSET_MS);
  return new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), 1) - IST_OFFSET_MS);
}

const NOT_WASTED = { $nin: ['failed', 'cancelled'] };
const WASTED = new Set(['failed', 'cancelled']);
/** Training runs that count: not failed or cancelled, or cancelled after the GPU could have started */
const COUNTED_RUN = { $or: [{ status: NOT_WASTED }, { status: 'cancelled', cancelCountsAsRun: true }] };

/** "YYYY-MM" of a date's month in India time */
function monthKeyIST(date = Date.now()) {
  return new Date(new Date(date).getTime() + IST_OFFSET_MS).toISOString().slice(0, 7);
}

/** Usage kept from this month's deleted runs */
async function carriedOver(company) {
  const row = await UsageCarryover.findOne({ company, month: monthKeyIST() }).lean();
  return row || { trainingRuns: 0, predictions: 0 };
}

/** Training runs started this month */
async function countTrainingRunsThisMonth(company) {
  const [live, kept] = await Promise.all([
    TrainingJob.countDocuments({ company, createdAt: { $gte: startOfMonthIST() }, ...COUNTED_RUN }),
    carriedOver(company),
  ]);
  return live + (kept.trainingRuns || 0);
}

/** Images sent for prediction this month (a batch of 20 images counts as 20) */
async function countPredictionsThisMonth(company) {
  const [[row], kept] = await Promise.all([
    InferenceJob.aggregate([
      { $match: { company, createdAt: { $gte: startOfMonthIST() }, status: NOT_WASTED, purpose: { $nin: ['practice', 'learning'] } } },
      { $group: { _id: null, images: { $sum: { $ifNull: ['$progress.totalImages', 0] } } } },
    ]),
    carriedOver(company),
  ]);
  return (row?.images ?? 0) + (kept.predictions || 0);
}

/**
 * Call before deleting training or inference jobs: adds the ones that used up an allowance to
 * their company's carry-over for the month they ran in.
 * @param {{ trainingJobs?: object[], inferenceJobs?: object[] }} jobs need company, createdAt,
 *   status (and progress.totalImages for inference jobs)
 */
async function keepDeletedUsage({ trainingJobs = [], inferenceJobs = [] }) {
  const totals = new Map();
  const add = (job, field, amount) => {
    if (!job?.company || (WASTED.has(job.status) && !(field === 'trainingRuns' && job.cancelCountsAsRun)) || !amount) return;
    const key = `${job.company}\u0000${monthKeyIST(job.createdAt || Date.now())}`;
    const row = totals.get(key) || { trainingRuns: 0, predictions: 0 };
    row[field] += amount;
    totals.set(key, row);
  };
  trainingJobs.forEach((job) => add(job, 'trainingRuns', 1));
  inferenceJobs.forEach((job) => add(job, 'predictions', job.progress?.totalImages || 0));

  for (const [key, inc] of totals) {
    const [company, month] = key.split('\u0000');
    await UsageCarryover.updateOne({ company, month }, { $inc: inc }, { upsert: true });
  }
}

/**
 * Call before deleting training or inference jobs, with the whole job documents: keeps a copy in
 * UsageRecord so Settings -> Usage still lists them (marked deleted), with who started them.
 * @param {{ trainingJobs?: object[], inferenceJobs?: object[] }} jobs
 */
async function keepUsageHistory({ trainingJobs = [], inferenceJobs = [] }) {
  const rows = [
    ...trainingJobs.map((job) => ({ kind: 'training', refId: job.jobId, job })),
    ...inferenceJobs
      .filter((job) => !['live_camera', 'live'].includes(job.sourceType))
      .map((job) => ({ kind: 'inference', refId: job.inferenceId, job })),
  ].filter((r) => r.refId && r.job.company);
  if (!rows.length) return;

  const audits = await AuditLog.find({ resourceId: { $in: rows.map((r) => r.refId) }, action: { $in: ['execute', 'create'] } })
    .select('resourceId userId')
    .sort({ timestamp: 1 })
    .lean();
  const starter = new Map();
  for (const a of audits) if (!starter.has(a.resourceId)) starter.set(a.resourceId, a.userId);

  const deletedAt = new Date();
  await UsageRecord.bulkWrite(
    rows.map(({ kind, refId, job }) => {
      // Only what Usage shows: not the results, which can be large
      const { results, logs, metrics, ...data } = job;
      return {
        updateOne: {
          filter: { kind, refId },
          update: {
            $set: {
              company: job.company,
              project: job.project || null,
              userId: starter.get(refId) || (job.createdBy ? String(job.createdBy) : null),
              at: job.createdAt || deletedAt,
              data: { ...data, progress: job.progress ? { totalImages: job.progress.totalImages } : undefined },
              deletedAt,
            },
          },
          upsert: true,
        },
      };
    })
  );
}

/**
 * The company's own datasets. Not counted: GSN sample links, samples it labels itself, and
 * augmented versions (extra training photos made from one of its datasets).
 */
const ownDatasetFilter = (company) => ({
  company,
  deletedAt: null,
  linkedFrom: null,
  labelledSampleOf: null,
  isAugmented: { $ne: true },
});

/** Images stored in the company's own datasets */
async function countStoredImages(company) {
  const [row] = await Dataset.aggregate([
    // Extra training photos (augmented versions) are files on disk too, so they count here
    { $match: { ...ownDatasetFilter(company), isAugmented: { $in: [true, false, null] } } },
    { $group: { _id: null, images: { $sum: { $ifNull: ['$totalImages', 0] } } } },
  ]);
  return row?.images ?? 0;
}

module.exports = {
  startOfMonthIST,
  monthKeyIST,
  keepDeletedUsage,
  keepUsageHistory,
  countTrainingRunsThisMonth,
  countPredictionsThisMonth,
  countStoredImages,
  ownDatasetFilter,
};
