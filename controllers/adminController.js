const path = require('path');
const fs = require('fs').promises;
const Dataset = require('../models/Dataset');
const Image = require('../models/Image');
const Annotation = require('../models/Annotation');
const Category = require('../models/Category');
const Model = require('../models/Model');
const TrainingJob = require('../models/TrainingJob');
const InferenceJob = require('../models/InferenceJob');
const ActionItem = require('../models/ActionItem');
const Observation = require('../models/Observation');
const ObservationCounter = require('../models/ObservationCounter');
const MobileInspectConfig = require('../models/MobileInspectConfig');
const AuditLog = require('../models/AuditLog');
const { getSupabaseClient } = require('../services/supabaseService');
const razorpay = require('../services/razorpayService');
const auditService = require('../services/auditService');
const { PLANS } = require('../utils/plans');
const { invalidateUserCache, invalidateCompanyCache } = require('../middleware/authMiddleware');

/**
 * Superadmin (GSN platform admin) panel
 *
 * Every route here sits behind requireSuperadmin. Reads across ALL companies:
 * users and companies come from Supabase (service role), datasets / models / jobs
 * from MongoDB, payments from subscription_payments.
 *
 * GET    /api/admin/overview
 * GET    /api/admin/users
 * POST   /api/admin/users/:userId/status      { active: boolean }
 * DELETE /api/admin/users/:userId             { confirmEmail }
 * GET    /api/admin/companies
 * PATCH  /api/admin/companies/:companyId/unlimited  { isUnlimited: boolean }
 * DELETE /api/admin/companies/:companyId      { confirmName }
 * GET    /api/admin/revenue
 * GET    /api/admin/jobs?type=training|inference&status=&company=
 * GET    /api/admin/audit
 */

const GSN_COMPANY = 'gsn';
const DAY_MS = 24 * 60 * 60 * 1000;
const BAN_FOREVER = '876000h'; // ~100 years: Supabase's way of blocking sign-in
const ACTIVE_JOB_STATUSES = ['queued', 'running'];

const isGsn = (name) => String(name || '').trim().toLowerCase() === GSN_COMPANY;

/** Throw on a Supabase error, otherwise return its data */
function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

/** All Supabase Auth users (sign-in data: email verified, last login, banned) */
async function listAuthUsers(supabase) {
  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return users;
}

/** { [key]: count } from a Mongo group-by */
async function countBy(MongoModel, field, match = {}) {
  const rows = await MongoModel.aggregate([{ $match: match }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.count]));
}

/** 'YYYY-MM' in India time, so "this month" matches the Razorpay dashboard */
function monthKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' })
    .format(new Date(date))
    .slice(0, 7);
}

/**
 * Revenue figures shared by the Overview and Revenue pages.
 * MRR = monthly price of every company with an active PAID plan (unlimited-access
 * companies without a Razorpay subscription pay nothing, so they are left out).
 */
