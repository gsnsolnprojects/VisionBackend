const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/authorizationMiddleware');
const {
  getDashboardOverview,
  getDashboardActivity,
  getDashboardProjects,
  getProjectSummary,
  deleteProject,
  getLearningProgress,
} = require('../controllers/dashboardController');
const { getActivity } = require('../controllers/usageController');

/**
 * Dashboard Routes
 *
 * All routes here are read-only aggregations over existing data.
 */

// GET /api/dashboard/overview
router.get('/overview', authenticateToken, requirePermission('viewProjects'), getDashboardOverview);

// GET /api/dashboard/learning-progress - Playground learning path counts for the caller's company
router.get('/learning-progress', authenticateToken, requirePermission('viewProjects'), getLearningProgress);

// GET /api/dashboard/usage?month=YYYY-MM - who did what and when (trainings with GPU time, tests, uploads)
router.get('/usage', authenticateToken, requirePermission('viewProjects'), getActivity);

// GET /api/dashboard/activity
router.get('/activity', authenticateToken, requirePermission('viewProjects'), getDashboardActivity);

// GET /api/dashboard/projects
router.get('/projects', authenticateToken, requirePermission('viewProjects'), getDashboardProjects);

// GET /api/dashboard/project - Single project summary (counts for delete confirmation modal)
// Query: company, project
router.get('/project', authenticateToken, requirePermission('viewProjects'), getProjectSummary);

// DELETE /api/dashboard/project - Delete entire project (all datasets, models, training, inference)
// Query or body: company, project. Requires deleteProjects.
router.delete('/project', authenticateToken, requirePermission('deleteProjects'), deleteProject);

module.exports = router;

