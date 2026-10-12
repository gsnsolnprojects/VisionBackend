const { VALID_ROLES } = require('../utils/permissions');
const { getSupabaseClient } = require('../services/supabaseService');
const { getCompanyAccess } = require('../utils/plans');

/**
 * Authentication Middleware
 *
 * Verifies the Supabase access token sent in the Authorization header and loads
 * the user's role and company from the Supabase profiles table.
 *
 * The X-User-* headers that clients still send are NOT trusted: identity, role
 * and company always come from the verified token + database, so a caller can't
 * claim to be someone else (or an admin) by editing headers.
 */

// Verified tokens, so we don't call Supabase on every request (token -> { userId, email, expiresAt })
const tokenCache = new Map();
const TOKEN_CACHE_MS = 5 * 60 * 1000;

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

/** Expiry time (ms) inside a JWT, or null if it can't be read */
function getJwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Verify the token with Supabase (cached). Returns { userId, email } or null */
async function verifyToken(token) {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) return cached;

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    tokenCache.delete(token);
    return null;
  }

  const jwtExpiry = getJwtExpiryMs(token);
  const entry = {
    userId: data.user.id,
    email: data.user.email || null,
    expiresAt: Math.min(now + TOKEN_CACHE_MS, jwtExpiry || now + TOKEN_CACHE_MS),
  };
  tokenCache.set(token, entry);
  pruneCache(tokenCache);
  return entry;
}

/** Load role / company for a user from Supabase (cached). Returns null if no profile */
async function loadProfile(userId) {
  const now = Date.now();
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.profile;

  const supabase = getSupabaseClient();
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, email, role, company_id, is_active')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;

  let companyName = null;
  let subscription = null;
  if (profile?.company_id) {
    const [{ data: company, error: companyError }, { data: subRow, error: subError }] = await Promise.all([
      supabase.from('companies').select('name').eq('id', profile.company_id).maybeSingle(),
      supabase
        .from('company_subscriptions')
        .select('plan, status, current_period_end, is_unlimited')
        .eq('company_id', profile.company_id)
        .maybeSingle(),
    ]);
    if (companyError) throw companyError;
    companyName = company?.name || null;
    // A subscription lookup problem must never block sign-in; treat it as "no plan"
    if (subError) console.warn('[auth] Could not load company subscription:', subError.message);
    subscription = subError ? null : subRow || null;
  }

  const result = profile ? { ...profile, company_name: companyName, subscription } : null;
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
  if (profile.is_active === false) {
    return { status: 403, error: 'Forbidden', message: 'Your account has been deactivated. Please contact your administrator.' };
  }

  // Same fallback the frontend uses: missing / legacy roles map to the closest current role
  let role = LEGACY_ROLES[profile.role] || profile.role || 'viewer';
  if (!VALID_ROLES.includes(role)) role = 'viewer';

  return {
    user: {
      id: profile.id,
      email: profile.email || verified.email,
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
 * Verifies the Supabase access token and attaches the user to req.user.
 *
 * Required header:
 * - Authorization: Bearer <Supabase access token>
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

module.exports = {
  authenticateToken,
  optionalAuthenticateToken,
  invalidateUserCache
};