async function buildRevenue(supabase) {
  const [subscriptions, companies] = await Promise.all([
    supabase.from('company_subscriptions').select('*').then(unwrap),
    supabase.from('companies').select('id, name').then(unwrap),
  ]);
  const companyName = Object.fromEntries(companies.map((c) => [c.id, c.name]));

  const paidActive = subscriptions.filter(
    (s) => s.status === 'active' && s.razorpay_subscription_id && PLANS[s.plan]
  );
  const mrrInr = paidActive.reduce((sum, s) => sum + PLANS[s.plan].priceMonthlyInr, 0);

  const planBreakdown = Object.values(PLANS).map((plan) => ({
    plan: plan.id,
    name: plan.name,
    priceMonthlyInr: plan.priceMonthlyInr,
    activeCompanies: paidActive.filter((s) => s.plan === plan.id).length,
  }));

  // Payment history needs the subscription_payments table (superadmin migration)
  let payments = [];
  let paymentsAvailable = true;
  const { data: paymentRows, error: paymentsError } = await supabase
    .from('subscription_payments')
    .select('*')
    .order('paid_at', { ascending: false });
  if (paymentsError) {
    paymentsAvailable = false;
    console.warn('[admin] subscription_payments not readable:', paymentsError.message);
  } else {
    payments = paymentRows.map((p) => ({
      paymentId: p.razorpay_payment_id,
      companyId: p.company_id,
      companyName: companyName[p.company_id] || p.company_name || 'Deleted company',
      plan: p.plan,
      amountInr: p.amount_paise / 100,
      currency: p.currency,
      paidAt: p.paid_at,
    }));
  }

  const thisMonth = monthKey(new Date());
  const totalInr = payments.reduce((sum, p) => sum + p.amountInr, 0);
  const thisMonthInr = payments.filter((p) => monthKey(p.paidAt) === thisMonth).reduce((sum, p) => sum + p.amountInr, 0);

  // Last 12 months, oldest first, including months with no payments
  const byMonth = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const key = monthKey(new Date(now.getFullYear(), now.getMonth() - i, 15));
    byMonth.push({
      month: key,
      amountInr: payments.filter((p) => monthKey(p.paidAt) === key).reduce((sum, p) => sum + p.amountInr, 0),
      payments: payments.filter((p) => monthKey(p.paidAt) === key).length,
    });
  }

  const companyTotals = new Map();
  for (const p of payments) {
    const key = p.companyId || p.companyName;
    const entry = companyTotals.get(key) || { companyId: p.companyId, companyName: p.companyName, amountInr: 0, payments: 0 };
    entry.amountInr += p.amountInr;
    entry.payments += 1;
    companyTotals.set(key, entry);
  }

  return {
    mrrInr,
    paidCompanies: paidActive.length,
    totalInr,
    thisMonthInr,
    planBreakdown,
    byMonth,
    byCompany: [...companyTotals.values()].sort((a, b) => b.amountInr - a.amountInr),
    payments,
    paymentsAvailable,
  };
}

/**
 * GET /api/admin/overview
 */
const getOverview = async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const now = Date.now();
    const [companies, profiles, projectCount, revenue, datasets, models, training, trainingActive, inference, inferenceActive] =
      await Promise.all([
        supabase.from('companies').select('id').then(unwrap),
        supabase.from('profiles').select('id, is_active, created_at').then(unwrap),
        supabase.from('projects').select('id', { count: 'exact', head: true }).then((r) => {
          if (r.error) throw r.error;
          return r.count || 0;
        }),
        buildRevenue(supabase),
        Dataset.countDocuments(),
        Model.countDocuments(),
        TrainingJob.countDocuments(),
        TrainingJob.countDocuments({ status: { $in: ACTIVE_JOB_STATUSES } }),
        InferenceJob.countDocuments(),
        InferenceJob.countDocuments({ status: { $in: ACTIVE_JOB_STATUSES } }),
      ]);

    const signedUpSince = (days) => profiles.filter((p) => p.created_at && now - new Date(p.created_at).getTime() <= days * DAY_MS).length;

    res.json({
      companies: companies.length,
      users: {
        total: profiles.length,
        active: profiles.filter((p) => p.is_active !== false).length,
        disabled: profiles.filter((p) => p.is_active === false).length,
        newLast7Days: signedUpSince(7),
        newLast30Days: signedUpSince(30),
      },
      projects: projectCount,
      datasets,
      models,
      trainingJobs: { total: training, active: trainingActive },
      inferenceJobs: { total: inference, active: inferenceActive },
      revenue: {
        mrrInr: revenue.mrrInr,
        paidCompanies: revenue.paidCompanies,
        thisMonthInr: revenue.thisMonthInr,
        totalInr: revenue.totalInr,
      },
    });
  } catch (error) {
    console.error('[admin] overview failed:', error);
    res.status(500).json({ error: 'Could not load overview', message: error.message });
  }
};

/**
 * GET /api/admin/users
 */
