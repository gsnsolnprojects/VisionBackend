/**
 * Subscription plans and access rules
 *
 * Single source of truth for plan prices, limits and features. The Billing page
 * reads these through GET /api/subscription, so change them here only.
 *
 * Limits: null = no limit.
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
      projects: 1,
      liveCameraStreams: 0,
    },
    features: {
      // Training only on GSN-provided datasets with the provided base models
      trainOnOwnDatasets: false,
      uploadImagesForInference: true,
      inspectionDashboard: false,
      downloadableReports: false,
      defectTrends: false,
      shiftReports: false,
      configurableAlerts: false,
    },
    highlights: [
      '1 user',
      '1 sandbox project with GSN datasets and base models',
      'Train your own model on the provided datasets',
      'Upload sample images to run inference (no live camera)',
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
      limits: { users: null, projects: null, liveCameraStreams: null },
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
    limits: plan ? plan.limits : { users: 0, projects: 0, liveCameraStreams: 0 },
    features: Object.fromEntries(Object.keys(PLANS.production.features).map((f) => [f, false])),
  };
}

module.exports = {
  PLANS,
  PLAN_ORDER,
  getCompanyAccess,
};
