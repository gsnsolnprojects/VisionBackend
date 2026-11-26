/**
 * Tests for our own login (/api/auth), invite links (/api/invites) and account data (/api/account).
 *
 * Runs against a throwaway copy of the accounts database:
 *   docker exec vision-pg-dev psql -U postgres -d postgres -c "drop database if exists vision_test" -c "create database vision_test template vision"
 *   TEST_DATABASE_URL=postgres://vision_app:devapp@127.0.0.1:5433/vision_test node --test tests/
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://vision_app:devapp@127.0.0.1:5433/vision_test';
process.env.AUTH_JWT_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.EMAIL_MODE = 'log';
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGIN = 'http://localhost:8080';
process.env.APP_URL = 'http://localhost:8080';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { outbox } = require('../services/emailService');
const { authenticateToken } = require('../middleware/authMiddleware');

let server;
let base;
const STRONG = 'Str0ng!Pass';
const uniq = () => crypto.randomBytes(4).toString('hex');

before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(require('cookie-parser')());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/invites', require('../routes/invitesPublic'));
  app.use('/api/account', authenticateToken, require('../routes/account'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

/** Tiny client: remembers the refresh cookie like a browser would */
function client() {
  let cookie = null;
  let token = null;
  async function call(method, path, body, headers = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:8080',
        'x-forwarded-for': `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/vm_rt=([^;]*)/);
      if (m) cookie = m[1] ? `vm_rt=${m[1]}` : null;
    }
    const json = await res.json().catch(() => ({}));
    if (json?.session?.access_token) token = json.session.access_token;
    return { status: res.status, body: json };
  }
  return {
    call,
    get token() { return token; },
    set token(v) { token = v; },
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

const lastLink = (to, path) => {
  const mail = [...outbox].reverse().find((m) => m.to === to && m.text.includes(path));
  assert.ok(mail, `expected an email to ${to} containing ${path}`);
  return new URL(mail.text.match(/https?:\/\/\S+/)[0]);
};

/** Sign up, confirm by email link, return a signed-in client */
async function newUser(name = 'Test User') {
  const email = `t_${uniq()}@example.com`;
  const c = client();
  const signup = await c.call('POST', '/api/auth/signup', { email, password: STRONG, data: { name, phone: '+911234567890' } });
  assert.equal(signup.status, 200, JSON.stringify(signup.body));
  assert.equal(signup.body.email_confirmation_required, true);
  const link = lastLink(email, '/verify-email');
  const verify = await c.call('POST', '/api/auth/verify-email', { token: link.searchParams.get('token') });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  const me = await c.call('GET', '/api/auth/me');
  return { c, email, id: me.body.user.id };
}

// ---- login --------------------------------------------------------------------------------

test('sign up needs a confirmed email before signing in', async () => {
  const email = `t_${uniq()}@example.com`;
  const c = client();
  const signup = await c.call('POST', '/api/auth/signup', { email, password: STRONG, data: { name: 'Asha', phone: '+91999' } });
  assert.equal(signup.status, 200);
  assert.equal(signup.body.session, null);

  const early = await c.call('POST', '/api/auth/login', { email, password: STRONG });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /Email not confirmed/);

  const link = lastLink(email, '/verify-email');
  assert.equal(link.origin, 'http://localhost:8080');
  const verify = await c.call('POST', '/api/auth/verify-email', { token: link.searchParams.get('token') });
  assert.equal(verify.status, 200);
  assert.ok(verify.body.session.access_token);
  assert.ok(c.cookie, 'refresh cookie set');

  const again = await c.call('POST', '/api/auth/verify-email', { token: link.searchParams.get('token') });
  assert.equal(again.status, 400, 'a link works only once');

  const me = await c.call('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.profile.name, 'Asha', 'the profile was created from the sign-up details');
  assert.equal(me.body.profile.is_verified, true);
});

test('the confirmation link keeps the plan the person picked', async () => {
  const email = `t_${uniq()}@example.com`;
  await client().call('POST', '/api/auth/signup', { email, password: STRONG, redirectTo: 'http://localhost:8080/verify-email?plan=pilot' });
  const link = lastLink(email, '/verify-email');
  assert.equal(link.pathname, '/verify-email');
  assert.equal(link.searchParams.get('plan'), 'pilot');
  assert.ok(link.searchParams.get('token'));
});

test('wrong password, unknown email and weak passwords are refused with the usual messages', async () => {
  const { email } = await newUser();
  const c = client();
  const wrong = await c.call('POST', '/api/auth/login', { email, password: 'Wr0ng!Pass' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /Invalid login credentials/);
  const unknown = await c.call('POST', '/api/auth/login', { email: `nobody_${uniq()}@example.com`, password: STRONG });
  assert.match(unknown.body.error, /Invalid login credentials/);
  for (const weak of ['short', 'alllowercase1!', 'NoDigits!!', 'NoSymbol123']) {
    const r = await c.call('POST', '/api/auth/signup', { email: `w_${uniq()}@example.com`, password: weak });
    assert.equal(r.status, 422, `${weak} should be refused`);
  }
});

test('signing up again with a confirmed email says "User already registered"', async () => {
  const { email } = await newUser();
  const r = await client().call('POST', '/api/auth/signup', { email, password: STRONG });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /User already registered/);
});

test('an old Supabase-style $2a$10 password hash still works and is upgraded to cost 12', async () => {
  const { email, id } = await newUser();
  const legacy = await bcrypt.hash('Old!Pass1', 10);
  await db.query('update auth.users set encrypted_password = $2 where id = $1', [id, legacy.replace(/^\$2b\$/, '$2a$')]);
  const r = await client().call('POST', '/api/auth/login', { email, password: 'Old!Pass1' });
  assert.equal(r.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const row = await db.one('select encrypted_password from auth.users where id = $1', [id]);
  assert.equal(bcrypt.getRounds(row.encrypted_password), 12);
});

test('refresh tokens rotate, and reusing an old one ends the whole sign-in', async () => {
  const { c } = await newUser();
  const first = c.cookie;
  const r1 = await c.call('POST', '/api/auth/refresh');
  assert.equal(r1.status, 200);
  const second = c.cookie;
  assert.notEqual(first, second);

  // A second tab refreshing with the same token a moment later is fine (grace period)
  const tab2 = client();
  tab2.cookie = first;
  assert.equal((await tab2.call('POST', '/api/auth/refresh')).status, 200);

  // ...but an attacker replaying it after the grace period ends the whole sign-in
  await db.query("update auth.refresh_tokens set revoked_at = now() - interval '5 minutes' where token_hash = $1", [
    require('../services/authService').sha256(first.replace(/^vm_rt=/, '')),
  ]);
  const attacker = client();
  attacker.cookie = first;
  const replay = await attacker.call('POST', '/api/auth/refresh');
  assert.equal(replay.status, 401);

  // ...which also ends the real user's current token
  const r2 = await c.call('POST', '/api/auth/refresh');
  assert.equal(r2.status, 401);
});

test('logging out ends the refresh token', async () => {
  const { c } = await newUser();
  const saved = c.cookie;
  assert.equal((await c.call('POST', '/api/auth/logout')).status, 200);
  const other = client();
  other.cookie = saved;
  assert.equal((await other.call('POST', '/api/auth/refresh')).status, 401);
});

test('native apps get the refresh token in the body instead of a cookie', async () => {
  const { email } = await newUser();
  const c = client();
  const r = await c.call('POST', '/api/auth/login', { email, password: STRONG, client: 'native' });
  assert.equal(r.status, 200);
  assert.ok(r.body.session.refresh_token);
  assert.equal(c.cookie, null);
  const refreshed = await c.call('POST', '/api/auth/refresh', { client: 'native', refresh_token: r.body.session.refresh_token });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.session.refresh_token);
});

test('password reset: link works once, old password stops working, other devices are signed out', async () => {
  const { c, email } = await newUser();
  const otherDevice = c.cookie;
  assert.equal((await client().call('POST', '/api/auth/forgot-password', { email })).status, 200);
  const link = lastLink(email, '/reset-password');
  const token = link.searchParams.get('token');
  const weak = await client().call('POST', '/api/auth/reset-password', { token, password: 'weak' });
  assert.equal(weak.status, 422);
  const ok = await client().call('POST', '/api/auth/reset-password', { token, password: 'N3w!Password' });
  assert.equal(ok.status, 200);
  assert.equal((await client().call('POST', '/api/auth/reset-password', { token, password: 'N3w!Password2' })).status, 400);
  assert.match((await client().call('POST', '/api/auth/login', { email, password: STRONG })).body.error, /Invalid login credentials/);
  assert.equal((await client().call('POST', '/api/auth/login', { email, password: 'N3w!Password' })).status, 200);
  const old = client();
  old.cookie = otherDevice;
  assert.equal((await old.call('POST', '/api/auth/refresh')).status, 401);
});

test('forgot-password answers the same for unknown emails', async () => {
  const r = await client().call('POST', '/api/auth/forgot-password', { email: `nobody_${uniq()}@example.com` });
  assert.equal(r.status, 200);
});

test('change password needs the current password', async () => {
  const { c, email } = await newUser();
  const bad = await c.call('POST', '/api/auth/change-password', { currentPassword: 'Wr0ng!Pass', newPassword: 'An0ther!Pass' });
  assert.equal(bad.status, 400);
  const good = await c.call('POST', '/api/auth/change-password', { currentPassword: STRONG, newPassword: 'An0ther!Pass' });
  assert.equal(good.status, 200);
  assert.equal((await client().call('POST', '/api/auth/login', { email, password: 'An0ther!Pass' })).status, 200);
});

test('forged, tampered and expired access tokens are refused', async () => {
  const { c, id, email } = await newUser();
  const forged = jwt.sign({ sub: id, email, role: 'authenticated' }, 'not-our-secret', { issuer: 'vision-api', expiresIn: 600 });
  const expired = jwt.sign({ sub: id, email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) - 10 }, process.env.AUTH_JWT_SECRET, { issuer: 'vision-api' });
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, iss: 'vision-api' })).toString('base64url')}.`;
  for (const bad of [forged, expired, none, 'garbage']) {
    const t = client();
    t.token = bad;
    assert.equal((await t.call('GET', '/api/auth/me')).status, 401);
  }
  assert.equal((await c.call('GET', '/api/auth/me')).status, 200);
});