const listUsers = async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const [profiles, companies, authUsers] = await Promise.all([
      supabase.from('profiles').select('id, email, name, phone, role, company_id, is_active, created_at').then(unwrap),
      supabase.from('companies').select('id, name').then(unwrap),
      listAuthUsers(supabase),
    ]);
    const companyName = Object.fromEntries(companies.map((c) => [c.id, c.name]));
    const authById = new Map(authUsers.map((u) => [u.id, u]));

    const users = profiles.map((p) => {
      const auth = authById.get(p.id);
      return {
        id: p.id,
        name: p.name || null,
        email: p.email || auth?.email || null,
        phone: p.phone || null,
        role: p.role || null,
        companyId: p.company_id || null,
        companyName: companyName[p.company_id] || null,
        isActive: p.is_active !== false,
        isSuperadmin: p.role === 'platform_admin',
        emailVerified: !!auth?.email_confirmed_at,
        lastSignInAt: auth?.last_sign_in_at || null,
        bannedUntil: auth?.banned_until || null,
        createdAt: p.created_at || auth?.created_at || null,
      };
    });

    // Sign-ups that never got a profile row (rare) are still listed so they can be cleaned up
    for (const auth of authUsers) {
      if (profiles.some((p) => p.id === auth.id)) continue;
      users.push({
        id: auth.id,
        name: null,
        email: auth.email || null,
        phone: null,
        role: null,
        companyId: null,
        companyName: null,
        isActive: !auth.banned_until,
        isSuperadmin: false,
        emailVerified: !!auth.email_confirmed_at,
        lastSignInAt: auth.last_sign_in_at || null,
        bannedUntil: auth.banned_until || null,
        createdAt: auth.created_at || null,
        noProfile: true,
      });
    }

    users.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ users });
  } catch (error) {
    console.error('[admin] list users failed:', error);
    res.status(500).json({ error: 'Could not load users', message: error.message });
  }
};

/** Load the target user for a write action and refuse the superadmin / yourself */
async function loadTargetUser(supabase, userId, req) {
  const [{ data: profile, error: profileError }, { data: authData, error: authError }] = await Promise.all([
    supabase.from('profiles').select('id, email, role, company_id, is_active').eq('id', userId).maybeSingle(),
    supabase.auth.admin.getUserById(userId),
  ]);
  if (profileError) throw profileError;
  const authUser = authError ? null : authData?.user || null;
  if (!profile && !authUser) return { status: 404, message: 'User not found' };
  if (userId === req.user.id) return { status: 400, message: 'You cannot do this to your own account' };
  if (profile?.role === 'platform_admin') return { status: 403, message: 'The superadmin account is protected' };
  return { profile, authUser, email: profile?.email || authUser?.email || null };
}

/**
 * POST /api/admin/users/:userId/status  { active: boolean }
 * Disables / re-enables sign-in: profiles.is_active (checked by the backend and app)
 * plus a Supabase Auth ban so the user can't get a new session at all.
 */
const setUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { active } = req.body || {};
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'Invalid request', message: '"active" must be true or false' });
    }

    const supabase = getSupabaseClient();
    const target = await loadTargetUser(supabase, userId, req);
    if (target.status) return res.status(target.status).json({ error: 'Not allowed', message: target.message });

    if (target.profile) {
      const { error } = await supabase.from('profiles').update({ is_active: active }).eq('id', userId);
      if (error) throw error;
    }
    if (target.authUser) {
      const { error } = await supabase.auth.admin.updateUserById(userId, { ban_duration: active ? 'none' : BAN_FOREVER });
      if (error) throw error;
    }
    invalidateUserCache(userId);

    auditService.logAction({
      action: 'update',
      resourceType: 'user',
      resourceId: userId,
      details: { change: active ? 'enabled login' : 'disabled login', email: target.email, by: 'superadmin' },
      req,
    });

    res.json({ success: true, userId, isActive: active });
  } catch (error) {
    console.error('[admin] set user status failed:', error);
    res.status(500).json({ error: 'Could not change login access', message: error.message });
  }
};

/**
 * DELETE /api/admin/users/:userId  { confirmEmail }
 * Permanently deletes the account. Companies / projects / datasets the user created
 * are kept (their "created by" is cleared first).
 */
