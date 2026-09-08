const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission, requirePermissionOr } = require('../middleware/authorizationMiddleware');
const {
  listActionItems,
  getActionItem,
  createActionItem,
  updateActionItem,
  deleteActionItem,
} = require('../controllers/actionItemController');

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

module.exports = router;
