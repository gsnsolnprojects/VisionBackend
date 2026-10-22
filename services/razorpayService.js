const crypto = require('crypto');
const { PLANS } = require('../utils/plans');
const { getSupabaseClient } = require('./supabaseService');

/**
 * Razorpay Service
 *
 * Talks to the Razorpay REST API (no SDK needed) for VisionM subscriptions:
 * - creates the Razorpay plan for each VisionM plan on first use
 * - creates / fetches / cancels subscriptions
 * - verifies checkout and webhook signatures
 * - copies a Razorpay subscription's state into company_subscriptions
 *
 * Keys come from .env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (and
 * RAZORPAY_WEBHOOK_SECRET for webhooks). Test keys (rzp_test_...) only move fake money.
 *
 * Everything VisionM creates in Razorpay carries notes.app = 'visionm', because the
 * same Razorpay account is also used by other GSN apps.
 */

const RAZORPAY_API = 'https://api.razorpay.com/v1';
const APP_TAG = 'visionm';

// How many monthly charges a subscription is set up for (1 year). UPI Autopay didn't show its
// checkout QR for a 10-year (120) mandate; 12 matches the GSN app whose UPI Autopay works.
// After the year the company picks the plan again from the Billing page.
const SUBSCRIPTION_TOTAL_COUNT = 12;

function getKeys() {
  const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId || !keySecret) {
    throw new Error('Online payments are not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing)');
  }
  return { keyId, keySecret };
}

