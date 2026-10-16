const mongoose = require('mongoose');
const Dataset = require('../models/Dataset');
const SampleLibraryItem = require('../models/SampleLibraryItem');
const { SAMPLE_INDUSTRIES } = require('../models/SampleLibraryItem');
const auditService = require('../services/auditService');
const {
  readyGsnDatasetFilter,
  isOnThisServer,
  guessIndustry,
  defaultName,
  addAllGsnDatasets,
  deleteDatasetPermanently,
  pruneDeletedEntries,
} = require('../services/sampleLibraryService');

/**
 * Superadmin: manage the Playground sample dataset library
 *
 * GET    /api/admin/sample-library             - entries + GSN datasets not in it yet
 * POST   /api/admin/sample-library             { datasetId, name?, industry?, description? }
 * POST   /api/admin/sample-library/add-all     - add every ready GSN dataset not in it yet
 * PATCH  /api/admin/sample-library/:itemId     { name?, industry?, description?, isVisible? }
 * DELETE /api/admin/sample-library/:itemId     { confirmName } - removes the entry AND deletes
 *                                                 GSN's original dataset permanently
 */

const datasetFields = 'project version storagePath status totalImages trainCount valCount testCount labels createdAt deletedAt';

const describeDataset = (d) =>
  d
    ? {
        project: d.project,
        version: d.version,
        totalImages: d.totalImages || 0,
        trainCount: d.trainCount || 0,
        valCount: d.valCount || 0,
        testCount: d.testCount || 0,
        labels: Array.isArray(d.labels) ? d.labels : [],
        onThisServer: isOnThisServer(d),
        usable: !d.deletedAt && ['ready', 'ready_to_train'].includes(d.status) && (d.trainCount || 0) > 0,
      }
    : null;

function badRequest(res, message) {
  return res.status(400).json({ error: 'Invalid request', message });
}

/** Validate optional editable fields; returns { update } or { error } */
function readEdits(body, { requireName = false } = {}) {
  const update = {};
  if (body.name !== undefined || requireName) {
    const name = String(body.name ?? '').trim();
    if (!name) return { error: 'Name cannot be empty' };
    if (name.length > 80) return { error: 'Name must be at most 80 characters' };
    update.name = name;
  }
  if (body.industry !== undefined) {
    if (!SAMPLE_INDUSTRIES.includes(body.industry)) {
      return { error: `Industry must be one of: ${SAMPLE_INDUSTRIES.join(', ')}` };
    }
    update.industry = body.industry;
  }
  if (body.description !== undefined) {
    const description = String(body.description ?? '').trim();
    if (description.length > 300) return { error: 'Description must be at most 300 characters' };
    update.description = description;
  }
  if (body.isVisible !== undefined) {
    if (typeof body.isVisible !== 'boolean') return { error: '"isVisible" must be true or false' };
    update.isVisible = body.isVisible;
  }
  return { update };
}

/**
 * GET /api/admin/sample-library
 */
const listLibrary = async (req, res) => {
  try {
    // Entries whose dataset was deleted elsewhere are removed before listing
    await pruneDeletedEntries();

    const [items, gsnDatasets] = await Promise.all([
      SampleLibraryItem.find({}).sort({ industry: 1, name: 1 }).lean(),
      Dataset.find(readyGsnDatasetFilter).select(datasetFields).sort({ project: 1, createdAt: -1 }).lean(),
    ]);

    const linkedDatasets = await Dataset.find({ _id: { $in: items.map((i) => i.datasetId) } })
      .select(datasetFields)
      .lean();
    const byId = new Map(linkedDatasets.map((d) => [String(d._id), d]));
    const inLibrary = new Set(items.map((i) => String(i.datasetId)));

    res.json({
      industries: SAMPLE_INDUSTRIES,
      items: items.map((i) => ({
        id: String(i._id),
        datasetId: String(i.datasetId),
        name: i.name,
        industry: i.industry,
        description: i.description || '',
        isVisible: i.isVisible,
        createdAt: i.createdAt,
        dataset: describeDataset(byId.get(String(i.datasetId))),
      })),
      available: gsnDatasets
        .filter((d) => !inLibrary.has(String(d._id)) && isOnThisServer(d))
        .map((d) => ({
          datasetId: String(d._id),
          suggestedName: defaultName(d),
          suggestedIndustry: guessIndustry(d),
          ...describeDataset(d),
        })),
    });
  } catch (error) {
    console.error('[admin] sample library list failed:', error);
    res.status(500).json({ error: 'Could not load the sample library', message: error.message });
  }
};

