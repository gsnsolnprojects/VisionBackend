const fsPromises = require('fs').promises;
const mongoose = require('mongoose');
const Dataset = require('../models/Dataset');
const { ownDatasetFilter } = require('../utils/usage');
const { isCopyName } = require('../services/datasetCopies');
const { checkImageFiles, isImage } = require('../utils/imageRules');

/**
 * Plan limits on uploaded datasets (Playground: 1 dataset of its own, up to 500 images, each
 * 10 KB to 5 MB and 320 to 8000 px). Runs after multer has saved the files to the temp folder, so a refused
 * upload deletes them again. Limits come from req.user.access.limits (null = no limit);
 * GSN and unlimited workspaces have none.
 */

async function removeTempFiles(files) {
  await Promise.all(files.map((f) => (f.path ? fsPromises.unlink(f.path).catch(() => {}) : null)));
}

/**
 * @param {'new' | 'add'} kind - 'new' for POST /api/dataset/upload, 'add' for POST /api/dataset/:datasetId/files
 */
const enforceDatasetAllowance = (kind) => async (req, res, next) => {
  const limits = req.user?.access?.limits || {};
  const files = req.files?.files || [];
  const images = files.filter(isImage);

  const refuse = async (message, code) => {
    await removeTempFiles([...files, ...(req.files?.fileMeta || [])]);
    return res.status(403).json({ error: message, message, code });
  };

  try {
    // Each photo's file size and pixel size (utils/imageRules)
    const problem = await checkImageFiles(images, limits);
    if (problem) return refuse(problem.message, problem.code);

    const company = req.user?.company;
    let existingImages = 0;

    if (kind === 'new') {
      const maxDatasets = limits.ownDatasets;
      if (typeof maxDatasets === 'number') {
        const own = await Dataset.countDocuments(ownDatasetFilter(company));
        if (own >= maxDatasets) {
          return refuse(
            `Your plan includes ${maxDatasets} dataset${maxDatasets === 1 ? '' : 's'} of your own. Delete your current dataset to upload a new one.`,
            'plan_dataset_limit'
          );
        }
      }
    } else {
      const { datasetId } = req.params;
      if (mongoose.Types.ObjectId.isValid(datasetId)) {
        const dataset = await Dataset.findById(datasetId).select('files').lean();
        // Only photos the student added: making extra photos again replaces the copies
        existingImages = (dataset?.files || []).filter((f) => f.type === 'image' && !isCopyName(f.storedName)).length;
      }
    }

    const maxImages = limits.imagesPerDataset;
    if (typeof maxImages === 'number' && existingImages + images.length > maxImages) {
      const room = Math.max(0, maxImages - existingImages);
      return refuse(
        kind === 'new'
          ? `A dataset can have up to ${maxImages} images on your plan. You selected ${images.length}.`
          : `A dataset can have up to ${maxImages} images on your plan. This one has ${existingImages}, so you can add ${room} more.`,
        'plan_image_limit'
      );
    }

    next();
  } catch (error) {
    await removeTempFiles(files);
    next(error);
  }
};

module.exports = { enforceDatasetAllowance };
