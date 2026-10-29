const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/authorizationMiddleware');
const {
  listSamples,
  importSampleDataset,
  labelSampleYourself,
  importSampleModel,
  getSampleDatasetThumbnail,
} = require('../controllers/sampleLibraryController');

/**
 * Sample library routes (GSN sample datasets and models for every company)
 *
 * GET  /api/samples                             - list sample datasets and models
 * GET  /api/samples/datasets/:datasetId/thumbnail - preview picture of a shown sample dataset
 * POST /api/samples/datasets/:datasetId/import  - copy a sample dataset into one of your projects
 * POST /api/samples/datasets/:datasetId/label-yourself - its photos without GSN's labels, to label and train on
 * POST /api/samples/models/:modelId/import      - copy a sample model into one of your projects
 */
router.get('/', authenticateToken, requirePermission('viewDatasets'), listSamples);
router.get('/datasets/:datasetId/thumbnail', authenticateToken, requirePermission('viewDatasets'), getSampleDatasetThumbnail);
router.post('/datasets/:datasetId/import', authenticateToken, requirePermission('uploadDatasets'), importSampleDataset);
router.post('/datasets/:datasetId/label-yourself', authenticateToken, requirePermission('uploadDatasets'), labelSampleYourself);
router.post('/models/:modelId/import', authenticateToken, requirePermission('runInference'), importSampleModel);

module.exports = router;
