const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const {
  getSubscription,
  startCheckout,
  verifyCheckout,
  cancelSubscription,
  handleWebhook,
} = require('../controllers/subscriptionController');

/**
 * Subscription Routes
 *
 * GET  /api/subscription          - Current company's plan, access mode, limits and usage
 * POST /api/subscription/checkout - Start paying for a plan (Razorpay)
 * POST /api/subscription/verify   - Confirm a completed payment
 * POST /api/subscription/cancel   - Cancel at the end of the paid month
 * POST /api/subscription/webhook  - Razorpay webhook (no login; verified by signature)
 */
router.post('/webhook', handleWebhook);

router.get('/', authenticateToken, getSubscription);
router.post('/checkout', authenticateToken, startCheckout);
router.post('/verify', authenticateToken, verifyCheckout);
router.post('/cancel', authenticateToken, cancelSubscription);

module.exports = router;
