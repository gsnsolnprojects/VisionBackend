/**
 * /api/account/*: the signed-in person's own data (replaces the web app's direct Supabase
 * table calls and the Supabase edge functions).
 *
 * Former direct table calls run through db.asUser(), so the same RLS policies and triggers that
 * protected these tables before still decide what each person may read or change. Former edge
 * functions run through db.asSystem() and check permissions here in code.
 *
 * Profile        GET/PATCH /profile
 * Organisation   GET/PATCH /company, GET /company-exists?name=, POST /company
 * Members        GET /members, PATCH /members/:id
 * Invites        GET /invites/latest, POST /invites
 * Projects       GET /projects, GET /projects/:id, POST /projects, PATCH /projects/:id,
 *                DELETE /projects/:id, DELETE /projects?name=
 * Join requests  GET /join-requests/mine, POST /join-requests, GET /join-requests/incoming,
 *                GET /join-requests/:id/requester, POST /join-requests/approve | /reject
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const email = require('../services/emailService');
const { revokeAllSessions } = require('../services/authService');
const { invalidateUserCache, invalidateCompanyCache } = require('../middleware/authMiddleware');

const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_REQUEST = ['pending', 'email_sent'];
const ADMIN_ROLES = ['workspace_admin', 'platform_admin'];

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Errors raised by database rules (triggers / RLS) carry messages meant for people */
function sendError(res, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, message: err.message, ...err.extra });
  }
  if (err?.code === 'P0001' || err?.code === '23514') {
    return res.status(400).json({ error: err.message, message: err.message, code: err.code });
  }
  if (err?.code === '42501') {
    return res.status(403).json({ error: 'You are not allowed to do this.', message: 'You are not allowed to do this.', code: err.code });
  }
  if (err?.code === '23505') {
    return res.status(409).json({ error: 'This already exists.', message: 'This already exists.', code: err.code });
  }
  console.error('[account] unexpected error:', err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.', message: 'Something went wrong. Please try again.' });
}

const route = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));

const me = (req) => ({ id: req.user.id, email: req.user.email });
const appUrl = (req) => {
  const allowed = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim().replace(/\/+$/, ''));
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  return origin && allowed.includes(origin) ? origin : (process.env.APP_URL || 'https://visionm.gsnsoln.in').replace(/\/+$/, '');
};
const sameEmail = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const text = (value, max) => (value == null ? null : String(value).trim().slice(0, max));

function requireUuid(value, what = 'id') {
  if (!UUID.test(String(value || ''))) throw new HttpError(404, `${what} not found`);
  return value;
}

// ---- Profile --------------------------------------------------------------------------------

router.get('/profile', route(async (req, res) => {
  const { rows } = await db.asUser(me(req), (c) => c.query('select * from public.profiles where id = $1', [req.user.id]));
  res.json({ profile: rows[0] || null });
}));

/** Own name / phone / colour theme (role, organisation and login access are changed elsewhere) */
router.patch('/profile', route(async (req, res) => {
  const fields = {};
  if (req.body?.name !== undefined) fields.name = text(req.body.name, 120) || '';
  if (req.body?.phone !== undefined) fields.phone = text(req.body.phone, 40) || null;
  if (req.body?.color_theme !== undefined) fields.color_theme = text(req.body.color_theme, 40);
  const cols = Object.keys(fields);
  if (!cols.length) throw new HttpError(400, 'Nothing to update');
  const sets = cols.map((c, i) => `${db.ident(c)} = $${i + 2}`).join(', ');
  const { rows } = await db.asUser(me(req), (c) =>
    c.query(`update public.profiles set ${sets} where id = $1 returning *`, [req.user.id, ...cols.map((k) => fields[k])])
  );
  if (!rows[0]) throw new HttpError(404, 'Profile not found');
  invalidateUserCache(req.user.id);
  res.json({ profile: rows[0] });
}));

// ---- Organisation ---------------------------------------------------------------------------

router.get('/company', route(async (req, res) => {
  if (!req.user.company_id) return res.json({ company: null });
  const { rows } = await db.asUser(me(req), (c) => c.query('select * from public.companies where id = $1', [req.user.company_id]));
  res.json({ company: rows[0] || null });
}));

router.patch('/company', route(async (req, res) => {
  if (!req.user.company_id) throw new HttpError(400, 'You are not in an organisation');
  if (req.body?.description === undefined) throw new HttpError(400, 'Nothing to update');
  const { rows } = await db.asUser(me(req), (c) =>
    c.query('update public.companies set description = $2 where id = $1 returning *', [req.user.company_id, text(req.body.description, 2000) || null])
  );
  if (!rows[0]) throw new HttpError(403, 'Only an organisation admin can change these details.');
  invalidateCompanyCache(req.user.company_id);
  res.json({ company: rows[0] });
}));