const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const confirmEmail = String(req.body?.confirmEmail || '').trim().toLowerCase();

    const supabase = getSupabaseClient();
    const target = await loadTargetUser(supabase, userId, req);
    if (target.status) return res.status(target.status).json({ error: 'Not allowed', message: target.message });
    if (!target.email || confirmEmail !== target.email.trim().toLowerCase()) {
      return res.status(400).json({ error: 'Confirmation failed', message: "Type the user's email exactly to confirm" });
    }

    // Keep everything the user created: clear created_by so nothing is deleted with them
    for (const table of ['companies', 'projects', 'datasets', 'company_invites']) {
      const { error } = await supabase.from(table).update({ created_by: null }).eq('created_by', userId);
      if (error) throw new Error(`Could not detach ${table} from the user: ${error.message}`);
    }

    if (target.authUser) {
      const { error } = await supabase.auth.admin.deleteUser(userId); // profile row is removed with it
      if (error) throw error;
    } else {
      const { error } = await supabase.from('profiles').delete().eq('id', userId);
      if (error) throw error;
    }
    invalidateUserCache(userId);

    auditService.logAction({
      action: 'delete',
      resourceType: 'user',
      resourceId: userId,
      details: { email: target.email, companyId: target.profile?.company_id || null, by: 'superadmin' },
      req,
    });

    res.json({ success: true, userId });
  } catch (error) {
    console.error('[admin] delete user failed:', error);
    res.status(500).json({ error: 'Could not delete user', message: error.message });
  }
};

/**
 * GET /api/admin/companies
 */
const listCompanies = async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const [companies, profiles, projects, subscriptions, datasetsBy, modelsBy, trainingBy, inferenceBy] = await Promise.all([
      supabase.from('companies').select('id, name, description, admin_email, created_by, created_at').then(unwrap),
      supabase.from('profiles').select('id, email, role, company_id, is_active').then(unwrap),
      supabase.from('projects').select('id, company_id').then(unwrap),
      supabase.from('company_subscriptions').select('*').then(unwrap),
      countBy(Dataset, 'company'),
      countBy(Model, 'company'),
      countBy(TrainingJob, 'company'),
      countBy(InferenceJob, 'company'),
    ]);

    const result = companies.map((c) => {
      const members = profiles.filter((p) => p.company_id === c.id);
      const sub = subscriptions.find((s) => s.company_id === c.id) || null;
      const creator = profiles.find((p) => p.id === c.created_by);
      return {
        id: c.id,
        name: c.name,
        description: c.description || null,
        adminEmail: c.admin_email || null,
        createdByEmail: creator?.email || null,
        createdAt: c.created_at,
        isGsn: isGsn(c.name),
        members: members.length,
        admins: members.filter((p) => ['workspace_admin', 'platform_admin'].includes(p.role)).map((p) => p.email),
        projects: projects.filter((p) => p.company_id === c.id).length,
        datasets: datasetsBy[c.name] || 0,
        models: modelsBy[c.name] || 0,
        trainingJobs: trainingBy[c.name] || 0,
        inferenceJobs: inferenceBy[c.name] || 0,
        subscription: sub
          ? {
              plan: sub.plan,
              planName: PLANS[sub.plan]?.name || null,
              status: sub.status,
              currentPeriodEnd: sub.current_period_end,
              isUnlimited: !!sub.is_unlimited,
              cancelAtPeriodEnd: !!sub.cancel_at_period_end,
              hasPaidSubscription: !!sub.razorpay_subscription_id,
            }
          : null,
      };
    });

    result.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ companies: result });
  } catch (error) {
    console.error('[admin] list companies failed:', error);
    res.status(500).json({ error: 'Could not load companies', message: error.message });
  }
};

/**
 * PATCH /api/admin/companies/:companyId/unlimited  { isUnlimited: boolean }
 * Full access without paying (for GSN's own testing / special customers).
 */
const setCompanyUnlimited = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { isUnlimited } = req.body || {};
    if (typeof isUnlimited !== 'boolean') {
      return res.status(400).json({ error: 'Invalid request', message: '"isUnlimited" must be true or false' });
    }

    const supabase = getSupabaseClient();
    const company = unwrap(await supabase.from('companies').select('id, name').eq('id', companyId).maybeSingle());
    if (!company) return res.status(404).json({ error: 'Not found', message: 'Company not found' });

    const { error } = await supabase
      .from('company_subscriptions')
      .upsert({ company_id: companyId, is_unlimited: isUnlimited }, { onConflict: 'company_id' });
    if (error) throw error;
    invalidateCompanyCache(companyId);

    auditService.logAction({
      action: 'update',
      resourceType: 'company',
      resourceId: companyId,
      details: { company: company.name, change: isUnlimited ? 'unlimited access on' : 'unlimited access off', by: 'superadmin' },
      req,
    });

    res.json({ success: true, companyId, isUnlimited });
  } catch (error) {
    console.error('[admin] set unlimited failed:', error);
    res.status(500).json({ error: 'Could not change unlimited access', message: error.message });
  }
};

