const TrainingJob = require('../models/TrainingJob');
const InferenceJob = require('../models/InferenceJob');
const Dataset = require('../models/Dataset');

/**
 * Plan usage counts for a company, used by the monthly allowances (Playground: 5 training
 * runs and 1,000 image predictions a month) and the overview's allowance meters.
 *
 * Months follow India time. Failed or cancelled training runs and predictions don't use up
 * the allowance.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Start of the current calendar month in India time (IST, UTC+5:30), as a Date */
function startOfMonthIST(now = Date.now()) {
  const nowIST = new Date(now + IST_OFFSET_MS);
  return new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), 1) - IST_OFFSET_MS);
}

const NOT_WASTED = { $nin: ['failed', 'cancelled'] };

/** Training runs started this month */
function countTrainingRunsThisMonth(company) {
  return TrainingJob.countDocuments({ company, createdAt: { $gte: startOfMonthIST() }, status: NOT_WASTED });
}

/** Images sent for prediction this month (a batch of 20 images counts as 20) */
async function countPredictionsThisMonth(company) {
  const [row] = await InferenceJob.aggregate([
    { $match: { company, createdAt: { $gte: startOfMonthIST() }, status: NOT_WASTED } },
    { $group: { _id: null, images: { $sum: { $ifNull: ['$progress.totalImages', 0] } } } },
  ]);
  return row?.images ?? 0;
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
  countTrainingRunsThisMonth,
  countPredictionsThisMonth,
  countStoredImages,
  ownDatasetFilter,
};
