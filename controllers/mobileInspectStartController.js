const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const MobileInspectConfig = require('../models/MobileInspectConfig');
const InferenceJob = require('../models/InferenceJob');
const { inferenceQueue } = require('../queue');
const storageAdapter = require('../services/storageAdapter');
const auditService = require('../services/auditService');
const { resolveObservationForNewJob, findPreviousVisit } = require('../utils/observationService');
const { parseAssessmentField } = require('../utils/assessment');
const { validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const { resolveModelCheckpointPath } = require('../services/resolveModelCheckpoint');

// Phone cameras are often 12MP+. YOLO already resizes to 640 internally, but
// overlay + corrosion % + upload all run on the original pixels. 1600px is plenty
// for a phone screen and cuts overlay time / result download a lot.
const INSPECT_MAX_EDGE = 1600;

async function downscaleInspectImage(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff'].includes(ext)) {
      return filePath;
    }
    const stat = await fs.promises.stat(filePath);
    const meta = await sharp(filePath, { failOn: 'none' }).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    const alreadySmall =
      width > 0 &&
      height > 0 &&
      width <= INSPECT_MAX_EDGE &&
      height <= INSPECT_MAX_EDGE &&
      stat.size <= 1_200_000;
    if (alreadySmall) return filePath;

    const outPath = filePath.replace(/\.[^.]+$/i, '') + '.jpg';
    const tmpPath = `${outPath}.tmp.jpg`;
    await sharp(filePath, { failOn: 'none' })
      .rotate()
      .resize(INSPECT_MAX_EDGE, INSPECT_MAX_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(tmpPath);

    if (fs.existsSync(filePath) && path.resolve(filePath) !== path.resolve(tmpPath)) {
      await fs.promises.unlink(filePath);
    }
    if (fs.existsSync(outPath) && path.resolve(outPath) !== path.resolve(tmpPath)) {
      await fs.promises.unlink(outPath);
    }
    await fs.promises.rename(tmpPath, outPath);
    return outPath;
  } catch (err) {
    console.warn('[mobile-inspect] downscale skipped:', err.message);
    return filePath;
  }
}

/**
 * POST /api/mobile-inspect
 * multipart: regionName, project, files[]
 * Uses the pinned YOLO_SEG model for company + project.
 */
