const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { getSubscription } = require('../controllers/subscriptionController');

/**
 * Subscription Routes
 *
 * GET /api/subscription - Current company's plan, access mode, limits and usage
 */
router.get('/', authenticateToken, getSubscription);

module.exports = router;
