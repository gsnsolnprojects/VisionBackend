const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const SavedSampleRun = require('../models/SavedSampleRun');

/**
 * Level 1's test and auto-label show the same photos to every student, so GSN's model only has to
 * run on them once. The first finished run is saved; later runs copy its real results, which takes
 * a moment instead of a minute on the server's CPU. Each student gets their own copy because
 * closing a test deletes its folder. Another model or other photos make another key.
 */

const SAVED_ROOT = path.join(process.cwd(), 'uploads', 'sample-runs');
const PATH_FIELDS = ['resultsPath', 'annotatedImagesPath', 'goodImagesPath', 'defectImagesPath', 'metadataPath'];

const sampleRunKey = ({ purpose, datasetId, modelId, confidence, fileIds }) =>
  crypto
    .createHash('sha256')
    .update([purpose, datasetId, modelId, confidence, ...[...fileIds].sort()].join('|'))
    .digest('hex')
    .slice(0, 32);

/** The results with their paths moved from one folder to another */
function moveResults(results, from, to) {
  const moved = { ...results };
  for (const field of PATH_FIELDS) {
    if (moved[field]) moved[field] = path.join(to, path.relative(from, moved[field]));
  }
  return moved;
}

/** Keeps a finished run's results for later students; a run already saved stays as it is */
async function saveSampleRun(job) {
  const root = job?.results?.resultsPath;
  if (!job?.sampleRunKey || job.status !== 'completed' || !root || !fs.existsSync(root)) return;
  const saved = await SavedSampleRun.findOne({ key: job.sampleRunKey }).select('folder').lean();
  if (saved && fs.existsSync(saved.folder)) return;

  const folder = path.join(SAVED_ROOT, job.sampleRunKey);
  const copying = `${folder}.${job.inferenceId}`;
  await fs.promises.cp(root, copying, { recursive: true });
  await fs.promises.rm(folder, { recursive: true, force: true });
  await fs.promises.rename(copying, folder);
  await SavedSampleRun.updateOne(
    { key: job.sampleRunKey },
    { $set: { folder, results: moveResults(job.results, root, folder), totalImages: job.progress?.totalImages ?? 0 } },
    { upsert: true }
  );
}

/** Copies a saved run into `folder` and returns its results, or null when there is none to use */
async function copySavedRun(key, folder) {
  const saved = await SavedSampleRun.findOne({ key }).lean();
  if (!saved || !fs.existsSync(saved.folder)) return null;
  await fs.promises.cp(saved.folder, folder, { recursive: true });
  return { results: moveResults(saved.results, saved.folder, folder), totalImages: saved.totalImages };
}

module.exports = { sampleRunKey, saveSampleRun, copySavedRun };
