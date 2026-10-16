const mongoose = require('mongoose');
const Dataset = require('../models/Dataset');
const Category = require('../models/Category');
const Annotation = require('../models/Annotation');
const Image = require('../models/Image');
const storageAdapter = require('./storageAdapter');

/**
 * Where a dataset's labels came from (badges: Unlabeled, Pre-Labelled, Manually Labelled).
 * Augmented datasets use the stored labelSource; others derive it from status/datasetType.
 */
function getLabelSource(dataset) {
  if (dataset.isAugmented && dataset.labelSource) return dataset.labelSource;
  const dt = dataset.datasetType ?? (dataset.status === 'ready_to_train' ? 'labeled' : null);
  if (dt === 'unlabeled') return 'unlabeled';
  if (dataset.status === 'ready_to_train') return 'manually_labeled';
  if (dataset.status === 'ready' && dt === 'labeled') return 'pre_labelled';
  return null;
}

/**
 * Make a fully independent copy of a dataset version: every file on disk plus the
 * Dataset / Category / Image / Annotation records (ids remapped), so the copy shares
 * nothing with the source. The target can be a new version in the same project
 * (duplicate) or another company/project (Playground sample datasets).
 *
 * Files are copied before any record is written, so a disk failure never leaves a
 * half-created dataset behind.
 *
 * @param {Document} sourceDataset - Dataset document to copy
 * @param {{ company: string, project: string, version: string, isActive?: boolean }} target
 * @returns {Promise<{ dataset: Document, images: number, categories: number, annotations: number }>}
 */
async function copyDataset(sourceDataset, { company, project, version, isActive = false }) {
  const newStoragePath = storageAdapter.buildDatasetPath(company, project, version);
  await storageAdapter.copyDirectory(sourceDataset.storagePath, newStoragePath);

  const newDataset = new Dataset({
    company,
    project,
    version,
    storagePath: newStoragePath,
    files: sourceDataset.files.map((f) => {
      const plain = f.toObject();
      delete plain._id;
      return plain;
    }),
    totalImages: sourceDataset.totalImages,
    sizeBytes: sourceDataset.sizeBytes,
    labels: sourceDataset.labels,
    datasetType: sourceDataset.datasetType,
    annotationStatus: sourceDataset.annotationStatus,
    unlabeledImagesCount: sourceDataset.unlabeledImagesCount,
    status: sourceDataset.status,
    labeledImages: sourceDataset.labeledImages,
    unlabeledImages: sourceDataset.unlabeledImages,
    trainCount: sourceDataset.trainCount,
    valCount: sourceDataset.valCount,
    testCount: sourceDataset.testCount,
    thumbnailsGenerated: sourceDataset.thumbnailsGenerated,
    labelSource: getLabelSource(sourceDataset),
    isAugmented: false,
    isActive,
    parentDatasetId: sourceDataset._id,
    rootDatasetId: sourceDataset.rootDatasetId || sourceDataset._id,
    split_seed: sourceDataset.split_seed,
    split_ratio_train: sourceDataset.split_ratio_train,
    split_ratio_val: sourceDataset.split_ratio_val,
    test_sample_ratio: sourceDataset.test_sample_ratio,
  });
  await newDataset.save();

  // Categories first — Annotation.categoryId must point at the new copies
  const sourceCategories = await Category.find({ datasetId: sourceDataset._id }).lean();
  const categoryIdMap = new Map();
  if (sourceCategories.length > 0) {
    const newCategoryDocs = sourceCategories.map((c) => {
      const newId = new mongoose.Types.ObjectId();
      categoryIdMap.set(String(c._id), newId);
      const { _id, ...rest } = c;
      return { ...rest, _id: newId, datasetId: newDataset._id };
    });
    await Category.insertMany(newCategoryDocs);
  }

  const sourceImages = await Image.find({ datasetId: sourceDataset._id }).lean();
  const imageIdMap = new Map();
  if (sourceImages.length > 0) {
    const newImageDocs = sourceImages.map((img) => {
      const newId = new mongoose.Types.ObjectId();
      imageIdMap.set(String(img._id), newId);
      const { _id, ...rest } = img;
      return { ...rest, _id: newId, datasetId: newDataset._id };
    });
    await Image.insertMany(newImageDocs);
  }

  const sourceAnnotations = await Annotation.find({ datasetId: sourceDataset._id, deletedAt: null }).lean();
  const newAnnotationDocs = sourceAnnotations
    .filter((a) => imageIdMap.has(String(a.imageId)) && categoryIdMap.has(String(a.categoryId)))
    .map((a) => {
      const { _id, ...rest } = a;
      return {
        ...rest,
        _id: new mongoose.Types.ObjectId(),
        datasetId: newDataset._id,
        imageId: imageIdMap.get(String(a.imageId)),
        categoryId: categoryIdMap.get(String(a.categoryId)),
      };
    });
  if (newAnnotationDocs.length > 0) {
    await Annotation.insertMany(newAnnotationDocs);
  }

  return {
    dataset: newDataset,
    images: sourceImages.length,
    categories: sourceCategories.length,
    annotations: newAnnotationDocs.length,
  };
}

module.exports = { copyDataset, getLabelSource };