async function razorpayRequest(method, path, body) {
  const { keyId, keySecret } = getKeys();
  const response = await fetch(`${RAZORPAY_API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.description || `Razorpay request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

// VisionM plan id -> Razorpay plan id, cached after the first lookup
const razorpayPlanIds = new Map();

/**
 * Razorpay plan id for a VisionM plan. Reuses a matching VisionM plan in Razorpay
 * (same plan, price, monthly) or creates one. A price change therefore creates a new
 * Razorpay plan; existing subscriptions keep their old price.
 */
async function getRazorpayPlanId(planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  const amount = plan.priceMonthlyInr * 100; // paise

  const cacheKey = `${planId}:${amount}`;
  if (razorpayPlanIds.has(cacheKey)) return razorpayPlanIds.get(cacheKey);

  let skip = 0;
  for (;;) {
    const page = await razorpayRequest('GET', `/plans?count=100&skip=${skip}`);
    const match = (page.items || []).find(
      (p) =>
        p.notes?.app === APP_TAG &&
        p.notes?.plan_id === planId &&
        p.period === 'monthly' &&
        p.interval === 1 &&
        p.item?.amount === amount &&
        p.item?.currency === 'INR'
    );
    if (match) {
      razorpayPlanIds.set(cacheKey, match.id);
      return match.id;
    }
    if (!page.items || page.items.length < 100) break;
    skip += 100;
  }

  const created = await razorpayRequest('POST', '/plans', {
    period: 'monthly',
    interval: 1,
    item: {
      name: `VisionM ${plan.name}`,
      amount,
      currency: 'INR',
      description: plan.tagline,
    },
    notes: { app: APP_TAG, plan_id: planId },
  });
  razorpayPlanIds.set(cacheKey, created.id);
  return created.id;
}

/** Start a monthly subscription for a company. The company pays for it in Razorpay Checkout. */
async function createSubscription({ planId, companyId, companyName, createdBy }) {
  const razorpayPlanId = await getRazorpayPlanId(planId);
  return razorpayRequest('POST', '/subscriptions', {
    plan_id: razorpayPlanId,
    total_count: SUBSCRIPTION_TOTAL_COUNT,
    quantity: 1,
    customer_notify: 1,
    notes: {
      app: APP_TAG,
      company_id: companyId,
      company_name: companyName || '',
      plan_id: planId,
      created_by: createdBy || '',
    },
  });
}

function fetchSubscription(subscriptionId) {
  return razorpayRequest('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/** Cancel at the end of the month already paid for (access continues until then). */
function cancelSubscriptionAtPeriodEnd(subscriptionId) {
  return razorpayRequest('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    cancel_at_cycle_end: 1,
  });
}

/** Cancel straight away (used when a company is deleted, so it is never charged again). */
function cancelSubscriptionNow(subscriptionId) {
  return razorpayRequest('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    cancel_at_cycle_end: 0,
  });
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** Signature Razorpay Checkout returns after a subscription payment */
function verifyCheckoutSignature({ paymentId, subscriptionId, signature }) {
  const { keySecret } = getKeys();
  const expected = crypto.createHmac('sha256', keySecret).update(`${paymentId}|${subscriptionId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

/** Signature Razorpay puts on webhook calls (X-Razorpay-Signature), over the raw request body */
function verifyWebhookSignature(rawBody, signature) {
  const secret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  if (!secret || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

// Razorpay subscription status -> company_subscriptions.status
const STATUS_MAP = {
  authenticated: 'active',
  active: 'active',
  pending: 'past_due', // a renewal payment failed; Razorpay is retrying
  halted: 'past_due', // all retries failed
  paused: 'past_due',
  cancelled: 'cancelled',
  completed: 'expired',
  expired: 'expired',
};

/**
 * Copy a Razorpay subscription's state into company_subscriptions.
 * Only VisionM subscriptions (notes.app = 'visionm') are applied.
 *
 * @param {Object} rzpSub - Razorpay subscription entity
 * @returns {Promise<{ applied: boolean, companyId?: string, status?: string, reason?: string }>}
 */
async function applyRazorpaySubscription(rzpSub) {
  const notes = rzpSub?.notes || {};
  if (notes.app !== APP_TAG || !notes.company_id || !PLANS[notes.plan_id]) {
    return { applied: false, reason: 'not a VisionM subscription' };
  }

  const status = STATUS_MAP[rzpSub.status];
  if (!status) {
    // 'created' = checkout opened but not paid yet; nothing to record
    return { applied: false, reason: `ignored status ${rzpSub.status}` };
  }

  const supabase = getSupabaseClient();
  const { data: current, error: readError } = await supabase
    .from('company_subscriptions')
    .select('razorpay_subscription_id, plan, status')
    .eq('company_id', notes.company_id)
    .maybeSingle();
  if (readError) throw readError;

  // Don't let a late event from an older, replaced subscription overwrite the current one
  if (current?.razorpay_subscription_id && current.razorpay_subscription_id !== rzpSub.id && status !== 'active') {
    return { applied: false, reason: 'event for a replaced subscription' };
  }
  // Nor let an old or abandoned subscription end a plan the superadmin gave for free
  const freeGrant = current && !current.razorpay_subscription_id && current.status === 'active';
  if (freeGrant && status !== 'active') {
    return { applied: false, reason: 'company has free access from the superadmin' };
  }

  const update = {
    company_id: notes.company_id,
    plan: notes.plan_id,
    status,
    razorpay_subscription_id: rzpSub.id,
    razorpay_customer_id: rzpSub.customer_id || null,
  };
  if (rzpSub.current_end) update.current_period_end = new Date(rzpSub.current_end * 1000).toISOString();
  if (status !== 'active') update.cancel_at_period_end = false;

  const { error } = await supabase.from('company_subscriptions').upsert(update, { onConflict: 'company_id' });
  if (error) throw error;
  return { applied: true, companyId: notes.company_id, status };
}

/**
 * Save a successful VisionM subscription charge in subscription_payments
 * (the superadmin Revenue page reads it). Safe to call twice for the same payment.
 *
 * @param {Object} payment - Razorpay payment entity (from the subscription.charged webhook)
 * @param {Object} rzpSub - Razorpay subscription entity it belongs to
 * @returns {Promise<{ recorded: boolean, reason?: string }>}
 */
async function recordSubscriptionPayment(payment, rzpSub) {
  const notes = rzpSub?.notes || {};
  if (notes.app !== APP_TAG || !notes.company_id) {
    return { recorded: false, reason: 'not a VisionM subscription' };
  }
  if (!payment?.id || payment.status !== 'captured') {
    return { recorded: false, reason: `payment not captured (${payment?.status || 'missing'})` };
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase.from('subscription_payments').upsert(
    {
      razorpay_payment_id: payment.id,
      company_id: notes.company_id,
      company_name: notes.company_name || null,
      razorpay_subscription_id: rzpSub.id,
      plan: notes.plan_id || null,
      amount_paise: payment.amount,
      currency: payment.currency || 'INR',
      status: payment.status,
      paid_at: new Date((payment.created_at || Date.now() / 1000) * 1000).toISOString(),
    },
    { onConflict: 'razorpay_payment_id' }
  );
  if (error) throw error;
  return { recorded: true };
}

module.exports = {
  createSubscription,
  fetchSubscription,
  cancelSubscriptionAtPeriodEnd,
  cancelSubscriptionNow,
  recordSubscriptionPayment,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  applyRazorpaySubscription,
  getKeyId: () => getKeys().keyId,
};
