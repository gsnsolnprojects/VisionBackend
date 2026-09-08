const mongoose = require('mongoose');

/**
 * AuditLog Schema
 *
 * Stores a minimal, structured record of important actions in the system
 * for traceability and governance. This does not affect existing flows;
 * it is only used by new admin/analytics features.
 */

const auditLogSchema = new mongoose.Schema({
  logId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Supabase UUID string — there is no Mongo User model, so this is never
  // an ObjectId (was previously typed as one and silently stored null).
  userId: {
    type: String
  },

  company: {
    type: String,
    index: true
  },

  project: {
    type: String,
    index: true
  },

  action: {
    type: String,
    enum: ['create', 'update', 'delete', 'view', 'execute'],
    required: true,
    index: true
  },

  resourceType: {
    type: String,
    enum: ['user', 'company', 'project', 'dataset', 'model', 'training', 'inference', 'action_item'],
    required: true,
    index: true
  },

  resourceId: {
    type: String
  },

  details: {
    type: Object // Free-form JSON payload with additional context
  },

  ipAddress: {
    type: String
  },

  userAgent: {
    type: String
  },

  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('AuditLog', auditLogSchema);

