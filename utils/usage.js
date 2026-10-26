const TrainingJob = require('../models/TrainingJob');
const InferenceJob = require('../models/InferenceJob');
const Dataset = require('../models/Dataset');
const UsageCarryover = require('../models/UsageCarryover');

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
    TrainingJob.countDocuments({ company, createdAt: { $gte: startOfMonthIST() }, status: NOT_WASTED }),
    carriedOver(company),
  ]);
  return live + (kept.trainingRuns || 0);
}

/** Images sent for prediction this month (a batch of 20 images counts as 20) */
async function countPredictionsThisMonth(company) {
  const [[row], kept] = await Promise.all([
    InferenceJob.aggregate([
      { $match: { company, createdAt: { $gte: startOfMonthIST() }, status: NOT_WASTED } },
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
    if (!job?.company || WASTED.has(job.status) || !amount) return;
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

/** The company's own datasets (GSN sample links don't count) */
const ownDatasetFilter = (company) => ({ company, deletedAt: null, linkedFrom: null });

/** Images stored in the company's own datasets */
async function countStoredImages(company) {
  const [row] = await Dataset.aggregate([
    { $match: ownDatasetFilter(company) },
    { $group: { _id: null, images: { $sum: { $ifNull: ['$totalImages', 0] } } } },
  ]);
  return row?.images ?? 0;
}

module.exports = {
  startOfMonthIST,
  monthKeyIST,
  keepDeletedUsage,
  countTrainingRunsThisMonth,
  countPredictionsThisMonth,
  countStoredImages,
  ownDatasetFilter,
};
