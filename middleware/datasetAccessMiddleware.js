const mongoose = require('mongoose');
const Dataset = require('../models/Dataset');
const SampleLibraryItem = require('../models/SampleLibraryItem');
const { SAMPLE_COMPANY } = require('../services/sampleLibraryService');
const { validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');

/**
 * Reads that Learn to label makes on a GSN sample without a project: the photo list, one photo,
 * its thumbnail and the labels. Allowed (GET only) for customers with an active plan on samples
 * the library shows; the request is marked req.sampleRead so the handlers skip their own
 * company check.
 */
const SAMPLE_READS = /^\/(files|file-labels|file\/[^/]+(\/thumbnail)?)\/?$/;

async function isVisibleSample(dataset) {
  if (dataset.company !== SAMPLE_COMPANY) return false;
  return !!(await SampleLibraryItem.exists({ datasetId: dataset._id, isVisible: true }));
}

/**
 * Company check for every /api/dataset/:datasetId/... route (files, images, thumbnails,
 * annotations, categories, ...). A dataset can only be used by its own company; the
 * platform admin can use any. Mounted once in server.js so no single handler can forget it.
 *
 * Paths whose first segment is not a dataset id (e.g. /api/dataset/upload) and ids that
 * don't exist are passed on unchanged - the route itself answers those.
 */
async function datasetAccess(req, res, next) {
  try {
    const { datasetId } = req.params;
    if (!req.user || canAccessAllWorkspaces(req.user) || !mongoose.Types.ObjectId.isValid(datasetId)) {
      return next();
    }

    const dataset = await Dataset.findById(datasetId).select('company').lean();
    if (!dataset) return next();

    const access = validateWorkspaceAccess(req.user, dataset.company);
    if (
      !access.allowed &&
      req.method === 'GET' &&
      SAMPLE_READS.test(req.path) &&
      req.user.access?.mode === 'full' &&
      (await isVisibleSample(dataset))
    ) {
      req.sampleRead = true;
      return next();
    }
    if (!access.allowed) {
      return res.status(403).json({
        error: 'Permission denied',
        message: access.error || 'You do not have access to this dataset',
      });
    }
    next();
  } catch (error) {
    console.error('[datasetAccess] check failed:', error.message);
    res.status(500).json({ error: 'Internal server error', message: 'Could not check dataset access' });
  }
}

module.exports = { datasetAccess };
