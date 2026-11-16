const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const InferenceJob = require('../models/InferenceJob');
const Model = require('../models/Model');
const Dataset = require('../models/Dataset');
const SampleLibraryItem = require('../models/SampleLibraryItem');
const PlaygroundReport = require('../models/PlaygroundReport');
const auditService = require('../services/auditService');
const storageAdapter = require('../services/storageAdapter');
const { inferenceQueue } = require('../queue');
const { resolveModelCheckpointPath } = require('../services/resolveModelCheckpoint');
const { SAMPLE_COMPANY } = require('../services/sampleLibraryService');
const { canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const { markPracticeDone } = require('../services/playgroundProgressService');
const { listLevels, startLevel, saveProgress } = require('../services/playgroundLevelService');
const { syncBadges, markBadgesSeen } = require('../services/playgroundBadgeService');
const { sampleRunKey, copySavedRun } = require('../services/sampleRunService');
const {
  closeRun,
  writeReport,
  removeReportFiles,
  PLAYGROUND_REPORT_LIFETIME_MS,
  PLAYGROUND_HIDDEN_CLASSES,
} = require('../services/playgroundRunService');

/**
 * Playground tests and reports (see services/playgroundRunService.js)
 *
 * POST   /api/playground/runs/:inferenceId/close   delete the test's photos
 * POST   /api/playground/runs/:inferenceId/report  write a PDF report, then close the test
 * GET    /api/playground/reports?projectId=        reports still available (all projects, or one)
 * GET    /api/playground/reports/:id/download      the PDF
 * GET    /api/playground/reports/:id/csv           the results as a spreadsheet
 * GET    /api/playground/annexure/:token           Excel file with every photo, from the link in the PDF (no sign-in)
 * GET    /api/playground/reports/:id/preview       small picture of the first photo
 * DELETE /api/playground/reports/:id               delete a report early
 * POST   /api/playground/practice/auto-label        { datasetId, fileIds } run GSN's model on sample photos
 * GET    /api/playground/practice/auto-label/:inferenceId   progress, then the boxes it found
 * POST   /api/playground/practice/done          label practice finished (unlocks the next challenge)
 * POST   /api/playground/level1/test            { datasetId, fileIds } GSN's model on the sample's held-out photos
 * GET    /api/playground/levels                 the student's levels, latest first
 * POST   /api/playground/levels/start           { level, mission, industry, sample, projectId }
 * POST   /api/playground/levels/progress        { mission, step, practiceScore, cleanPhotos, practicePhotos, practiceTotal, trainingJobId, skipped }
 * GET    /api/playground/badges                 the student's badges, with any newly earned saved
 * POST   /api/playground/badges/seen            { ids } their award cards have been shown
 */

/** Learn to label: at most this many photos per auto-label run, and runs per company a day */
const PRACTICE_PROJECT = 'Learn to label';
const LEVEL_ONE_PROJECT = 'Level 1';
const PRACTICE_MAX_PHOTOS = 30;
const PRACTICE_RUNS_PER_DAY = 10;
const PRACTICE_CONFIDENCE = 0.4;
const PRACTICE_LIFETIME_MS = 60 * 60 * 1000;

/** The API's public address, for the link in the PDF. Behind CloudFront the request's host is the server's. */
const publicApiUrl = (req) => {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/+$/, '');
  const host = req.get('host') || '';
  return /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? `${req.protocol}://${host}` : 'https://api.gsnsoln.in';
};

const ownsCompany = (req, company) =>
  canAccessAllWorkspaces(req.user) ||
  String(company || '').trim().toLowerCase() === String(req.user?.company || '').trim().toLowerCase();

async function loadRun(req, res) {
  const job = await InferenceJob.findOne({ inferenceId: req.params.inferenceId });
  if (!job || !ownsCompany(req, job.company)) {
    res.status(404).json({ error: 'Test not found', message: 'This test was not found.' });
    return null;
  }
  return job;
}

const closeTest = async (req, res) => {
  try {
    const job = await loadRun(req, res);
    if (!job) return;
    if (!job.closedAt) await closeRun(job);
    res.json({ success: true, closed: true });
  } catch (error) {
    console.error('[playground] close test failed:', error);
    res.status(500).json({ error: 'Could not close the test', message: error.message });
  }
};

