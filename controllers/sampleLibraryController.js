const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Dataset = require('../models/Dataset');
const Category = require('../models/Category');
const storageAdapter = require('../services/storageAdapter');
const { preprocessingQueue } = require('../queue');
const { isPlaygroundHiddenClass } = require('../services/playgroundRunService');
const Model = require('../models/Model');
const SampleLibraryItem = require('../models/SampleLibraryItem');
const { copyDataset } = require('../services/datasetCopyService');
const { getSupabaseClient } = require('../services/supabaseService');
const auditService = require('../services/auditService');
const { SAMPLE_COMPANY, readyGsnDatasetFilter, isOnThisServer } = require('../services/sampleLibraryService');

/**
 * Sample library (Playground)
 *
 * Datasets: the superadmin-curated library (SampleLibraryItem -> a GSN dataset), with
 * display name, industry and description; only visible entries are offered.
 * Models: GSN's own trained models.
 * "Adding" one creates a read-only link inside the caller's company + project (the
 * records are copied, the files are not: it uses GSN's folder), so it shows up in Model
 * Training / Testing & Inference like any other data, every customer shares one copy on
 * disk, and GSN's originals are only ever read.
 *
 * GET  /api/samples                              - list sample datasets and models
 * POST /api/samples/datasets/:datasetId/import   { project }
 * POST /api/samples/models/:modelId/import       { project }
 */

/** Visible library entries whose GSN dataset is ready and on this server, as [{ item, dataset }] */
async function loadVisibleLibrary() {
  const items = await SampleLibraryItem.find({ isVisible: true }).lean();
  if (items.length === 0) return [];
  const datasets = await Dataset.find({ ...readyGsnDatasetFilter, _id: { $in: items.map((i) => i.datasetId) } })
    .select('project version storagePath totalImages trainCount valCount testCount labels datasetType createdAt')
    .lean();
  const byId = new Map(datasets.map((d) => [String(d._id), d]));
  return items
    .map((item) => ({ item, dataset: byId.get(String(item.datasetId)) }))
    .filter(({ dataset }) => dataset && isOnThisServer(dataset));
}

/** Version / folder names: letters, numbers, _ and - only (same rule as dataset versions) */
const toSafeName = (value, fallback) =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || fallback;