/** Same as the old check_company_exists(): case-insensitive, trimmed name match */
router.get('/company-exists', route(async (req, res) => {
  const name = text(req.query.name, 200);
  if (!name) throw new HttpError(400, 'Organisation name is required');
  const company = await db.one(
    'select id, name, admin_email from public.companies where lower(trim(name)) = lower(trim($1)) limit 1',
    [name]
  );
  res.json({ exists: !!company, company });
}));

/** Create an organisation; the creator becomes its workspace_admin (was edge function create-company) */
router.post('/company', route(async (req, res) => {
  const companyName = text(req.body?.companyName, 200);
  const contactEmail = text(req.body?.adminEmail, 254);
  const description = text(req.body?.description, 2000) || null;
  if (!companyName || !contactEmail) throw new HttpError(400, 'Company name and admin email are required', { ok: false });
  if (req.user.company_id) throw new HttpError(400, 'You already belong to an organisation.', { ok: false });

  const company = await db.asSystem(async (c) => {
    const { rows: existing } = await c.query(
      'select id, name from public.companies where lower(trim(name)) = lower(trim($1)) limit 1',
      [companyName]
    );
    if (existing[0]) throw new HttpError(400, 'Company already exists', { ok: false, company: existing[0] });
    let created;
    try {
      ({ rows: [created] } = await c.query(
        `insert into public.companies (name, admin_email, email, created_by, description)
         values ($1, $2, $3, $4, $5) returning *`,
        [companyName, req.user.email || contactEmail, contactEmail, req.user.id, description]
      ));
    } catch (err) {
      if (err.code === '23505') throw new HttpError(400, 'Company with this name already exists.', { ok: false });
      throw err;
    }
    await c.query(`update public.profiles set company_id = $2, role = 'workspace_admin' where id = $1`, [req.user.id, created.id]);
    return created;
  });
  invalidateUserCache(req.user.id);
  res.json({ ok: true, company });
}));

// ---- Members --------------------------------------------------------------------------------

router.get('/members', route(async (req, res) => {
  if (!req.user.company_id) return res.json({ members: [] });
  const { rows } = await db.asUser(me(req), (c) =>
    c.query(
      `select id, name, email, phone, created_at, company_id, role, is_active
         from public.profiles where company_id = $1 order by created_at desc`,
      [req.user.company_id]
    )
  );
  res.json({ members: rows });
}));

/** Enable / disable a member's login, or change their role (RLS + triggers decide who may) */
router.patch('/members/:id', route(async (req, res) => {
  const id = requireUuid(req.params.id, 'Member');
  const fields = {};
  if (typeof req.body?.is_active === 'boolean') fields.is_active = req.body.is_active;
  if (typeof req.body?.role === 'string') fields.role = text(req.body.role, 40);
  const cols = Object.keys(fields);
  if (!cols.length) throw new HttpError(400, 'Nothing to update');
  const sets = cols.map((c, i) => `${db.ident(c)} = $${i + 2}`).join(', ');
  const { rows } = await db.asUser(me(req), (c) =>
    c.query(`update public.profiles set ${sets} where id = $1 returning id, name, email, role, is_active, company_id`, [id, ...cols.map((k) => fields[k])])
  );
  if (!rows[0]) throw new HttpError(403, 'You are not allowed to change this member.');
  if (fields.is_active === false) await revokeAllSessions(id);
  invalidateUserCache(id);
  res.json({ member: rows[0] });
}));

// ---- Invites --------------------------------------------------------------------------------

router.get('/invites/latest', route(async (req, res) => {
  if (!req.user.company_id) return res.json({ invite: null });
  const { rows } = await db.asUser(me(req), (c) =>
    c.query(
      `select email, status, created_at, null::timestamptz as updated_at from public.company_invites
        where company_id = $1 and created_by = $2 order by created_at desc limit 1`,
      [req.user.company_id, req.user.id]
    )
  );
  res.json({ invite: rows[0] || null });
}));

