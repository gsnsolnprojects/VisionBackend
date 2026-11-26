/**
 * /api/auth/*: sign up, sign in, tokens, email links, Google (replaces Supabase Auth).
 *
 * Web app: the refresh token lives in an httpOnly cookie (vm_rt, path /api/auth); the access
 * token is returned in JSON and kept in memory. Desktop / mobile apps send { client: 'native' }
 * and get the refresh token in the JSON body instead.
 */
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const auth = require('../services/authService');
const email = require('../services/emailService');
const { authenticateToken, invalidateUserCache } = require('../middleware/authMiddleware');

const router = express.Router();
const { AuthError } = auth;

const REFRESH_COOKIE = 'vm_rt';
const OAUTH_COOKIE = 'vm_oauth';
const isProduction = () => process.env.NODE_ENV === 'production';

// ---- helpers ---------------------------------------------------------------------------------

function allowedOrigins() {
  return (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => o && o !== '*');
}

/** Base URL of the web app for links in emails: the caller's own origin if we trust it */
function appUrl(req) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin && allowedOrigins().includes(origin)) return origin;
  return (process.env.APP_URL || 'https://visionm.gsnsoln.in').replace(/\/+$/, '');
}

/** Only allow redirects inside our own app: "/path" or a full URL on a trusted origin */
function safeRedirect(value, req, fallback = '/dashboard') {
  const v = String(value || '').trim();
  if (!v) return fallback;
  if (v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\')) return v;
  try {
    const u = new URL(v);
    const base = appUrl(req);
    if (u.origin === base || allowedOrigins().includes(u.origin)) return u.pathname + u.search + u.hash;
  } catch { /* not a URL */ }
  return fallback;
}

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: auth.REFRESH_TTL_MS,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: isProduction(), sameSite: 'lax', path: '/api/auth' });
}

const isNative = (req) => req.body?.client === 'native' || req.headers['x-client'] === 'native';
const readRefreshToken = (req) => req.cookies?.[REFRESH_COOKIE] || req.body?.refresh_token || null;

/** Same shape the Supabase session had, so the apps change as little as possible */
function sendSession(req, res, session, extra = {}) {
  if (!isNative(req)) setRefreshCookie(res, session.refreshToken);
  const body = {
    session: {
      access_token: session.accessToken,
      token_type: 'bearer',
      expires_in: session.expiresIn,
      expires_at: Math.floor(Date.now() / 1000) + session.expiresIn,
      user: auth.publicUser(session.user),
      ...(isNative(req) ? { refresh_token: session.refreshToken } : {}),
    },
    user: auth.publicUser(session.user),
    ...extra,
  };
  res.set('Cache-Control', 'no-store');
  return res.json(body);
}

function fail(res, err) {
  if (err instanceof AuthError) {
    return res.status(err.status).json({ error: err.message, message: err.message, code: err.code });
  }
  console.error('[auth] unexpected error:', err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.', message: 'Something went wrong. Please try again.', code: 'server_error' });
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => fail(res, err));

function limiter({ windowMinutes, max, byEmail = false, message }) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (byEmail ? `${req.ip}|${auth.normalizeEmail(req.body?.email)}` : req.ip),
    handler: (req, res, next, options) => {
      const retry = Math.ceil(options.windowMs / 1000);
      res.status(429).json({
        error: message || `Too many attempts. Please wait ${retry} seconds and try again.`,
        message: message || `Too many attempts. Please wait ${retry} seconds and try again.`,
        code: 'over_request_rate_limit',
      });
    },
  });
}

const loginLimiter = limiter({ windowMinutes: 15, max: 10, byEmail: true });
const signupLimiter = limiter({ windowMinutes: 60, max: 10 });
const emailLinkLimiter = limiter({ windowMinutes: 60, max: 10, byEmail: true });
const checkLimiter = limiter({ windowMinutes: 15, max: 30 });
const tokenLimiter = limiter({ windowMinutes: 15, max: 30 });

function requireEmail(value) {
  const e = auth.normalizeEmail(value);
  if (!auth.isValidEmail(e)) throw new AuthError(400, 'Please enter a valid email address.', 'invalid_email');
  return e;
}

function requireStrongPassword(value) {
  const problem = auth.passwordProblem(value);
  if (problem) throw new AuthError(422, problem, 'weak_password');
  return String(value);
}

/**
 * Email the confirmation link. The web app passes its own /verify-email address (it may carry
 * ?plan=... so the picked plan survives on another device); the token is added to it.
 */
