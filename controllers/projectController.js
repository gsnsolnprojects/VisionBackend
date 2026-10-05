const InferenceJob = require('../models/InferenceJob');
const ActionItem = require('../models/ActionItem');
const Model = require('../models/Model');
const MobileInspectConfig = require('../models/MobileInspectConfig');
const Dataset = require('../models/Dataset');
const TrainingJob = require('../models/TrainingJob');
const Observation = require('../models/Observation');
const ObservationCounter = require('../models/ObservationCounter');
const { validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const auditService = require('../services/auditService');

/**
 * Collections that scope records by plain company/project NAME strings
 * (there is no Mongo Project collection — the canonical project record is
 * in Supabase, matched here only by name). Renaming a project in Supabase
 * without also updating these leaves every one of them orphaned under the
 * old name, invisible to every query that filters by project.
 *
 * AuditLog is deliberately NOT included — audit entries should keep
 * reflecting what the project was called at the time of the action, not
 * get silently rewritten by a later rename.
 */
const RENAME_TARGETS = [
  { label: 'inferenceJobs', Model: InferenceJob },
  { label: 'actionItems', Model: ActionItem },
  { label: 'models', Model: Model },
  { label: 'datasets', Model: Dataset },
  { label: 'trainingJobs', Model: TrainingJob },
  { label: 'observations', Model: Observation },
];

/**
 * PATCH /api/projects/rename
 *
 * Renames a project across every Mongo collection that references it by
 * name, so historical inspection data (surveys, parts, photos, actions,
 * trained models, pinned mobile-inspect config) stays linked after a
 * project is renamed in Supabase. Call this immediately after the
 * Supabase-side rename succeeds — Supabase remains the source of truth for
 * the project's canonical name; this endpoint only keeps Mongo in sync.
 *
 * Body: { company, oldProjectName, newProjectName }
 */
const renameProject = async (req, res) => {
  try {
    const company = String(req.body.company || '').trim();
    const oldProjectName = String(req.body.oldProjectName || '').trim();
    const newProjectName = String(req.body.newProjectName || '').trim();

    if (!company || !oldProjectName || !newProjectName) {
      return res.status(400).json({
        error: 'Missing required field(s)',
        required: ['company', 'oldProjectName', 'newProjectName'],
      });
    }
    if (oldProjectName === newProjectName) {
      return res.status(200).json({ message: 'No change', collections: {} });
    }

    if (!canAccessAllWorkspaces(req.user)) {
      const access = validateWorkspaceAccess(req.user, company);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: access.error || 'You do not have access to this workspace',
        });
      }
    }

    const collections = {};
    for (const { label, Model: TargetModel } of RENAME_TARGETS) {
      const result = await TargetModel.updateMany(
        { company, project: oldProjectName },
        { $set: { project: newProjectName } }
      );
      collections[label] = result.modifiedCount;
    }

    // MobileInspectConfig has a UNIQUE index on {company, project} — handle
    // separately so a pre-existing stray config at the new name (unlikely,
    // but possible) reports a clear error instead of silently failing.
    try {
      const configResult = await MobileInspectConfig.updateOne(
        { company, project: oldProjectName },
        { $set: { project: newProjectName } }
      );
      collections.mobileInspectConfig = configResult.modifiedCount;
    } catch (configErr) {
      collections.mobileInspectConfig = 0;
      collections.mobileInspectConfigError = configErr.message;
    }

    // ObservationCounter also has a UNIQUE index on {company, project} — same
    // reasoning as MobileInspectConfig above.
    try {
      const counterResult = await ObservationCounter.updateOne(
        { company, project: oldProjectName },
        { $set: { project: newProjectName } }
      );
      collections.observationCounters = counterResult.modifiedCount;
    } catch (counterErr) {
      collections.observationCounters = 0;
      collections.observationCountersError = counterErr.message;
    }

    auditService.logAction({
      action: 'update',
      resourceType: 'project',
      resourceId: newProjectName,
      details: { company, oldProjectName, newProjectName, collections },
      req,
    });

    return res.status(200).json({
      message: 'Project renamed across all linked records',
      company,
      oldProjectName,
      newProjectName,
      collections,
    });
  } catch (error) {
    console.error('Error renaming project:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

module.exports = { renameProject };
