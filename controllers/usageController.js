const TrainingJob = require('../models/TrainingJob');
const InferenceJob = require('../models/InferenceJob');
const Dataset = require('../models/Dataset');
const AuditLog = require('../models/AuditLog');
const GpuServerSession = require('../models/GpuServerSession');
const { canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const { getSupabaseClient } = require('../services/supabaseService');

/**
 * GET /api/usage/activity?month=YYYY-MM[&company=<name>|all]
 *
 * Who did what and when, for Settings -> Usage: every training (with GPU time), test, set of
 * extra photos and upload in the month, totals per person, and the month's summary. Customers
 * see their own company; the platform admin can pick any company or all, and also gets the GPU
 * server's real on-time (what AWS bills, including start-up and idle minutes) and its cost.
 */

/** GPU server price: g4dn.xlarge in Mumbai, $0.579 an hour at about Rs 88 per $1 */
const GPU_INR_PER_HOUR = 51;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** [start, end) of a calendar month in India time, from "YYYY-MM" (default: this month) */
function monthRange(month) {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  const [y, m] = /^\d{4}-\d{2}$/.test(month || '')
    ? month.split('-').map(Number)
    : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const start = new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS);
  return { month: `${y}-${String(m).padStart(2, '0')}`, start, end };
}

const minutesBetween = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 60000) : null);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/** userId -> { name, email } from Supabase profiles */
async function loadPeople(userIds) {
  // Only real user ids: one non-UUID value makes the whole Supabase query fail
  const ids = [...new Set(userIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id || '')))];
  if (!ids.length) return new Map();
  try {
    const { data } = await getSupabaseClient().from('profiles').select('id, name, email').in('id', ids);
    return new Map((data || []).map((p) => [p.id, { name: p.name || p.email || 'Unknown', email: p.email || null }]));
  } catch {
    return new Map();
  }
}