const createReport = async (req, res) => {
  try {
    const job = await loadRun(req, res);
    if (!job) return;
    if (job.closedAt) {
      return res.status(409).json({ error: 'Test closed', message: 'This test was already closed, so its photos are gone.' });
    }
    if (job.status !== 'completed') {
      return res.status(409).json({ error: 'Test not finished', message: 'Wait for the test to finish first.' });
    }

    const { projectId, title, industry, labelled, names } = req.body || {};
    const model = job.modelId ? await Model.findById(job.modelId).select('modelVersion').lean() : null;
    const reportTitle = String(title || job.project).slice(0, 120);
    const annexureToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + PLAYGROUND_REPORT_LIFETIME_MS);
    const written = await writeReport(job, {
      title: reportTitle,
      industry: industry ? String(industry).slice(0, 80) : null,
      modelName: model?.modelVersion || null,
      labelled: labelled && typeof labelled === 'object' ? labelled : undefined,
      names: names && typeof names === 'object' ? names : undefined,
      annexureUrl: `${publicApiUrl(req)}/api/playground/annexure/${annexureToken}`,
      expiresAt,
    });

    const report = await PlaygroundReport.create({
      company: job.company,
      project: job.project,
      projectId: projectId ? String(projectId) : null,
      title: reportTitle,
      industry: industry || null,
      modelName: model?.modelVersion || null,
      inferenceId: job.inferenceId,
      photos: written.photos,
      filePath: written.filePath,
      csvPath: written.csvPath,
      excelPath: written.excelPath,
      annexureToken,
      previewPath: written.previewPath,
      sizeBytes: written.sizeBytes,
      createdBy: req.user?.id || null,
      expiresAt,
    });
    await closeRun(job);

    auditService.logAction({
      action: 'create',
      resourceType: 'inference',
      resourceId: job.inferenceId,
      details: { company: job.company, project: job.project, change: 'playground report created', reportId: String(report._id), photos: written.photos },
      req,
    });

    res.status(201).json({ report: toJson(report) });
  } catch (error) {
    console.error('[playground] report failed:', error);
    res.status(500).json({ error: 'Could not create the report', message: error.message });
  }
};

const toJson = (r) => ({
  id: String(r._id),
  title: r.title,
  project: r.project,
  projectId: r.projectId,
  industry: r.industry,
  modelName: r.modelName,
  photos: r.photos,
  sizeBytes: r.sizeBytes,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  hasCsv: Boolean(r.csvPath),
  hasPreview: Boolean(r.previewPath),
});

const listReports = async (req, res) => {
  try {
    const filter = { company: req.user?.company, expiresAt: { $gt: new Date() } };
    if (req.query.projectId) filter.projectId = String(req.query.projectId);
    const reports = await PlaygroundReport.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ reports: reports.map(toJson) });
  } catch (error) {
    res.status(500).json({ error: 'Could not load reports', message: error.message });
  }
};

async function loadReport(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'Report not found' });
    return null;
  }
  const report = await PlaygroundReport.findById(req.params.id);
  if (!report || !ownsCompany(req, report.company) || report.expiresAt <= new Date()) {
    res.status(404).json({ error: 'Report not found', message: 'This report has expired or was deleted.' });
    return null;
  }
  return report;
}

const reportFileName = (report, ext) => `${report.title.replace(/[^\w\- ]+/g, '').trim() || 'report'} - test report.${ext}`;

const downloadReport = async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    if (!fs.existsSync(report.filePath)) return res.status(404).json({ error: 'Report file missing' });
    const name = reportFileName(report, 'pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    fs.createReadStream(report.filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'Could not download the report', message: error.message });
  }
};

const downloadCsv = async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    if (!report.csvPath || !fs.existsSync(report.csvPath)) {
      return res.status(404).json({ error: 'No spreadsheet', message: 'This report has no spreadsheet. Reports made from now on include one.' });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(report, 'csv')}"`);
    fs.createReadStream(report.csvPath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'Could not download the spreadsheet', message: error.message });
  }
};

