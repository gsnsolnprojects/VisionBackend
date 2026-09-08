const { v4: uuidv4 } = require('uuid');
const AuditLog = require('../models/AuditLog');

/**
 * Audit Service
 *
 * Lightweight helper around the AuditLog model so that
 * new admin / analytics features can record important events
 * without touching existing flows.
 */

/**
 * Create a new audit log entry.
 *
 * @param {Object} options
 * @param {string} options.action - 'create' | 'update' | 'delete' | 'view' | 'execute'
 * @param {string} options.resourceType - 'user' | 'company' | 'project' | 'dataset' | 'model' | 'training' | 'inference' | 'action_item'
 * @param {string} [options.resourceId] - ID of the resource
 * @param {Object} [options.details] - Additional JSON payload
 * @param {Object} [options.req] - Optional Express request (for ip/userAgent/user)
 */
async function logAction({ action, resourceType, resourceId, details, req }) {
  try {
    const log = new AuditLog({
      logId: `log_${Date.now()}_${uuidv4().substring(0, 8)}`,
      userId: req?.user?.id || null,
      company: req?.user?.company || details?.company || null,
      project: details?.project || null,
      action,
      resourceType,
      resourceId: resourceId || null,
      details: details || {},
      ipAddress: req?.ip || null,
      userAgent: req?.headers?.['user-agent'] || null,
      timestamp: new Date()
    });

    await log.save();
  } catch (error) {
    // Never throw from logging – this must not break main flows
    console.error('Failed to write audit log entry:', error.message || error);
  }
}

/**
 * Query audit logs with simple filters.
 *
 * NOTE: This is only used by the new /api/audit/log endpoint
 * and does not affect existing controllers.
 *
 * @param {Object} filters
 * @returns {Promise<Array>}
 */
async function getAuditLogs(filters = {}) {
  const {
    company,
    project,
    userId,
    action,
    resourceType,
    startDate,
    endDate,
    page = 1,
    limit = 50
  } = filters;

  const query = {};

  if (company) query.company = company;
  if (project) query.project = project;
  if (userId) query.userId = userId;
  if (action) query.action = action;
  if (resourceType) query.resourceType = resourceType;

  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }

  const skip = (Number(page) - 1) * Number(limit);
  const docs = await AuditLog.find(query)
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  const total = await AuditLog.countDocuments(query);

  return {
    logs: docs,
    total,
    page: Number(page),
    limit: Number(limit)
  };
}

module.exports = {
  logAction,
  getAuditLogs
};

