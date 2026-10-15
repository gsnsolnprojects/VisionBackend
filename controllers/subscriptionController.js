const { getSupabaseClient } = require('../services/supabaseService');
const razorpay = require('../services/razorpayService');
const { invalidateCompanyCache } = require('../middleware/authMiddleware');
const { PLANS, PLAN_ORDER } = require('../utils/plans');
const { countActiveLiveStreams } = require('./inferenceController');

/**
 * Subscription Controller
 *
 * GET  /api/subscription          - plan catalogue, company subscription, access and usage
 * POST /api/subscription/checkout - start a Razorpay subscription for a plan (company admins)
 * POST /api/subscription/verify   - confirm a completed Razorpay Checkout payment
 * POST /api/subscription/cancel   - cancel at the end of the paid month (company admins)
 * POST /api/subscription/webhook  - Razorpay webhook (renewals, failed payments, cancellations)
 */

// Only company admins buy or cancel plans for their company
const canManageBilling = (user) =>
  !!user?.company_id && (user.role === 'workspace_admin' || user.role === 'platform_admin');

const paymentsConfigured = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

const getSubscription = async (req, res) => {
  try {
    const { company_id: companyId, company, subscription, access } = req.user;
    const plans = PLAN_ORDER.map((id) => PLANS[id]);
    const billing = { canManage: canManageBilling(req.user), paymentsEnabled: paymentsConfigured() };

    if (!companyId) {
      return res.json({ plans, subscription: null, access, usage: null, billing });
    }

    const supabase = getSupabaseClient();
    const [members, projects] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
      supabase.from('projects').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    ]);
    if (members.error) throw members.error;
    if (projects.error) throw projects.error;

    res.json({
      plans,
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            isUnlimited: subscription.is_unlimited,
            cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
            hasPaidSubscription: !!subscription.razorpay_subscription_id,
          }
        : null,
      access,
      usage: {
        users: members.count || 0,
        projects: projects.count || 0,
        liveCameraStreams: countActiveLiveStreams(company),
      },
      billing,
    });
  } catch (error) {
    console.error('Error loading subscription:', error);
    res.status(500).json({ error: 'Failed to load subscription', message: error.message });
  }
};

/**
 * POST /api/subscription/checkout  { plan: 'playground' | 'pilot' | 'production' }
 * Creates a Razorpay subscription; the browser then opens Razorpay Checkout with it.
 * Nothing is saved until the payment is confirmed (verify / webhook).
 */
const startCheckout = async (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!canManageBilling(req.user)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Only a workspace admin can choose a plan for the company' });
    }
    if (!PLANS[plan]) {
      return res.status(400).json({ error: 'Invalid plan', message: `Unknown plan: ${plan}` });
    }

    const sub = req.user.subscription;
    if (sub?.razorpay_subscription_id && sub.status === 'active') {
      return res.status(409).json({
        error: 'Already subscribed',
        message: 'Your company already has an active plan. Cancel it before choosing a different one.',
      });
    }

    const rzpSub = await razorpay.createSubscription({
      planId: plan,
      companyId: req.user.company_id,
      companyName: req.user.company,
      createdBy: req.user.id,
    });

    res.json({
      keyId: razorpay.getKeyId(),
      subscriptionId: rzpSub.id,
      plan: { id: plan, name: PLANS[plan].name, priceMonthlyInr: PLANS[plan].priceMonthlyInr },
      company: req.user.company,
    });
  } catch (error) {
    console.error('Error starting checkout:', error);
    res.status(error.status === 400 ? 400 : 500).json({ error: 'Could not start payment', message: error.message });
  }
};

/**
 * POST /api/subscription/verify  { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
 * Called after Razorpay Checkout succeeds. Checks the signature, then asks Razorpay
 * itself for the subscription before activating the plan - the browser's word alone is not trusted.
 */
const verifyCheckout = async (req, res) => {
  try {
    const {
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subscriptionId,
      razorpay_signature: signature,
    } = req.body || {};

    if (!paymentId || !subscriptionId || !signature) {
      return res.status(400).json({ error: 'Invalid request', message: 'Missing payment details' });
    }
    if (!razorpay.verifyCheckoutSignature({ paymentId, subscriptionId, signature })) {
      return res.status(400).json({ error: 'Invalid payment', message: 'Payment signature check failed' });
    }

    const rzpSub = await razorpay.fetchSubscription(subscriptionId);
    if (rzpSub.notes?.company_id !== req.user.company_id) {
      return res.status(403).json({ error: 'Forbidden', message: 'This payment belongs to a different company' });
    }

    const result = await razorpay.applyRazorpaySubscription(rzpSub);
    if (!result.applied || result.status !== 'active') {
      return res.status(409).json({
        error: 'Payment not completed',
        message: `Razorpay reports this subscription as "${rzpSub.status}". If you were charged, it will update shortly.`,
      });
    }

    invalidateCompanyCache(req.user.company_id);
    res.json({ success: true, plan: rzpSub.notes.plan_id, status: result.status });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ error: 'Could not confirm payment', message: error.message });
  }
};

/**
 * POST /api/subscription/cancel
 * Cancels at the end of the month already paid for; the plan stays active until then.
 */
const cancelSubscription = async (req, res) => {
  try {
    if (!canManageBilling(req.user)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Only a workspace admin can cancel the plan' });
    }
    const sub = req.user.subscription;
    if (!sub?.razorpay_subscription_id || sub.status !== 'active') {
      return res.status(400).json({ error: 'Nothing to cancel', message: 'Your company has no active paid plan' });
    }

    await razorpay.cancelSubscriptionAtPeriodEnd(sub.razorpay_subscription_id);

    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('company_subscriptions')
      .update({ cancel_at_period_end: true })
      .eq('company_id', req.user.company_id);
    if (error) throw error;

    invalidateCompanyCache(req.user.company_id);
    res.json({ success: true, cancelsOn: sub.current_period_end });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({ error: 'Could not cancel', message: error.message });
  }
};

/**
 * POST /api/subscription/webhook  (no login - Razorpay calls it; verified by signature)
 * Keeps company_subscriptions in step with renewals, failed payments and cancellations.
 */
const handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!razorpay.verifyWebhookSignature(req.rawBody, signature)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = req.body?.event || '';
    const rzpSub = req.body?.payload?.subscription?.entity;
    if (!event.startsWith('subscription.') || !rzpSub) {
      return res.json({ received: true, ignored: event });
    }

    const result = await razorpay.applyRazorpaySubscription(rzpSub);
    if (result.applied) invalidateCompanyCache(result.companyId);
    console.log(`[razorpay webhook] ${event} ${rzpSub.id} -> ${result.applied ? result.status : result.reason}`);
    res.json({ received: true });
  } catch (error) {
    console.error('Error handling Razorpay webhook:', error);
    // 500 makes Razorpay retry the event later
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

module.exports = {
  getSubscription,
  startCheckout,
  verifyCheckout,
  cancelSubscription,
  handleWebhook,
};
