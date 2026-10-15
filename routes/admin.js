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
  deleteCompany,
  getRevenue,
  listJobs,
  listAudit,
} = require('../controllers/adminController');

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
 */
router.use(authenticateToken, requireSuperadmin);

router.get('/overview', getOverview);
router.get('/users', listUsers);
router.post('/users/:userId/status', setUserStatus);
router.delete('/users/:userId', deleteUser);
router.get('/companies', listCompanies);
router.patch('/companies/:companyId/unlimited', setCompanyUnlimited);
router.delete('/companies/:companyId', deleteCompany);
router.get('/revenue', getRevenue);
router.get('/jobs', listJobs);
router.get('/audit', listAudit);

module.exports = router;
