const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission, requirePermissionOr } = require('../middleware/authorizationMiddleware');
const {
  listActionItems,
  getActionItem,
  createActionItem,
  updateActionItem,
  deleteActionItem,
  uploadAfterPhoto,
  getActionPhoto,
} = require('../controllers/actionItemController');

// Photos land directly under uploads/action-items/<actionId>/ — no temp+move
// step needed since (unlike inference results) there's no processing step
// in between upload and serving.
const actionItemsDir = path.join(process.cwd(), 'uploads', 'action-items');
const uploadAfterPhotoStorage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(actionItemsDir, req.params.actionId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `after_${Date.now()}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png'].includes(ext)) cb(null, true);
    else cb(new Error(`Invalid file type: ${ext}. Only .jpg, .jpeg, .png are allowed.`), false);
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

/**
 * Action Item Routes
 *
 * Follow-up tasks raised against a corrosion finding, tracked through to
 * approval — backs the dashboard's "open actions and overdue reviews" view.
 */

// GET /api/actions - List/filter action items for a company+project
router.get('/', authenticateToken, requirePermissionOr(['viewActions', 'manageActions', 'approveActions']), listActionItems);

// GET /api/actions/:actionId - Get one action item
router.get('/:actionId', authenticateToken, requirePermissionOr(['viewActions', 'manageActions', 'approveActions']), getActionItem);

// POST /api/actions - Raise a new action item
router.post('/', authenticateToken, requirePermission('manageActions'), createActionItem);

// PATCH /api/actions/:actionId - Edit an action item (approving requires approveActions, checked in controller)
router.patch('/:actionId', authenticateToken, requirePermissionOr(['manageActions', 'approveActions']), updateActionItem);

// DELETE /api/actions/:actionId - Delete an action item
router.delete('/:actionId', authenticateToken, requirePermission('manageActions'), deleteActionItem);

// POST /api/actions/:actionId/after-photo - Attach an after-repair photo
router.post(
  '/:actionId/after-photo',
  authenticateToken,
  requirePermissionOr(['manageActions', 'approveActions']),
  uploadAfterPhotoStorage.single('file'),
  uploadAfterPhoto
);

// GET /api/actions/:actionId/photo/:filename - Serve an after-repair photo
router.get(
  '/:actionId/photo/:filename',
  authenticateToken,
  requirePermissionOr(['viewActions', 'manageActions', 'approveActions']),
  getActionPhoto
);

module.exports = router;
