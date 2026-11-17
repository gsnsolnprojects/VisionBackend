const MobileInspectConfig = require('../models/MobileInspectConfig');
const Model = require('../models/Model');
const { validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const { resolveModelCheckpointPath } = require('../services/resolveModelCheckpoint');
const fs = require('fs');

function parseConfidence(value, fallback = 0.25) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseFloat(value);
  if (Number.isNaN(n) || n < 0 || n > 1) return null;
  return n;
}

async function findSegModel(modelId) {
  let model = null;
  const mongoose = require('mongoose');
  if (mongoose.Types.ObjectId.isValid(modelId) && String(modelId).length === 24) {
    model = await Model.findById(modelId);
  }
  if (!model) {
    model = await Model.findOne({ modelId: String(modelId) });
  }
  return model;
}

function formatConfig(doc, model) {
  if (!doc) return null;
  return {
    company: doc.company,
    project: doc.project,
    modelId: model?.modelId || null,
    mongoModelId: doc.modelId ? doc.modelId.toString() : null,
    modelVersion: model?.modelVersion || null,
    modelType: model?.modelType || null,
    confidenceThreshold: doc.confidenceThreshold,
    updatedBy: doc.updatedBy || null,
    updatedAt: doc.updatedAt,
  };
}

/**
 * GET /api/mobile-inspect/config?company=&project=
 */
const getMobileInspectConfig = async (req, res) => {
  try {
    const company = String(req.query.company || req.user?.company || '').trim();
    const project = String(req.query.project || '').trim();

    if (!company || !project) {
      return res.status(400).json({
        error: 'Missing required query parameters',
        required: ['company', 'project'],
      });
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

    const doc = await MobileInspectConfig.findOne({ company, project }).populate(
      'modelId',
      'modelId modelVersion modelType bestCheckpointPath storagePath'
    );

    if (!doc) {
      return res.status(200).json({
        config: null,
        message: 'No mobile inspect model is pinned for this project. Pin a YOLO_SEG model in Workspace Settings.',
      });
    }

    const model = doc.modelId;
    return res.status(200).json({ config: formatConfig(doc, model) });
  } catch (error) {
    console.error('[mobile-inspect] get config error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * PUT /api/mobile-inspect/config
 * Body: { company, project, modelId, confidenceThreshold? }
 */
const putMobileInspectConfig = async (req, res) => {
  try {
    const company = String(req.body.company || req.user?.company || '').trim();
    const project = String(req.body.project || '').trim();
    const modelId = req.body.modelId;
    const confidenceThreshold = parseConfidence(req.body.confidenceThreshold, 0.25);

    if (!company || !project || !modelId) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['company', 'project', 'modelId'],
      });
    }

    if (confidenceThreshold === null) {
      return res.status(400).json({
        error: 'Invalid confidenceThreshold',
        message: 'Must be a number between 0 and 1',
      });
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

    const model = await findSegModel(modelId);
    if (!model) {
      return res.status(404).json({ error: 'Model not found', modelId });
    }

    if (model.company !== company || model.project !== project) {
      return res.status(400).json({
        error: 'Model does not belong to this organisation and project',
        modelCompany: model.company,
        modelProject: model.project,
      });
    }

    if (model.modelType !== 'YOLO_SEG') {
      return res.status(400).json({
        error: 'Pinned model must be YOLO_SEG',
        modelType: model.modelType,
      });
    }

    const checkpointPath = resolveModelCheckpointPath(model);
    if (!checkpointPath || !fs.existsSync(checkpointPath)) {
      return res.status(400).json({
        error: 'Model checkpoint file not found',
        modelId: model.modelId,
      });
    }

    const doc = await MobileInspectConfig.findOneAndUpdate(
      { company, project },
      {
        company,
        project,
        modelId: model._id,
        confidenceThreshold,
        updatedBy: req.user?.id || null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({
      config: formatConfig(doc, model),
      message: 'Mobile inspect model pinned',
    });
  } catch (error) {
    console.error('[mobile-inspect] put config error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

module.exports = {
  getMobileInspectConfig,
  putMobileInspectConfig,
  findSegModel,
  parseConfidence,
};