/** First free name: "name", then "name-2", "name-3", ... */
async function uniqueName(base, isTaken) {
  if (!(await isTaken(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error('Could not find a free name for the copy');
}

/** The target project must be one of the caller's own company projects (Supabase is the source of truth) */
async function resolveTargetProject(req) {
  const project = String(req.body?.project || '').trim();
  if (!req.user?.company || !req.user?.company_id) {
    return { status: 400, message: 'Create or join a company first' };
  }
  if (!project) return { status: 400, message: 'Choose a project to add the sample to' };

  const { data, error } = await getSupabaseClient()
    .from('projects')
    .select('id, name')
    .eq('company_id', req.user.company_id)
    .eq('name', project)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { status: 404, message: `Project "${project}" was not found in your company` };
  return { company: req.user.company, project: data.name };
}

/**
 * GET /api/samples
 */
const listSamples = async (req, res) => {
  try {
    const [library, models] = await Promise.all([
      loadVisibleLibrary(),
      Model.find({ company: SAMPLE_COMPANY, bestCheckpointPath: { $ne: null } })
        .sort({ project: 1, createdAt: -1 })
        .select('modelId project modelVersion modelType metrics bestCheckpointPath datasetVersion createdAt')
        .lean(),
    ]);

    res.json({
      datasets: library
        .map(({ item, dataset: d }) => ({
          id: String(d._id),
          name: item.name,
          industry: item.industry,
          description: item.description || '',
          project: d.project,
          version: d.version,
          totalImages: d.totalImages || 0,
          trainCount: d.trainCount || 0,
          valCount: d.valCount || 0,
          testCount: d.testCount || 0,
          labels: Array.isArray(d.labels) ? d.labels : [],
          datasetType: d.datasetType || null,
          createdAt: d.createdAt,
        }))
        .sort((a, b) => a.industry.localeCompare(b.industry) || a.name.localeCompare(b.name)),
      // Only models whose weights are really on disk can be used for inference
      models: models
        .filter((m) => fs.existsSync(m.bestCheckpointPath))
        .map((m) => ({
          id: m.modelId,
          project: m.project,
          modelVersion: m.modelVersion,
          modelType: m.modelType,
          mAP50: m.metrics?.mAP50 ?? null,
          precision: m.metrics?.precision ?? null,
          recall: m.metrics?.recall ?? null,
          datasetVersion: m.datasetVersion,
          createdAt: m.createdAt,
        })),
    });
  } catch (error) {
    console.error('[samples] list failed:', error);
    res.status(500).json({ error: 'Could not load sample library', message: error.message });
  }
};

/**
 * POST /api/samples/datasets/:datasetId/import  { project }
 */
const importSampleDataset = async (req, res) => {
  try {
    const target = await resolveTargetProject(req);
    if (target.status) return res.status(target.status).json({ error: 'Cannot add sample', message: target.message });

    // Only datasets the superadmin has put (and kept visible) in the library can be added
    const item = await SampleLibraryItem.findOne({ datasetId: req.params.datasetId, isVisible: true })
      .lean()
      .catch(() => null);
    const source = item
      ? await Dataset.findOne({ ...readyGsnDatasetFilter, _id: item.datasetId })
      : null;
    if (!source || !isOnThisServer(source)) {
      return res.status(404).json({ error: 'Not found', message: 'This sample dataset is no longer available' });
    }

    const already = await Dataset.findOne({
      company: target.company,
      project: target.project,
      linkedFrom: source._id,
      deletedAt: null,
    })
      .select('version')
      .lean();
    if (already) {
      return res.status(409).json({
        error: 'Already added',
        message: `This sample is already in ${target.project} as "${already.version}"`,
      });
    }

    const version = await uniqueName(toSafeName(item.name, toSafeName(source.version, 'sample')), async (name) =>
      !!(await Dataset.exists({ company: target.company, project: target.project, version: name, deletedAt: null }))
    );
    // First dataset in the project becomes its active one, like a first upload
    const hasActive = await Dataset.exists({
      company: target.company,
      project: target.project,
      isActive: true,
      deletedAt: null,
    });

    const result = await copyDataset(source, {
      company: target.company,
      project: target.project,
      version,
      isActive: !hasActive,
      link: true,
    });

    auditService.logAction({
      action: 'create',
      resourceType: 'dataset',
      resourceId: String(result.dataset._id),
      details: {
        company: target.company,
        project: target.project,
        change: 'added sample dataset',
        sample: item.name,
        images: result.images,
      },
      req,
    });

    res.status(201).json({
      success: true,
      datasetId: String(result.dataset._id),
      project: target.project,
      version,
      images: result.images,
    });
  } catch (error) {
    console.error('[samples] import dataset failed:', error);
    res.status(500).json({ error: 'Could not add sample dataset', message: error.message });
  }
};

/** Data-augmentation copies in a sample ("..._aug_3.jpg"): left out when labelling it yourself */
const AUGMENTED_COPY = /_aug_\d+/i;

/**
 * POST /api/samples/datasets/:datasetId/label-yourself  { project }
 *
 * A GSN sample's photos without GSN's labels, in the caller's project, for them to label and
 * train on. The photos are hard links into GSN's folder (no extra disk; a plain copy where a
 * link can't be made), so it goes through the same preparation, labelling and training as an
 * upload, but doesn't count as one of the company's own datasets (utils/usage ownDatasetFilter).
 */
const labelSampleYourself = async (req, res) => {
  try {
    const target = await resolveTargetProject(req);
    if (target.status) return res.status(target.status).json({ error: 'Cannot add sample', message: target.message });
    const isGsn = String(req.user.company || '').trim().toLowerCase() === SAMPLE_COMPANY;
    if (!isGsn && req.user.access?.features?.trainOnOwnDatasets !== true) {
      const message = 'Your plan doesn\'t include labelling and training your own datasets.';
      return res.status(403).json({ error: message, message });
    }

    const item = await SampleLibraryItem.findOne({ datasetId: req.params.datasetId, isVisible: true })
      .lean()
      .catch(() => null);
    const source = item ? await Dataset.findOne({ ...readyGsnDatasetFilter, _id: item.datasetId }) : null;
    if (!source || !isOnThisServer(source)) {
      return res.status(404).json({ error: 'Not found', message: 'This sample dataset is no longer available' });
    }

    const already = await Dataset.findOne({
      company: target.company,
      project: target.project,
      labelledSampleOf: source._id,
      deletedAt: null,
    })
      .select('_id version')
      .lean();
    if (already) {
      return res.status(409).json({
        error: 'Already added',
        message: `You're already labelling this sample in ${target.project} as "${already.version}"`,
        datasetId: String(already._id),
      });
    }

    const images = source.files.filter((f) => f.type === 'image' && f.storedPath);
    const originals = images.filter((f) => !AUGMENTED_COPY.test(f.storedName || f.storedPath));
    const photos = originals.length > 0 ? originals : images;
    if (photos.length === 0) return res.status(400).json({ error: 'No photos', message: 'This sample has no photos' });

    const version = await uniqueName(`${toSafeName(item.name, 'sample')}-my-labels`, async (name) =>
      !!(await Dataset.exists({ company: target.company, project: target.project, version: name, deletedAt: null }))
    );
    const dataset = new Dataset({
      company: target.company,
      project: target.project,
      version,
      storagePath: storageAdapter.buildDatasetPath(target.company, target.project, version),
      status: 'uploaded',
      files: [],
      labelledSampleOf: source._id,
    });
    await dataset.save();
    const datasetId = String(dataset._id);

    // Same layout as an upload: images/dataset/<hash>.<ext>
    const folder = path.join(storageAdapter.buildImagesPath(target.company, target.project, version), 'dataset');
    await fs.promises.mkdir(folder, { recursive: true });
    let totalSize = 0;
    for (const f of photos) {
      const ext = path.extname(f.storedName || f.storedPath).toLowerCase();
      const storedName = `${crypto.createHash('sha256').update(`${datasetId}_${f.storedPath}`).digest('hex').slice(0, 12)}${ext}`;
      const dest = path.join(folder, storedName);
      const src = path.join(source.storagePath, f.storedPath);
      try {
        await fs.promises.link(src, dest);
      } catch {
        await fs.promises.copyFile(src, dest);
      }
      totalSize += f.size || 0;
      dataset.files.push({
        storedName,
        originalName: f.originalName || storedName,
        type: 'image',
        size: f.size || 0,
        folder: 'dataset',
        storedPath: path.relative(dataset.storagePath, dest).replace(/\\/g, '/'),
      });
    }

    // GSN's label names, so the labelling tool offers the same defects (minus Playground-hidden ones)
    const categories = (await Category.getOrderedCategories(source._id)).filter(
      (c) => isGsn || !isPlaygroundHiddenClass(c.name)
    );
    if (categories.length > 0) {
      await Category.insertMany(
        categories.map(({ _id, ...rest }, i) => ({ ...rest, datasetId: dataset._id, order: i }))
      );
    }

    Object.assign(dataset, {
      totalImages: photos.length,
      sizeBytes: totalSize,
      datasetType: 'unlabeled',
      annotationStatus: 'pending',
      labelSource: 'unlabeled',
      unlabeledImagesCount: photos.length,
      status: 'queued', // photo preparation, as after an upload
    });
    await dataset.save();
    await preprocessingQueue.add(
      { datasetId, storagePath: dataset.storagePath, company: target.company, project: target.project, version },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } }
    );

    auditService.logAction({
      action: 'create',
      resourceType: 'dataset',
      resourceId: datasetId,
      details: { company: target.company, project: target.project, change: 'sample to label yourself', sample: item.name, images: photos.length },
      req,
    });

    res.status(201).json({ success: true, datasetId, project: target.project, version, images: photos.length });
  } catch (error) {
    console.error('[samples] label-yourself failed:', error);
    res.status(500).json({ error: 'Could not add the sample to label', message: error.message });
  }
};

const THUMB_MAX_PX = 480;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Absolute path inside `base`, or null if `relative` would leave it */
function insideFolder(base, relative) {
  const root = path.resolve(base);
  const full = path.resolve(root, relative);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/**
 * GET /api/samples/datasets/:datasetId/thumbnail
 * A preview picture for a sample dataset card. Only datasets shown in the library can be
 * previewed, and only one small image is sent (the app's ready-made thumbnail, or the
 * first image scaled down).
 */
const getSampleDatasetThumbnail = async (req, res) => {
  try {
    const item = await SampleLibraryItem.findOne({ datasetId: req.params.datasetId, isVisible: true })
      .lean()
      .catch(() => null);
    const dataset = item ? await Dataset.findOne({ ...readyGsnDatasetFilter, _id: item.datasetId }).lean() : null;
    if (!dataset || !isOnThisServer(dataset)) return res.status(404).json({ error: 'Not found' });

    const images = (dataset.files || []).filter((f) => f.type === 'image' && f.storedName).slice(0, 25);
    let thumbPath = null;
    let originalPath = null;
    for (const f of images) {
      const thumb = insideFolder(dataset.storagePath, path.join('thumbnails', `thumb_${f.storedName}`));
      if (thumb && fs.existsSync(path.toNamespacedPath(thumb))) {
        thumbPath = thumb;
        break;
      }
      if (!originalPath && f.storedPath) {
        const original = insideFolder(dataset.storagePath, f.storedPath);
        if (original && fs.existsSync(path.toNamespacedPath(original))) originalPath = original;
      }
    }

    res.set('Cache-Control', 'private, max-age=86400');
    if (thumbPath) {
      res.type(IMAGE_TYPES[path.extname(thumbPath).toLowerCase()] || 'image/jpeg');
      return res.send(await fs.promises.readFile(path.toNamespacedPath(thumbPath)));
    }
    if (originalPath) {
      const sharp = require('sharp');
      const buffer = await sharp(path.toNamespacedPath(originalPath))
        .rotate()
        .resize(THUMB_MAX_PX, THUMB_MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      res.type('image/jpeg');
      return res.send(buffer);
    }
    return res.status(404).json({ error: 'No preview image' });
  } catch (error) {
    console.error('[samples] thumbnail failed:', error.message);
    res.status(500).json({ error: 'Could not load preview' });
  }
};

/**
 * POST /api/samples/models/:modelId/import  { project }
 */
const importSampleModel = async (req, res) => {
  try {
    const target = await resolveTargetProject(req);
    if (target.status) return res.status(target.status).json({ error: 'Cannot add sample', message: target.message });

    const source = await Model.findOne({ company: SAMPLE_COMPANY, modelId: req.params.modelId }).lean();
    if (!source || !source.bestCheckpointPath || !fs.existsSync(source.bestCheckpointPath)) {
      return res.status(404).json({ error: 'Not found', message: 'Sample model not found' });
    }

    const already = await Model.findOne({ company: target.company, project: target.project, linkedFrom: source._id })
      .select('modelVersion')
      .lean();
    if (already) {
      return res.status(409).json({
        error: 'Already added',
        message: `This sample model is already in ${target.project} as "${already.modelVersion}"`,
      });
    }

    const modelVersion = await uniqueName(toSafeName(source.modelVersion, 'sample-model'), async (name) => {
      const inDb = await Model.exists({ company: target.company, project: target.project, modelVersion: name });
      const onDisk = fs.existsSync(path.join(process.cwd(), 'models', target.company, target.project, name));
      return !!inDb || onDisk;
    });

    // A read-only link: it uses GSN's model folder and weights, nothing is copied
    const storagePath = source.storagePath;
    const bestCheckpointPath = source.bestCheckpointPath;

    const model = await Model.create({
      modelId: `model_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      jobId: source.jobId, // training history stays with the original GSN job
      company: target.company,
      project: target.project,
      modelVersion,
      modelType: source.modelType,
      datasetVersion: source.datasetVersion,
      datasetId: source.datasetId,
      metrics: source.metrics,
      insights: source.insights,
      storagePath,
      bestCheckpointPath,
      chartDataPath: source.chartDataPath,
      linkedFrom: source._id,
    });

    auditService.logAction({
      action: 'create',
      resourceType: 'model',
      resourceId: model.modelId,
      details: {
        company: target.company,
        project: target.project,
        change: 'added sample model',
        sample: `${source.project} / ${source.modelVersion}`,
      },
      req,
    });

    res.status(201).json({ success: true, modelId: model.modelId, project: target.project, modelVersion });
  } catch (error) {
    console.error('[samples] import model failed:', error);
    res.status(500).json({ error: 'Could not add sample model', message: error.message });
  }
};

module.exports = { listSamples, importSampleDataset, labelSampleYourself, importSampleModel, getSampleDatasetThumbnail };