/** Invite someone by email (was edge function create-invite). Only the organisation's creator may invite. */
router.post('/invites', route(async (req, res) => {
  const companyId = requireUuid(req.body?.companyId, 'Company');
  const inviteEmail = String(req.body?.inviteEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) throw new HttpError(400, 'companyId and inviteEmail are required', { success: false });

  const company = await db.one('select * from public.companies where id = $1', [companyId]);
  if (!company) throw new HttpError(404, 'Company not found', { success: false });
  if (company.created_by !== req.user.id) throw new HttpError(403, 'Insufficient permissions: must be company admin', { success: false });

  const recent = await db.one(
    `select count(*)::int as n from public.company_invites
      where company_id = $1 and lower(email) = $2 and created_at > now() - interval '5 minutes'`,
    [companyId, inviteEmail]
  );
  if (recent.n >= 2) {
    throw new HttpError(429, 'Too many invites to this user recently. Please wait 5 minutes before inviting again.', {
      success: false, errorCode: 'INVITE_RATE_LIMIT', waitTimeSeconds: 300,
    });
  }
  const member = await db.one('select id, company_id from public.profiles where lower(email) = $1 and company_id is not null limit 1', [inviteEmail]);
  if (member && member.company_id === companyId) throw new HttpError(400, 'User already a member', { success: false, errorCode: 'USER_ALREADY_MEMBER' });
  if (member) {
    throw new HttpError(400, 'User already exists in another company and cannot be added to your company', {
      success: false, errorCode: 'USER_IN_ANOTHER_COMPANY',
    });
  }

  const token = crypto.randomUUID();
  const invite = await db.one(
    `insert into public.company_invites (company_id, email, token, created_by, expires_at, status)
     values ($1, $2, $3, $4, now() + interval '24 hours', 'pending') returning id`,
    [companyId, inviteEmail, token, req.user.id]
  );
  const inviteLink = `${appUrl(req)}/auth?invite=${encodeURIComponent(token)}`;
  const inviter = await db.one('select name from public.profiles where id = $1', [req.user.id]);
  const sent = await email.organisationInvite({ to: inviteEmail, companyName: company.name, inviterName: inviter?.name, link: inviteLink });
  if (!sent.sent) {
    await db.query(`update public.company_invites set status = 'email_failed', error_message = $2 where id = $1`, [invite.id, String(sent.reason || 'send failed')]);
    return res.status(500).json({ success: false, error: 'Failed to send invite email', details: sent.reason, inviteLink });
  }
  await db.query(`update public.company_invites set status = 'email_sent' where id = $1`, [invite.id]);
  res.json({ success: true, inviteId: invite.id, inviteLink });
}));

// ---- Projects -------------------------------------------------------------------------------

router.get('/projects', route(async (req, res) => {
  if (!req.user.company_id) return res.json({ projects: [] });
  const params = [req.user.company_id];
  let where = 'company_id = $1';
  if (req.query.type) {
    params.push(String(req.query.type));
    where += ` and project_type = $${params.length}`;
  }
  if (req.query.liveOnly === '1' || req.query.liveOnly === 'true') where += ' and publish_to_live = true';
  if (req.query.name) {
    params.push(String(req.query.name));
    where += ` and name = $${params.length}`;
  }
  const order = req.query.order === 'name' ? 'name asc' : 'created_at desc';
  const { rows } = await db.asUser(me(req), (c) => c.query(`select * from public.projects where ${where} order by ${order}`, params));
  res.json({ projects: rows });
}));

router.get('/projects/:id', route(async (req, res) => {
  const id = requireUuid(req.params.id, 'Project');
  const live = req.query.liveOnly === '1' || req.query.liveOnly === 'true' ? ' and publish_to_live = true' : '';
  // company_name: the project's own organisation (a superadmin may open another organisation's project)
  const { rows } = await db.asUser(me(req), (c) =>
    c.query(
      `select p.*, (select name from public.companies where id = p.company_id) as company_name
         from public.projects p where p.id = $1${live}`,
      [id]
    )
  );
  if (!rows[0]) throw new HttpError(404, 'Project not found');
  res.json({ project: rows[0] });
}));

router.post('/projects', route(async (req, res) => {
  if (!req.user.company_id) throw new HttpError(400, 'Create or join an organisation first');
  const name = text(req.body?.name, 200);
  if (!name) throw new HttpError(400, 'Project name is required');
  const { rows } = await db.asUser(me(req), (c) =>
    c.query(
      `insert into public.projects (name, description, company_id, created_by, project_type)
       values ($1, $2, $3, $4, $5) returning *`,
      [name, text(req.body?.description, 2000) || null, req.user.company_id, req.user.id, text(req.body?.project_type, 40) || 'generic']
    )
  );
  res.status(201).json({ project: rows[0] });
}));

