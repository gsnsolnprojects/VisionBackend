const { v4: uuidv4 } = require('uuid');
const ActionItem = require('../models/ActionItem');
const { validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const auditService = require('../services/auditService');

const STATUSES = ['open', 'in_review', 'approved', 'rejected', 'completed'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const CLOSED_STATUSES = ['approved', 'rejected', 'completed'];

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

    return res.status(200).json({
      actions: items.map(withComputedFields),
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
    return res.status(200).json({ action: withComputedFields(item) });
  } catch (error) {
    console.error('Error getting action item:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * POST /api/actions
 * Body: { company, project, surveyName, regionName, inferenceId, filename,
 *         title, description, severity, dueDate, assignedTo, findingSnapshot }
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

    const actionId = `act_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const item = await ActionItem.create({
      actionId,
      company,
      project,
      surveyName: req.body.surveyName || null,
      regionName: req.body.regionName || null,
      inferenceId: req.body.inferenceId || null,
      filename: req.body.filename || null,
      title,
      description: req.body.description || '',
      severity,
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

const EDITABLE_FIELDS = ['title', 'description', 'severity', 'dueDate', 'assignedTo', 'status'];

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
    if (nextStatus === 'approved' && !checkPermissionForApproval(req)) {
      return res.status(403).json({
        error: 'Permission denied',
        message: 'Your role does not have permission to approve actions',
      });
    }
    if (req.body.severity !== undefined && !SEVERITIES.includes(req.body.severity)) {
      return res.status(400).json({ error: 'Invalid severity', message: `severity must be one of: ${SEVERITIES.join(', ')}` });
    }

    const changedFields = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] === undefined) continue;
      const value = field === 'dueDate' ? (req.body.dueDate ? new Date(req.body.dueDate) : null) : req.body[field];
      item[field] = value;
      changedFields[field] = value;
    }
    if (nextStatus === 'approved') {
      item.approvedBy = req.user.id;
      item.approvedAt = new Date();
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

module.exports = {
  listActionItems,
  getActionItem,
  createActionItem,
  updateActionItem,
  deleteActionItem,
};