/** The link in the PDF: no sign-in, as it opens from outside the app. Ends with the report. */
const downloadAnnexure = async (req, res) => {
  try {
    const report = await PlaygroundReport.findOne({
      annexureToken: String(req.params.token),
      expiresAt: { $gt: new Date() },
    }).lean();
    // Reports made before the Excel file existed link to their CSV
    const filePath = report?.excelPath || report?.csvPath;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).type('text/plain').send('This link has expired. Reports and their photo lists are kept for 24 hours.');
    }
    const isExcel = filePath === report.excelPath;
    res.setHeader('Content-Type', isExcel ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(report, isExcel ? 'xlsx' : 'csv')}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(500).type('text/plain').send('Could not download the photo list.');
  }
};

const reportPreview = async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    if (!report.previewPath || !fs.existsSync(report.previewPath)) return res.status(404).json({ error: 'No preview' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(report.previewPath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'Could not load the preview', message: error.message });
  }
};

const deleteReport = async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    await removeReportFiles(report);
    await PlaygroundReport.deleteOne({ _id: report._id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not delete the report', message: error.message });
  }
};

/**
 * GSN's ready-made model for a GSN sample: one trained on the sample's own dataset version first
 * (it knows all of the sample's labels), then the highest mAP50; weights must be on disk
 */
async function readyMadeModelFor(sample) {
  const models = await Model.find({
    company: SAMPLE_COMPANY,
    project: sample.project,
    bestCheckpointPath: { $ne: null },
    modelType: { $ne: 'RF_DETR' },
  }).lean();
  return models
    .filter((m) => {
      const checkpoint = resolveModelCheckpointPath(m);
      return checkpoint && fs.existsSync(checkpoint);
    })
    .sort(
      (a, b) =>
        Number(b.datasetVersion === sample.version) - Number(a.datasetVersion === sample.version) ||
        (b.metrics?.mAP50 ?? 0) - (a.metrics?.mAP50 ?? 0)
    )[0] || null;
}

/**
 * Run GSN's ready-made model on a few photos of a GSN sample (the library sample itself, or a
 * company's link to it), so the student can compare its boxes with the real labels. No project is
 * needed. The student's practice labels never reach the server; this only reads GSN's photos.
 */