router.patch('/projects/:id', route(async (req, res) => {
  const id = requireUuid(req.params.id, 'Project');
  const fields = {};
  if (req.body?.name !== undefined) {
    fields.name = text(req.body.name, 200);
    if (!fields.name) throw new HttpError(400, 'Project name is required');
  }
  if (req.body?.description !== undefined) fields.description = text(req.body.description, 2000) || null;
  const cols = Object.keys(fields);
  if (!cols.length) throw new HttpError(400, 'Nothing to update');
  const sets = cols.map((c, i) => `${db.ident(c)} = $${i + 2}`).join(', ');
  const { rows } = await db.asUser(me(req), (c) =>
    c.query(`update public.projects set ${sets} where id = $1 returning *`, [id, ...cols.map((k) => fields[k])])
  );
  if (!rows[0]) throw new HttpError(404, 'Project not found or you are not allowed to change it');
  res.json({ project: rows[0] });
}));

router.delete('/projects/:id', route(async (req, res) => {
  const id = requireUuid(req.params.id, 'Project');
  const { rowCount } = await db.asUser(me(req), (c) => c.query('delete from public.projects where id = $1', [id]));
  res.json({ deleted: rowCount });
}));

/** Delete by name inside your own organisation (the Projects page deletes by name) */
router.delete('/projects', route(async (req, res) => {
  const name = text(req.query.name, 200);
  if (!name || !req.user.company_id) throw new HttpError(400, 'Project name is required');
  const { rowCount } = await db.asUser(me(req), (c) =>
    c.query('delete from public.projects where company_id = $1 and name = $2', [req.user.company_id, name])
  );
  res.json({ deleted: rowCount });
}));

// ---- Join requests --------------------------------------------------------------------------

/** My latest request: ?status=open (pending / email_sent) or ?status=decided (approved / rejected) */
router.get('/join-requests/mine', route(async (req, res) => {
  const statuses = req.query.status === 'decided' ? ['approved', 'rejected'] : OPEN_REQUEST;
  const { rows } = await db.asUser(me(req), (c) =>
    c.query(
      `select id, company_name, status, created_at from public.workspace_join_requests
        where user_id = $1 and status = any($2) order by created_at desc limit 1`,
      [req.user.id, statuses]
    )
  );
  res.json({ request: rows[0] || null });
}));

/** Ask to join an organisation (was edge function send-workspace-request; the requester is the signed-in user) */
router.post('/join-requests', route(async (req, res) => {
  const companyName = text(req.body?.companyName, 200);
  const adminEmail = String(req.body?.adminEmail || '').trim().toLowerCase();
  if (!companyName || !adminEmail) throw new HttpError(400, 'Missing companyName/adminEmail in request body', { success: false });
  if (req.user.company_id) throw new HttpError(400, 'You already belong to an organisation.', { success: false });

  const open = await db.one(
    'select id from public.workspace_join_requests where user_id = $1 and status = any($2) limit 1',
    [req.user.id, OPEN_REQUEST]
  );
  if (open) throw new HttpError(400, 'You already have a pending request.', { success: false, code: 'request_pending' });

  const profile = await db.one('select name, email from public.profiles where id = $1', [req.user.id]);
  const request = await db.one(
    `insert into public.workspace_join_requests (user_id, admin_email, company_name, token, status, requester_email)
     values ($1, $2, $3, $4, 'pending', $5) returning id`,
    [req.user.id, adminEmail, companyName, crypto.randomUUID(), profile?.email || req.user.email]
  );
  const sent = await email.joinRequestToAdmin({
    to: adminEmail,
    requesterName: profile?.name,
    requesterEmail: profile?.email || req.user.email,
    companyName,
    link: `${appUrl(req)}/dashboard`,
  });
  await db.query('update public.workspace_join_requests set status = $2 where id = $1', [request.id, sent.sent ? 'email_sent' : 'pending']);
  res.json({ success: true, requestId: request.id, emailSent: sent.sent });
}));

/** Requests sent to me as an organisation admin. ?count=1 returns only the open count. */
router.get('/join-requests/incoming', route(async (req, res) => {
  const myEmail = (await db.one('select email from public.profiles where id = $1', [req.user.id]))?.email || req.user.email;
  if (req.query.count === '1') {
    const { rows } = await db.asUser(me(req), (c) =>
      c.query('select count(*)::int as n from public.workspace_join_requests where lower(admin_email) = lower($1) and status = any($2)', [myEmail, OPEN_REQUEST])
    );
    return res.json({ count: rows[0].n });
  }
  const { rows } = await db.asUser(me(req), (c) =>
    c.query(
      `select * from public.workspace_join_requests where lower(admin_email) = lower($1) and status = any($2)
        order by created_at desc`,
      [myEmail, [...OPEN_REQUEST, 'approved']]
    )
  );
  res.json({ requests: rows });
}));

