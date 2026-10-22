const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/authorizationMiddleware');
const { enforceDatasetAllowance } = require('../middleware/datasetAllowanceMiddleware');

const {
  uploadDataset,
  getDataset,
  getDatasetStatus,
  getActiveDataset,
  startAugmentation,
  cancelAugmentation,
  duplicateDataset,
  getAnnotationSummary,
  getDatasetFolders,
  getDatasetFiles,
  getFileLabels,
  addDatasetFiles,
  deleteDatasetFile,
  getFileThumbnail,
  getFile,
  updateDataset,
  getDatasetDependencies,
  deleteDataset,
  deleteDatasetByVersion,
  getDetectedClasses,
  createCategoriesFromClasses,
  downloadDataset,
  checkDatasetType,
  listDatasets
} = require('../controllers/datasetController');

/**
 * Routes for Dataset Management
 * 
 * What are Routes?
 * Routes define the URL paths (endpoints) your API responds to.
 * Example: POST /api/dataset/upload → calls uploadDataset function
 */

// ✅ Configure multer for file uploads
// Multer is middleware that handles multipart/form-data (file uploads)

// ⚠️ CAUTION: Ensure temp directory exists to prevent errors
const tempDir = path.join(process.cwd(), 'uploads', 'tmp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// ✅ Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // ✅ Save uploaded files to temp directory
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    // ✅ Generate unique temp filename to avoid collisions
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `temp-${uniqueSuffix}-${file.originalname}`);
  }
});

// ✅ File filter - validate fileMeta only
// For 'files' field: Accept all files, let controller validate and skip invalid ones
// For 'fileMeta' field: JSON files only (strict validation)
const fileFilter = (req, file, cb) => {
  // ✅ Only validate fileMeta field (must be JSON)
  if (file.fieldname === 'fileMeta') {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.json' || file.mimetype === 'application/json') {
      cb(null, true);
      return;
    } else {
      cb(new Error('fileMeta must be a JSON file'), false);
      return;
    }
  }
  
  // ✅ For 'files' field: Accept all files
  // Controller will validate extensions and skip invalid files gracefully
  // This allows mixed valid/invalid files to upload successfully
  cb(null, true);
};

// ✅ Create multer instance
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // ⚠️ CAUTION: 50MB per file limit
    files: 10000 // Maximum 10000 files per request
  }
});

// Note: GET /api/datasets is handled in server.js directly

/**
 * POST /api/dataset/upload
 * 
 * Accepts multipart/form-data with:
 * - Field name "files" (array of files)
 * - Field "fileMeta" (optional - JSON string as text field OR JSON file)
 * - Field "company" (string, required)
 * - Field "project" (string, required)
 * - Field "version" (string, optional, defaults to "v1")
 * 
 * Note: Invalid files in 'files' field are skipped and reported in uploadErrors.
 * Controller handles validation gracefully.
 */
router.post('/upload',
  authenticateToken,
  requirePermission('uploadDatasets'),
  upload.fields([
    { name: 'files', maxCount: 10000 }, // ✅ Accept up to 10000 files (controller validates)
    { name: 'fileMeta', maxCount: 1 } // ✅ Accept optional fileMeta (JSON file, validated by fileFilter)
  ]),
  // ✅ Error handler for Multer errors (e.g., fileMeta validation fails)
  (err, req, res, next) => {
    if (err) {
      // Multer error (e.g., fileMeta is not JSON)
      return res.status(400).json({
        error: 'Upload error',
        message: err.message
      });
    }
    next();
  },
  enforceDatasetAllowance('new'),
  uploadDataset
);

/**
 * POST /api/dataset/:datasetId/augment
 *
 * Starts augmentation for a dataset using the augmentation worker.
 */
router.post(
  '/:datasetId/augment',
  authenticateToken,
  requirePermission('uploadDatasets'),
  startAugmentation
);

/**
 * POST /api/dataset/:datasetId/augment/cancel
 *
 * Cancels a running augmentation job for a dataset (best-effort).
 */
router.post(
  '/:datasetId/augment/cancel',
  authenticateToken,
  requirePermission('uploadDatasets'),
  cancelAugmentation
);

/**
 * POST /api/dataset/:datasetId/duplicate
 *
 * Creates an independent copy of a dataset version under a new version name.
 */
router.post(
  '/:datasetId/duplicate',
  authenticateToken,
  requirePermission('uploadDatasets'),
  duplicateDataset
);

/**
 * GET /api/dataset/active/:company/:project
 * 
 * Returns the active dataset for a given company/project.
 * Useful for file browser and training to resolve which dataset version to use.
 */
router.get('/active/:company/:project', authenticateToken, requirePermission('viewDatasets'), getActiveDataset);

/**
 * GET /api/dataset/:datasetId/status
 * 
 * Returns minimal status for polling
 */
router.get('/:datasetId/status', authenticateToken, requirePermission('viewDatasets'), getDatasetStatus);

/**
 * GET /api/dataset/:datasetId/annotation-summary
 *
 * Returns annotation progress summary for a dataset.
 */
router.get('/:datasetId/annotation-summary', authenticateToken, requirePermission('viewDatasets'), getAnnotationSummary);

/**
 * GET /api/dataset/:datasetId/detected-classes
 * 
 * Returns detected class IDs and default class names for labeled datasets.
 * Used by frontend to prompt user to map class IDs to meaningful names.
 */
router.get('/:datasetId/detected-classes', authenticateToken, requirePermission('viewDatasets'), getDetectedClasses);

/**
 * GET /api/dataset/:datasetId/type-check
 *
 * Scan YOLO label files and report detection vs segmentation vs unlabeled/mixed.
 */