const startSampleRun = async (req, res, { purpose, project, tooMany, fileName }) => {
  try {
    const { datasetId } = req.body || {};
    const fileIds = Array.isArray(req.body?.fileIds) ? [...new Set(req.body.fileIds.map(String))] : [];
    if (!fileIds.length || fileIds.length > PRACTICE_MAX_PHOTOS) {
      return res.status(400).json({ error: 'Choose photos', message: `Choose 1 to ${PRACTICE_MAX_PHOTOS} photos.` });
    }
    if (!mongoose.Types.ObjectId.isValid(String(datasetId || ''))) {
      return res.status(400).json({ error: 'Dataset not found', message: 'This dataset was not found.' });
    }
    const company = req.user?.company;
    if (!company) return res.status(400).json({ error: 'No company', message: 'Create or join a company first.' });
    const dataset = await Dataset.findById(datasetId);
    if (!dataset || dataset.deletedAt) {
      return res.status(404).json({ error: 'Dataset not found', message: 'This dataset was not found.' });
    }
    // A library sample, or the company's own link to one
    let source = null;
    if (dataset.company === SAMPLE_COMPANY && (await SampleLibraryItem.exists({ datasetId: dataset._id, isVisible: true }))) {
      source = dataset;
    } else if (ownsCompany(req, dataset.company) && dataset.linkedFrom) {
      source = await Dataset.findById(dataset.linkedFrom).select('project version').lean();
    } else if (ownsCompany(req, dataset.company)) {
      return res.status(400).json({ error: 'Not a GSN sample', message: 'Label practice works on GSN sample datasets only.' });
    }
    if (!source) return res.status(404).json({ error: 'Dataset not found', message: 'This dataset was not found.' });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const runsToday = await InferenceJob.countDocuments({ company, purpose, createdAt: { $gte: since } });
    if (runsToday >= PRACTICE_RUNS_PER_DAY) {
      return res.status(429).json({ error: 'Too many runs', message: tooMany });
    }

    const model = await readyMadeModelFor(source);
    if (!model) {
      return res.status(404).json({ error: 'No ready-made model', message: "GSN doesn't have a ready-made model for this sample yet." });
    }

    const files = fileIds
      .map((id) => dataset.files.find((f) => f.type === 'image' && (String(f._id) === id || f.storedName === id)))
      .filter(Boolean);
    if (!files.length) {
      return res.status(400).json({ error: 'Photos not found', message: 'None of these photos are in the dataset.' });
    }

    const inferenceId = `inf_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const folder = path.join(process.cwd(), 'uploads', 'inference-temp', `practice_${inferenceId}`);

    // Another student's finished run of the same model on the same photos: the same results, at once
    const key = sampleRunKey({
      purpose,
      datasetId: String(dataset._id),
      modelId: String(model._id),
      confidence: PRACTICE_CONFIDENCE,
      fileIds: files.map((f) => String(f._id)),
    });
    const saved = await copySavedRun(key, folder).catch((err) => {
      console.warn(`[playground] saved run not used: ${err.message}`);
      return null;
    });
    if (saved) {
      const job = await InferenceJob.create({
        inferenceId,
        modelId: model._id,
        company,
        project,
        sourceType: 'custom_folder',
        customFolderPath: folder,
        status: 'completed',
        completedAt: new Date(),
        createdBy: req.user?.id || null,
        excludeFromHistory: true,
        purpose,
        autoCloseAt: new Date(Date.now() + PRACTICE_LIFETIME_MS),
        progress: { totalImages: files.length, processedImages: files.length, progressPercent: 100 },
        results: saved.results,
      });
      return res.status(202).json({ inferenceId: job.inferenceId, totalImages: files.length });
    }

    await fs.promises.rm(folder, { recursive: true, force: true });
    await storageAdapter.ensureDir(folder);
    for (const file of files) {
      const ext = path.extname(file.storedName) || '.jpg';
      await fs.promises.copyFile(path.join(dataset.storagePath, file.storedPath), path.join(folder, fileName(file, ext)));
    }

    const job = await InferenceJob.create({
      inferenceId,
      modelId: model._id,
      company,
      project,
      sourceType: 'custom_folder',
      customFolderPath: folder,
      status: 'queued',
      createdBy: req.user?.id || null,
      excludeFromHistory: true,
      purpose,
      sampleRunKey: key,
      autoCloseAt: new Date(Date.now() + PRACTICE_LIFETIME_MS),
      progress: { totalImages: files.length, processedImages: 0, progressPercent: 0 },
    });
    await inferenceQueue.add(
      {
        inferenceId,
        modelId: model._id.toString(),
        company,
        project,
        sourceType: 'custom_folder',
        customFolderPath: folder,
        confidenceThreshold: PRACTICE_CONFIDENCE,
        hiddenClasses: PLAYGROUND_HIDDEN_CLASSES,
      },
      { attempts: 1, removeOnComplete: false, removeOnFail: false }
    );

    res.status(202).json({ inferenceId: job.inferenceId, totalImages: files.length });
  } catch (error) {
    console.error(`[playground] ${purpose} run failed:`, error);
    res.status(500).json({ error: 'Could not start the run', message: error.message });
  }
};

/** Learn to label: copies named after the file id, so the results map back to the student's photos */
const startPracticeAutoLabel = (req, res) =>
  startSampleRun(req, res, {
    purpose: 'practice',
    project: PRACTICE_PROJECT,
    tooMany: 'You have used today\'s auto-label practice runs. Try again tomorrow.',
    fileName: (file, ext) => `${file._id}${ext}`,
  });

/**
 * Level 1 test: GSN's model on the sample's held-out photos, without a project. It's learning, so
 * it doesn't use the plan's predictions. Copies keep the photo's name, to show and to match its labels.
 */
const startLevelOneTest = (req, res) => {
  const used = new Set();
  return startSampleRun(req, res, {
    purpose: 'learning',
    project: LEVEL_ONE_PROJECT,
    tooMany: 'You have used today\'s Level 1 tests. Try again tomorrow.',
    fileName: (file, ext) => {
      const name = path.basename(file.originalName || file.storedName);
      if (used.has(name)) return `${file._id}${ext}`;
      used.add(name);
      return name;
    },
  });
};

/** Progress of a practice auto-label run; once done, each photo's boxes (0-1 units, top-left x/y) */
const getPracticeAutoLabel = async (req, res) => {
  try {
    const job = await loadRun(req, res);
    if (!job) return;
    if (job.purpose !== 'practice') {
      return res.status(404).json({ error: 'Test not found', message: 'This test was not found.' });
    }
    const progress = { processed: job.progress?.processedImages ?? 0, total: job.progress?.totalImages ?? 0 };
    if (job.status === 'failed' || job.status === 'cancelled') {
      return res.json({ status: job.status, progress, message: 'Auto-label did not finish. Try again.' });
    }
    if (job.status !== 'completed') return res.json({ status: job.status, progress });
    if (job.closedAt) {
      return res.status(410).json({ error: 'Expired', message: 'These auto-label results have expired. Run auto-label again.' });
    }

    const metadataPath = job.results?.metadataPath || path.join(job.results?.resultsPath || '', 'metadata.json');
    const metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
    const images = (metadata.images || metadata.files || [])
      .filter((img) => img.fileType !== 'video')
      .map((img) => {
        const W = Number(img.imageWidth) || 1;
        const H = Number(img.imageHeight) || 1;
        return {
          fileId: path.parse(path.basename(img.originalName || img.filePath || '')).name,
          boxes: (img.detections || [])
            .filter((d) => Array.isArray(d.bbox) && d.bbox.length === 4)
            .map((d) => ({
              name: String(d.class || ''),
              confidence: typeof d.confidence === 'number' ? d.confidence : null,
              x: d.bbox[0] / W,
              y: d.bbox[1] / H,
              w: (d.bbox[2] - d.bbox[0]) / W,
              h: (d.bbox[3] - d.bbox[1]) / H,
            })),
        };
      });
    res.json({ status: 'completed', progress, images });
  } catch (error) {
    console.error('[playground] practice auto-label results failed:', error);
    res.status(500).json({ error: 'Could not read auto-label results', message: error.message });
  }
};

/** Learn to label finished: saved for the company's challenge path */
const practiceDone = async (req, res) => {
  try {
    if (!req.user?.company) return res.status(400).json({ error: 'No company', message: 'Create or join a company first.' });
    res.json({ path: await markPracticeDone(req.user.company) });
  } catch (error) {
    console.error('[playground] practice done failed:', error);
    res.status(500).json({ error: 'Could not save progress', message: error.message });
  }
};

/** The student's levels, for "Continue" on the overview */
const getLevels = async (req, res) => {
  try {
    if (!req.user?.company) return res.json({ levels: [] });
    res.json({ levels: await listLevels(req.user) });
  } catch (error) {
    console.error('[playground] levels failed:', error);
    res.status(500).json({ error: 'Could not load progress', message: error.message });
  }
};

const postLevelStart = async (req, res) => {
  try {
    if (!req.user?.company) return res.status(400).json({ error: 'No company', message: 'Create or join a company first.' });
    const level = await startLevel(req.user, req.body || {});
    if (!level) return res.status(400).json({ error: 'Bad level', message: 'This level could not be started.' });
    res.json({ level });
  } catch (error) {
    console.error('[playground] level start failed:', error);
    res.status(500).json({ error: 'Could not save progress', message: error.message });
  }
};

const postLevelProgress = async (req, res) => {
  try {
    if (!req.user?.company) return res.status(400).json({ error: 'No company', message: 'Create or join a company first.' });
    res.json({ level: await saveProgress(req.user, req.body || {}) });
  } catch (error) {
    console.error('[playground] level progress failed:', error);
    res.status(500).json({ error: 'Could not save progress', message: error.message });
  }
};

const getBadges = async (req, res) => {
  try {
    if (!req.user?.company) return res.json({ badges: [] });
    res.json({ badges: await syncBadges(req.user) });
  } catch (error) {
    console.error('[playground] badges failed:', error);
    res.status(500).json({ error: 'Could not load badges', message: error.message });
  }
};

const postBadgesSeen = async (req, res) => {
  try {
    if (req.user?.company) await markBadgesSeen(req.user, req.body?.ids);
    res.json({ success: true });
  } catch (error) {
    console.error('[playground] badges seen failed:', error);
    res.status(500).json({ error: 'Could not save', message: error.message });
  }
};

module.exports = {
  startLevelOneTest,
  getBadges,
  postBadgesSeen,
  getLevels,
  postLevelStart,
  postLevelProgress,
  practiceDone,
  closeTest,
  createReport,
  listReports,
  downloadReport,
  downloadCsv,
  downloadAnnexure,
  reportPreview,
  deleteReport,
  startPracticeAutoLabel,
  getPracticeAutoLabel,
};
