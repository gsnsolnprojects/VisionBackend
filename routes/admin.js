const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireSuperadmin } = require('../middleware/authorizationMiddleware');
const {
  getOverview,
  listUsers,
  setUserStatus,
  deleteUser,
  listCompanies,
  setCompanyUnlimited,
  setCompanyPlaygroundAccess,
  deleteCompany,
  getRevenue,
  listJobs,
  listAudit,
} = require('../controllers/adminController');
const {
  listLibrary,
  addToLibrary,
  addAllToLibrary,
  updateLibraryItem,
  deleteLibraryItem,
  getProjectPlaygroundStatus,
  setProjectPlayground,
  getDatasetPlaygroundStatus,
  setDatasetPlayground,
} = require('../controllers/adminSampleLibraryController');
const {
  requireEnabled: requirePublishEnabled,
  listPublishDatasets,
  savePublishSelection,
  setProjectPublish,
} = require('../controllers/adminPublishController');

/**
 * Superadmin Routes (GSN platform admin only)
 *
 * GET    /api/admin/overview
 * GET    /api/admin/users
 * POST   /api/admin/users/:userId/status
 * DELETE /api/admin/users/:userId
 * GET    /api/admin/companies
 * PATCH  /api/admin/companies/:companyId/unlimited
 * DELETE /api/admin/companies/:companyId
 * GET    /api/admin/revenue
 * GET    /api/admin/jobs
 * GET    /api/admin/audit
 * GET    /api/admin/sample-library
 * POST   /api/admin/sample-library
 * POST   /api/admin/sample-library/add-all
 * PATCH  /api/admin/sample-library/:itemId
 * DELETE /api/admin/sample-library/:itemId
 * GET    /api/admin/publish/datasets     (local setup only)
 * PUT    /api/admin/publish/selection    (local setup only)
 * PUT    /api/admin/publish/project      (local setup only)
 */
router.use(authenticateToken, requireSuperadmin);

router.get('/overview', getOverview);
router.get('/users', listUsers);
router.post('/users/:userId/status', setUserStatus);
router.delete('/users/:userId', deleteUser);
router.get('/companies', listCompanies);
router.patch('/companies/:companyId/unlimited', setCompanyUnlimited);
router.patch('/companies/:companyId/playground', setCompanyPlaygroundAccess);
router.delete('/companies/:companyId', deleteCompany);
router.get('/revenue', getRevenue);
router.get('/jobs', listJobs);
router.get('/audit', listAudit);

// Playground sample dataset library
router.get('/sample-library', listLibrary);
router.post('/sample-library', addToLibrary);
router.post('/sample-library/add-all', addAllToLibrary);
router.get('/sample-library/projects', getProjectPlaygroundStatus);
router.post('/sample-library/projects/playground', setProjectPlayground);
router.get('/sample-library/datasets', getDatasetPlaygroundStatus);
router.post('/sample-library/datasets/:datasetId/playground', setDatasetPlayground);
router.patch('/sample-library/:itemId', updateLibraryItem);
router.delete('/sample-library/:itemId', deleteLibraryItem);

// Publish to live: pick datasets to copy to the AWS setup (only when ENABLE_PUBLISH_TO_LIVE=true)
router.get('/publish/datasets', requirePublishEnabled, listPublishDatasets);
router.put('/publish/selection', requirePublishEnabled, savePublishSelection);
router.put('/publish/project', requirePublishEnabled, setProjectPublish);

module.exports = router;
