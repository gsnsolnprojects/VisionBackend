/**
 * Our own login (replacing Supabase Auth).
 *
 * - Passwords: bcrypt. Old Supabase hashes ($2a$10$...) are checked as-is and upgraded to
 *   cost 12 on the next successful login.
 * - Access token: JWT (HS256, AUTH_JWT_SECRET), 15 minutes. Checked by authMiddleware.
 * - Refresh token: 32 random bytes, stored only as sha256, 30 days, replaced on every use.
 *   Using an already-replaced token revokes every token from that sign-in (theft signal).
 * - One-time tokens (verify email, reset password, sign-in link): random, sha256 stored,
 *   single use, short expiry.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REUSE_GRACE_MS = 30 * 1000; // concurrent refreshes from several tabs
const BCRYPT_COST = 12;
const ISSUER = 'vision-api';

const ONE_TIME_TTL_MS = {
  verify_email: 24 * 60 * 60 * 1000,
  reset_password: 60 * 60 * 1000,
  magic_login: 60 * 60 * 1000,
};

class AuthError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

function jwtSecret() {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_JWT_SECRET is missing or too short');
  return secret;
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;

// Same rule Supabase enforced: 6+ characters with lower, upper, digit and symbol
const SYMBOLS = "!@#$%^&*()_+-=[]{};':\"|<>?,./`~\\";
function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 6) return 'Password should be at least 6 characters.';
  if (p.length > 72) return 'Password should be at most 72 characters.';
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p) || ![...p].some((c) => SYMBOLS.includes(c))) {
    return 'Password should contain at least one lowercase letter, one uppercase letter, one number and one symbol.';
  }
  return null;
}

const hashPassword = (password) => bcrypt.hash(String(password), BCRYPT_COST);
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

// ---- Users ---------------------------------------------------------------------------------

const USER_COLUMNS = `id, email, encrypted_password, email_confirmed_at, raw_user_meta_data,
  raw_app_meta_data, created_at, updated_at, last_sign_in_at, banned_until, deleted_at`;

async function findUserByEmail(email, client) {
  const run = client ? (sql, p) => client.query(sql, p) : (sql, p) => db.query(sql, p);
  const { rows } = await run(
    `select ${USER_COLUMNS} from auth.users where lower(email) = $1 and deleted_at is null
      order by created_at limit 1`,
    [normalizeEmail(email)]
  );
  return rows[0] || null;
}

async function getUserById(id) {
  return db.one(`select ${USER_COLUMNS} from auth.users where id = $1 and deleted_at is null`, [id]);
}

function isBanned(user) {
  return !!(user?.banned_until && new Date(user.banned_until) > new Date());
}

/** Public shape sent to the apps (same field names the Supabase user object had) */
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    email_confirmed_at: user.email_confirmed_at,
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at,
    user_metadata: user.raw_user_meta_data || {},
    app_metadata: user.raw_app_meta_data || {},
  };
}

/**
 * Create an account. The on_auth_user_created trigger creates the profile from metadata
 * (name, phone). Returns the new user row.
 */
