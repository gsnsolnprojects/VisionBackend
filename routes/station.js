const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/authorizationMiddleware');
const {
  STATION_UPLOAD_DIR,
  upsertRun,
  uploadDefect,
  listRuns,
  getRun,
  getDefectImage,
} = require('../controllers/stationController');

/**
 * Vision-M Station (desktop app) routes.
 * Stations run inference locally and upload run summaries + defect snapshots here.
 */

const defectUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // runId is validated by the controller; keep only safe characters for the folder name.
      const dir = path.join(STATION_UPLOAD_DIR, String(req.params.runId).replace(/[^a-zA-Z0-9]/g, ''));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.jpg`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'image/jpeg' || file.mimetype === 'image/png'),
});

// POST /api/station/runs — create/update a run (idempotent on clientRunId)
router.post('/runs', authenticateToken, requirePermission('runInference'), upsertRun);

// POST /api/station/runs/:runId/defects — upload one defect snapshot (idempotent on clientDefectId)
router.post('/runs/:runId/defects', authenticateToken, requirePermission('runInference'), defectUpload.single('image'), uploadDefect);

// GET /api/station/runs — list runs for the workspace
router.get('/runs', authenticateToken, requirePermission('viewInferenceResults'), listRuns);

// GET /api/station/runs/:runId — run + defect log
router.get('/runs/:runId', authenticateToken, requirePermission('viewInferenceResults'), getRun);

// GET /api/station/runs/:runId/defects/:defectId/image — defect snapshot
router.get('/runs/:runId/defects/:defectId/image', authenticateToken, requirePermission('viewInferenceResults'), getDefectImage);

module.exports = router;