const getActivity = async (req, res) => {
  try {
    const isAdmin = canAccessAllWorkspaces(req.user);
    const { month, start, end } = monthRange(req.query.month);
    const company = isAdmin ? String(req.query.company || 'all') : req.user.company;
    if (!company) return res.status(400).json({ error: 'No company', message: 'Create or join a company first.' });
    const byCompany = company === 'all' ? {} : { company };
    const inMonth = { createdAt: { $gte: start, $lt: end } };

    const [trainings, tests, augmented, uploads] = await Promise.all([
      TrainingJob.find({ ...byCompany, ...inMonth })
        .select('jobId company project modelType modelSize status device createdAt startedAt completedAt cancelledAt updatedAt')
        .lean(),
      InferenceJob.find({ ...byCompany, ...inMonth, sourceType: { $nin: ['live_camera', 'live'] } })
        .select('inferenceId company project status purpose createdBy createdAt startedAt completedAt cancelledAt updatedAt progress.totalImages')
        .lean(),
      Dataset.find({ ...byCompany, ...inMonth, isAugmented: true })
        .select('company project version status totalImages parentDatasetId createdAt updatedAt')
        .lean(),
      Dataset.find({ ...byCompany, ...inMonth, isAugmented: { $ne: true }, linkedFrom: null })
        .select('company project version status totalImages labelledSampleOf createdAt updatedAt')
        .lean(),
    ]);

    // Who started each: the audit log has the user for every training, test and dataset
    const ids = [
      ...trainings.map((t) => t.jobId),
      ...tests.map((t) => t.inferenceId),
      ...augmented.map((d) => String(d.parentDatasetId)),
      ...uploads.map((d) => String(d._id)),
    ];
    const audits = await AuditLog.find({ resourceId: { $in: ids }, action: { $in: ['execute', 'create'] } })
      .select('resourceType resourceId userId action')
      .sort({ timestamp: 1 })
      .lean();
    // Extra photos are logged as 'execute' on the source dataset; an upload is its 'create'
    const isAugment = (a) => a.resourceType === 'dataset' && a.action === 'execute';
    const starter = new Map(audits.filter((a) => !isAugment(a)).map((a) => [a.resourceId, a.userId]));
    const augmenter = new Map(audits.filter(isAugment).map((a) => [a.resourceId, a.userId]));
    augmented.forEach((d) => augmenter.has(String(d.parentDatasetId)) && starter.set(String(d._id), augmenter.get(String(d.parentDatasetId))));
    tests.forEach((t) => !starter.has(t.inferenceId) && t.createdBy && starter.set(t.inferenceId, t.createdBy));
    const people = await loadPeople([...starter.values()]);
    const personOf = (id) => {
      const userId = starter.get(id) || null;
      const p = userId ? people.get(userId) : null;
      return { userId, name: p?.name || null, email: p?.email || null };
    };

    const sessions = [];
    for (const t of trainings) {
      const ended = t.completedAt || t.cancelledAt || (['failed', 'cancelled'].includes(t.status) ? t.updatedAt : null);
      sessions.push({
        type: 'training',
        id: t.jobId,
        company: t.company,
        project: t.project,
        person: personOf(t.jobId),
        detail: `${t.modelType || 'YOLO'} ${t.modelSize || ''}`.trim(),
        device: t.device || null,
        queuedAt: t.createdAt,
        startedAt: t.startedAt || null,
        endedAt: ended || null,
        minutes: round1(minutesBetween(t.startedAt, ended)),
        waitMinutes: round1(minutesBetween(t.createdAt, t.startedAt)),
        status: t.status,
      });
    }
    for (const t of tests) {
      const ended = t.completedAt || t.cancelledAt || (['failed', 'cancelled'].includes(t.status) ? t.updatedAt : null);
      sessions.push({
        type: t.purpose === 'practice' ? 'practice' : 'test',
        id: t.inferenceId,
        company: t.company,
        project: t.project,
        person: personOf(t.inferenceId),
        detail: `${t.progress?.totalImages || 0} photos`,
        device: 'cpu',
        queuedAt: t.createdAt,
        startedAt: t.startedAt || t.createdAt,
        endedAt: ended || null,
        minutes: round1(minutesBetween(t.startedAt || t.createdAt, ended)),
        status: t.status,
        photos: t.progress?.totalImages || 0,
      });
    }
    for (const d of augmented) {
      sessions.push({
        type: 'more-photos',
        id: String(d._id),
        company: d.company,
        project: d.project,
        person: personOf(String(d._id)),
        detail: `${d.version} · ${d.totalImages || 0} photos`,
        device: 'cpu',
        startedAt: d.createdAt,
        endedAt: d.status === 'processing' ? null : d.updatedAt,
        minutes: d.status === 'processing' ? null : round1(minutesBetween(d.createdAt, d.updatedAt)),
        status: d.status,
      });
    }
    for (const d of uploads) {
      sessions.push({
        type: d.labelledSampleOf ? 'sample-to-label' : 'upload',
        id: String(d._id),
        company: d.company,
        project: d.project,
        person: personOf(String(d._id)),
        detail: `${d.version} · ${d.totalImages || 0} photos`,
        device: 'cpu',
        startedAt: d.createdAt,
        endedAt: null,
        minutes: null,
        status: d.status,
      });
    }
    sessions.sort((a, b) => new Date(b.startedAt || b.queuedAt) - new Date(a.startedAt || a.queuedAt));

    // Totals per person and for the month
    const perPerson = new Map();
    const summary = { gpuTrainingMinutes: 0, cpuTrainingMinutes: 0, trainings: 0, tests: 0, photosPredicted: 0, morePhotos: 0, uploads: 0 };
    for (const s of sessions) {
      const key = s.person.userId || 'unknown';
      const row = perPerson.get(key) || {
        userId: s.person.userId, name: s.person.name, email: s.person.email,
        gpuTrainingMinutes: 0, trainings: 0, tests: 0, photosPredicted: 0,
      };
      if (s.type === 'training') {
        summary.trainings += 1;
        row.trainings += 1;
        if (s.device === 'gpu') {
          summary.gpuTrainingMinutes += s.minutes || 0;
          row.gpuTrainingMinutes += s.minutes || 0;
        } else summary.cpuTrainingMinutes += s.minutes || 0;
      } else if (s.type === 'test') {
        summary.tests += 1;
        summary.photosPredicted += s.photos || 0;
        row.tests += 1;
        row.photosPredicted += s.photos || 0;
      } else if (s.type === 'more-photos') summary.morePhotos += 1;
      else if (s.type === 'upload' || s.type === 'sample-to-label') summary.uploads += 1;
      perPerson.set(key, row);
    }
    summary.gpuTrainingMinutes = round1(summary.gpuTrainingMinutes);
    summary.cpuTrainingMinutes = round1(summary.cpuTrainingMinutes);

    const payload = {
      month,
      company,
      summary,
      people: [...perPerson.values()]
        .map((p) => ({ ...p, gpuTrainingMinutes: round1(p.gpuTrainingMinutes) }))
        .sort((a, b) => b.gpuTrainingMinutes - a.gpuTrainingMinutes || b.tests - a.tests),
      sessions,
    };

    // Platform admin: the GPU server's real on-time and cost
    if (isAdmin) {
      const servers = await GpuServerSession.find({ startedAt: { $lt: end }, $or: [{ stoppedAt: null }, { stoppedAt: { $gte: start } }] })
        .sort({ startedAt: -1 })
        .lean();
      const rows = servers.map((s) => {
        const from = new Date(Math.max(new Date(s.startedAt), start));
        const to = s.stoppedAt ? new Date(Math.min(new Date(s.stoppedAt), end)) : new Date(Math.min(Date.now(), end));
        return { startedAt: s.startedAt, stoppedAt: s.stoppedAt, running: !s.stoppedAt, minutes: round1(minutesBetween(from, to)) };
      });
      const totalMinutes = round1(rows.reduce((sum, r) => sum + (r.minutes || 0), 0));
      payload.gpuServer = {
        sessions: rows,
        totalMinutes,
        inrPerHour: GPU_INR_PER_HOUR,
        costInr: Math.round(((totalMinutes || 0) / 60) * GPU_INR_PER_HOUR),
      };
    }

    res.json(payload);
  } catch (error) {
    console.error('[usage] activity failed:', error);
    res.status(500).json({ error: 'Could not load usage', message: error.message });
  }
};

module.exports = { getActivity };