async function createUser({ email, password, metadata = {}, confirmed = false, provider = 'email' }, client) {
  const run = async (c) => {
    const passwordHash = password ? await hashPassword(password) : null;
    const { rows } = await c.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_user_meta_data, raw_app_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
         $1, $2, $3, $4, $5, now(), now(), false, false)
       returning ${USER_COLUMNS}`,
      [
        normalizeEmail(email),
        passwordHash,
        confirmed ? new Date() : null,
        metadata,
        { provider, providers: [provider] },
      ]
    );
    const user = rows[0];
    if (provider === 'email') {
      await c.query(
        `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
         values ($1::text, $1::uuid, $2, 'email', now(), now())`,
        [user.id, { sub: user.id, email: user.email, email_verified: confirmed }]
      );
    }
    return user;
  };
  return client ? run(client) : db.asSystem(run);
}

async function setPassword(userId, password) {
  const hash = await hashPassword(password);
  await db.query('update auth.users set encrypted_password = $2, updated_at = now() where id = $1', [userId, hash]);
}

async function confirmEmail(userId) {
  await db.query(
    `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = $1`,
    [userId]
  );
  await db.query('update public.profiles set is_verified = true where id = $1', [userId]);
}

/** Check email + password. Throws AuthError with the messages the apps already understand. */
async function checkPassword(email, password) {
  const user = await findUserByEmail(email);
  // Compare against a dummy hash when there's no user, so timing doesn't reveal which emails exist
  const hash = user?.encrypted_password || DUMMY_HASH;
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!user || !user.encrypted_password || !ok) {
    throw new AuthError(400, 'Invalid login credentials', 'invalid_credentials');
  }
  if (!user.email_confirmed_at) throw new AuthError(400, 'Email not confirmed', 'email_not_confirmed');
  if (isBanned(user)) throw new AuthError(403, 'Your account has been deactivated. Please contact your administrator.', 'user_banned');
  // Upgrade older / weaker hashes now that we know the password
  if (bcrypt.getRounds(user.encrypted_password) < BCRYPT_COST) {
    setPassword(user.id, password).catch((err) => console.warn('[auth] rehash failed:', err.message));
  }
  return user;
}

// ---- Sessions ------------------------------------------------------------------------------

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: 'authenticated' },
    jwtSecret(),
    { algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS, issuer: ISSUER }
  );
}

/** Returns { userId, email, expiresAt } or null */
function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'], issuer: ISSUER });
    if (!payload.sub) return null;
    return { userId: payload.sub, email: payload.email || null, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
}

function clientInfo(req) {
  return {
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300) || null,
    ip: req?.ip || null,
  };
}

/** New sign-in: returns { accessToken, refreshToken, expiresIn, user } */
async function startSession(user, req, familyId = crypto.randomUUID()) {
  const refreshToken = randomToken();
  const { userAgent, ip } = clientInfo(req);
  await db.query(
    `insert into auth.refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     values ($1, $2, $3, $4, $5, $6)`,
    [user.id, familyId, sha256(refreshToken), new Date(Date.now() + REFRESH_TTL_MS), userAgent, ip]
  );
  await db.query('update auth.users set last_sign_in_at = now() where id = $1', [user.id]);
  return { accessToken: signAccessToken(user), refreshToken, expiresIn: ACCESS_TTL_SECONDS, user };
}

/** Swap a refresh token for a new pair. Throws AuthError(401) when it can't be used. */
async function refreshSession(refreshToken, req) {
  if (!refreshToken) throw new AuthError(401, 'Not signed in', 'no_session');
  const tokenHash = sha256(refreshToken);
  const result = await db.asSystem(async (c) => {
    const { rows } = await c.query(
      'select * from auth.refresh_tokens where token_hash = $1 for update',
      [tokenHash]
    );
    const row = rows[0];
    if (!row) return { error: 'unknown' };
    if (row.revoked_at) {
      // Two tabs refreshing at the same moment both send the same token: the second one, within a
      // few seconds of the first and while the family is still live, is not a theft signal.
      const justRotated = row.replaced_by && Date.now() - new Date(row.revoked_at).getTime() < REUSE_GRACE_MS;
      const { rows: live } = justRotated
        ? await c.query('select 1 from auth.refresh_tokens where family_id = $1 and revoked_at is null and expires_at > now() limit 1', [row.family_id])
        : { rows: [] };
      if (!live.length) {
        // Already used or signed out: someone may be replaying a stolen token
        await c.query('update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where family_id = $1', [row.family_id]);
        return { error: 'reused' };
      }
      const next = randomToken();
      const { userAgent, ip } = clientInfo(req);
      await c.query(
        `insert into auth.refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
         values ($1, $2, $3, $4, $5, $6)`,
        [row.user_id, row.family_id, sha256(next), new Date(Date.now() + REFRESH_TTL_MS), userAgent, ip]
      );
      return { userId: row.user_id, refreshToken: next };
    }
    if (new Date(row.expires_at) <= new Date()) return { error: 'expired' };
    const next = randomToken();
    const { userAgent, ip } = clientInfo(req);
    const { rows: inserted } = await c.query(
      `insert into auth.refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [row.user_id, row.family_id, sha256(next), new Date(Date.now() + REFRESH_TTL_MS), userAgent, ip]
    );
    await c.query('update auth.refresh_tokens set revoked_at = now(), replaced_by = $2 where id = $1', [row.id, inserted[0].id]);
    return { userId: row.user_id, refreshToken: next };
  });
  if (result.error) throw new AuthError(401, 'Your session has ended. Please sign in again.', `refresh_${result.error}`);
  const user = await getUserById(result.userId);
  if (!user) throw new AuthError(401, 'Your session has ended. Please sign in again.', 'user_gone');
  if (isBanned(user)) {
    await revokeAllSessions(user.id);
    throw new AuthError(403, 'Your account has been deactivated. Please contact your administrator.', 'user_banned');
  }
  return { accessToken: signAccessToken(user), refreshToken: result.refreshToken, expiresIn: ACCESS_TTL_SECONDS, user };
}

