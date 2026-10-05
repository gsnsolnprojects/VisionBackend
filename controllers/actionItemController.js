const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ActionItem = require('../models/ActionItem');
const InferenceJob = require('../models/InferenceJob');
const { validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const auditService = require('../services/auditService');

const STATUSES = ['open', 'in_review', 'approved', 'rejected', 'completed'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
// An issue is only "closed" once it's resolved (completed) or dismissed (rejected).
// Legacy 'approved' items (from before the approve step was removed) still count as open.
const CLOSED_STATUSES = ['rejected', 'completed'];
const DECISIONS = ['monitor', 'inspect_further', 'repair', 'recoat', 'replace'];
const DAMAGE_TAGS = ['peeling', 'cracking', 'blistering', 'exposed_metal'];

const actionItemsDir = path.join(process.cwd(), 'uploads', 'action-items');

function normalizeDamageTags(input) {
  const list = Array.isArray(input) ? input : [];
  return [...new Set(list.filter((t) => DAMAGE_TAGS.includes(t)))];
}

async function scopedCompanyProject(req, res) {
  const company = String(req.query.company || req.body?.company || req.user?.company || '').trim();
  const project = String(req.query.project || req.body?.project || '').trim();
  if (!company || !project) {
    res.status(400).json({
      error: 'Missing required parameter(s)',
      required: ['company', 'project'],
    });
    return null;
  }
  if (!canAccessAllWorkspaces(req.user)) {
    const access = validateWorkspaceAccess(req.user, company);
    if (!access.allowed) {
      res.status(403).json({
        error: 'Permission denied',
        message: access.error || 'You do not have access to this workspace',
      });
      return null;
    }
  }
  return { company, project };
}

function withComputedFields(doc) {
  const isOverdue = !!(
    doc.dueDate &&
    new Date(doc.dueDate).getTime() < Date.now() &&
    !CLOSED_STATUSES.includes(doc.status)
  );
  return { ...doc, isOverdue };
}

/**
 * A closed repair (`status: 'completed'`) "establishes a new baseline" in
 * spirit, but only once someone actually goes and re-photographs the part —
 * until then it's flagged `needsResurvey` so the dashboard/app can nudge for
 * that follow-up visit. True when the repair was closed and no completed
 * survey visit for that region has happened since.
 */
async function attachResurveyFlags(docs) {
  const candidates = docs.filter((d) => d.status === 'completed' && (d.observationId || d.regionName) && d.completedAt);
  if (candidates.length === 0) {
    return docs.map((d) => ({ ...d, needsResurvey: false }));
  }

  // Issues on a specific spot are confirmed by a later visit to that same spot;
  // older issues (no observation) fall back to the whole area.
  const keyOf = (d) =>
    d.observationId
      ? `${d.company}\u0000${d.project}\u0000obs:${d.observationId}`
      : `${d.company}\u0000${d.project}\u0000${d.regionName}`;
  const uniqueKeys = new Map();
  for (const d of candidates) {
    if (!uniqueKeys.has(keyOf(d))) {
      uniqueKeys.set(keyOf(d), {
        company: d.company,
        project: d.project,
        regionName: d.regionName,
        observationId: d.observationId || null,
      });
    }
  }

  const latestByKey = new Map();
  await Promise.all(
    [...uniqueKeys.entries()].map(async ([key, { company, project, regionName, observationId }]) => {
      const spot = observationId ? { observationId } : { regionName };
      const latest = await InferenceJob.findOne({ company, project, ...spot, status: 'completed' })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean();
      latestByKey.set(key, latest ? latest.createdAt : null);
    })
  );

  return docs.map((d) => {
    if (d.status !== 'completed' || !(d.observationId || d.regionName) || !d.completedAt) {
      return { ...d, needsResurvey: false };
    }
    const latestVisit = latestByKey.get(keyOf(d));
    const needsResurvey = !latestVisit || new Date(latestVisit).getTime() <= new Date(d.completedAt).getTime();
    return { ...d, needsResurvey };
  });
}

/**
 * GET /api/actions?company=&project=&status=&severity=&overdueOnly=&regionName=&surveyName=&page=&limit=
 */
const listActionItems = async (req, res) => {
  try {
    const scope = await scopedCompanyProject(req, res);
    if (!scope) return;
    const { company, project } = scope;
    const { status, severity, overdueOnly, regionName, surveyName } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const filter = { company, project };
    if (status) filter.status = status;
    if (severity) filter.severity = severity;
    if (regionName) filter.regionName = regionName;
    if (surveyName) filter.surveyName = surveyName;
    if (overdueOnly === 'true') {
      filter.dueDate = { $lt: new Date() };
      filter.status = { $nin: CLOSED_STATUSES };
    }

    const [items, total] = await Promise.all([
      ActionItem.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ActionItem.countDocuments(filter),
    ]);

    const withResurveyFlags = await attachResurveyFlags(items.map(withComputedFields));

    return res.status(200).json({
      actions: withResurveyFlags,
      total,
      page,
      limit,
    });
  } catch (error) {
    console.error('Error listing action items:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * GET /api/actions/:actionId
 */
const getActionItem = async (req, res) => {
  try {
    const item = await ActionItem.findOne({ actionId: req.params.actionId }).lean();
    if (!item) {
      return res.status(404).json({ error: 'Action not found', actionId: req.params.actionId });
    }
    if (!canAccessAllWorkspaces(req.user)) {
      const access = validateWorkspaceAccess(req.user, item.company);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: access.error || 'You do not have access to this action',
        });
      }
    }
    const [withFlags] = await attachResurveyFlags([withComputedFields(item)]);
    return res.status(200).json({ action: withFlags });
  } catch (error) {
    console.error('Error getting action item:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * POST /api/actions
 * Body: { company, project, surveyName, regionName, inferenceId, filename,
 *         title, description, severity, decision, damageTags, dueDate,
 *         assignedTo, findingSnapshot }
 */
const createActionItem = async (req, res) => {
  try {
    const scope = await scopedCompanyProject(req, res);
    if (!scope) return;
    const { company, project } = scope;

    const title = String(req.body.title || '').trim();
    if (!title) {
      return res.status(400).json({ error: 'Missing required field: title' });
    }
    const severity = req.body.severity;
    if (!SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity', message: `severity must be one of: ${SEVERITIES.join(', ')}` });
    }
    if (req.body.decision !== undefined && req.body.decision !== null && !DECISIONS.includes(req.body.decision)) {
      return res.status(400).json({ error: 'Invalid decision', message: `decision must be one of: ${DECISIONS.join(', ')}` });
    }

    const actionId = `act_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const item = await ActionItem.create({
      actionId,
      company,
      project,
      surveyName: req.body.surveyName || null,
      regionName: req.body.regionName || null,
      observationId: req.body.observationId || null,
      componentName: req.body.componentName || '',
      inferenceId: req.body.inferenceId || null,
      filename: req.body.filename || null,
      title,
      description: req.body.description || '',
      severity,
      decision: req.body.decision || null,
      damageTags: normalizeDamageTags(req.body.damageTags),
      engineeringRecommendation: req.body.engineeringRecommendation || '',
      status: 'open',
      dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null,
      createdBy: req.user.id,
      assignedTo: req.body.assignedTo || null,
      findingSnapshot: req.body.findingSnapshot || null,
    });

    auditService.logAction({
      action: 'create',
      resourceType: 'action_item',
      resourceId: actionId,
      details: { company, project, regionName: item.regionName, severity },
      req,
    });

    return res.status(201).json({ action: withComputedFields(item.toObject()) });
  } catch (error) {
    console.error('Error creating action item:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

const EDITABLE_FIELDS = [
  'title',
  'description',
  'severity',
  'dueDate',
  'assignedTo',
  'status',
  'decision',
  'reviewerNotes',
  'engineeringRecommendation',
  'repairActionTaken',
];

/**
 * PATCH /api/actions/:actionId
 */
const updateActionItem = async (req, res) => {
  try {
    const item = await ActionItem.findOne({ actionId: req.params.actionId });
    if (!item) {
      return res.status(404).json({ error: 'Action not found', actionId: req.params.actionId });
    }
    if (!canAccessAllWorkspaces(req.user)) {
      const access = validateWorkspaceAccess(req.user, item.company);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: access.error || 'You do not have access to this action',
        });
      }
    }

    const nextStatus = req.body.status;
    if (nextStatus !== undefined && !STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status', message: `status must be one of: ${STATUSES.join(', ')}` });
    }
    // "Technical approval closes the observation" — closing it out (whether
    // via the approve step or completing the repair directly) requires the
    // same approval permission either way.
    if ((nextStatus === 'approved' || nextStatus === 'completed') && !checkPermissionForApproval(req)) {
      return res.status(403).json({
        error: 'Permission denied',
        message: 'Your role does not have permission to approve actions',
      });
    }
    if (req.body.severity !== undefined && !SEVERITIES.includes(req.body.severity)) {
      return res.status(400).json({ error: 'Invalid severity', message: `severity must be one of: ${SEVERITIES.join(', ')}` });
    }
    if (req.body.decision !== undefined && req.body.decision !== null && !DECISIONS.includes(req.body.decision)) {
      return res.status(400).json({ error: 'Invalid decision', message: `decision must be one of: ${DECISIONS.join(', ')}` });
    }

    const changedFields = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] === undefined) continue;
      const value = field === 'dueDate' ? (req.body.dueDate ? new Date(req.body.dueDate) : null) : req.body[field];
      item[field] = value;
      changedFields[field] = value;
    }
    if (req.body.damageTags !== undefined) {
      item.damageTags = normalizeDamageTags(req.body.damageTags);
      changedFields.damageTags = item.damageTags;
    }
    if ((nextStatus === 'approved' || nextStatus === 'completed') && !item.approvedBy) {
      item.approvedBy = req.user.id;
      item.approvedAt = new Date();
    }
    if (nextStatus === 'completed') {
      item.completedAt = new Date();
    }

    await item.save();

    auditService.logAction({
      action: 'update',
      resourceType: 'action_item',
      resourceId: item.actionId,
      details: { company: item.company, project: item.project, changedFields },
      req,
    });

    return res.status(200).json({ action: withComputedFields(item.toObject()) });
  } catch (error) {
    console.error('Error updating action item:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

function checkPermissionForApproval(req) {
  const { checkPermission } = require('../utils/permissions');
  return checkPermission(req.user?.role, 'approveActions');
}

/**
 * DELETE /api/actions/:actionId
 */
const deleteActionItem = async (req, res) => {
  try {
    const item = await ActionItem.findOne({ actionId: req.params.actionId });
    if (!item) {
      return res.status(404).json({ error: 'Action not found', actionId: req.params.actionId });
    }
    if (!canAccessAllWorkspaces(req.user)) {
      const access = validateWorkspaceAccess(req.user, item.company);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: access.error || 'You do not have access to this action',
        });
      }
    }

    await ActionItem.deleteOne({ actionId: req.params.actionId });

    auditService.logAction({
      action: 'delete',
      resourceType: 'action_item',
      resourceId: item.actionId,
      details: { company: item.company, project: item.project },
      req,
    });

    return res.status(200).json({ actionId: item.actionId, message: 'Action deleted' });
  } catch (error) {
    console.error('Error deleting action item:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * POST /api/actions/:actionId/after-photo
 * multipart: file (the after-repair photo)
 *
 * Records evidence that a repair/recoat was actually done — the "before"
 * photo is just the finding's own inferenceId/filename, already on the
 * action, so only "after" needs its own storage.
 */
const uploadAfterPhoto = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', message: 'A photo file is required.' });
    }
    const item = await ActionItem.findOne({ actionId: req.params.actionId });
    if (!item) {
      return res.status(404).json({ error: 'Action not found', actionId: req.params.actionId });
    }
    if (!canAccessAllWorkspaces(req.user)) {
      const access = validateWorkspaceAccess(req.user, item.company);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: access.error || 'You do not have access to this action',
        });
      }
    }

    item.afterPhotos.push(req.file.filename);
    await item.save();

    auditService.logAction({
      action: 'update',
      resourceType: 'action_item',
      resourceId: item.actionId,
      details: { company: item.company, project: item.project, addedAfterPhoto: req.file.filename },
      req,
    });

    return res.status(200).json({ action: withComputedFields(item.toObject()) });
  } catch (error) {
    console.error('Error uploading after-photo:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * GET /api/actions/:actionId/photo/:filename
 * Serves one of an action's after-repair photos.
 */
const getActionPhoto = async (req, res) => {
  try {
    const { actionId, filename } = req.params;
    const item = await ActionItem.findOne({ actionId }).lean();
    if (!item) {
      return res.status(404).json({ error: 'Action not found', actionId });
    }
    if (!canAccessAllWorkspaces(req.user)) {
      const access = validateWorkspaceAccess(req.user, item.company);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: access.error || 'You do not have access to this action',
        });
      }
    }
    if (!item.afterPhotos.includes(filename)) {
      return res.status(404).json({ error: 'Photo not found on this action', filename });
    }

    const filePath = path.join(actionItemsDir, actionId, filename);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(actionItemsDir)) || !fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found', filename });
    }
    return res.sendFile(resolvedPath);
  } catch (error) {
    console.error('Error serving action photo:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

module.exports = {
  // Shared with the PDF report so "awaiting resurvey" is computed in one place.
  attachResurveyFlags,
  listActionItems,
  getActionItem,
  createActionItem,
  updateActionItem,
  deleteActionItem,
  uploadAfterPhoto,
  getActionPhoto,
};
