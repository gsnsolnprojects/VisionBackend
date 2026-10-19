const mongoose = require('mongoose');
const Dataset = require('../models/Dataset');
const { validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');

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