async function sendVerifyEmail(req, user, redirectTo) {
  const page = redirectTo && redirectTo.startsWith('/verify-email') ? redirectTo : '/verify-email';
  const afterwards = redirectTo && !redirectTo.startsWith('/verify-email') ? redirectTo : '/dashboard';
  const token = await auth.createOneTimeToken({ user, email: user.email, purpose: 'verify_email', redirectTo: afterwards });
  const link = `${appUrl(req)}${page}${page.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  return email.verifyEmail({ to: user.email, name: user.raw_user_meta_data?.name, link });
}

/** A pending, unexpired organisation invite for this email (proves the person owns the inbox) */
async function validInviteFor(inviteToken, emailAddress) {
  if (!inviteToken) return null;
  return db.one(
    `select id, company_id, email from public.company_invites
      where token = $1 and lower(email) = lower($2) and coalesce(status, 'pending') not in ('accepted', 'revoked')
        and (expires_at is null or expires_at > now())`,
    [String(inviteToken), emailAddress]
  );
}

// ---- sign up / sign in ----------------------------------------------------------------------

router.post('/signup', signupLimiter, wrap(async (req, res) => {
  const emailAddress = requireEmail(req.body?.email);
  const password = requireStrongPassword(req.body?.password);
  const meta = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {};
  const metadata = {
    name: String(meta.name || req.body?.name || '').trim().slice(0, 120),
    phone: String(meta.phone || req.body?.phone || '').trim().slice(0, 40),
    ...(meta.signup_plan ? { signup_plan: String(meta.signup_plan).slice(0, 40) } : {}),
  };
  const redirectTo = safeRedirect(req.body?.redirectTo, req, '/dashboard');
  // Signing up from an emailed invite link already proves the inbox belongs to them
  const invite = await validInviteFor(req.body?.inviteToken, emailAddress);

  const existing = await auth.findUserByEmail(emailAddress);
  if (existing?.email_confirmed_at) {
    throw new AuthError(422, 'User already registered', 'user_already_exists');
  }

  let user;
  if (existing) {
    // Signed up before but never confirmed: take the new details and send a fresh link
    const wait = await auth.emailCooldownSeconds(emailAddress, 'verify_email');
    if (wait > 0 && !invite) {
      throw new AuthError(429, `For security purposes, you can only request this after ${wait} seconds.`, 'over_email_send_rate_limit');
    }
    await auth.setPassword(existing.id, password);
    await db.query(
      `update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1`,
      [existing.id, metadata]
    );
    await db.query(
      `update public.profiles set name = coalesce(nullif($2, ''), name), phone = coalesce(nullif($3, ''), phone) where id = $1`,
      [existing.id, metadata.name, metadata.phone]
    );
    user = await auth.getUserById(existing.id);
  } else {
    user = await auth.createUser({ email: emailAddress, password, metadata, confirmed: !!invite });
  }

  if (invite) {
    await auth.confirmEmail(user.id);
    user = await auth.getUserById(user.id);
    const session = await auth.startSession(user, req);
    return sendSession(req, res, session, { email_confirmation_required: false });
  }

  await sendVerifyEmail(req, user, redirectTo);
  res.json({ user: auth.publicUser(user), session: null, email_confirmation_required: true });
}));

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const user = await auth.checkPassword(req.body?.email, req.body?.password);
  const profile = await db.one('select is_active from public.profiles where id = $1', [user.id]);
  if (profile && profile.is_active === false) {
    throw new AuthError(403, 'Your account has been deactivated. Please contact your administrator.', 'user_banned');
  }
  const session = await auth.startSession(user, req);
  sendSession(req, res, session);
}));

router.post('/refresh', tokenLimiter, wrap(async (req, res) => {
  try {
    const session = await auth.refreshSession(readRefreshToken(req), req);
    sendSession(req, res, session);
  } catch (err) {
    if (err instanceof AuthError) clearRefreshCookie(res);
    throw err;
  }
}));

router.post('/logout', wrap(async (req, res) => {
  await auth.endSession(readRefreshToken(req));
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

router.post('/logout-all', authenticateToken, wrap(async (req, res) => {
  await auth.revokeAllSessions(req.user.id);
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

// ---- email links ----------------------------------------------------------------------------

router.post('/verify-email', tokenLimiter, wrap(async (req, res) => {
  const row = await auth.useOneTimeToken(req.body?.token, 'verify_email');
  if (!row) throw new AuthError(400, 'This confirmation link is invalid or has expired. Please request a new one.', 'otp_expired');
  const user = await auth.findUserByEmail(row.email);
  if (!user) throw new AuthError(400, 'This confirmation link is invalid or has expired. Please request a new one.', 'otp_expired');
  await auth.confirmEmail(user.id);
  invalidateUserCache(user.id);
  const session = await auth.startSession(await auth.getUserById(user.id), req);
  sendSession(req, res, session, { redirect_to: row.redirect_to || '/dashboard' });
}));

router.post('/resend-verification', emailLinkLimiter, wrap(async (req, res) => {
  const emailAddress = requireEmail(req.body?.email);
  const user = await auth.findUserByEmail(emailAddress);
  // Same answer whether or not the account exists
  if (user && !user.email_confirmed_at) {
    const wait = await auth.emailCooldownSeconds(emailAddress, 'verify_email');
    if (wait > 0) throw new AuthError(429, `For security purposes, you can only request this after ${wait} seconds.`, 'over_email_send_rate_limit');
    await sendVerifyEmail(req, user, safeRedirect(req.body?.redirectTo, req));
  }
  res.json({ ok: true });
}));

router.post('/forgot-password', emailLinkLimiter, wrap(async (req, res) => {
  const emailAddress = requireEmail(req.body?.email);
  const user = await auth.findUserByEmail(emailAddress);
  if (user) {
    const wait = await auth.emailCooldownSeconds(emailAddress, 'reset_password');
    if (wait > 0) throw new AuthError(429, `For security purposes, you can only request this after ${wait} seconds.`, 'over_email_send_rate_limit');
    const token = await auth.createOneTimeToken({ user, email: user.email, purpose: 'reset_password' });
    const link = `${appUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
    await email.resetPassword({ to: user.email, name: user.raw_user_meta_data?.name, link });
  }
  res.json({ ok: true });
}));

