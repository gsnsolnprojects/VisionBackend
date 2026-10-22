const fsPromises = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');
const Dataset = require('../models/Dataset');
const { ownDatasetFilter } = require('../utils/usage');

/**
 * Plan limits on uploaded datasets (Playground: 1 dataset of its own, up to 500 images,
 * 5 MB per image). Runs after multer has saved the files to the temp folder, so a refused
 * upload deletes them again. Limits come from req.user.access.limits (null = no limit);
 * GSN and unlimited workspaces have none.
 */

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

const isImage = (file) => IMAGE_EXTENSIONS.has(path.extname(file.originalname || '').toLowerCase());

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
    const maxMB = limits.maxImageSizeMB;
    if (typeof maxMB === 'number') {
      const tooBig = images.filter((f) => f.size > maxMB * 1024 * 1024);
      if (tooBig.length) {
        const names = tooBig.slice(0, 3).map((f) => path.basename(f.originalname)).join(', ');
        const more = tooBig.length > 3 ? ` and ${tooBig.length - 3} more` : '';
        return refuse(`Images can be up to ${maxMB} MB each on your plan. Too large: ${names}${more}.`, 'plan_image_size');
      }
    }

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
        const dataset = await Dataset.findById(datasetId).select('totalImages').lean();
        existingImages = dataset?.totalImages || 0;
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
