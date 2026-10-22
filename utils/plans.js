/**
 * Subscription plans and access rules
 *
 * Single source of truth for plan prices, limits and features. The Billing page
 * reads these through GET /api/subscription, so change them here only.
 *
 * Limits: null = no limit.
 *  - ownDatasets: datasets the company uploads itself (GSN sample links don't count)
 *  - imagesPerDataset / maxImageSizeMB: per uploaded dataset and per image file
 *  - trainingRunsPerMonth / predictionsPerMonth: reset each calendar month (India time),
 *    failed or cancelled runs don't count; predictions count images, not batches
 */

const PLANS = {
  playground: {
    id: 'playground',
    name: 'Playground Edition',
    tagline: 'Explore AI inspection',
    bestFor: 'Teams exploring feasibility',
    priceMonthlyInr: 999,
    limits: {
      users: 1,
      projects: 2,
      liveCameraStreams: 0,
      ownDatasets: 1,
      imagesPerDataset: 500,
      maxImageSizeMB: 5,
      trainingRunsPerMonth: 5,
      predictionsPerMonth: 1000,
    },
    features: {
      // One uploaded dataset of its own, plus GSN sample datasets
      trainOnOwnDatasets: true,
      uploadImagesForInference: true,
      inspectionDashboard: false,
      downloadableReports: false,
      defectTrends: false,
      shiftReports: false,
      configurableAlerts: false,
    },
    highlights: [
      '1 user · 2 projects',
      '1 dataset of your own (up to 500 images, 5 MB each) plus GSN sample datasets',
      '5 training runs a month (nano and small models, latest 2 kept)',
      '1,000 image predictions a month (no live camera)',
      'Defect previews and confidence scores',
      'Email support',
    ],
  },
  pilot: {
    id: 'pilot',
    name: 'Pilot Edition',
    tagline: 'Validate on your line',
    bestFor: 'A single inspection use case',
    priceMonthlyInr: 9999,
    limits: {
      users: 3,
      projects: 1,
      liveCameraStreams: 1,
      ownDatasets: null,
      imagesPerDataset: null,
      maxImageSizeMB: null,
      trainingRunsPerMonth: null,
      predictionsPerMonth: null,
    },
    features: {
      trainOnOwnDatasets: true,
      uploadImagesForInference: true,
      inspectionDashboard: true,
      downloadableReports: true,
      defectTrends: false,
      shiftReports: false,
      configurableAlerts: false,
    },
    highlights: [
      'Up to 3 users',
      '1 configured inspection use case',
      '1 live camera stream',
      'Inspection dashboard and defect history',
      'Downloadable reports',
      'Remote onboarding and email support',
    ],
  },
  production: {
    id: 'production',
    name: 'Production Edition',
    tagline: 'Run live inspection',
    bestFor: 'A defined production checkpoint',
    priceMonthlyInr: 19999,
    limits: {
      users: 5,
      projects: 3,
      liveCameraStreams: 2,
      ownDatasets: null,
      imagesPerDataset: null,
      maxImageSizeMB: null,
      trainingRunsPerMonth: null,
      predictionsPerMonth: null,
    },
    features: {
      trainOnOwnDatasets: true,
      uploadImagesForInference: true,
      inspectionDashboard: true,
      downloadableReports: true,
      defectTrends: true,
      shiftReports: true,
      configurableAlerts: true,
    },
    highlights: [
      'Up to 5 users',
      'Up to 3 configured inspection use cases',
      'Up to 2 live camera streams',
      'Dashboard, defect trends and shift reports',
      'Reports and configurable alerts',
      'Priority remote support',
    ],
  },
};

const PLAN_ORDER = ['playground', 'pilot', 'production'];

/**
 * Work out what a company may do from its subscription row.
 *
 * mode:
 *  - 'full'      : active plan (or internal unlimited access) - normal use within limits
 *  - 'view_only' : no plan / payment stopped - can view data, can't create or run anything
 *
 * @param {Object|null} subscription - company_subscriptions row (or null if missing)
 * @param {Date} [now]
 */
function getCompanyAccess(subscription, now = new Date()) {
  const sub = subscription || {};
  const plan = PLANS[sub.plan] || null;

  if (sub.is_unlimited) {
    return {
      mode: 'full',
      reason: 'unlimited',
      plan: plan ? plan.id : null,
      limits: Object.fromEntries(Object.keys(PLANS.playground.limits).map((k) => [k, null])),
      features: Object.fromEntries(Object.keys(PLANS.production.features).map((f) => [f, true])),
    };
  }

  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
  const paidUp = sub.status === 'active' && (!periodEnd || periodEnd > now);

  if (plan && paidUp) {
    return { mode: 'full', reason: 'active', plan: plan.id, limits: plan.limits, features: plan.features };
  }

  return {
    mode: 'view_only',
    reason: !plan ? 'no_plan' : sub.status === 'active' ? 'expired' : sub.status || 'no_plan',
    plan: plan ? plan.id : null,
    limits: plan ? plan.limits : Object.fromEntries(Object.keys(PLANS.playground.limits).map((k) => [k, 0])),
    features: Object.fromEntries(Object.keys(PLANS.production.features).map((f) => [f, false])),
  };
}

module.exports = {
  PLANS,
  PLAN_ORDER,
  getCompanyAccess,
};