/**
 * POST /api/admin/sample-library  { datasetId, name?, industry?, description? }
 */
const addToLibrary = async (req, res) => {
  try {
    const { datasetId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(datasetId)) return badRequest(res, 'Choose a dataset to add');

    const dataset = await Dataset.findOne({ ...readyGsnDatasetFilter, _id: datasetId }).lean();
    if (!dataset) return res.status(404).json({ error: 'Not found', message: 'Ready GSN dataset not found' });
    if (!isOnThisServer(dataset)) return badRequest(res, "This dataset's files are not on this server");
    if (await SampleLibraryItem.exists({ datasetId })) return badRequest(res, 'This dataset is already in the library');

    const { update, error } = readEdits({
      name: req.body.name ?? defaultName(dataset),
      industry: req.body.industry ?? guessIndustry(dataset),
      description: req.body.description ?? '',
    });
    if (error) return badRequest(res, error);

    const item = await SampleLibraryItem.create({ datasetId, ...update, isVisible: true });

    auditService.logAction({
      action: 'create',
      resourceType: 'dataset',
      resourceId: String(datasetId),
      details: { company: 'gsn', change: 'added to sample library', name: item.name, by: 'superadmin' },
      req,
    });

    res.status(201).json({ success: true, id: String(item._id) });
  } catch (error) {
    console.error('[admin] sample library add failed:', error);
    res.status(500).json({ error: 'Could not add to the sample library', message: error.message });
  }
};

/**
 * POST /api/admin/sample-library/add-all
 */
const addAllToLibrary = async (req, res) => {
  try {
    const added = await addAllGsnDatasets();
    if (added > 0) {
      auditService.logAction({
        action: 'create',
        resourceType: 'dataset',
        details: { company: 'gsn', change: `added ${added} datasets to sample library`, by: 'superadmin' },
        req,
      });
    }
    res.json({ success: true, added });
  } catch (error) {
    console.error('[admin] sample library add-all failed:', error);
    res.status(500).json({ error: 'Could not add datasets to the sample library', message: error.message });
  }
};

/**
 * PATCH /api/admin/sample-library/:itemId  { name?, industry?, description?, isVisible? }
 */
const updateLibraryItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(itemId)) return badRequest(res, 'Invalid library entry');

    const { update, error } = readEdits(req.body || {});
    if (error) return badRequest(res, error);
    if (Object.keys(update).length === 0) return badRequest(res, 'Nothing to change');

    const item = await SampleLibraryItem.findByIdAndUpdate(itemId, { $set: update }, { new: true, runValidators: true }).lean();
    if (!item) return res.status(404).json({ error: 'Not found', message: 'Library entry not found' });

    auditService.logAction({
      action: 'update',
      resourceType: 'dataset',
      resourceId: String(item.datasetId),
      details: { company: 'gsn', change: 'edited sample library entry', name: item.name, fields: Object.keys(update).join(', '), by: 'superadmin' },
      req,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[admin] sample library update failed:', error);
    res.status(500).json({ error: 'Could not update the library entry', message: error.message });
  }
};

/**
 * DELETE /api/admin/sample-library/:itemId  { confirmName }
 * Removes the entry and permanently deletes GSN's original dataset. Copies that
 * customers already added to their own projects are not affected.
 */
const deleteLibraryItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(itemId)) return badRequest(res, 'Invalid library entry');

    const item = await SampleLibraryItem.findById(itemId).lean();
    if (!item) return res.status(404).json({ error: 'Not found', message: 'Library entry not found' });

    const confirmName = String(req.body?.confirmName || '').trim().toLowerCase();
    if (confirmName !== item.name.trim().toLowerCase()) {
      return badRequest(res, 'Type the dataset name exactly to confirm');
    }

    const dataset = await Dataset.findById(item.datasetId);
    if (dataset && dataset.company !== 'gsn') {
      return res.status(409).json({ error: 'Not allowed', message: 'Library entries can only delete GSN datasets' });
    }
    if (dataset && !dataset.deletedAt) {
      await deleteDatasetPermanently(dataset); // throws { status: 409 } while processing / augmenting
    }
    await SampleLibraryItem.deleteOne({ _id: item._id });

    auditService.logAction({
      action: 'delete',
      resourceType: 'dataset',
      resourceId: String(item.datasetId),
      details: {
        company: 'gsn',
        change: 'deleted sample dataset and GSN original',
        name: item.name,
        dataset: dataset ? `${dataset.project} / ${dataset.version}` : null,
        by: 'superadmin',
      },
      req,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[admin] sample library delete failed:', error);
    res.status(error.status || 500).json({ error: 'Could not delete the sample dataset', message: error.message });
  }
};

/** Ready GSN datasets on this server, grouped by project name with surrounding spaces ignored ("PCB " -> "PCB") */
async function readyDatasetsByProject() {
  const datasets = await Dataset.find(readyGsnDatasetFilter).select('project version storagePath').lean();
  const byProject = new Map();
  for (const d of datasets) {
    if (!isOnThisServer(d)) continue;
    const key = String(d.project).trim();
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(d);
  }
  return byProject;
}

/**
 * GET /api/admin/sample-library/projects
 * Per GSN project: how many of its ready datasets are shown in Playground.
 * -> { projects: { "Car Seat": { shown: 6, total: 6 }, ... } }
 */
const getProjectPlaygroundStatus = async (req, res) => {
  try {
    await pruneDeletedEntries();
    const [byProject, items] = await Promise.all([readyDatasetsByProject(), SampleLibraryItem.find({}).lean()]);
    const itemByDataset = new Map(items.map((i) => [String(i.datasetId), i]));

    const projects = {};
    for (const [project, datasets] of byProject) {
      projects[project] = {
        total: datasets.length,
        shown: datasets.filter((d) => itemByDataset.get(String(d._id))?.isVisible).length,
      };
    }
    res.json({ projects });
  } catch (error) {
    console.error('[admin] project playground status failed:', error);
    res.status(500).json({ error: 'Could not load Playground status', message: error.message });
  }
};

/**
 * POST /api/admin/sample-library/projects/playground  { project, enabled }
 * enabled: true  -> every ready dataset of the project is shown in Playground (added to the
 *                   library if it isn't there yet)
 * enabled: false -> all of the project's library entries are hidden (nothing is deleted)
 */
const setProjectPlayground = async (req, res) => {
  try {
    const project = String(req.body?.project || '').trim();
    const { enabled } = req.body || {};
    if (!project) return badRequest(res, 'Project is required');
    if (typeof enabled !== 'boolean') return badRequest(res, '"enabled" must be true or false');

    const datasets = (await readyDatasetsByProject()).get(project) || [];
    const datasetIds = datasets.map((d) => d._id);

    if (enabled) {
      if (datasets.length === 0) {
        return badRequest(res, `"${project}" has no ready datasets on this server to offer in Playground`);
      }
      const existing = await SampleLibraryItem.find({ datasetId: { $in: datasetIds } }).select('datasetId').lean();
      const inLibrary = new Set(existing.map((e) => String(e.datasetId)));
      const toAdd = datasets
        .filter((d) => !inLibrary.has(String(d._id)))
        .map((d) => ({ datasetId: d._id, name: defaultName(d), industry: guessIndustry(d), isVisible: true }));
      if (toAdd.length > 0) await SampleLibraryItem.insertMany(toAdd, { ordered: false });
      await SampleLibraryItem.updateMany({ datasetId: { $in: datasetIds } }, { $set: { isVisible: true } });
    } else {
      // Hide every entry of this project, including any whose dataset is no longer ready
      const allProjectDatasets = await Dataset.find({ company: 'gsn' }).select('project').lean();
      const ids = allProjectDatasets.filter((d) => String(d.project).trim() === project).map((d) => d._id);
      await SampleLibraryItem.updateMany({ datasetId: { $in: ids } }, { $set: { isVisible: false } });
    }

    auditService.logAction({
      action: 'update',
      resourceType: 'project',
      resourceId: `gsn/${project}`,
      details: { company: 'gsn', project, change: enabled ? 'shown in Playground' : 'hidden from Playground', by: 'superadmin' },
      req,
    });

    res.json({ success: true, project, enabled, shown: enabled ? datasets.length : 0, total: datasets.length });
  } catch (error) {
    console.error('[admin] set project playground failed:', error);
    res.status(500).json({ error: 'Could not change Playground setting', message: error.message });
  }
};

