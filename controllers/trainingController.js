const TrainingJob = require('../models/TrainingJob');
const Dataset = require('../models/Dataset');
const Model = require('../models/Model');
const { trainingQueue } = require('../queue');
const trainingService = require('../services/trainingService');
const auditService = require('../services/auditService');
const { checkCustomerTraining } = require('../middleware/customerAccessMiddleware');
const { buildWorkspaceFilter, validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const fs = require('fs');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const {
  hydrateAndPersistModelMetrics,
  formatModelNameWithMap,
} = require('../utils/yoloTrainingMetrics');

/**
 * Normalize modelSize input to a consistent format.
 * Supports:
 * - "n" | "s" | "m" | "l" | "x"
 * - "v5n" | "v8n" | "v11s" | "v26n"
 * - "base-v26n"
 * - "yolov26n.pt" | "yolo26n.pt" | "yolov5n.pt"
 */
function normalizeModelSize(input) {
  if (!input) return null;

  let value = String(input).trim();

  if (value.startsWith('base-')) {
    value = value.slice('base-'.length);
  }

  const fileMatch = value.match(/yolov?(\d+)([nsmlx])(?:-seg)?\.pt/i);
  if (fileMatch) {
    return `v${fileMatch[1]}${fileMatch[2].toLowerCase()}`;
  }

  const versionMatch = value.match(/^v?(5|8|11|26)([nsmlx])$/i);
  if (versionMatch) {
    return `v${versionMatch[1]}${versionMatch[2].toLowerCase()}`;
  }

  const sizeMatch = value.match(/^([nsmlx])$/i);
  if (sizeMatch) {
    return sizeMatch[1].toLowerCase();
  }

  return value;
}

function parseModelKeyInfo(modelKey) {
  if (!modelKey) return null;
  const match = String(modelKey).trim().match(/^base-v(5|8|11|26)([nsmlx])(-seg)?$/i);
  if (!match) return null;
  return {
    version: match[1],
    size: match[2].toLowerCase(),
    isSeg: Boolean(match[3])
  };
}

/** Max length for optional modelVersion / display name (matches typical frontend limit). */
const MODEL_VERSION_MAX_LENGTH = 120;
const ALLOWED_AUGMENTATION_PRESETS = new Set([
  'none',
  'color_invariant',
  'small_defect',
  'low_light',
  'robust'
]);

/**
 * Parse optional `modelVersion` from training start body.
 * - Omitted / null → { value: null } (use auto v1, v2, … in worker)
 * - Whitespace-only → 400-level error message
 * @returns {{ value: string | null } | { error: string }}
 */
function parseOptionalModelVersion(raw) {
  if (raw === undefined || raw === null) {
    return { value: null };
  }
  const s = String(raw).trim();
  if (s.length === 0) {
    return {
      error:
        'modelVersion must not be empty or whitespace-only if provided'
    };
  }
  if (s.length > MODEL_VERSION_MAX_LENGTH) {
    return {
      error: `modelVersion must be at most ${MODEL_VERSION_MAX_LENGTH} characters`
    };
  }
  if (s === '.' || s === '..') {
    return { error: 'modelVersion must not be "." or ".."' };
  }
  // Windows / path-unsafe and control characters
  if (/[\x00-\x1F<>:"/\\|?*]/.test(s)) {
    return {
      error:
        'modelVersion contains illegal characters (path reserved: \\ / : * ? " < > | or control characters)'
    };
  }
  return { value: s };
}

/**
 * Training Controller - Handles training job management
 * 
 * This controller provides endpoints for:
 * - Listing available base models
 * - Starting new training jobs
 * - Checking training status and progress
 * - Retrieving training logs
 * - Cancelling training jobs
 * - Retrying failed/cancelled jobs
 */

/**
 * GET /api/train/base-models
 * 
 * List available base YOLO models and trained models for a project
 * 
 * Query params:
 * - company (optional) - Filter trained models by company
 * - project (optional) - Filter trained models by project
 * 
 * Returns both base models (from models/base/) and trained models (from MongoDB)
 */
const getAvailableBaseModels = async (req, res) => {
  try {
    const baseModelsDir = path.join(process.cwd(), 'models', 'base');
    
    // ✅ Get trained models from MongoDB (if company and project provided)
    const trainedModels = [];
    if (req.query.company && req.query.project) {
      const models = await Model.find({ company: req.query.company, project: req.query.project })
        .sort({ createdAt: -1 }) // Newest first
        .select('modelId modelVersion modelType metrics createdAt storagePath')
        .lean();

      trainedModels.push(...await Promise.all(models.map(async (model) => {
        const metrics = await hydrateAndPersistModelMetrics(Model, model);

        return {
          type: 'trained',
          modelId: model.modelId,
          modelVersion: model.modelVersion,
          modelType: model.modelType,
          name: formatModelNameWithMap(model.modelType, model.modelVersion, metrics?.mAP50),
          metrics: {
            mAP50: metrics?.mAP50,
            precision: metrics?.precision,
            recall: metrics?.recall
          },
          createdAt: model.createdAt
        };
      })));
    }

    // ✅ DUAL MODE: Read base models from Azure Blob Storage OR local filesystem
    const models = [];
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    
    if (connectionString) {
      // ✅ Azure Blob Storage mode
      console.log('[getAvailableBaseModels] Using Azure Blob Storage mode');
      
      try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerName = 'models';
        const prefix = 'base/';
        
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const baseModelsList = [];
        
        // List blobs with prefix "base/"
        for await (const blob of containerClient.listBlobsFlat({ prefix })) {
          // Skip directory placeholders (blobs ending with "/")
          if (blob.name.endsWith('/')) {
            continue;
          }
          
          // Extract filename from blob name (e.g., "base/yolov8n.pt" -> "yolov8n.pt")
          const filename = blob.name.substring(prefix.length);
          
          // Only process .pt files
          if (!filename.endsWith('.pt')) {
            continue;
          }
          
          // Extract model size from filename (yolov8n.pt -> 'n', yolov11s.pt -> 's')
          const isSeg = /-seg\.pt$/i.test(filename);
          const v5Match = filename.match(/yolov5([nsmlx])(?:-seg)?\.pt/i);
          const v8Match = filename.match(/yolov8([nsmlx])(?:-seg)?\.pt/i);
          const v11Match = filename.match(/yolov11([nsmlx])(?:-seg)?\.pt/i);
          const v26Match = filename.match(/yolov?26([nsmlx])(?:-seg)?\.pt/i);
          const size = v5Match ? v5Match[1] : (v8Match ? v8Match[1] : (v11Match ? v11Match[1] : (v26Match ? v26Match[1] : null)));
          const version = v5Match ? 'v5' : (v8Match ? 'v8' : (v11Match ? 'v11' : (v26Match ? 'v26' : null)));
          
          // Skip invalid YOLO models
          if (!size || !version) {
            continue;
          }
          
          // Map size codes to readable names
          const sizeNames = {
            'n': 'Nano',
            's': 'Small',
            'm': 'Medium',
            'l': 'Large',
            'x': 'Extra Large'
          };
          
          const sizeMB = blob.properties.contentLength 
            ? (blob.properties.contentLength / (1024 * 1024)).toFixed(2)
            : '0.00';
          
          baseModelsList.push({
            type: 'base',
            filename: filename,
            modelType: isSeg ? 'YOLO_SEG' : 'YOLO',
            size: size,
            version: version,
            key: `base-${version}${size}${isSeg ? '-seg' : ''}`,
            name: `${isSeg ? 'YOLO_SEG' : 'YOLO'} ${version} ${sizeNames[size]}`,
            sizeMB: parseFloat(sizeMB),
            path: `/models/${blob.name}` // Logical path for Azure mode
          });
        }
        
        // Sort by size (n, s, m, l, x)
        const sizeOrder = { 'n': 1, 's': 2, 'm': 3, 'l': 4, 'x': 5 };
        baseModelsList.sort((a, b) => (sizeOrder[a.size] || 99) - (sizeOrder[b.size] || 99));
        models.push(...baseModelsList);
        
        console.log(`[getAvailableBaseModels] Found ${baseModelsList.length} base models in Azure Blob Storage`);
        
      } catch (error) {
        console.error('[getAvailableBaseModels] Error reading from Azure Blob Storage:', error.message);
        // Fall through to return empty array (don't break the API)
      }
    } else {
      // ✅ Local filesystem mode
      console.log('[getAvailableBaseModels] Using local filesystem mode');
      
      if (fs.existsSync(baseModelsDir)) {
        const files = fs.readdirSync(baseModelsDir);
        const modelFiles = files.filter(file => file.endsWith('.pt'));

        // Map to model info
        const baseModelsList = modelFiles.map(file => {
          const filePath = path.join(baseModelsDir, file);
          const stats = fs.statSync(filePath);
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

          // Extract model size from filename (yolov8n.pt -> 'n', yolov11s.pt -> 's')
          const isSeg = /-seg\.pt$/i.test(file);
          const v5Match = file.match(/yolov5([nsmlx])(?:-seg)?\.pt/i);
          const v8Match = file.match(/yolov8([nsmlx])(?:-seg)?\.pt/i);
          const v11Match = file.match(/yolov11([nsmlx])(?:-seg)?\.pt/i);
          const v26Match = file.match(/yolov?26([nsmlx])(?:-seg)?\.pt/i);
          const size = v5Match ? v5Match[1] : (v8Match ? v8Match[1] : (v11Match ? v11Match[1] : (v26Match ? v26Match[1] : null)));
          const version = v5Match ? 'v5' : (v8Match ? 'v8' : (v11Match ? 'v11' : (v26Match ? 'v26' : null)));

          // Map size codes to readable names
          const sizeNames = {
            'n': 'Nano',
            's': 'Small',
            'm': 'Medium',
            'l': 'Large',
            'x': 'Extra Large'
          };

          return {
            type: 'base',
            filename: file,
            modelType: isSeg ? 'YOLO_SEG' : 'YOLO',
            size: size,
            version: version,
            key: `base-${version}${size}${isSeg ? '-seg' : ''}`,
            name: size && version ? `${isSeg ? 'YOLO_SEG' : 'YOLO'} ${version} ${sizeNames[size]}` : file.replace('.pt', ''),
            sizeMB: parseFloat(sizeMB),
            path: filePath
          };
        }).filter(model => model.size !== null); // Only include valid YOLO models

        // Sort by size (n, s, m, l, x)
        const sizeOrder = { 'n': 1, 's': 2, 'm': 3, 'l': 4, 'x': 5 };
        baseModelsList.sort((a, b) => (sizeOrder[a.size] || 99) - (sizeOrder[b.size] || 99));
        models.push(...baseModelsList);
        
        console.log(`[getAvailableBaseModels] Found ${baseModelsList.length} base models in local filesystem`);
      }
    }

    // Virtual RF-DETR-N base (weights downloaded by rfdetr package on first train)
    models.push({
      type: 'base',
      filename: null,
      modelType: 'RF_DETR',
      size: 'n',
      version: 'rfdetr',
      key: 'base-rfdetr-n',
      name: 'RF-DETR Nano (detection)',
      sizeMB: null,
      path: null
    });

    return res.status(200).json({
      baseModels: models,
      trainedModels: trainedModels,
      total: models.length + trainedModels.length
    });

  } catch (error) {
    console.error('Error listing base models:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/train/defaults
 * 
 * Get default hyperparameters for a model type
 * 
 * Query params:
 * - modelType: 'YOLO' | 'YOLO_SEG'
 * 
 * Response:
 * {
 *   "modelType": "YOLO",
 *   "defaults": {
 *     "epochs": 20,
 *     "batchSize": 8,
 *     "imgSize": 416,
 *     "learningRate": 0.01,
 *     "workers": 2
 *   }
 * }
 */
const getDefaultHyperparameters = async (req, res) => {
  try {
    const { modelType } = req.query;

    if (!modelType) {
      return res.status(400).json({
        error: 'modelType query parameter is required',
        validTypes: ['YOLO', 'YOLO_SEG', 'RF_DETR']
      });
    }

    const validTypes = ['YOLO', 'YOLO_SEG', 'RF_DETR'];
    if (!validTypes.includes(modelType)) {
      return res.status(400).json({
        error: `Invalid modelType: ${modelType}`,
        validTypes: validTypes
      });
    }

    const defaults = trainingService.getDefaultHyperparameters(modelType);

    return res.status(200).json({
      modelType: modelType,
      defaults: defaults
    });

  } catch (error) {
    console.error('Error getting default hyperparameters:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Block a second training start while this server already has a live job.
 * Returns true if a 409 was already sent.
 */
async function respondIfTrainingBusy(res) {
  try {
    const [active, waiting, delayed] = await Promise.all([
      trainingQueue.getActive(),
      trainingQueue.getWaiting(),
      trainingQueue.getDelayed()
    ]);
    const busy = [...active, ...waiting, ...delayed];
    if (busy.length > 0) {
      const existingJobId = busy[0]?.data?.jobId || null;
      res.status(409).json({
        error:
          'A training job is already running or queued on this server. Cancel it before starting another.',
        existingJobId,
        existingStatus: 'queued_or_running'
      });
      return true;
    }
  } catch (err) {
    console.warn('[training] Could not inspect queue:', err.message);
  }

  const live = await trainingService.findLiveTrainingJob();
  if (live) {
    res.status(409).json({
      error: `A training job is already ${live.status} (${live.jobId}). Cancel it before starting another.`,
      existingJobId: live.jobId,
      existingStatus: live.status
    });
    return true;
  }

  return false;
}

/**
 * POST /api/train
 * 
 * Start a new training job
 */
const startTraining = async (req, res) => {
  try {
    const {
      datasetId,
      modelId,
      modelType,
      modelSize,
      modelKey,
      hyperparameters,
      modelVersion,
      augmentationPreset
    } =
      req.body;
    const normalizedModelSize = normalizeModelSize(modelSize);
    const normalizedModelKey = modelKey ? String(modelKey).trim() : null;

    const parsedVersion = parseOptionalModelVersion(modelVersion);
    if (parsedVersion.error) {
      return res.status(400).json({ error: parsedVersion.error });
    }
    const requestedModelVersion = parsedVersion.value;
    const normalizedAugmentationPreset = augmentationPreset
      ? String(augmentationPreset).trim()
      : 'none';
    if (!ALLOWED_AUGMENTATION_PRESETS.has(normalizedAugmentationPreset)) {
      return res.status(400).json({
        error:
          'Invalid augmentationPreset. Allowed values: none, color_invariant, small_defect, low_light, robust'
      });
    }

    // Validate required fields
    if (!datasetId) {
      return res.status(400).json({
        error: 'Missing required field: datasetId'
      });
    }

    // Use the requested dataset for training
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return res.status(404).json({
        error: 'Dataset not found'
      });
    }

    // Must be ready (annotated / processed) before training
    if (dataset.status !== 'ready' && dataset.status !== 'ready_to_train') {
      return res.status(400).json({
        error: `Dataset is not ready for training (status: ${dataset.status}). Finish processing/annotation first.`
      });
    }

    // ✅ Auto-activate selected version: after augmentation the original is marked inactive,
    // but Simulation still lets you pick any ready version. Activate the one the user chose.
    if (!dataset.isActive) {
      await Dataset.updateMany(
        {
          company: dataset.company,
          project: dataset.project,
          deletedAt: null,
          _id: { $ne: dataset._id },
        },
        { $set: { isActive: false } }
      );
      dataset.isActive = true;
      await dataset.save();
      console.log('[TRAIN] Auto-activated dataset for training', {
        datasetId: dataset._id.toString(),
        version: dataset.version,
        company: dataset.company,
        project: dataset.project,
      });
    }

    // ✅ If modelId is provided, validate and use trained model
    let trainedModel = null;
    let finalModelType = modelType;
    let finalModelSize = normalizedModelSize || 'n';
    let finalModelKey = normalizedModelKey;

    if (modelId) {
      // Fetch trained model from database
      trainedModel = await Model.findOne({ modelId });
      
      if (!trainedModel) {
        return res.status(404).json({
          error: 'Trained model not found',
          modelId: modelId
        });
      }

      // ✅ Validate that modelType matches (if provided)
      if (modelType && modelType !== trainedModel.modelType) {
        return res.status(400).json({
          error: `Model type mismatch. Trained model is ${trainedModel.modelType}, but ${modelType} was provided.`
        });
      }

      // Use trained model's type and size
      finalModelType = trainedModel.modelType;
      // Note: trained models don't have modelSize stored, so we'll use the one from request or default
      
      // Validate that model belongs to same company/project as the selected dataset
      if (trainedModel.company !== dataset.company || trainedModel.project !== dataset.project) {
        return res.status(400).json({
          error: 'Trained model does not belong to the same company/project as the selected dataset'
        });
      }
    } else {
      // ✅ If no modelId, validate modelType and modelSize (base model)
      if (!modelType) {
        return res.status(400).json({
          error: 'Missing required field: modelType (or provide modelId for trained model)'
        });
      }

      // Validate modelType
      if (!['YOLO', 'YOLO_SEG', 'RF_DETR'].includes(modelType)) {
        return res.status(400).json({
          error: 'Invalid modelType. Must be: YOLO, YOLO_SEG, or RF_DETR'
        });
      }

      if (modelType === 'RF_DETR') {
        finalModelSize = 'n';
        if (normalizedModelSize && normalizedModelSize !== 'n') {
          return res.status(400).json({
            error: 'RF_DETR only supports modelSize n (Nano) in v1'
          });
        }
        if (normalizedModelKey && normalizedModelKey !== 'base-rfdetr-n') {
          return res.status(400).json({
            error: 'Invalid modelKey for RF_DETR. Must be base-rfdetr-n'
          });
        }
        if (!normalizedModelKey) {
          finalModelKey = 'base-rfdetr-n';
        }
      }

      // Validate modelSize for YOLO (optional, defaults to 'n')
      if ((modelType === 'YOLO' || modelType === 'YOLO_SEG') && normalizedModelSize) {
        const validSizePattern = /^(?:[nsmlx]|v(?:5|8|11|26)[nsmlx])$/i;
        if (!validSizePattern.test(normalizedModelSize)) {
          return res.status(400).json({
            error: 'Invalid modelSize. Must be one of: n/s/m/l/x or v5n/v8n/v11n/v26n'
          });
        }
      }

      if ((modelType === 'YOLO' || modelType === 'YOLO_SEG') && normalizedModelKey) {
        const validKeyPattern = /^base-v(?:5|8|11|26)[nsmlx](?:-seg)?$/i;
        if (!validKeyPattern.test(normalizedModelKey)) {
          return res.status(400).json({
            error: 'Invalid modelKey. Must be like base-v5n/base-v8n/base-v11n/base-v26n with optional -seg'
          });
        }
        const keyInfo = parseModelKeyInfo(normalizedModelKey);
        if (keyInfo && keyInfo.isSeg && modelType !== 'YOLO_SEG') {
          return res.status(400).json({
            error: 'modelKey with -seg requires modelType=YOLO_SEG'
          });
        }
        if (keyInfo && !keyInfo.isSeg && modelType === 'YOLO_SEG') {
          return res.status(400).json({
            error: 'modelType=YOLO_SEG requires modelKey ending with -seg'
          });
        }
      }
    }

    if (
      finalModelType === 'RF_DETR' &&
      normalizedAugmentationPreset !== 'none'
    ) {
      console.warn(
        `[startTraining] augmentationPreset "${normalizedAugmentationPreset}" ignored for RF_DETR (YOLO-only presets)`
      );
    }

    // Customers: nano/small only, limited number of models per company
    const customerBlock = await checkCustomerTraining(req.user, {
      modelType: finalModelType,
      modelSize: normalizedModelSize,
      modelKey: finalModelKey,
      baseModel: trainedModel,
    });
    if (customerBlock) {
      return res.status(customerBlock.status).json({ error: customerBlock.message, message: customerBlock.message });
    }

    // Validate dataset is ready for training
    const validation = await trainingService.validateDatasetForTraining(dataset._id);
    if (!validation.valid) {
      return res.status(400).json({
        error: validation.error
      });
    }

    // Merge hyperparameters with defaults (use finalModelType which may come from trained model)
    const mergedHyperparameters = trainingService.mergeHyperparameters(finalModelType, hyperparameters);

    // Validate hyperparameters
    const hyperValidation = trainingService.validateHyperparameters(mergedHyperparameters);
    if (!hyperValidation.valid) {
      return res.status(400).json({
        error: hyperValidation.error
      });
    }

    if (requestedModelVersion) {
      const duplicate = await Model.findOne({
        company: dataset.company,
        project: dataset.project,
        modelVersion: requestedModelVersion
      })
        .select('_id modelVersion')
        .lean();
      if (duplicate) {
        return res.status(409).json({
          error:
            'A model with this modelVersion already exists for this company and project. Choose a different name.',
          modelVersion: requestedModelVersion
        });
      }
    }

    if (await respondIfTrainingBusy(res)) {
      return;
    }

    // Generate job ID
    const jobId = trainingService.generateJobId();

    // Create TrainingJob document
    const trainingJob = new TrainingJob({
      jobId,
      datasetId: dataset._id,
      company: dataset.company,
      project: dataset.project,
      modelType: finalModelType,
      modelSize: finalModelSize,
      modelKey: finalModelKey,
      requestedModelVersion: requestedModelVersion || null,
      augmentationPreset: normalizedAugmentationPreset,
      status: 'queued',
      hyperparameters: mergedHyperparameters
    });

    await trainingJob.save();

    // Enqueue training job (include modelId if using trained model)
    await trainingQueue.add({
      jobId,
      datasetId: dataset._id.toString(),
      company: dataset.company,
      project: dataset.project,
      modelType: finalModelType,
      modelSize: finalModelSize,
      modelKey: finalModelKey,
      modelId: modelId || null, // ✅ Pass modelId if provided (for trained model)
      requestedModelVersion: requestedModelVersion || null,
      augmentationPreset: normalizedAugmentationPreset,
      hyperparameters: mergedHyperparameters
    }, {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false
    });

    // Log training job execution activity
    await auditService.logAction({
      action: 'execute',
      resourceType: 'training',
      resourceId: jobId,
      details: {
        company: dataset.company,
        project: dataset.project,
        projectName: dataset.project,
        datasetId: dataset._id.toString(),
        modelType: finalModelType,
        modelSize: finalModelSize
      },
      req
    });

    return res.status(202).json({
      jobId,
      status: 'queued',
      message: 'Training job queued successfully',
      datasetId: dataset._id.toString(),
      modelType,
      modelSize: finalModelSize,
      ...(requestedModelVersion && { modelVersion: requestedModelVersion }),
      augmentationPreset: normalizedAugmentationPreset,
      hyperparameters: mergedHyperparameters
    });

  } catch (error) {
    console.error('Error starting training:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/train/:jobId/status
 * 
 * Get training job status and progress
 */
const getTrainingStatus = async (req, res) => {
  try {
    const { jobId } = req.params;

    const trainingJob = await TrainingJob.findOne({ jobId }).select('-logs');

    if (!trainingJob) {
      return res.status(404).json({
        error: 'Training job not found',
        jobId: jobId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, trainingJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this training job'
        });
      }
    }

    // ✅ Build base response with training job data
    const response = {
      jobId: trainingJob.jobId,
      status: trainingJob.status,
      progress: trainingJob.progress,
      metrics: trainingJob.metrics,
      finalMetrics: trainingJob.finalMetrics || null, // ✅ Include final metrics
      hyperparameters: trainingJob.hyperparameters, // ✅ Include hyperparameters used
      modelType: trainingJob.modelType,
      modelSize: trainingJob.modelSize,
      augmentationPreset: trainingJob.augmentationPreset || 'none',
      /** Display / storage folder name if client sent modelVersion at train start; mirrors registered Model.modelVersion when complete */
      requestedModelVersion: trainingJob.requestedModelVersion || null,
      datasetId: trainingJob.datasetId ? trainingJob.datasetId.toString() : null,
      company: trainingJob.company,
      project: trainingJob.project,
      startedAt: trainingJob.startedAt,
      completedAt: trainingJob.completedAt,
      cancelledAt: trainingJob.cancelledAt,
      error: trainingJob.error,
      model: null // ✅ Will be populated if model is registered
    };

    // ✅ If training is completed, check if model was registered
    if (trainingJob.status === 'completed') {
      const registeredModel = await Model.findOne({ jobId: trainingJob._id })
        .select('modelId modelVersion storagePath bestCheckpointPath downloadUrl metrics insights createdAt')
        .lean();

      if (registeredModel) {
        response.model = {
          modelId: registeredModel.modelId,
          modelVersion: registeredModel.modelVersion,
          storagePath: registeredModel.storagePath,
          bestCheckpointPath: registeredModel.bestCheckpointPath,
          downloadUrl: registeredModel.downloadUrl,
          metrics: registeredModel.metrics,
          insights: registeredModel.insights,
          registeredAt: registeredModel.createdAt
        };
      }
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('Error getting training status:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/train/active
 *
 * Return the live queued/running job on this server (heartbeat within 10 minutes).
 * Used by the Simulation page so a refresh or navigation cannot hide a GPU job.
 */
const getActiveTraining = async (req, res) => {
  try {
    const live = await trainingService.findLiveTrainingJob();
    if (!live) {
      return res.status(200).json({ jobId: null });
    }

    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, live.company);
      if (!accessValidation.allowed) {
        return res.status(200).json({ jobId: null });
      }
    }

    return res.status(200).json({
      jobId: live.jobId,
      status: live.status,
      company: live.company,
      project: live.project,
      datasetId: live.datasetId ? String(live.datasetId) : null,
      modelType: live.modelType,
      modelSize: live.modelSize,
      requestedModelVersion: live.requestedModelVersion || null
    });
  } catch (error) {
    console.error('Error getting active training job:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/train/:jobId/logs
 * 
 * Get training logs
 */
const getTrainingLogs = async (req, res) => {
  try {
    const { jobId } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    const trainingJob = await TrainingJob.findOne({ jobId }).select('jobId company logs');

    if (!trainingJob) {
      return res.status(404).json({
        error: 'Training job not found',
        jobId: jobId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, trainingJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this training job'
        });
      }
    }

    // Return last N logs
    const logs = trainingJob.logs.slice(-limit);

    return res.status(200).json({
      jobId: trainingJob.jobId,
      logs: logs,
      total: trainingJob.logs.length
    });

  } catch (error) {
    console.error('Error getting training logs:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * POST /api/train/:jobId/cancel
 * 
 * Cancel a training job
 */
const cancelTraining = async (req, res) => {
  try {
    const { jobId } = req.params;

    const trainingJob = await TrainingJob.findOne({ jobId }).select('-logs');

    if (!trainingJob) {
      return res.status(404).json({
        error: 'Training job not found',
        jobId: jobId
      });
    }

    if (!trainingService.canCancelJob(trainingJob.status)) {
      return res.status(400).json({
        error: `Cannot cancel job with status: ${trainingJob.status}`,
        validStatuses: ['queued', 'running']
      });
    }

    trainingJob.status = 'cancelled';
    trainingJob.cancelledAt = new Date();
    await trainingJob.save();

    return res.status(200).json({
      jobId: trainingJob.jobId,
      status: 'cancelled',
      message: 'Training job cancelled successfully'
    });

  } catch (error) {
    console.error('Error cancelling training:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * POST /api/train/:jobId/retry
 * 
 * Retry a failed/cancelled training job
 */
const retryTraining = async (req, res) => {
  try {
    const { jobId } = req.params;

    const originalJob = await TrainingJob.findOne({ jobId }).select('-logs');

    if (!originalJob) {
      return res.status(404).json({
        error: 'Training job not found',
        jobId: jobId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, originalJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this training job'
        });
      }
    }

    if (!trainingService.canRetryJob(originalJob.status)) {
      return res.status(400).json({
        error: `Cannot retry job with status: ${originalJob.status}`,
        validStatuses: ['failed', 'cancelled']
      });
    }

    // Customers: same size and model-count rules as a new training
    const retryBase = originalJob.modelId ? await Model.findOne({ modelId: originalJob.modelId }).lean() : null;
    const customerBlock = await checkCustomerTraining(req.user, {
      modelType: originalJob.modelType,
      modelSize: originalJob.modelSize,
      modelKey: originalJob.modelKey,
      baseModel: retryBase,
    });
    if (customerBlock) {
      return res.status(customerBlock.status).json({ error: customerBlock.message, message: customerBlock.message });
    }

    if (await respondIfTrainingBusy(res)) {
      return;
    }

    // Create new job with same parameters
    const newJobId = trainingService.generateJobId();
    const newTrainingJob = new TrainingJob({
      jobId: newJobId,
      datasetId: originalJob.datasetId,
      company: originalJob.company,
      project: originalJob.project,
      modelType: originalJob.modelType,
      modelSize: originalJob.modelSize || 'n',
      requestedModelVersion: originalJob.requestedModelVersion || null,
      augmentationPreset: originalJob.augmentationPreset || 'none',
      status: 'queued',
      hyperparameters: originalJob.hyperparameters
    });

    await newTrainingJob.save();

    // Enqueue new training job
    await trainingQueue.add({
      jobId: newJobId,
      datasetId: originalJob.datasetId.toString(),
      company: originalJob.company,
      project: originalJob.project,
      modelType: originalJob.modelType,
      modelSize: originalJob.modelSize || 'n',
      requestedModelVersion: originalJob.requestedModelVersion || null,
      augmentationPreset: originalJob.augmentationPreset || 'none',
      hyperparameters: originalJob.hyperparameters
    }, {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false
    });

    return res.status(202).json({
      jobId: newJobId,
      status: 'queued',
      message: 'Training job retried successfully',
      originalJobId: jobId
    });

  } catch (error) {
    console.error('Error retrying training:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

module.exports = {
  getAvailableBaseModels,
  getDefaultHyperparameters,
  startTraining,
  getActiveTraining,
  getTrainingStatus,
  getTrainingLogs,
  cancelTraining,
  retryTraining
};
