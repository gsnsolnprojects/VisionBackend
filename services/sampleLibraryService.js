const path = require('path');
const fs = require('fs');
const Dataset = require('../models/Dataset');
const Image = require('../models/Image');
const Annotation = require('../models/Annotation');
const Category = require('../models/Category');
const SampleLibraryItem = require('../models/SampleLibraryItem');

/**
 * Sample library helpers: which GSN datasets can be offered, sensible defaults for
 * new entries, and permanently deleting a library dataset.
 */

const SAMPLE_COMPANY = 'gsn';
const READY_STATUSES = ['ready', 'ready_to_train'];
const DATASETS_BASE = path.resolve(process.cwd(), 'datasets');

/** GSN datasets that are ready to train on */
const readyGsnDatasetFilter = {
  company: SAMPLE_COMPANY,
  status: { $in: READY_STATUSES },
  deletedAt: null,
  trainCount: { $gt: 0 },
};

/** The database is shared between machines: only datasets whose files are on this server can be copied */
const isOnThisServer = (dataset) => !!dataset?.storagePath && fs.existsSync(dataset.storagePath);

/** Best guess of the industry from the GSN project / version name (the superadmin can change it) */
function guessIndustry(dataset) {
  const text = `${dataset.project} ${dataset.version}`.toLowerCase();
  if (/blister|pharma|tablet|capsule/.test(text)) return 'Pharma';
  if (/car ?seat|leather|automo/.test(text)) return 'Automotive';
  if (/pcb|connectwell|terminal|electron/.test(text)) return 'Electronics';
  if (/rust|corros|irina|varuna|ship|marine/.test(text)) return 'Marine & Corrosion';
  return 'General';
}

/** "Car Seat – car_seat_dataset_v2" */
const defaultName = (dataset) => `${String(dataset.project).trim()} – ${dataset.version}`.slice(0, 80);

/**
 * Add every ready GSN dataset on this server that isn't in the library yet.
 * Safe to run any number of times.
 * @returns {Promise<number>} how many entries were added
 */
async function addAllGsnDatasets() {
  const [datasets, existing] = await Promise.all([
    Dataset.find(readyGsnDatasetFilter).select('project version storagePath').lean(),
    SampleLibraryItem.find({}).select('datasetId').lean(),
  ]);
  const inLibrary = new Set(existing.map((e) => String(e.datasetId)));
  const toAdd = datasets
    .filter((d) => !inLibrary.has(String(d._id)) && isOnThisServer(d))
    .map((d) => ({ datasetId: d._id, name: defaultName(d), industry: guessIndustry(d) }));
  if (toAdd.length === 0) return 0;
  await SampleLibraryItem.insertMany(toAdd, { ordered: false });
  return toAdd.length;
}

/**
 * Permanently delete a GSN dataset: its files, images, labels and categories.
 * The Dataset document is kept as a soft-deleted record (same as the normal dataset
 * delete), so models trained on it still show where they came from.
 * Uses the dataset's real stored folder (projects may have been renamed since upload).
 */
async function deleteDatasetPermanently(dataset) {
  if (dataset.status === 'processing' || dataset.status === 'queued') {
    throw Object.assign(new Error('This dataset is still processing. Try again when it has finished.'), { status: 409 });
  }
  if (dataset.augmentationStatus === 'running') {
    throw Object.assign(new Error('Augmentation is running on this dataset. Cancel it first.'), { status: 409 });
  }
  const links = await Dataset.countDocuments({ linkedFrom: dataset._id, deletedAt: null });
  if (links > 0) {
    throw Object.assign(
      new Error(`${links} customer project${links === 1 ? ' uses' : 's use'} this sample dataset, so its files can't be deleted. Hide it instead.`),
      { status: 409 }
    );
  }

  if (dataset.storagePath) {
    const folder = path.resolve(dataset.storagePath);
    if (!folder.startsWith(DATASETS_BASE + path.sep)) {
      throw new Error(`Refusing to delete a folder outside the datasets directory: ${folder}`);
    }
    await fs.promises.rm(folder, { recursive: true, force: true });
  }

  await Promise.all([
    Annotation.deleteMany({ datasetId: dataset._id }),
    Category.deleteMany({ datasetId: dataset._id }),
    Image.deleteMany({ datasetId: dataset._id }),
  ]);

  dataset.deletedAt = new Date();
  dataset.status = 'failed'; // same marker the normal delete uses
  dataset.isActive = false;
  await dataset.save();
}

/**
 * Remove library entries for datasets that were just deleted (project / version /
 * company delete). Never throws: a cleanup problem must not fail the delete itself.
 * @param {Array<ObjectId|string>} datasetIds
 */
async function removeLibraryEntriesForDatasets(datasetIds) {
  if (!datasetIds || datasetIds.length === 0) return 0;
  try {
    const result = await SampleLibraryItem.deleteMany({ datasetId: { $in: datasetIds } });
    return result.deletedCount || 0;
  } catch (error) {
    console.error('[sample-library] could not remove entries for deleted datasets:', error.message);
    return 0;
  }
}

/**
 * Safety net: drop entries whose dataset no longer exists or is deleted (e.g. deleted by
 * a path that didn't clean up). Datasets that are only missing on this machine's disk
 * are kept — the database is shared with other machines.
 */
async function pruneDeletedEntries() {
  const items = await SampleLibraryItem.find({}).select('datasetId').lean();
  if (items.length === 0) return 0;
  const alive = await Dataset.find({ _id: { $in: items.map((i) => i.datasetId) }, deletedAt: null })
    .select('_id')
    .lean();
  const aliveIds = new Set(alive.map((d) => String(d._id)));
  const orphanIds = items.filter((i) => !aliveIds.has(String(i.datasetId))).map((i) => i.datasetId);
  return removeLibraryEntriesForDatasets(orphanIds);
}

module.exports = {
  removeLibraryEntriesForDatasets,
  pruneDeletedEntries,
  SAMPLE_COMPANY,
  readyGsnDatasetFilter,
  isOnThisServer,
  guessIndustry,
  defaultName,
  addAllGsnDatasets,
  deleteDatasetPermanently,
};