test('a deactivated or banned user cannot sign in or refresh', async () => {
  const { c, email, id } = await newUser();
  await db.query('update public.profiles set is_active = false where id = $1', [id]);
  const r = await client().call('POST', '/api/auth/login', { email, password: STRONG });
  assert.equal(r.status, 403);
  await db.query('update public.profiles set is_active = true where id = $1', [id]);
  await db.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [id]);
  assert.equal((await client().call('POST', '/api/auth/login', { email, password: STRONG })).status, 403);
  assert.equal((await c.call('POST', '/api/auth/refresh')).status, 403);
});

test('check-email tells whether an account exists', async () => {
  const { email } = await newUser();
  assert.equal((await client().call('POST', '/api/auth/check-email', { email: email.toUpperCase() })).body.exists, true);
  assert.equal((await client().call('POST', '/api/auth/check-email', { email: `nobody_${uniq()}@example.com` })).body.exists, false);
});

test('magic sign-in link works once', async () => {
  const { email } = await newUser();
  const c = client();
  assert.equal((await c.call('POST', '/api/auth/magic-link', { email, redirectTo: '/dashboard?x=1' })).status, 200);
  const token = lastLink(email, '/auth/link').searchParams.get('token');
  const r = await c.call('POST', '/api/auth/magic-login', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.redirect_to, '/dashboard?x=1');
  assert.equal((await client().call('POST', '/api/auth/magic-login', { token })).status, 400);
});