/** Remove <base>/<companyName> on disk, refusing anything that resolves outside <base> */
async function removeCompanyFolder(baseDir, companyName) {
  const base = path.resolve(process.cwd(), baseDir);
  const target = path.resolve(base, companyName);
  if (!companyName.trim() || path.dirname(target) !== base) {
    throw new Error(`Refusing to remove unsafe path for company "${companyName}"`);
  }
  await fs.rm(target, { recursive: true, force: true });
  return target;
}

/**
 * DELETE /api/admin/companies/:companyId  { confirmName }
 * Permanently deletes a company and everything it owns. Members keep their login
 * but are removed from the company (they can create or join another one).
 */
const deleteCompany = async (req, res) => {
  const steps = [];
  try {
    const { companyId } = req.params;
    const confirmName = String(req.body?.confirmName || '').trim().toLowerCase();

    const supabase = getSupabaseClient();
    const company = unwrap(await supabase.from('companies').select('id, name').eq('id', companyId).maybeSingle());
    if (!company) return res.status(404).json({ error: 'Not found', message: 'Company not found' });
    if (isGsn(company.name)) {
      return res.status(403).json({ error: 'Not allowed', message: 'The gsn company cannot be deleted' });
    }
    if (confirmName !== company.name.trim().toLowerCase()) {
      return res.status(400).json({ error: 'Confirmation failed', message: 'Type the company name exactly to confirm' });
    }

    const companyName = company.name;
    const [activeTraining, activeInference] = await Promise.all([
      TrainingJob.countDocuments({ company: companyName, status: { $in: ACTIVE_JOB_STATUSES } }),
      InferenceJob.countDocuments({ company: companyName, status: { $in: ACTIVE_JOB_STATUSES } }),
    ]);
    if (activeTraining + activeInference > 0) {
      return res.status(409).json({
        error: 'Jobs still running',
        message: `This company has ${activeTraining} training and ${activeInference} inference job(s) queued or running. Cancel them first.`,
      });
    }

    // 1) Stop billing first, so a deleted company is never charged again
    const sub = unwrap(
      await supabase.from('company_subscriptions').select('*').eq('company_id', companyId).maybeSingle()
    );
    if (sub?.razorpay_subscription_id && ['active', 'past_due'].includes(sub.status)) {
      await razorpay.cancelSubscriptionNow(sub.razorpay_subscription_id);
      steps.push('cancelled Razorpay subscription');
    }

    // 2) Members stay as users but leave the company
    const { data: members, error: membersError } = await supabase
      .from('profiles')
      .update({ company_id: null, role: null })
      .eq('company_id', companyId)
      .select('id');
    if (membersError) throw membersError;
    (members || []).forEach((m) => invalidateUserCache(m.id));
    steps.push(`removed ${members?.length || 0} member(s) from the company`);

    // 3) Supabase rows: the company (projects, datasets, invites, subscription cascade) + join requests
    const { error: joinError } = await supabase.from('workspace_join_requests').delete().eq('company_name', companyName);
    if (joinError) throw joinError;
    const { error: companyError } = await supabase.from('companies').delete().eq('id', companyId);
    if (companyError) throw companyError;
    steps.push('deleted company, projects and invites');

    // 4) MongoDB data (audit log is kept as history)
    const datasetIds = (await Dataset.find({ company: companyName }).select('_id').lean()).map((d) => d._id);
    const mongo = {};
    mongo.images = (await Image.deleteMany({ datasetId: { $in: datasetIds } })).deletedCount;
    mongo.annotations = (await Annotation.deleteMany({ datasetId: { $in: datasetIds } })).deletedCount;
    mongo.categories = (await Category.deleteMany({ datasetId: { $in: datasetIds } })).deletedCount;
    for (const [label, M] of Object.entries({
      datasets: Dataset,
      models: Model,
      trainingJobs: TrainingJob,
      inferenceJobs: InferenceJob,
      actionItems: ActionItem,
      observations: Observation,
      observationCounters: ObservationCounter,
      mobileInspectConfigs: MobileInspectConfig,
    })) {
      mongo[label] = (await M.deleteMany({ company: companyName })).deletedCount;
    }
    steps.push('deleted datasets, models, jobs and results records');

    // 5) Files on disk
    for (const dir of ['datasets', 'results', 'models']) {
      await removeCompanyFolder(dir, companyName);
    }
    steps.push('deleted dataset, model and result files');

    auditService.logAction({
      action: 'delete',
      resourceType: 'company',
      resourceId: companyId,
      details: { company: companyName, members: members?.length || 0, mongo, by: 'superadmin' },
      req,
    });

    res.json({ success: true, companyId, steps, deleted: mongo });
  } catch (error) {
    console.error('[admin] delete company failed:', error, 'completed steps:', steps);
    res.status(500).json({
      error: 'Could not finish deleting the company',
      message: error.message,
      completedSteps: steps,
    });
  }
};