const startMobileInspect = async (req, res) => {
  try {
    const regionName = String(req.body.regionName || '').trim();
    const surveyName = String(req.body.surveyName || '').trim();
    const project = String(req.body.project || '').trim();
    const company = String(req.user?.company || '').trim();
    const uploadedImages = Array.isArray(req.files) ? req.files : [];
    const baselineInferenceId = req.body.baselineInferenceId
      ? String(req.body.baselineInferenceId).trim()
      : null;
    let photoMatches = [];
    if (req.body.photoMatches) {
      try {
        const parsed = JSON.parse(req.body.photoMatches);
        if (Array.isArray(parsed)) {
          photoMatches = parsed
            .filter((m) => m && typeof m.filename === 'string')
            .map((m) => ({ filename: m.filename, matchedBaselineFilename: m.matchedBaselineFilename || null }));
        }
      } catch {
        return res.status(400).json({ error: 'Invalid photoMatches payload', message: 'photoMatches must be valid JSON.' });
      }
    }

    if (!regionName) {
      return res.status(400).json({
        error: 'Missing required field: regionName',
        message: 'Enter a region name before uploading photos.',
      });
    }

    if (!surveyName) {
      return res.status(400).json({
        error: 'Missing required field: surveyName',
        message: 'Start or open a survey first, then inspect a ship part.',
      });
    }

    if (!project) {
      return res.status(400).json({
        error: 'Missing required field: project',
      });
    }

    if (!company) {
      return res.status(400).json({
        error: 'Missing company on user',
        message: 'Your account has no workspace company. Log in again.',
      });
    }

    if (uploadedImages.length === 0) {
      return res.status(400).json({
        error: 'No files uploaded',
        message: 'At least one jpg/png image is required.',
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

    const pin = await MobileInspectConfig.findOne({ company, project }).populate('modelId');
    if (!pin || !pin.modelId) {
      return res.status(400).json({
        error: 'No mobile inspect model pinned',
        message: 'Pin a YOLO_SEG model in Workspace Settings → Mobile Inspect.',
      });
    }

    const model = pin.modelId;
    if (model.modelType !== 'YOLO_SEG') {
      return res.status(400).json({
        error: 'Pinned model must be YOLO_SEG',
        modelType: model.modelType,
      });
    }

    const checkpointPath = resolveModelCheckpointPath(model);
    if (!checkpointPath || !fs.existsSync(checkpointPath)) {
      return res.status(404).json({
        error: 'Pinned model checkpoint file not found',
        modelId: model.modelId,
      });
    }

    const conf =
      typeof pin.confidenceThreshold === 'number' && Number.isFinite(pin.confidenceThreshold)
        ? pin.confidenceThreshold
        : 0.25;

    const tempInferenceDir = path.join(
      process.cwd(),
      'uploads',
      'inference-temp',
      `insp_${Date.now()}_${uuidv4().substring(0, 8)}`
    );
    await storageAdapter.ensureDir(tempInferenceDir);

    for (const file of uploadedImages) {
      const destPath = path.join(tempInferenceDir, file.originalname);
      try {
        await fs.promises.rename(file.path, destPath);
      } catch {
        await fs.promises.copyFile(file.path, destPath);
        await fs.promises.unlink(file.path);
      }
      await downscaleInspectImage(destPath);
    }

    const inferenceId = `inf_${Date.now()}_${uuidv4().substring(0, 8)}`;

    const observation = await resolveObservationForNewJob({
      company: model.company,
      project: model.project,
      regionName,
      componentName: req.body.componentName,
      baselineInferenceId,
      createdBy: req.user ? req.user.id : null,
    });

    const inferenceJob = new InferenceJob({
      inferenceId,
      modelId: model._id,
      company: model.company,
      project: model.project,
      sourceType: 'custom_folder',
      customFolderPath: tempInferenceDir,
      regionName: observation.regionName,
      componentName: observation.componentName,
      observationId: observation.observationId,
      previousInferenceId: await findPreviousVisit({
        company: model.company,
        project: model.project,
        observationId: observation.observationId,
      }),
      notes: String(req.body.notes || '').trim().slice(0, 2000),
      inspectorName: req.user?.email || null,
      surveyName,
      baselineInferenceId,
      photoMatches,
      status: 'queued',
      createdBy: req.user ? req.user.id : null,
      progress: {
        totalImages: uploadedImages.length,
        processedImages: 0,
        progressPercent: 0,
      },
    });
    await inferenceJob.save();

    await inferenceQueue.add(
      {
        inferenceId,
        modelId: model._id.toString(),
        company: model.company,
        project: model.project,
        sourceType: 'custom_folder',
        customFolderPath: tempInferenceDir,
        confidenceThreshold: conf,
        regionName,
        surveyName,
        mobileInspect: true,
      },
      {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    await auditService.logAction({
      action: 'execute',
      resourceType: 'inference',
      resourceId: inferenceId,
      details: {
        company: model.company,
        project: model.project,
        projectName: model.project,
        modelId: model._id.toString(),
        sourceType: 'custom_folder',
        regionName,
        surveyName,
        totalImages: uploadedImages.length,
        mobileInspect: true,
      },
      req,
    });

    return res.status(202).json({
      inferenceId: inferenceJob.inferenceId,
      status: inferenceJob.status,
      regionName,
      surveyName,
      modelVersion: model.modelVersion,
      totalImages: uploadedImages.length,
      message: 'Inspect job queued',
    });
  } catch (error) {
    console.error('[mobile-inspect] start error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
};

/**
 * POST /api/mobile-inspect/confirm-on-device
 * multipart: regionName, surveyName, project, stats (JSON string), files[]
 *
 * Confirms an on-device preview into a real, permanent survey part WITHOUT
 * re-running server-side inference — the corrosion stats and annotated
 * overlay images were already computed on the phone (using the on-device
 * TFLite model). This just stores them the same way a normal completed
 * inference job would look on disk (annotated images + metadata.json), so
 * every existing consumer (survey dashboard, PDF export, image serving)
 * works completely unchanged.
 */
const confirmOnDeviceInspect = async (req, res) => {
  try {
    const regionName = String(req.body.regionName || '').trim();
    const surveyName = String(req.body.surveyName || '').trim();
    const project = String(req.body.project || '').trim();
    const company = String(req.user?.company || '').trim();
    const uploadedImages = Array.isArray(req.files) ? req.files : [];
    const baselineInferenceId = req.body.baselineInferenceId
      ? String(req.body.baselineInferenceId).trim()
      : null;

    if (!regionName) {
      return res.status(400).json({ error: 'Missing required field: regionName' });
    }
    if (!surveyName) {
      return res.status(400).json({ error: 'Missing required field: surveyName' });
    }
    if (!project) {
      return res.status(400).json({ error: 'Missing required field: project' });
    }
    if (!company) {
      return res.status(400).json({
        error: 'Missing company on user',
        message: 'Your account has no workspace company. Log in again.',
      });
    }
    if (uploadedImages.length === 0) {
      return res.status(400).json({
        error: 'No files uploaded',
        message: 'At least one image is required.',
      });
    }

    let stats;
    try {
      stats = JSON.parse(req.body.stats || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid stats payload', message: 'stats must be valid JSON.' });
    }
    if (typeof stats.meanCorrosionPercent !== 'number' || !Array.isArray(stats.images)) {
      return res.status(400).json({
        error: 'Invalid stats payload',
        message: 'stats.meanCorrosionPercent (number) and stats.images (array) are required.',
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

    const pin = await MobileInspectConfig.findOne({ company, project }).populate('modelId');
    if (!pin || !pin.modelId) {
      return res.status(400).json({
        error: 'No mobile inspect model pinned',
        message: 'Pin a YOLO_SEG model in Workspace Settings → Mobile Inspect.',
      });
    }
    const model = pin.modelId;

    const inferenceId = `inf_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const resultsPath = storageAdapter.buildResultsPath(model.company, model.project, model.modelId, inferenceId);
    const annotatedImagesPath = storageAdapter.buildAnnotatedImagesPath(resultsPath);
    const metadataPath = storageAdapter.buildMetadataPath(resultsPath);
    await storageAdapter.ensureDir(annotatedImagesPath);

    const statsByFilename = {};
    for (const img of stats.images) {
      if (img?.filename) statsByFilename[img.filename] = img;
    }

    const metaImages = [];
    // Derived from each stats.images[] entry's optional `matchedBaselineFilename`
    // (set by the resurvey capture flow) — same end shape as the server
    // path's separate `photoMatches` field, just carried alongside the
    // per-image stats here since this path already has them at hand.
    const photoMatches = [];
    for (const file of uploadedImages) {
      const destPath = path.join(annotatedImagesPath, file.originalname);
      try {
        await fs.promises.rename(file.path, destPath);
      } catch {
        await fs.promises.copyFile(file.path, destPath);
        await fs.promises.unlink(file.path);
      }
      const s = statsByFilename[file.originalname] || {};
      metaImages.push({
        filePath: file.originalname,
        corrosionPercentTotal: typeof s.corrosionPercentTotal === 'number' ? s.corrosionPercentTotal : null,
        byClass: Array.isArray(s.byClass) ? s.byClass : [],
        instanceCount: typeof s.instanceCount === 'number' ? s.instanceCount : 0,
      });
      if (typeof s.matchedBaselineFilename === 'string' && s.matchedBaselineFilename) {
        photoMatches.push({ filename: file.originalname, matchedBaselineFilename: s.matchedBaselineFilename });
      }
    }

    const classNames = Array.isArray(stats.classNames) ? stats.classNames : [];
    const corrosionStats = {
      meanCorrosionPercent: stats.meanCorrosionPercent,
      byClass: Array.isArray(stats.byClass) ? stats.byClass : [],
      imageCount: uploadedImages.length,
      classNames,
    };

    const metadata = {
      classNames,
      corrosionStats,
      images: metaImages,
      totalImages: uploadedImages.length,
      totalFiles: uploadedImages.length,
      source: 'on_device',
    };
    await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    let onDeviceAssessment = null;
    try {
      onDeviceAssessment = parseAssessmentField(req.body.assessment);
    } catch (validationError) {
      return res.status(400).json({ error: 'Invalid assessment', message: validationError.message });
    }

    const observation = await resolveObservationForNewJob({
      company: model.company,
      project: model.project,
      regionName,
      componentName: req.body.componentName,
      baselineInferenceId,
      createdBy: req.user ? req.user.id : null,
    });

    const inferenceJob = new InferenceJob({
      inferenceId,
      modelId: model._id,
      company: model.company,
      project: model.project,
      sourceType: 'custom_folder',
      customFolderPath: resultsPath,
      assessment: onDeviceAssessment
        ? { ...onDeviceAssessment, assessedBy: req.user?.email || null, assessedAt: new Date() }
        : null,
      regionName: observation.regionName,
      componentName: observation.componentName,
      observationId: observation.observationId,
      previousInferenceId: await findPreviousVisit({
        company: model.company,
        project: model.project,
        observationId: observation.observationId,
      }),
      notes: String(req.body.notes || '').trim().slice(0, 2000),
      inspectorName: req.user?.email || null,
      surveyName,
      baselineInferenceId,
      photoMatches,
      status: 'completed',
      createdBy: req.user ? req.user.id : null,
      progress: {
        totalImages: uploadedImages.length,
        processedImages: uploadedImages.length,
        progressPercent: 100,
      },
      results: {
        resultsPath,
        annotatedImagesPath,
        goodImagesPath: null,
        defectImagesPath: null,
        metadataPath,
        totalDetections: metaImages.reduce((sum, i) => sum + (i.instanceCount || 0), 0),
        averageConfidence: 0,
        goodCount: 0,
        defectCount: 0,
        detectionsByClass: [],
        corrosionStats,
      },
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await inferenceJob.save();

    await auditService.logAction({
      action: 'execute',
      resourceType: 'inference',
      resourceId: inferenceId,
      details: {
        company: model.company,
        project: model.project,
        modelId: model._id.toString(),
        sourceType: 'custom_folder',
        regionName,
        surveyName,
        totalImages: uploadedImages.length,
        mobileInspect: true,
        onDevice: true,
      },
      req,
    });

    return res.status(201).json({
      inferenceId: inferenceJob.inferenceId,
      status: inferenceJob.status,
      regionName,
      surveyName,
      message: 'On-device inspect confirmed and added to survey',
    });
  } catch (error) {
    console.error('[mobile-inspect] confirm-on-device error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
};

module.exports = { startMobileInspect, confirmOnDeviceInspect };
