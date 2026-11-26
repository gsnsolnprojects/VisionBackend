const { VALID_ROLES } = require('../utils/permissions');
const { getCompanyAccess } = require('../utils/plans');
const db = require('../db');
const { verifyAccessToken, isBanned } = require('../services/authService');

/**
 * Authentication Middleware
 *
 * Verifies our own access token (JWT signed with AUTH_JWT_SECRET, see services/authService.js)
 * sent in the Authorization header and loads the user's role and company from the profiles table.
 *
 * The X-User-* headers that clients still send are NOT trusted: identity, role
 * and company always come from the verified token + database, so a caller can't
 * claim to be someone else (or an admin) by editing headers.
 */

// Profile + company per user; short-lived so role / deactivation changes apply within seconds
const profileCache = new Map();
const PROFILE_CACHE_MS = 30 * 1000;

const MAX_CACHE_ENTRIES = 2000;

// Legacy role values still present on some profiles
const LEGACY_ROLES = { admin: 'workspace_admin', member: 'viewer' };

function pruneCache(cache) {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  // Still too big: drop the oldest entries
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

/** Verify the access token (no network call). Returns { userId, email } or null */
async function verifyToken(token) {
  return verifyAccessToken(token);
}

/** Load role / company for a user (cached). Returns null if no profile */
async function loadProfile(userId) {
  const now = Date.now();
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.profile;

  const profile = await db.one(
    `select p.id, p.email, p.name, p.role, p.company_id, p.is_active, c.name as company_name,
            u.banned_until
       from public.profiles p
       join auth.users u on u.id = p.id
       left join public.companies c on c.id = p.company_id
      where p.id = $1 and u.deleted_at is null`,
    [userId]
  );

  let subscription = null;
  if (profile?.company_id) {
    try {
      subscription = await db.one('select * from public.company_subscriptions where company_id = $1', [profile.company_id]);
    } catch (subError) {
      // A subscription lookup problem must never block sign-in; treat it as "no plan"
      console.warn('[auth] Could not load company subscription:', subError.message);
    }
  }

  const result = profile ? { ...profile, subscription } : null;
  profileCache.set(userId, { profile: result, expiresAt: now + PROFILE_CACHE_MS });
  pruneCache(profileCache);
  return result;
}

/**
 * Resolve the signed-in user for a request.
 * Returns { user } on success or { status, error, message } on failure.
 */
async function resolveUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return { status: 401, error: 'Unauthorized', message: 'Missing or invalid Authorization header' };
  }

  const verified = await verifyToken(token);
  if (!verified) {
    return { status: 401, error: 'Unauthorized', message: 'Invalid or expired session. Please sign in again.' };
  }

  const profile = await loadProfile(verified.userId);
  if (!profile) {
    return { status: 403, error: 'Forbidden', message: 'User profile not found' };
  }
  if (profile.is_active === false || isBanned(profile)) {
    return { status: 403, error: 'Forbidden', message: 'Your account has been deactivated. Please contact your administrator.' };
  }

  // Same fallback the frontend uses: missing / legacy roles map to the closest current role
  let role = LEGACY_ROLES[profile.role] || profile.role || 'viewer';
  if (!VALID_ROLES.includes(role)) role = 'viewer';

  return {
    user: {
      id: profile.id,
      email: profile.email || verified.email,
      name: profile.name || null,
      role,
      company_id: profile.company_id || null,
      company: profile.company_name, // Company name, used to scope MongoDB data (e.g. "gsn")
      subscription: profile.subscription, // company_subscriptions row, or null
      access: getCompanyAccess(profile.subscription) // { mode: 'full' | 'view_only', limits, features, ... }
    }
  };
}

/**
 * Authenticate token middleware
 * Verifies the access token and attaches the user to req.user.
 *
 * Required header:
 * - Authorization: Bearer <access token from /api/auth/login or /api/auth/refresh>
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function authenticateToken(req, res, next) {
  // Already verified earlier in the chain (global /api middleware + per-route middleware)
  if (req.user) return next();

  try {
    const result = await resolveUser(req);
    if (!result.user) {
      return res.status(result.status).json({ error: result.error, message: result.message });
    }
    req.user = result.user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Optional authentication middleware
 * Same as authenticateToken, but continues without req.user when there is no valid session.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function optionalAuthenticateToken(req, res, next) {
  if (req.user) return next();

  try {
    const result = await resolveUser(req);
    if (result.user) req.user = result.user;
  } catch (error) {
    console.error('Optional authentication error:', error);
  }
  next();
}

/** Drop cached profile data for a user, e.g. right after their role changes */
function invalidateUserCache(userId) {
  profileCache.delete(userId);
}

/** Drop cached profile data for every member of a company, e.g. right after its plan changes */
function invalidateCompanyCache(companyId) {
  for (const [userId, entry] of profileCache) {
    if (entry.profile?.company_id === companyId) profileCache.delete(userId);
  }
}

module.exports = {
  authenticateToken,
  optionalAuthenticateToken,
  invalidateUserCache,
  invalidateCompanyCache
};