/**
 * GET /api/admin/revenue
 */
const getRevenue = async (req, res) => {
  try {
    res.json(await buildRevenue(getSupabaseClient()));
  } catch (error) {
    console.error('[admin] revenue failed:', error);
    res.status(500).json({ error: 'Could not load revenue', message: error.message });
  }
};

/**
 * GET /api/admin/jobs?type=training|inference&status=&company=
 * Latest 200 jobs across every company.
 */
const listJobs = async (req, res) => {
  try {
    const type = req.query.type === 'inference' ? 'inference' : 'training';
    const filter = {};
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.company) filter.company = String(req.query.company);

    let jobs;
    if (type === 'training') {
      const rows = await TrainingJob.find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .select('jobId company project modelType modelSize status progress error createdAt startedAt completedAt')
        .lean();
      jobs = rows.map((j) => ({
        id: j.jobId,
        company: j.company,
        project: j.project,
        detail: [j.modelType, j.modelSize].filter(Boolean).join(' '),
        status: j.status,
        error: j.error?.message || (typeof j.error === 'string' ? j.error : null),
        createdAt: j.createdAt,
        startedAt: j.startedAt || null,
        completedAt: j.completedAt || null,
      }));
    } else {
      const rows = await InferenceJob.find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .select('inferenceId company project modelId sourceType status error createdBy createdAt startedAt completedAt')
        .lean();
      jobs = rows.map((j) => ({
        id: j.inferenceId,
        company: j.company,
        project: j.project,
        detail: j.sourceType || null,
        status: j.status,
        error: j.error?.message || (typeof j.error === 'string' ? j.error : null),
        createdBy: j.createdBy || null,
        createdAt: j.createdAt,
        startedAt: j.startedAt || null,
        completedAt: j.completedAt || null,
      }));
    }

    res.json({ type, jobs });
  } catch (error) {
    console.error('[admin] list jobs failed:', error);
    res.status(500).json({ error: 'Could not load jobs', message: error.message });
  }
};

/**
 * GET /api/admin/audit
 * Latest 200 audit log entries across every company, with user emails.
 */
const listAudit = async (req, res) => {
  try {
    const logs = await AuditLog.find({}).sort({ timestamp: -1 }).limit(200).lean();
    const { data: profiles, error } = await getSupabaseClient().from('profiles').select('id, email');
    if (error) throw error;
    const emailById = Object.fromEntries((profiles || []).map((p) => [p.id, p.email]));

    res.json({
      entries: logs.map((l) => ({
        id: l.logId,
        timestamp: l.timestamp,
        userId: l.userId,
        userEmail: emailById[l.userId] || null,
        company: l.company,
        project: l.project,
        action: l.action,
        resourceType: l.resourceType,
        resourceId: l.resourceId,
        details: l.details || {},
      })),
    });
  } catch (error) {
    console.error('[admin] list audit failed:', error);
    res.status(500).json({ error: 'Could not load activity', message: error.message });
  }
};

module.exports = {
  getOverview,
  listUsers,
  setUserStatus,
  deleteUser,
  listCompanies,
  setCompanyUnlimited,
  deleteCompany,
  getRevenue,
  listJobs,
  listAudit,
};
