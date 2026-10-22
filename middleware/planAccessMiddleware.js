const { countActiveLiveStreams } = require('../controllers/inferenceController');

/**
 * Plan access guard
 *
 * Runs after authentication on every /api request. Viewing (GET) is always allowed.
 * Creating or running things (POST / PUT / PATCH on the work areas below) needs an
 * active plan (req.user.access.mode === 'full', set by authMiddleware from the
 * company's subscription), and the plan's own limits:
 *  - no plan / payment stopped -> blocked ("choose a plan")
 *  - plans without trainOnOwnDatasets -> can't upload their own datasets; they work with
 *    GSN sample datasets instead (dataset count/size limits: datasetAllowanceMiddleware)
 *  - live camera -> limited to the plan's liveCameraStreams
 *
 * Stopping work (cancel / stop) stays allowed, so a company that stops paying can still
 * end jobs it started.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const GATED_PREFIXES = [
  '/api/dataset',
  '/api/train',
  '/api/inference',
  '/api/samples',
  '/api/models',
  '/api/mobile-inspect',
  '/api/actions',
];

const ALWAYS_ALLOWED = [
  /^\/api\/train\/[^/]+\/cancel$/,
  /^\/api\/inference\/[^/]+\/cancel$/,
  /^\/api\/inference\/live\/[^/]+\/stop$/,
  /^\/api\/inference\/live\/[^/]+\/frame$/, // frames of a live session that was allowed to start
  /^\/api\/inference\/edge\/live$/, // edge devices (no user login)
  /^\/api\/dataset\/[^/]+\/augment\/cancel$/,
];

const OWN_DATASET_UPLOADS = [/^\/api\/dataset\/upload$/, /^\/api\/dataset\/[^/]+\/files$/];

const PLAN_REQUIRED_MESSAGE =
  'Your workspace needs an active plan to do this. Choose a plan in Settings → Billing.';

function deny(res, code, message) {
  // 402 Payment Required; "error" carries the readable text because some screens only show that field
  return res.status(402).json({ error: message, message, code });
}

function requirePlanForWork(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();

  const urlPath = req.originalUrl.split('?')[0];
  if (!GATED_PREFIXES.some((prefix) => urlPath === prefix || urlPath.startsWith(`${prefix}/`))) return next();
  if (ALWAYS_ALLOWED.some((pattern) => pattern.test(urlPath))) return next();
  if (!req.user) return next(); // unauthenticated requests are rejected by authenticateToken itself

  const access = req.user.access;
  if (!access || access.mode !== 'full') {
    return deny(res, 'plan_required', PLAN_REQUIRED_MESSAGE);
  }

  if (access.features?.trainOnOwnDatasets === false && OWN_DATASET_UPLOADS.some((p) => p.test(urlPath))) {
    return deny(
      res,
      'plan_feature',
      'Your plan works with GSN sample datasets. Use "Add sample dataset", or upgrade your plan in Settings → Billing to upload your own.'
    );
  }

  if (urlPath === '/api/inference/live/start') {
    const limit = access.limits?.liveCameraStreams;
    if (limit === 0) {
      return deny(res, 'plan_feature', 'Live camera is not included in your plan. Upgrade in Settings → Billing.');
    }
    if (typeof limit === 'number' && countActiveLiveStreams(req.user.company) >= limit) {
      return deny(
        res,
        'plan_limit',
        `Your plan allows ${limit} live camera stream${limit === 1 ? '' : 's'} at a time. Stop one first.`
      );
    }
  }

  next();
}

module.exports = { requirePlanForWork, PLAN_REQUIRED_MESSAGE };