router.get('/:datasetId/type-check', authenticateToken, requirePermission('viewDatasets'), checkDatasetType);

/**
 * POST /api/dataset/:datasetId/create-categories-from-classes
 * 
 * Creates Category documents from detected class IDs using user-provided names.
 */
router.post('/:datasetId/create-categories-from-classes', authenticateToken, requirePermission('uploadDatasets'), createCategoriesFromClasses);

/**
 * GET /api/dataset/:datasetId/folders
 * 
 * Returns folder summary with images/labels counts and size statistics
 */
router.get('/:datasetId/folders', authenticateToken, requirePermission('viewDatasets'), getDatasetFolders);

/**
 * GET /api/dataset/:datasetId/files
 * 
 * Returns paginated file manifest with filters and sorting
 * Requires: viewRawDatasetImages permission (for Viewer role restriction)
 */
router.get('/:datasetId/files', authenticateToken, requirePermission('viewRawDatasetImages'), getDatasetFiles);

// GET /api/dataset/:datasetId/file-labels?ids=a,b - boxes for a page of images (Playground grid)
router.get('/:datasetId/file-labels', authenticateToken, requirePermission('viewRawDatasetImages'), getFileLabels);

/**
 * POST /api/dataset/:datasetId/files
 * Add photos / labels to an existing dataset version (multipart field "files", body.folder).
 */
router.post(
  '/:datasetId/files',
  authenticateToken,
  requirePermission('uploadDatasets'),
  upload.fields([{ name: 'files', maxCount: 1000 }]),
  (err, req, res, next) => {
    if (err) {
      return res.status(400).json({ error: 'Upload error', message: err.message });
    }
    next();
  },
  enforceDatasetAllowance('add'),
  addDatasetFiles
);

/**
 * DELETE /api/dataset/:datasetId/files/:fileId
 * Remove one photo (and matching label) from a dataset version.
 */
router.delete(
  '/:datasetId/files/:fileId',
  authenticateToken,
  requirePermission('uploadDatasets'),
  deleteDatasetFile
);

/**
 * GET /api/dataset/:datasetId/file/:fileId/thumbnail
 * 
 * Serves thumbnail image if available
 * fileId can be storedName or file _id
 * Requires: viewRawDatasetImages permission (for Viewer role restriction)
 */
router.get('/:datasetId/file/:fileId/thumbnail', authenticateToken, requirePermission('viewRawDatasetImages'), getFileThumbnail);

/**
 * GET /api/dataset/:datasetId/file/:fileId
 * 
 * Serves original full-size image (never thumbnail)
 * fileId can be storedName or file _id
 * Requires: viewRawDatasetImages permission (for Viewer role restriction)
 * 
 * ⚠️ CAUTION: This route must be AFTER /thumbnail route to avoid route conflicts
 */
router.get('/:datasetId/file/:fileId', authenticateToken, requirePermission('viewRawDatasetImages'), getFile);

/**
 * GET /api/dataset/:datasetId/dependencies
 *
 * Get dependencies (training jobs, models, inference jobs) that use this dataset
 * Used for showing confirmation dialog before deletion
 */
router.get('/:datasetId/dependencies', authenticateToken, requirePermission('viewDatasets'), getDatasetDependencies);

/**
 * GET /api/dataset/:datasetId/download
 *
 * Streams the dataset as a ZIP file. Files use originalName for user-friendly download.
 * Includes images, labels, data.yaml, and class-mapping.json.
 */
router.get('/:datasetId/download', authenticateToken, requirePermission('viewDatasets'), downloadDataset);

/**
 * PATCH /api/dataset/:datasetId
 * 
 * Updates dataset company and/or project name
 * 
 * Request body:
 * {
 *   "company": "newCompanyName",  // Optional
 *   "project": "newProjectName"    // Optional
 * }
 * 
 * ⚠️ CAUTION: This route must be BEFORE GET /:datasetId to avoid route conflicts
 */
router.patch('/:datasetId', authenticateToken, requirePermission('uploadDatasets'), updateDataset);

/**
 * DELETE /api/dataset/:company/:project/:version
 * 
 * Soft delete dataset by company/project/version identifier
 * Delete files but keep MongoDB document
 * References in models/inference jobs will remain but show "Dataset deleted" status
 * 
 * ⚠️ CAUTION: 
 * - This route must be BEFORE DELETE /:datasetId to avoid route conflicts
 * - Cannot delete if:
 *   - Dataset is processing or queued
 *   - Dataset is already deleted
 */
router.delete(
  '/:company/:project/:version',
  authenticateToken,
  requirePermission('deleteDatasets'),
  // Guard: never treat /:datasetId/annotations/:annotationId as version-delete route.
  (req, res, next) => {
    if (String(req.params.project).toLowerCase() === 'annotations') {
      return next('route');
    }
    return next();
  },
  deleteDatasetByVersion
);

/**
 * DELETE /api/dataset/:datasetId
 * 
 * Soft delete dataset: Delete files but keep MongoDB document
 * References in models/inference jobs will remain but show "Dataset deleted" status
 * 
 * ⚠️ CAUTION: Cannot delete if:
 * - Dataset is processing or queued
 * - Dataset is already deleted
 */
router.delete('/:datasetId', authenticateToken, requirePermission('deleteDatasets'), deleteDataset);

/**
 * GET /api/dataset/:datasetId
 * 
 * Returns full dataset metadata
 * 
 * ⚠️ CAUTION: This route must be LAST to avoid matching /folders, /files, etc.
 */
router.get('/:datasetId', authenticateToken, requirePermission('viewDatasets'), getDataset);

module.exports = router;