/**
 * Who may answer a join request: the admin it was sent to, an admin of the organisation being
 * joined, or the superadmin (same rule as the newest approve-workspace-request in git, d523857).
 */
async function loadRequestForAdmin(req, { id, token }) {
  let request = null;
  if (id && UUID.test(id)) request = await db.one('select * from public.workspace_join_requests where id = $1', [id]);
  else if (token) request = await db.one('select * from public.workspace_join_requests where token = $1', [String(token)]);
  if (!request) throw new HttpError(404, 'Request not found', { success: false });
  const approver = await db.one('select email, role, company_id from public.profiles where id = $1', [req.user.id]);
  const company = await db.one(
    'select id from public.companies where name = $1 and lower(admin_email) = lower($2) limit 1',
    [request.company_name, request.admin_email]
  );
  const canAnswer =
    approver?.role === 'platform_admin' ||
    sameEmail(request.admin_email, approver?.email || req.user.email) ||
    (!!company && approver?.company_id === company.id && ['workspace_admin', 'admin'].includes(approver?.role || ''));
  if (!canAnswer) throw new HttpError(403, 'Only an admin of this company can approve join requests', { success: false });
  return request;
}

const ASSIGNABLE_ROLES = ['viewer', 'operator', 'ml_engineer', 'workspace_admin'];

/** Name / email / phone of the person who asked (was rpc get_join_request_user_info) */
router.get('/join-requests/:id/requester', route(async (req, res) => {
  const request = await loadRequestForAdmin(req, { id: req.params.id });
  const info = await db.one(
    `select coalesce(nullif(trim(p.name), ''), u.raw_user_meta_data->>'name', '') as name,
            coalesce(nullif(trim(p.email), ''), u.email::text, u.raw_user_meta_data->>'email', '') as email,
            coalesce(nullif(trim(p.phone), ''), u.raw_user_meta_data->>'phone', '') as phone
       from auth.users u left join public.profiles p on p.id = u.id where u.id = $1`,
    [request.user_id]
  );
  res.json({ requester: info });
}));

/** Approve with the role the admin picked (was edge function approve-workspace-request) */
router.post('/join-requests/approve', route(async (req, res) => {
  const role = req.body?.role ? String(req.body.role) : 'viewer';
  if (!ASSIGNABLE_ROLES.includes(role)) throw new HttpError(400, `Invalid role: ${role}`, { success: false });
  const request = await loadRequestForAdmin(req, { id: req.body?.id, token: req.body?.token });
  const result = await db.asSystem(async (c) => {
    await c.query(`update public.workspace_join_requests set status = 'approved' where id = $1`, [request.id]);
    const { rows: existing } = await c.query(
      'select id from public.companies where name = $1 and lower(admin_email) = lower($2) limit 1',
      [request.company_name, request.admin_email]
    );
    let companyId = existing[0]?.id;
    let isNewCompany = false;
    if (!companyId) {
      const { rows: requester } = await c.query('select email from public.profiles where id = $1', [request.user_id]);
      if (!requester[0]?.email) throw new HttpError(400, 'Requester email not found. Cannot create company.', { success: false });
      const { rows: created } = await c.query(
        'insert into public.companies (name, admin_email, email, created_by) values ($1, $2, $2, $3) returning id',
        [request.company_name, requester[0].email, request.user_id]
      );
      companyId = created[0].id;
      isNewCompany = true;
    }
    const savedRole = isNewCompany ? 'workspace_admin' : role;
    await c.query('update public.profiles set company_id = $2, role = $3 where id = $1', [request.user_id, companyId, savedRole]);
    const { rows: person } = await c.query('select name, email from public.profiles where id = $1', [request.user_id]);
    return { companyId, person: person[0], role: savedRole };
  });
  invalidateUserCache(request.user_id);
  if (result.person?.email) {
    await email.joinRequestApproved({ to: result.person.email, name: result.person.name, companyName: request.company_name, link: `${appUrl(req)}/dashboard` });
  }
  res.json({ success: true, message: 'Request approved', companyId: result.companyId, role: result.role });
}));

router.post('/join-requests/reject', route(async (req, res) => {
  const request = await loadRequestForAdmin(req, { id: req.body?.id, token: req.body?.token });
  await db.query(`update public.workspace_join_requests set status = 'rejected' where id = $1`, [request.id]);
  res.json({ success: true, message: 'Request rejected' });
}));

module.exports = router;
