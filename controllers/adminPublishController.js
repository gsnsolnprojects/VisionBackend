const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Dataset = require('../models/Dataset');
const Model = require('../models/Model');
const auditService = require('../services/auditService');

/**
 * Superadmin: choose which datasets (and the models trained on them) get copied to the
 * live AWS setup. Only the choice is stored here (Dataset.publishToLive); the copy itself
 * is a separate step. Available only when ENABLE_PUBLISH_TO_LIVE=true (the local setup).
 *
 * GET /api/admin/publish/datasets   - every dataset version with size, images and models
 * PUT /api/admin/publish/selection  { datasetIds: string[] } - the full new selection
 */

const isEnabled = () => process.env.ENABLE_PUBLISH_TO_LIVE === 'true';

/** Files the live copy leaves out: RF-DETR resume snapshots and YOLO last-epoch weights */
const isLeftOut = (fileName) => fileName.endsWith('.ckpt') || fileName === 'last.pt';

/** Total bytes of the files under a folder that would be uploaded; null if the folder is missing */
async function uploadSize(dir) {
  if (!dir) return null;
  try {
    await fs.promises.access(dir);
  } catch {
    return null;
  }
  let total = 0;
  const walk = async (folder) => {
    const entries = await fs.promises.readdir(folder, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (isLeftOut(entry.name)) return;
        const stat = await fs.promises.stat(full);
        total += stat.size;
      })
    );
  };
  await walk(dir);
  return total;
}

function requireEnabled(req, res, next) {
  if (!isEnabled()) {
    return res.status(404).json({
      error: 'Not available',
      message: 'Publish to live is only available on the local setup (ENABLE_PUBLISH_TO_LIVE=true)',
    });
  }
  next();
}

const listPublishDatasets = async (req, res) => {
  try {
    const [datasets, models] = await Promise.all([
      Dataset.find({ deletedAt: null })
        .select('company project version status totalImages storagePath createdAt publishToLive')
        .sort({ company: 1, project: 1, createdAt: 1 })
        .lean(),
      Model.find({})
        .select('modelId modelType modelVersion datasetId datasetVersion company project storagePath createdAt')
        .lean(),
    ]);

    // Folder sizes, each folder measured once (several models can share one folder)
    const sizes = new Map();
    const measure = (dir) => {
      if (!dir) return Promise.resolve(null);
      if (!sizes.has(dir)) sizes.set(dir, uploadSize(dir));
      return sizes.get(dir);
    };

    const rows = await Promise.all(
      datasets.map(async (d) => {
        const id = String(d._id);
        const trained = models.filter((m) =>
          m.datasetId
            ? String(m.datasetId) === id
            : m.company === d.company && m.project === d.project && m.datasetVersion === d.version
        );
        const sizeBytes = await measure(d.storagePath);
        return {
          id,
          company: d.company,
          project: String(d.project || '').trim(),
          version: d.version,
          status: d.status,
          totalImages: d.totalImages || 0,
          createdAt: d.createdAt,
          selected: !!d.publishToLive,
          onThisServer: sizeBytes !== null,
          sizeBytes: sizeBytes || 0,
          models: await Promise.all(
            trained.map(async (m) => {
              const modelSize = await measure(m.storagePath);
              return {
                id: String(m._id),
                modelId: m.modelId,
                modelType: m.modelType,
                modelVersion: m.modelVersion,
                createdAt: m.createdAt,
                folder: m.storagePath,
                onThisServer: modelSize !== null,
                sizeBytes: modelSize || 0,
              };
            })
          ),
        };
      })
    );

    // Group by company + project for the panel
    const projects = [];
    const byKey = new Map();
    for (const row of rows) {
      const key = `${row.company}/${row.project}`;
      if (!byKey.has(key)) {
        const group = { company: row.company, project: row.project, versions: [] };
        byKey.set(key, group);
        projects.push(group);
      }
      byKey.get(key).versions.push(row);
    }

    res.json({ projects });
  } catch (error) {
    console.error('[admin] publish list failed:', error);
    res.status(500).json({ error: 'Could not list datasets', message: error.message });
  }
};

const savePublishSelection = async (req, res) => {
  try {
    const { datasetIds } = req.body || {};
    if (!Array.isArray(datasetIds) || datasetIds.some((id) => typeof id !== 'string')) {
      return res.status(400).json({ error: 'Invalid request', message: 'datasetIds must be a list of dataset ids' });
    }
    const unique = [...new Set(datasetIds)];
    if (unique.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({ error: 'Invalid request', message: 'One or more dataset ids are not valid' });
    }

    const chosen = await Dataset.find({ _id: { $in: unique }, deletedAt: null }).select('project version storagePath').lean();
    if (chosen.length !== unique.length) {
      return res.status(400).json({ error: 'Invalid request', message: 'Some datasets were not found or are deleted' });
    }
    const missing = chosen.filter((d) => !d.storagePath || !fs.existsSync(d.storagePath));
    if (missing.length) {
      return res.status(400).json({
        error: 'Invalid request',
        message: `These datasets have no files on this computer: ${missing.map((d) => `${d.project} / ${d.version}`).join(', ')}`,
      });
    }

    const ids = chosen.map((d) => d._id);
    const [cleared, set] = await Promise.all([
      Dataset.updateMany({ _id: { $nin: ids }, publishToLive: true }, { $set: { publishToLive: false } }),
      Dataset.updateMany({ _id: { $in: ids } }, { $set: { publishToLive: true } }),
    ]);

    auditService.logAction({
      action: 'update',
      resourceType: 'dataset',
      resourceId: null,
      details: { company: 'gsn', change: 'publish to live selection saved', selected: ids.length, by: 'superadmin' },
      req,
    });

    res.json({ success: true, selected: ids.length, added: set.modifiedCount, removed: cleared.modifiedCount });
  } catch (error) {
    console.error('[admin] publish selection save failed:', error);
    res.status(500).json({ error: 'Could not save the selection', message: error.message });
  }
};

module.exports = { requireEnabled, listPublishDatasets, savePublishSelection };
