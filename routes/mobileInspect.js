const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission, requirePermissionOr } = require('../middleware/authorizationMiddleware');
const {
  getMobileInspectConfig,
  putMobileInspectConfig,
} = require('../controllers/mobileInspectController');
const { startMobileInspect, confirmOnDeviceInspect } = require('../controllers/mobileInspectStartController');
const {
  listMobileInspectSurveys,
  getMobileInspectSurvey,
  compareWithBaseline,
  setVisitReview,
  getLatestForRegion,
  listObservations,
} = require('../controllers/mobileInspectSurveyController');
const { exportSurveyPdf } = require('../controllers/pdfExportController');

const inferenceTempDir = path.join(process.cwd(), 'uploads', 'inference-temp');
if (!fs.existsSync(inferenceTempDir)) {
  fs.mkdirSync(inferenceTempDir, { recursive: true });
}

const imageFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${ext}. Only .jpg, .jpeg, .png are allowed.`), false);
  }
};

const uploadInspectImages = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, inferenceTempDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, `insp-${uniqueSuffix}-${file.originalname}`);
    },
  }),
  fileFilter: imageFilter,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 50,
  },
});

router.use(authenticateToken);

router.get(
  '/config',
  requirePermissionOr(['viewModels', 'runInference', 'viewInferenceResults']),
  getMobileInspectConfig
);

router.put(
  '/config',
  requirePermissionOr(['startTraining', 'uploadDatasets', 'manageProjects']),
  putMobileInspectConfig
);

router.get(
  '/surveys',
  requirePermissionOr(['viewModels', 'runInference', 'viewInferenceResults']),
  listMobileInspectSurveys
);

router.get(
  '/survey',
  requirePermissionOr(['viewModels', 'runInference', 'viewInferenceResults']),
  getMobileInspectSurvey
);

router.get(
  '/survey/pdf',
  requirePermissionOr(['viewModels', 'runInference', 'viewInferenceResults']),
  exportSurveyPdf
);

// GET /api/mobile-inspect/compare?currentInferenceId= - side-by-side baseline
// photo comparison for a resurvey job.
router.get(
  '/compare',
  requirePermissionOr(['viewModels', 'runInference', 'viewInferenceResults']),
  compareWithBaseline
);

// PUT /api/mobile-inspect/review/:inferenceId - reviewer's verdict (worse / same / better) on a visit
router.put('/review/:inferenceId', requirePermissionOr(['approveActions']), setVisitReview);

// GET /api/mobile-inspect/observations?company=&project= - every spot on the
// vessel with its inspection history (dashboard "Observations" register).
router.get(
  '/observations',
  requirePermissionOr(['viewModels', 'runInference', 'viewInferenceResults']),
  listObservations
);

// GET /api/mobile-inspect/region-history?company=&project=&regionName=&excludeSurveyName=
// - most recent completed job for a region, powers the mobile "resurvey instead?" suggestion.
router.get(
  '/region-history',
  requirePermissionOr(['viewModels', 'runInference', 'viewInferenceResults']),
  getLatestForRegion
);

router.post(
  '/',
  requirePermission('runInference'),
  uploadInspectImages.array('files', 50),
  startMobileInspect
);

// POST /api/mobile-inspect/confirm-on-device - confirm an on-device preview
// into a real survey part without re-running server-side inference.
router.post(
  '/confirm-on-device',
  requirePermission('runInference'),
  uploadInspectImages.array('files', 50),
  confirmOnDeviceInspect
);

module.exports = router;