async function endSession(refreshToken) {
  if (!refreshToken) return;
  await db.query('update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where token_hash = $1', [sha256(refreshToken)]);
}

async function revokeAllSessions(userId) {
  await db.query('update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where user_id = $1 and revoked_at is null', [userId]);
}

// ---- One-time tokens -----------------------------------------------------------------------

async function createOneTimeToken({ user, email, purpose, redirectTo = null }) {
  if (!ONE_TIME_TTL_MS[purpose]) throw new Error(`unknown token purpose ${purpose}`);
  const token = randomToken();
  // Only the newest link of each kind works
  await db.query(
    'update auth.one_time_tokens set used_at = now() where lower(email) = lower($1) and purpose = $2 and used_at is null',
    [email, purpose]
  );
  await db.query(
    `insert into auth.one_time_tokens (user_id, email, purpose, token_hash, redirect_to, expires_at)
     values ($1, lower($2), $3, $4, $5, $6)`,
    [user?.id || null, email, purpose, sha256(token), redirectTo, new Date(Date.now() + ONE_TIME_TTL_MS[purpose])]
  );
  return token;
}

/** Use a one-time token. Returns the token row (with user_id, email, redirect_to) or null. */
async function useOneTimeToken(token, purpose) {
  if (!token) return null;
  const { rows } = await db.query(
    `update auth.one_time_tokens set used_at = now()
      where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
      returning user_id, email, redirect_to`,
    [sha256(token), purpose]
  );
  return rows[0] || null;
}

/** Seconds until another email of this kind may be sent to this address (0 = now) */
async function emailCooldownSeconds(email, purpose, windowSeconds = 60) {
  const row = await db.one(
    `select extract(epoch from (max(created_at) + make_interval(secs => $3) - now()))::int as wait
       from auth.one_time_tokens where lower(email) = lower($1) and purpose = $2`,
    [email, purpose, windowSeconds]
  );
  return Math.max(0, row?.wait || 0);
}

module.exports = {
  AuthError,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_MS,
  normalizeEmail,
  isValidEmail,
  passwordProblem,
  hashPassword,
  findUserByEmail,
  getUserById,
  isBanned,
  publicUser,
  createUser,
  setPassword,
  confirmEmail,
  checkPassword,
  signAccessToken,
  verifyAccessToken,
  startSession,
  refreshSession,
  endSession,
  revokeAllSessions,
  createOneTimeToken,
  useOneTimeToken,
  emailCooldownSeconds,
  sha256,
};
