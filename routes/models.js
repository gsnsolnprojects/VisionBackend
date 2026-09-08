const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/authorizationMiddleware');
const {
  listModels,
  getModel,
  getModelMetrics,
  getModelInsights,
  getModelDownloadUrl,
  downloadModel,
  listCheckpoints,
  deleteModel
} = require('../controllers/modelController');
const {
  scanNetworkDevices,
  checkDeviceByIp,
  deployModelToDevice
} = require('../controllers/deployController');

/**
 * Model Registry Routes
 * 
 * These routes handle trained model management:
 * - List all models for a company/project
 * - Get model details
 * - Get model metrics and charts
 * - Get model insights and recommendations
 * - Download model files
 * - List checkpoints
 * - Delete models and their files
 */

// GET /api/models - List all models (filtered by company/project)
router.get('/', authenticateToken, requirePermission('viewModels'), listModels);

// Deploy routes (must come before /:modelId to avoid route conflicts)
// GET /api/models/:modelId/deploy/scan-devices - Scan network for devices
router.get('/:modelId/deploy/scan-devices', authenticateToken, requirePermission('runInference'), scanNetworkDevices);

// GET /api/models/:modelId/deploy/check-device - Check device by IP address
router.get('/:modelId/deploy/check-device', authenticateToken, requirePermission('runInference'), checkDeviceByIp);

// POST /api/models/:modelId/deploy - Deploy model to device
router.post('/:modelId/deploy', authenticateToken, requirePermission('runInference'), deployModelToDevice);

// GET /api/models/:modelId/metrics - Get detailed metrics and chart data
router.get('/:modelId/metrics', authenticateToken, requirePermission('viewTrainingMetrics'), getModelMetrics);

// GET /api/models/:modelId/insights - Get insights and recommendations
router.get('/:modelId/insights', authenticateToken, requirePermission('viewTrainingMetrics'), getModelInsights);

// GET /api/models/:modelId/download-url - Get signed download URL
// format=pt|onnx|tflite|zip, variant=float16|float32 (tflite only, default float16)
router.get('/:modelId/download-url', authenticateToken, requirePermission('viewModels'), getModelDownloadUrl);

// GET /api/models/:modelId/download - Download model file
// format=pt|onnx|tflite|zip, variant=float16|float32 (tflite only, default float16)
// tflite is converted on-demand from the .pt checkpoint on first request, then cached on disk.
router.get('/:modelId/download', authenticateToken, requirePermission('viewModels'), downloadModel);

// GET /api/models/:modelId/checkpoints - List all checkpoints
router.get('/:modelId/checkpoints', authenticateToken, requirePermission('viewTrainingMetrics'), listCheckpoints);

// GET /api/models/:modelId - Get model details (must come after all specific routes)
router.get('/:modelId', authenticateToken, requirePermission('viewModels'), getModel);

// DELETE /api/models/:modelId - Delete model and its files
router.delete('/:modelId', authenticateToken, requirePermission('deleteDatasets'), deleteModel);

module.exports = router;










