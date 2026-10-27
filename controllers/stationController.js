const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const StationRun = require('../models/StationRun');
const StationDefect = require('../models/StationDefect');
const { buildWorkspaceFilter, canAccessAllWorkspaces } = require('../utils/workspaceScoping');

const STATION_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'station-runs');
const RUN_STATUSES = ['running', 'completed', 'interrupted'];

/** Non-admins can only write into their own company, whatever the body says. */
function resolveCompany(req, bodyCompany) {
  if (canAccessAllWorkspaces(req.user)) return bodyCompany || req.user.company || null;
  return req.user.company || null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sanitizeClassCounts(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n >= 0) out[String(k).slice(0, 200)] = Math.floor(n);
    }
  }
  return out;
}

async function findScopedRun(req, runId) {
  if (!mongoose.Types.ObjectId.isValid(runId)) return null;
  return StationRun.findOne({ _id: runId, ...buildWorkspaceFilter(req.user) });
}

/**
 * POST /api/station/runs
 * Create or update a station run (idempotent on clientRunId).
 */
const upsertRun = async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.clientRunId || typeof b.clientRunId !== 'string') {
      return res.status(400).json({ error: 'clientRunId is required' });
    }
    if (!RUN_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: `status must be one of ${RUN_STATUSES.join(', ')}` });
    }
    const startedAt = parseDate(b.startedAt);
    if (!startedAt) return res.status(400).json({ error: 'startedAt must be a valid date' });

    const company = resolveCompany(req, b.company);
    if (!company) return res.status(403).json({ error: 'User has no workspace' });

    const existing = await StationRun.findOne({ clientRunId: b.clientRunId }).lean();
    if (existing && existing.company !== company) {
      return res.status(409).json({ error: 'clientRunId belongs to another workspace' });
    }

    const a = b.analytics || {};
    const update = {
      clientRunId: b.clientRunId,
      stationName: b.stationName || null,
      name: typeof b.name === 'string' ? b.name.slice(0, 120) : null,
      notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : null,
      company,
      project: b.project || null,
      projectId: b.projectId || null,
      modelId: b.modelId || null,
      modelName: b.modelName || null,
      modelType: b.modelType || null,
      cameraName: b.cameraName || null,
      status: b.status,
      startedAt,
      endedAt: parseDate(b.endedAt),
      analytics: {
        totalProducts: Number(a.totalProducts) || 0,
        goodProducts: Number(a.goodProducts) || 0,
        badProducts: Number(a.badProducts) || 0,
        classCounts: sanitizeClassCounts(a.classCounts),
      },
      config: b.config && typeof b.config === 'object' ? b.config : {},
      stats: b.stats && typeof b.stats === 'object' ? b.stats : {},
      operator: {
        id: b.operator?.id || req.user.id,
        email: b.operator?.email || req.user.email || null,
        role: b.operator?.role || req.user.role || null,
      },
    };

    const run = await StationRun.findOneAndUpdate(
      { clientRunId: b.clientRunId },
      { $set: update, $setOnInsert: { createdBy: req.user.id } },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({ runId: String(run._id) });
  } catch (error) {
    console.error('Error upserting station run:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * POST /api/station/runs/:runId/defects  (multipart: image + clientDefectId, timestamp, verdict, defectClasses)
 * Idempotent on clientDefectId.
 */
const uploadDefect = async (req, res) => {
  const uploadedPath = req.file?.path;
  const discardUpload = () => uploadedPath && fs.promises.unlink(uploadedPath).catch(() => {});
  try {
    const run = await findScopedRun(req, req.params.runId);
    if (!run) {
      await discardUpload();
      return res.status(404).json({ error: 'Run not found' });
    }
    const { clientDefectId, timestamp } = req.body || {};
    if (!clientDefectId || !req.file) {
      await discardUpload();
      return res.status(400).json({ error: 'clientDefectId and image are required' });
    }

    const existing = await StationDefect.findOne({ clientDefectId }).lean();
    if (existing) {
      await discardUpload();
      return res.status(200).json({ defectId: String(existing._id), duplicate: true });
    }

    let defectClasses = [];
    try {
      const parsed = JSON.parse(req.body.defectClasses || '[]');
      if (Array.isArray(parsed)) defectClasses = parsed.map((c) => String(c).slice(0, 200));
    } catch {
      defectClasses = [];
    }

    const defect = await StationDefect.create({
      run: run._id,
      clientDefectId,
      company: run.company,
      timestamp: parseDate(timestamp) || new Date(),
      verdict: 'NOT_OK',
      defectClasses,
      imagePath: uploadedPath,
    });
    await StationRun.updateOne({ _id: run._id }, { $inc: { defectCount: 1 } });

    return res.status(201).json({ defectId: String(defect._id) });
  } catch (error) {
    await discardUpload();
    if (error?.code === 11000) {
      return res.status(200).json({ duplicate: true });
    }
    console.error('Error uploading station defect:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * GET /api/station/runs?company=&project=&limit=
 */
const listRuns = async (req, res) => {
  try {
    const { company, project } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    if (!canAccessAllWorkspaces(req.user) && !req.user.company) {
      return res.status(403).json({ error: 'User has no workspace' });
    }
    const filter = buildWorkspaceFilter(req.user, company, project);
    const runs = await StationRun.find(filter).sort({ startedAt: -1 }).limit(limit).lean();
    return res.status(200).json({ runs, total: runs.length });
  } catch (error) {
    console.error('Error listing station runs:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * GET /api/station/runs/:runId
 */
const getRun = async (req, res) => {
  try {
    const run = await findScopedRun(req, req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const defects = await StationDefect.find({ run: run._id }).sort({ timestamp: -1 }).select('-imagePath').lean();
    return res.status(200).json({ run, defects });
  } catch (error) {
    console.error('Error fetching station run:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * GET /api/station/runs/:runId/defects/:defectId/image
 */
const getDefectImage = async (req, res) => {
  try {
    const run = await findScopedRun(req, req.params.runId);
    if (!run || !mongoose.Types.ObjectId.isValid(req.params.defectId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const defect = await StationDefect.findOne({ _id: req.params.defectId, run: run._id }).lean();
    if (!defect || !fs.existsSync(defect.imagePath)) return res.status(404).json({ error: 'Image not found' });
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(path.resolve(defect.imagePath));
  } catch (error) {
    console.error('Error serving station defect image:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

module.exports = {
  STATION_UPLOAD_DIR,
  upsertRun,
  uploadDefect,
  listRuns,
  getRun,
  getDefectImage,
};