/** Why a GSN dataset can't be offered in Playground, or null when it can */
function playgroundIneligibleReason(d) {
  if (!d || d.company !== 'gsn') return 'Only GSN datasets can be offered in Playground';
  if (d.deletedAt) return 'This dataset was deleted';
  if (!['ready', 'ready_to_train'].includes(d.status)) return 'Not ready yet (still processing)';
  if (!(d.trainCount > 0)) return 'Has no training images';
  if (!isOnThisServer(d)) return "Its files are not on this server";
  return null;
}

/**
 * GET /api/admin/sample-library/datasets?project=Car%20Seat
 * Playground state of every version in a GSN project.
 * -> { datasets: { "<datasetId>": { shown, inLibrary, eligible, reason } } }
 */
const getDatasetPlaygroundStatus = async (req, res) => {
  try {
    const project = String(req.query.project || '').trim();
    if (!project) return badRequest(res, 'Project is required');

    const all = await Dataset.find({ company: 'gsn', deletedAt: null })
      .select('company project version storagePath status trainCount deletedAt')
      .lean();
    const datasets = all.filter((d) => String(d.project).trim() === project);
    const items = await SampleLibraryItem.find({ datasetId: { $in: datasets.map((d) => d._id) } }).lean();
    const itemByDataset = new Map(items.map((i) => [String(i.datasetId), i]));

    const result = {};
    for (const d of datasets) {
      const item = itemByDataset.get(String(d._id));
      const reason = playgroundIneligibleReason(d);
      result[String(d._id)] = { shown: !!item?.isVisible && !reason, inLibrary: !!item, eligible: !reason, reason };
    }
    res.json({ datasets: result });
  } catch (error) {
    console.error('[admin] dataset playground status failed:', error);
    res.status(500).json({ error: 'Could not load Playground status', message: error.message });
  }
};

/**
 * POST /api/admin/sample-library/datasets/:datasetId/playground  { enabled }
 * enabled: true  -> add the version to the library if needed and show it
 * enabled: false -> hide it (nothing is deleted)
 */
const setDatasetPlayground = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { enabled } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(datasetId)) return badRequest(res, 'Invalid dataset');
    if (typeof enabled !== 'boolean') return badRequest(res, '"enabled" must be true or false');

    const dataset = await Dataset.findById(datasetId).lean();
    if (!dataset || dataset.company !== 'gsn') {
      return res.status(404).json({ error: 'Not found', message: 'GSN dataset not found' });
    }

    if (enabled) {
      const reason = playgroundIneligibleReason(dataset);
      if (reason) return badRequest(res, reason);
      await SampleLibraryItem.updateOne(
        { datasetId: dataset._id },
        {
          $set: { isVisible: true },
          $setOnInsert: { name: defaultName(dataset), industry: guessIndustry(dataset), description: '' },
        },
        { upsert: true }
      );
    } else {
      await SampleLibraryItem.updateOne({ datasetId: dataset._id }, { $set: { isVisible: false } });
    }

    auditService.logAction({
      action: 'update',
      resourceType: 'dataset',
      resourceId: String(dataset._id),
      details: {
        company: 'gsn',
        project: String(dataset.project).trim(),
        change: enabled ? 'shown in Playground' : 'hidden from Playground',
        name: `${String(dataset.project).trim()} / ${dataset.version}`,
        by: 'superadmin',
      },
      req,
    });

    res.json({ success: true, datasetId: String(dataset._id), enabled });
  } catch (error) {
    console.error('[admin] set dataset playground failed:', error);
    res.status(500).json({ error: 'Could not change Playground setting', message: error.message });
  }
};

module.exports = {
  getDatasetPlaygroundStatus,
  setDatasetPlayground,
  listLibrary,
  addToLibrary,
  addAllToLibrary,
  updateLibraryItem,
  deleteLibraryItem,
  getProjectPlaygroundStatus,
  setProjectPlayground,
};
