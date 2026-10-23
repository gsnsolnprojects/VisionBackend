const express = require('express');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/authorizationMiddleware');
const {
  closeTest,
  createReport,
  listReports,
  downloadReport,
  downloadCsv,
  reportPreview,
  deleteReport,
} = require('../controllers/playgroundController');

/** Playground tests and reports (controllers/playgroundController.js) */
const router = express.Router();

router.post('/runs/:inferenceId/close', authenticateToken, requirePermission('runInference'), closeTest);
router.post('/runs/:inferenceId/report', authenticateToken, requirePermission('runInference'), createReport);
router.get('/reports', authenticateToken, requirePermission('viewInferenceResults'), listReports);
router.get('/reports/:id/download', authenticateToken, requirePermission('viewInferenceResults'), downloadReport);
router.get('/reports/:id/csv', authenticateToken, requirePermission('viewInferenceResults'), downloadCsv);
router.get('/reports/:id/preview', authenticateToken, requirePermission('viewInferenceResults'), reportPreview);
router.delete('/reports/:id', authenticateToken, requirePermission('runInference'), deleteReport);

module.exports = router;