test('redirects only stay inside our app', () => {
  const { safeRedirect } = require('../routes/auth')._test;
  const req = { headers: { origin: 'http://localhost:8080' } };
  assert.equal(safeRedirect('/dashboard', req), '/dashboard');
  assert.equal(safeRedirect('//evil.com/x', req), '/dashboard');
  assert.equal(safeRedirect('https://evil.com/x', req), '/dashboard');
  assert.equal(safeRedirect('http://localhost:8080/projects?a=1', req), '/projects?a=1');
});

// ---- account data -------------------------------------------------------------------------

test('creating an organisation makes you its admin; the name must be unique', async () => {
  const { c, id } = await newUser('Owner');
  const name = `Org ${uniq()}`;
  const r = await c.call('POST', '/api/account/company', { companyName: name, adminEmail: 'contact@example.com', description: 'hi' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const profile = await db.one('select role, company_id from public.profiles where id = $1', [id]);
  assert.equal(profile.role, 'workspace_admin');
  assert.equal(profile.company_id, r.body.company.id);
  const exists = await c.call('GET', `/api/account/company-exists?name=${encodeURIComponent(`  ${name.toUpperCase()} `)}`);
  assert.equal(exists.body.exists, true);
  const other = await newUser();
  const dup = await other.c.call('POST', '/api/account/company', { companyName: name.toLowerCase(), adminEmail: 'x@example.com' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already exists/);
});

test('projects: you see and change only your own organisation\'s', async () => {
  const a = await newUser('A');
  const b = await newUser('B');
  const orgA = await a.c.call('POST', '/api/account/company', { companyName: `OrgA ${uniq()}`, adminEmail: 'a@example.com' });
  await b.c.call('POST', '/api/account/company', { companyName: `OrgB ${uniq()}`, adminEmail: 'b@example.com' });

  // No plan yet: the database refuses new projects with the message people see today
  const noPlan = await a.c.call('POST', '/api/account/projects', { name: 'Line 1' });
  assert.equal(noPlan.status, 400);
  assert.match(noPlan.body.error, /needs an active plan/);

  await db.upsert('public.company_subscriptions', { company_id: orgA.body.company.id, plan: 'playground', status: 'active' }, 'company_id');
  const created = await a.c.call('POST', '/api/account/projects', { name: 'Line 1', description: 'd', project_type: 'generic' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.project.id;

  assert.equal((await a.c.call('GET', '/api/account/projects')).body.projects.length, 1);
  assert.equal((await b.c.call('GET', '/api/account/projects')).body.projects.length, 0);
  assert.equal((await b.c.call('GET', `/api/account/projects/${pid}`)).status, 404, 'B cannot read A\'s project');
  assert.equal((await b.c.call('PATCH', `/api/account/projects/${pid}`, { name: 'hacked' })).status, 404, 'B cannot rename it');
  assert.equal((await b.c.call('DELETE', `/api/account/projects/${pid}`)).body.deleted, 0, 'B cannot delete it');

  const renamed = await a.c.call('PATCH', `/api/account/projects/${pid}`, { name: 'Line 1 renamed' });
  assert.equal(renamed.body.project.name, 'Line 1 renamed');
  assert.equal((await a.c.call('DELETE', `/api/account/projects/${pid}`)).body.deleted, 1);
});

test('members cannot make themselves superadmin or change their own organisation', async () => {
  const { c, id } = await newUser();
  await c.call('POST', '/api/account/company', { companyName: `Org ${uniq()}`, adminEmail: 'a@example.com' });
  const promote = await c.call('PATCH', `/api/account/members/${id}`, { role: 'platform_admin' });
  assert.notEqual(promote.status, 200);
  assert.equal((await db.one('select role from public.profiles where id = $1', [id])).role, 'workspace_admin');
  const sneaky = await c.call('PATCH', '/api/account/profile', { name: 'New Name', role: 'platform_admin', company_id: null });
  assert.equal(sneaky.status, 200);
  const p = await db.one('select name, role, company_id from public.profiles where id = $1', [id]);
  assert.equal(p.name, 'New Name');
  assert.equal(p.role, 'workspace_admin', 'role is not editable through /profile');
  assert.ok(p.company_id, 'organisation is not editable through /profile');
});

test('invite flow: invite -> sign up from the link (no extra email check) -> accept -> viewer', async () => {
  const owner = await newUser('Owner');
  const org = await owner.c.call('POST', '/api/account/company', { companyName: `Org ${uniq()}`, adminEmail: 'o@example.com' });
  const companyId = org.body.company.id;
  const invitee = `inv_${uniq()}@example.com`;

  const stranger = await newUser();
  assert.equal((await stranger.c.call('POST', '/api/account/invites', { companyId, inviteEmail: invitee })).status, 403, 'only the creator may invite');

  const inv = await owner.c.call('POST', '/api/account/invites', { companyId, inviteEmail: invitee });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const token = lastLink(invitee, '/auth?invite=').searchParams.get('invite');

  const check = await client().call('GET', `/api/invites/${token}`);
  assert.equal(check.body.ok, true);
  assert.equal(check.body.invite.invite_email, invitee);

  const c = client();
  const signup = await c.call('POST', '/api/auth/signup', { email: invitee, password: STRONG, inviteToken: token, data: { name: 'Invitee' } });
  assert.equal(signup.status, 200);
  assert.ok(signup.body.session, 'signed in straight away: the invite link proved the inbox');

  const accept = await c.call('POST', `/api/invites/${token}/accept`);
  assert.equal(accept.body.ok, true, JSON.stringify(accept.body));
  const p = await db.one('select role, company_id from public.profiles where lower(email) = $1', [invitee]);
  assert.equal(p.role, 'viewer');
  assert.equal(p.company_id, companyId);
  assert.equal((await c.call('POST', `/api/invites/${token}/accept`)).body.error, 'invite already accepted');

  // Someone else can't use the link
  const other = await newUser();
  const token2 = (await (async () => {
    const r = await owner.c.call('POST', '/api/account/invites', { companyId, inviteEmail: `x_${uniq()}@example.com` });
    return new URL(r.body.inviteLink).searchParams.get('invite');
  })());
  assert.equal((await other.c.call('POST', `/api/invites/${token2}/accept`)).body.error, 'Email does not match invite');
});

test('join request flow: only the admin it was sent to may approve', async () => {
  const owner = await newUser('Owner');
  const orgName = `Org ${uniq()}`;
  await owner.c.call('POST', '/api/account/company', { companyName: orgName, adminEmail: 'o@example.com' });
  const requester = await newUser('Requester');

  const sent = await requester.c.call('POST', '/api/account/join-requests', { companyName: orgName, adminEmail: owner.email });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((await requester.c.call('POST', '/api/account/join-requests', { companyName: orgName, adminEmail: owner.email })).status, 400, 'one open request at a time');
  assert.equal((await requester.c.call('GET', '/api/account/join-requests/mine')).body.request.company_name, orgName);

  assert.equal((await owner.c.call('GET', '/api/account/join-requests/incoming?count=1')).body.count, 1);
  const list = await owner.c.call('GET', '/api/account/join-requests/incoming');
  const reqId = list.body.requests[0].id;
  const info = await owner.c.call('GET', `/api/account/join-requests/${reqId}/requester`);
  assert.equal(info.body.requester.name, 'Requester');

  const intruder = await newUser();
  assert.equal((await intruder.c.call('POST', '/api/account/join-requests/approve', { id: reqId })).status, 403);
  assert.equal((await intruder.c.call('GET', `/api/account/join-requests/${reqId}/requester`)).status, 403);

  assert.equal((await owner.c.call('POST', '/api/account/join-requests/approve', { id: reqId, role: 'platform_admin' })).status, 400, 'cannot hand out superadmin');
  const ok = await owner.c.call('POST', '/api/account/join-requests/approve', { id: reqId, role: 'operator' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.role, 'operator');
  const p = await db.one('select role, company_id from public.profiles where id = $1', [requester.id]);
  assert.equal(p.role, 'operator', 'the role the admin picked');
  assert.ok(p.company_id);
  assert.equal((await requester.c.call('GET', '/api/account/join-requests/mine?status=decided')).body.request.status, 'approved');
});

test('signed-out requests to account data are refused', async () => {
  assert.equal((await client().call('GET', '/api/account/projects')).status, 401);
  assert.equal((await client().call('POST', '/api/account/company', { companyName: 'x', adminEmail: 'y@z.com' })).status, 401);
});
