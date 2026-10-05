const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission, requirePermissionOr } = require('../middleware/authorizationMiddleware');

const {
  startBatchInference,
  startLiveInference,
  processLiveFrame,
  stopLiveInference,
  getInferenceStatus,
  getInferenceResults,
  getAnnotatedImage,
  cancelInference,
  confirmInferenceJob,
  setInferenceAssessment,
  deleteInference,
  deleteInferenceImage,
  addInferenceImages,
  listInferenceJobs,
  listAvailableModels,
  listDatasetsWithTestFolders,
  postEdgeLive,
  getEdgeLive
} = require('../controllers/inferenceController');

/**
 * Inference Routes
 * 
 * These routes handle inference job management:
 * - Start batch inference (images/videos)
 * - Start/stop live camera inference
 * - Get inference status and results
 * - Get annotated images/videos
 * - Cancel/delete inference jobs
 * - List inference history
 */

// ✅ Configure multer for inference file uploads
const inferenceTempDir = path.join(process.cwd(), 'uploads', 'inference-temp');
if (!fs.existsSync(inferenceTempDir)) {
  fs.mkdirSync(inferenceTempDir, { recursive: true });
}

// ✅ File filter - accept image and video files
const inferenceFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const validExtensions = ['.jpg', '.jpeg', '.png', '.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v'];

  if (validExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${ext}. Only ${validExtensions.join(', ')} are allowed.`), false);
  }
};

// ✅ Create multer instance for inference uploads
const uploadInferenceImages = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, inferenceTempDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, `inf-${uniqueSuffix}-${file.originalname}`);
    }
  }),
  fileFilter: inferenceFileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB per file limit (increased for videos)
    files: 1000 // Maximum 1000 files per upload
  }
});

// GET /api/inference/models - List available models for inference
router.get('/models', authenticateToken, requirePermission('viewModels'), listAvailableModels);

// GET /api/inference/datasets - List datasets with test folders
router.get('/datasets', authenticateToken, requirePermission('viewDatasets'), listDatasetsWithTestFolders);

// GET /api/inference/history - List inference jobs (with filters)
router.get('/history', authenticateToken, requirePermission('viewInferenceResults'), listInferenceJobs);

// POST /api/inference/start - Start batch inference (images/videos)
router.post('/start', authenticateToken, requirePermission('runInference'), uploadInferenceImages.array('files', 1000), startBatchInference);

// POST /api/inference/live/start - Start live camera inference
router.post('/live/start', authenticateToken, requirePermission('runInference'), startLiveInference);

// POST /api/inference/live/:inferenceId/frame - Process a frame from live camera
router.post('/live/:inferenceId/frame', authenticateToken, requirePermission('runInference'), processLiveFrame);

// POST /api/inference/live/:inferenceId/stop - Stop live camera inference
router.post('/live/:inferenceId/stop', authenticateToken, requirePermission('runInference'), stopLiveInference);

// Edge Live: receive from edge device (no auth for MVP) and serve latest to frontend (auth required)
// POST /api/inference/edge/live - Edge device sends inference result (JSON)
router.post('/edge/live', postEdgeLive);
// GET /api/inference/edge/live - Frontend polls for latest (same auth as other inference read endpoints)
router.get('/edge/live', authenticateToken, requirePermission('viewInferenceResults'), getEdgeLive);

// GET /api/inference/:inferenceId/status - Get inference job status
// Allow monitorInference (for real-time monitoring) OR viewInferenceResults (for viewing completed jobs)
router.get('/:inferenceId/status', authenticateToken, requirePermissionOr(['monitorInference', 'viewInferenceResults']), getInferenceStatus);

// GET /api/inference/:inferenceId/results - Get inference results
router.get('/:inferenceId/results', authenticateToken, requirePermission('viewInferenceResults'), getInferenceResults);

// GET /api/inference/:inferenceId/image/:filename - Get annotated image/video
router.get('/:inferenceId/image/:filename', authenticateToken, requirePermission('viewInferenceResults'), getAnnotatedImage);

// DELETE /api/inference/:inferenceId/image/:filename - Remove one image from a job's results
// and recompute job-level aggregates. Same permission model as deleting the whole job.
router.delete(
  '/:inferenceId/image/:filename',
  authenticateToken,
  requirePermissionOr(['deleteProjects', 'deleteOwnInference']),
  deleteInferenceImage
);

// POST /api/inference/:inferenceId/images - Append already-annotated (on-device)
// images to a completed job's results and recompute job-level aggregates.
// Same permission model as deleting an image from a job.
router.post(
  '/:inferenceId/images',
  authenticateToken,
  requirePermissionOr(['deleteProjects', 'deleteOwnInference']),
  uploadInferenceImages.array('files', 50),
  addInferenceImages
);

// POST /api/inference/:inferenceId/cancel - Cancel a running inference job
router.post('/:inferenceId/cancel', authenticateToken, requirePermission('runInference'), cancelInference);

// POST /api/inference/:inferenceId/confirm - Mark a completed job as human-reviewed
// (POST, not PATCH: see confirmInferenceJob's doc comment for why.)
router.post('/:inferenceId/confirm', authenticateToken, requirePermission('runInference'), confirmInferenceJob);

// PUT /api/inference/:inferenceId/assessment - Save the inspector's confirmed severity + damage types
router.put('/:inferenceId/assessment', authenticateToken, requirePermission('runInference'), setInferenceAssessment);

// DELETE /api/inference/:inferenceId - Delete an inference job
// Permission check: deleteProjects (admins) OR deleteOwnInference (operators - with ownership verification in controller)
router.delete('/:inferenceId', authenticateToken, requirePermissionOr(['deleteProjects', 'deleteOwnInference']), deleteInference);

module.exports = router;