router.post('/reset-password', tokenLimiter, wrap(async (req, res) => {
  const password = requireStrongPassword(req.body?.password);
  const row = await auth.useOneTimeToken(req.body?.token, 'reset_password');
  if (!row) throw new AuthError(400, 'This reset link is invalid or has expired. Please request a new one.', 'otp_expired');
  const user = await auth.findUserByEmail(row.email);
  if (!user) throw new AuthError(400, 'This reset link is invalid or has expired. Please request a new one.', 'otp_expired');
  await auth.setPassword(user.id, password);
  await auth.confirmEmail(user.id); // they proved they own the inbox
  await auth.revokeAllSessions(user.id); // every other device has to sign in again
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

router.post('/magic-link', emailLinkLimiter, wrap(async (req, res) => {
  const emailAddress = requireEmail(req.body?.email);
  const user = await auth.findUserByEmail(emailAddress);
  if (user) {
    const wait = await auth.emailCooldownSeconds(emailAddress, 'magic_login');
    if (wait > 0) throw new AuthError(429, `For security purposes, you can only request this after ${wait} seconds.`, 'over_email_send_rate_limit');
    const redirectTo = safeRedirect(req.body?.redirectTo, req);
    const token = await auth.createOneTimeToken({ user, email: user.email, purpose: 'magic_login', redirectTo });
    const link = `${appUrl(req)}/auth/link?token=${encodeURIComponent(token)}`;
    await email.magicLogin({ to: user.email, link });
  }
  res.json({ ok: true });
}));

router.post('/magic-login', tokenLimiter, wrap(async (req, res) => {
  const row = await auth.useOneTimeToken(req.body?.token, 'magic_login');
  if (!row) throw new AuthError(400, 'This sign-in link is invalid or has expired. Please request a new one.', 'otp_expired');
  const user = await auth.findUserByEmail(row.email);
  if (!user || auth.isBanned(user)) throw new AuthError(400, 'This sign-in link is invalid or has expired. Please request a new one.', 'otp_expired');
  await auth.confirmEmail(user.id);
  const session = await auth.startSession(await auth.getUserById(user.id), req);
  sendSession(req, res, session, { redirect_to: row.redirect_to || '/dashboard' });
}));

router.post('/check-email', checkLimiter, wrap(async (req, res) => {
  const emailAddress = auth.normalizeEmail(req.body?.email);
  if (!auth.isValidEmail(emailAddress)) return res.status(400).json({ exists: false, error: 'Email is required' });
  const user = await auth.findUserByEmail(emailAddress);
  res.json({ exists: !!user });
}));

// ---- signed in ------------------------------------------------------------------------------

router.get('/me', authenticateToken, wrap(async (req, res) => {
  const user = await auth.getUserById(req.user.id);
  const [profile, company] = await Promise.all([
    db.one('select * from public.profiles where id = $1', [req.user.id]),
    req.user.company_id ? db.one('select * from public.companies where id = $1', [req.user.company_id]) : null,
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({ user: auth.publicUser(user), profile, company });
}));

router.post('/change-password', authenticateToken, wrap(async (req, res) => {
  const password = requireStrongPassword(req.body?.newPassword ?? req.body?.password);
  const user = await auth.getUserById(req.user.id);
  // People who already have a password must prove they know it; Google-only accounts set their first one
  if (user.encrypted_password) {
    try {
      await auth.checkPassword(user.email, req.body?.currentPassword);
    } catch {
      throw new AuthError(400, 'Your current password is incorrect.', 'invalid_credentials');
    }
  }
  await auth.setPassword(user.id, password);
  await db.query(
    `update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'needs_password_set' where id = $1`,
    [user.id]
  );
  // Keep this device signed in; sign out everywhere else
  const current = readRefreshToken(req);
  await db.query(
    `update auth.refresh_tokens set revoked_at = now()
      where user_id = $1 and revoked_at is null and ($2::text is null or token_hash <> $2)`,
    [user.id, current ? auth.sha256(current) : null]
  );
  res.json({ ok: true });
}));

// ---- Google ---------------------------------------------------------------------------------

function googleClient(req) {
  const redirectUri = `${(process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/api/auth/google/callback`;
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
}

router.get('/google', limiter({ windowMinutes: 15, max: 30 }), (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).send('Google sign-in is not configured.');
  }
  const state = crypto.randomBytes(16).toString('base64url');
  const returnTo = safeRedirect(req.query.redirectTo, req);
  const base = appUrl(req.query.origin ? { headers: { origin: req.query.origin } } : req);
  const stateCookie = jwt.sign({ state, returnTo, base }, process.env.AUTH_JWT_SECRET, { expiresIn: 600 });
  res.cookie(OAUTH_COOKIE, stateCookie, {
    httpOnly: true, secure: isProduction(), sameSite: 'lax', path: '/api/auth/google', maxAge: 10 * 60 * 1000,
  });
  const url = googleClient(req).generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  let base = (process.env.APP_URL || 'https://visionm.gsnsoln.in').replace(/\/+$/, '');
  const back = (path, error) => res.redirect(`${base}${path}${error ? `${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(error)}` : ''}`);
  try {
    let saved;
    try {
      saved = jwt.verify(req.cookies?.[OAUTH_COOKIE] || '', process.env.AUTH_JWT_SECRET);
    } catch {
      return back('/auth', 'Google sign-in took too long. Please try again.');
    }
    res.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' });
    base = saved.base || base;
    if (!req.query.state || req.query.state !== saved.state) return back('/auth', 'Google sign-in could not be verified. Please try again.');
    if (req.query.error) return back('/auth', 'Google sign-in was cancelled.');

    const client = googleClient(req);
    const { tokens } = await client.getToken(String(req.query.code || ''));
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    const g = ticket.getPayload();
    if (!g?.sub || !g.email) return back('/auth', 'Google did not share an email address.');
    if (!g.email_verified) return back('/auth', 'Your Google email address is not verified.');

    const identityData = { sub: g.sub, email: g.email, email_verified: true, name: g.name, full_name: g.name, avatar_url: g.picture, picture: g.picture, iss: g.iss };
    let user = null;
    const identity = await db.one(`select user_id from auth.identities where provider = 'google' and provider_id = $1`, [g.sub]);
    if (identity) user = await auth.getUserById(identity.user_id);
    if (!user) {
      user = await auth.findUserByEmail(g.email);
      if (!user) {
        user = await auth.createUser({ email: g.email, password: null, confirmed: true, provider: 'google', metadata: { name: g.name || '', full_name: g.name || '', avatar_url: g.picture || '', email: g.email } });
      }
      await db.query(
        `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
         values ($1, $2, $3, 'google', now(), now(), now())
         on conflict (provider_id, provider) do nothing`,
        [g.sub, user.id, identityData]
      );
      await db.query(
        `update auth.users set raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{providers}',
           (select coalesce(jsonb_agg(distinct p), '[]'::jsonb) from (
              select jsonb_array_elements_text(coalesce(raw_app_meta_data->'providers', '[]'::jsonb)) p union select 'google') x))
         where id = $1`,
        [user.id]
      );
    } else {
      await db.query(`update auth.identities set last_sign_in_at = now(), identity_data = $2, updated_at = now() where provider = 'google' and provider_id = $1`, [g.sub, identityData]);
    }
    await auth.confirmEmail(user.id);
    user = await auth.getUserById(user.id);
    if (auth.isBanned(user)) return back('/auth', 'Your account has been deactivated. Please contact your administrator.');
    const profile = await db.one('select is_active from public.profiles where id = $1', [user.id]);
    if (profile && profile.is_active === false) return back('/auth', 'Your account has been deactivated. Please contact your administrator.');

    const session = await auth.startSession(user, req);
    setRefreshCookie(res, session.refreshToken);
    // No tokens in the URL: the web app calls /api/auth/refresh with the cookie on arrival
    return res.redirect(`${base}${saved.returnTo || '/dashboard'}`);
  } catch (err) {
    console.error('[auth] Google callback failed:', err.message);
    return back('/auth', 'Google sign-in failed. Please try again.');
  }
});

module.exports = router;
module.exports._test = { safeRedirect, appUrl };
