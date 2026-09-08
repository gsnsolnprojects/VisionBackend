const Model = require('../models/Model');
const TrainingJob = require('../models/TrainingJob');
const { buildWorkspaceFilter, validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const fs = require('fs');
const path = require('path');
const storageAdapter = require('../services/storageAdapter');
const onnxConverter = require('../services/onnxConverter');
const tfliteConverter = require('../services/tfliteConverter');
const { getClassNamesForTrainedModel } = require('../services/yoloClassNamesService');
const { hydrateAndPersistModelMetrics } = require('../utils/yoloTrainingMetrics');

/**
 * Model Controller - Handles model registry operations
 * 
 * This controller provides endpoints for:
 * - Listing trained models
 * - Getting model details
 * - Retrieving metrics and chart data
 * - Getting insights and recommendations
 * - Downloading model files
 * - Listing checkpoints
 */

/**
 * GET /api/models
 * 
 * List all models for a company and project
 * 
 * Query params:
 * - company (required)
 * - project (required)
 */
const listModels = async (req, res) => {
  try {
    const { company, project } = req.query;

    // ✅ Validate required query parameters
    if (!company || !project) {
      return res.status(400).json({
        error: 'Missing required query parameters',
        required: ['company', 'project']
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this workspace'
        });
      }
    }

    // ✅ Find all models for company/project
    // Use collation for case-insensitive match (e.g. "Innovura" vs "innovura")
    const models = await Model.find({ company, project })
      .collation({ locale: 'en', strength: 2 })
      .sort({ createdAt: -1 }) // Newest first
      .select('modelId modelVersion modelType status metrics insights createdAt datasetVersion datasetId storagePath')
      .lean();

    const formattedModels = await Promise.all(models.map(async (model) => {
      const metrics = await hydrateAndPersistModelMetrics(Model, model);
      return {
      modelId: model.modelId,
      modelVersion: model.modelVersion,
      modelType: model.modelType,
      status: model.status || 'completed',
      metrics: metrics || {
        bestEpoch: null,
        bestLoss: null,
        precision: null,
        recall: null,
        mAP50: null,
        mAP50_95: null,
        perLabelStats: []
      },
      insights: model.insights || {
        bestAccuracy: null,
        bestmAP: null,
        weakestLabels: [],
        classImbalanceWarnings: [],
        recommendations: []
      },
      createdAt: model.createdAt,
      datasetVersion: model.datasetVersion,
      datasetId: model.datasetId ? model.datasetId.toString() : null
      };
    }));

    return res.status(200).json({
      models: formattedModels,
      total: formattedModels.length
    });

  } catch (error) {
    console.error('Error listing models:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/models/:modelId
 * 
 * Get full model details
 */
const getModel = async (req, res) => {
  try {
    const { modelId } = req.params;

    if (!modelId) {
      return res.status(400).json({
        error: 'Missing required parameter: modelId'
      });
    }

    // ✅ Find model
    const model = await Model.findOne({ modelId })
      .populate('jobId', 'jobId status hyperparameters')
      .populate('datasetId', 'company project version status totalImages trainCount valCount deletedAt')
      .lean();

    if (!model) {
      return res.status(404).json({
        error: 'Model not found',
        modelId: modelId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, model.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this model'
        });
      }
    }

    const classNames = await getClassNamesForTrainedModel(model);

    // ✅ Format response
    const response = {
      modelId: model.modelId,
      jobId: model.jobId?._id?.toString(),
      company: model.company,
      project: model.project,
      modelVersion: model.modelVersion,
      modelType: model.modelType,
      datasetVersion: model.datasetVersion,
      datasetId: model.datasetId?._id?.toString(),
      metrics: model.metrics,
      insights: model.insights,
      storagePath: model.storagePath,
      bestCheckpointPath: model.bestCheckpointPath,
      createdAt: model.createdAt,
      classNames
    };

    // ✅ Check if dataset is deleted
    if (model.datasetId && model.datasetId.deletedAt) {
      response.dataset = {
        datasetId: model.datasetId._id.toString(),
        deleted: true,
        deletedAt: model.datasetId.deletedAt,
        message: 'Dataset has been deleted'
      };
    } else if (model.datasetId) {
      response.dataset = {
        datasetId: model.datasetId._id.toString(),
        company: model.datasetId.company,
        project: model.datasetId.project,
        version: model.datasetId.version,
        status: model.datasetId.status
      };
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('Error getting model:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/models/:modelId/metrics
 * 
 * Get detailed metrics including per-label stats and chart data
 */
const getModelMetrics = async (req, res) => {
  try {
    const { modelId } = req.params;

    if (!modelId) {
      return res.status(400).json({
        error: 'Missing required parameter: modelId'
      });
    }

    // ✅ Find model
    const model = await Model.findOne({ modelId }).lean();

    if (!model) {
      return res.status(404).json({
        error: 'Model not found',
        modelId: modelId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, model.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this model'
        });
      }
    }

    // ✅ Load chart data if available
    let chartData = null;
    if (model.chartDataPath) {
      try {
        const lossCurvePath = path.join(model.chartDataPath, 'loss_curve.json');
        const precisionCurvePath = path.join(model.chartDataPath, 'precision_curve.json');
        const mapCurvePath = path.join(model.chartDataPath, 'map_curve.json');

        const lossCurve = fs.existsSync(lossCurvePath) 
          ? JSON.parse(fs.readFileSync(lossCurvePath, 'utf8'))
          : null;
        const precisionCurve = fs.existsSync(precisionCurvePath)
          ? JSON.parse(fs.readFileSync(precisionCurvePath, 'utf8'))
          : null;
        const mapCurve = fs.existsSync(mapCurvePath)
          ? JSON.parse(fs.readFileSync(mapCurvePath, 'utf8'))
          : null;

        chartData = {
          lossCurve: lossCurve || [],
          precisionCurve: precisionCurve || [],
          mAPCurve: mapCurve || []
        };
      } catch (error) {
        console.warn(`Could not load chart data for model ${modelId}:`, error.message);
        chartData = {
          lossCurve: [],
          precisionCurve: [],
          mAPCurve: []
        };
      }
    }

    // ✅ Format response
    const response = {
      modelId: model.modelId,
      metrics: model.metrics || {},
      chartData: chartData || {
        lossCurve: [],
        precisionCurve: [],
        mAPCurve: []
      }
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error('Error getting model metrics:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/models/:modelId/insights
 * 
 * Get insights and recommendations
 */
const getModelInsights = async (req, res) => {
  try {
    const { modelId } = req.params;

    if (!modelId) {
      return res.status(400).json({
        error: 'Missing required parameter: modelId'
      });
    }

    // ✅ Find model
    const model = await Model.findOne({ modelId }).lean();

    if (!model) {
      return res.status(404).json({
        error: 'Model not found',
        modelId: modelId
      });
    }

    // ✅ Format response
    const response = {
      modelId: model.modelId,
      insights: model.insights || {
        bestAccuracy: null,
        bestmAP: null,
        weakestLabels: [],
        classImbalanceWarnings: [],
        recommendations: []
      }
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error('Error getting model insights:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/models/:modelId/download-url
 * 
 * Get signed download URL for model file
 * Returns URL with expiration (for local storage, returns direct URL)
 */
const getModelDownloadUrl = async (req, res) => {
  try {
    const { modelId } = req.params;
    const { format = 'pt', variant = 'float16' } = req.query;

    if (!modelId) {
      return res.status(400).json({
        error: 'Missing required parameter: modelId'
      });
    }

    // ✅ Find model
    const model = await Model.findOne({ modelId }).lean();

    if (!model) {
      return res.status(404).json({
        error: 'Model not found',
        modelId: modelId
      });
    }

    // ✅ Determine file path based on format
    let filePath;
    let filename;

    if (format === 'pt') {
      filePath = model.bestCheckpointPath || path.join(model.storagePath, 'best.pt');
      filename = `model_${model.modelVersion}.pt`;
    } else if (format === 'onnx') {
      // Check if ONNX export exists
      filePath = path.join(model.storagePath, 'best.onnx');
      filename = `model_${model.modelVersion}.onnx`;
    } else if (format === 'tflite') {
      if (!tfliteConverter.TFLITE_VARIANTS.includes(variant)) {
        return res.status(400).json({
          error: 'Invalid variant',
          message: `variant must be one of: ${tfliteConverter.TFLITE_VARIANTS.join(', ')}`,
          provided: variant
        });
      }
      // On-device inference (mobile app) needs TFLite — bundled or downloaded.
      filePath = tfliteConverter.tflitePath(model, variant);
      filename = `model_${model.modelVersion}_${variant}.tflite`;
    } else if (format === 'zip') {
      // Create zip path (if exists)
      filePath = path.join(model.storagePath, 'model.zip');
      filename = `model_${model.modelVersion}.zip`;
    } else {
      return res.status(400).json({
        error: 'Invalid format',
        message: `Format must be 'pt', 'onnx', 'tflite', or 'zip'`,
        provided: format
      });
    }

    // ✅ For ONNX format, convert if file doesn't exist
    if (format === 'onnx' && !fs.existsSync(filePath)) {
      console.log(`🔄 ONNX file not found, converting from PyTorch model...`);

      const conversionResult = await onnxConverter.getOrCreateOnnx(model);

      if (!conversionResult.success) {
        return res.status(500).json({
          error: 'ONNX conversion failed',
          message: conversionResult.error || 'Failed to convert model to ONNX format',
          modelId: modelId
        });
      }

      // Update filePath to the converted file
      filePath = conversionResult.path;
    }

    // ✅ For TFLite format, convert if the requested variant doesn't exist
    if (format === 'tflite' && !fs.existsSync(filePath)) {
      console.log(`🔄 TFLite (${variant}) not found, converting from PyTorch model...`);

      const conversionResult = await tfliteConverter.getOrCreateTflite(model, variant);

      if (!conversionResult.success) {
        return res.status(500).json({
          error: 'TFLite conversion failed',
          message: conversionResult.error || 'Failed to convert model to TFLite format',
          modelId: modelId
        });
      }

      filePath = conversionResult.path;
    }

    // ✅ Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Model file not found',
        modelId: modelId,
        format: format,
        path: filePath
      });
    }

    // ✅ Get file size
    const fileStats = fs.statSync(filePath);
    const fileSize = fileStats.size;

    // ✅ Generate download URL (for local storage, use direct API endpoint)
    // In production with cloud storage, this would be a signed URL
    const baseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const downloadUrl = format === 'tflite'
      ? `${baseUrl}/api/models/${modelId}/download?format=${format}&variant=${variant}`
      : `${baseUrl}/api/models/${modelId}/download?format=${format}`;

    // ✅ Set expiration (1 hour from now)
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour

    return res.status(200).json({
      downloadUrl: downloadUrl,
      expiresAt: expiresAt.toISOString(),
      fileSize: fileSize,
      ...(format === 'tflite' ? { variant } : {})
    });

  } catch (error) {
    console.error('Error getting model download URL:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/models/:modelId/download
 *
 * Download the model file in specified format (pt, onnx, tflite, or zip)
 *
 * Query params:
 * - format (optional): File format - 'pt', 'onnx', 'tflite', or 'zip' (default: 'pt')
 * - variant (optional, tflite only): 'float16' or 'float32' (default: 'float16')
 */
const downloadModel = async (req, res) => {
  try {
    const { modelId } = req.params;
    const { format = 'pt', variant = 'float16' } = req.query;

    if (!modelId) {
      return res.status(400).json({
        error: 'Missing required parameter: modelId'
      });
    }

    // ✅ Find model
    const model = await Model.findOne({ modelId }).lean();

    if (!model) {
      return res.status(404).json({
        error: 'Model not found',
        modelId: modelId
      });
    }

    // ✅ Determine file path based on format
    let filePath;
    let filename;

    if (format === 'pt') {
      filePath = model.bestCheckpointPath || path.join(model.storagePath, 'best.pt');
      filename = `model_${model.modelVersion}.pt`;
    } else if (format === 'onnx') {
      filePath = path.join(model.storagePath, 'best.onnx');
      filename = `model_${model.modelVersion}.onnx`;

      // ✅ Convert to ONNX if file doesn't exist
      if (!fs.existsSync(filePath)) {
        console.log(`🔄 ONNX file not found, converting from PyTorch model...`);

        const conversionResult = await onnxConverter.getOrCreateOnnx(model);

        if (!conversionResult.success) {
          return res.status(500).json({
            error: 'ONNX conversion failed',
            message: conversionResult.error || 'Failed to convert model to ONNX format',
            modelId: modelId
          });
        }

        // Update filePath to the converted file
        filePath = conversionResult.path;
      }
    } else if (format === 'tflite') {
      if (!tfliteConverter.TFLITE_VARIANTS.includes(variant)) {
        return res.status(400).json({
          error: 'Invalid variant',
          message: `variant must be one of: ${tfliteConverter.TFLITE_VARIANTS.join(', ')}`,
          provided: variant
        });
      }
      filePath = tfliteConverter.tflitePath(model, variant);
      filename = `model_${model.modelVersion}_${variant}.tflite`;

      // ✅ Convert to TFLite if the requested variant doesn't exist
      if (!fs.existsSync(filePath)) {
        console.log(`🔄 TFLite (${variant}) not found, converting from PyTorch model...`);

        const conversionResult = await tfliteConverter.getOrCreateTflite(model, variant);

        if (!conversionResult.success) {
          return res.status(500).json({
            error: 'TFLite conversion failed',
            message: conversionResult.error || 'Failed to convert model to TFLite format',
            modelId: modelId
          });
        }

        filePath = conversionResult.path;
      }
    } else if (format === 'zip') {
      filePath = path.join(model.storagePath, 'model.zip');
      filename = `model_${model.modelVersion}.zip`;
    } else {
      return res.status(400).json({
        error: 'Invalid format',
        message: `Format must be 'pt', 'onnx', 'tflite', or 'zip'`,
        provided: format
      });
    }

    // ✅ Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Model file not found',
        modelId: modelId,
        format: format,
        path: filePath
      });
    }

    // ✅ Set headers for file download
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // ✅ Stream file to response
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('Error streaming model file:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Error reading model file',
          message: error.message
        });
      }
    });

  } catch (error) {
    console.error('Error downloading model:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    }
  }
};

/**
 * GET /api/models/:modelId/checkpoints
 * 
 * List all checkpoints for a model
 */
const listCheckpoints = async (req, res) => {
  try {
    const { modelId } = req.params;

    if (!modelId) {
      return res.status(400).json({
        error: 'Missing required parameter: modelId'
      });
    }

    // ✅ Find model
    const model = await Model.findOne({ modelId }).lean();

    if (!model) {
      return res.status(404).json({
        error: 'Model not found',
        modelId: modelId
      });
    }

    // ✅ Get checkpoints from training job
    const trainingJob = await TrainingJob.findById(model.jobId).select('checkpoints').lean();

    if (!trainingJob) {
      return res.status(404).json({
        error: 'Training job not found',
        modelId: modelId
      });
    }

    // ✅ Format checkpoints
    const checkpoints = (trainingJob.checkpoints || []).map(checkpoint => ({
      epoch: checkpoint.epoch,
      path: checkpoint.path,
      isBest: checkpoint.isBest,
      metrics: checkpoint.metrics,
      savedAt: checkpoint.savedAt
    }));

    return res.status(200).json({
      modelId: model.modelId,
      checkpoints: checkpoints,
      total: checkpoints.length
    });

  } catch (error) {
    console.error('Error listing checkpoints:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * DELETE /api/models/:modelId
 * 
 * Delete trained model and its files (storage + MongoDB document)
 */
const deleteModel = async (req, res) => {
  try {
    const { modelId } = req.params;

    if (!modelId) {
      return res.status(400).json({
        error: 'Missing required parameter: modelId'
      });
    }

    // ✅ Find model
    const model = await Model.findOne({ modelId });

    if (!model) {
      return res.status(404).json({
        error: 'Model not found',
        modelId: modelId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, model.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this model'
        });
      }
    }

    // ✅ Delete storage folder from disk if it exists
    // The storagePath contains the entire model directory with checkpoints, charts, etc.
    if (model.storagePath && fs.existsSync(model.storagePath)) {
      try {
        // Use fs.rmSync with recursive option (Node.js 14+)
        // This deletes the entire model directory including:
        // - best.pt checkpoint file
        // - chart data (loss_curve.json, precision_curve.json, etc.)
        // - any other files in the model directory
        fs.rmSync(model.storagePath, { recursive: true, force: true });
        console.log(`✅ Deleted model storage folder: ${model.storagePath}`);
      } catch (error) {
        console.warn(`⚠️ Could not delete model storage folder: ${error.message}`);
        // Continue with MongoDB deletion even if file deletion fails
      }
    }

    // ✅ Delete chart data folder if it's separate from storagePath
    if (model.chartDataPath && model.chartDataPath !== model.storagePath && fs.existsSync(model.chartDataPath)) {
      try {
        fs.rmSync(model.chartDataPath, { recursive: true, force: true });
        console.log(`✅ Deleted chart data folder: ${model.chartDataPath}`);
      } catch (error) {
        console.warn(`⚠️ Could not delete chart data folder: ${error.message}`);
        // Continue with MongoDB deletion even if file deletion fails
      }
    }

    // ✅ Delete MongoDB document
    await Model.deleteOne({ modelId });

    return res.status(200).json({
      modelId: modelId,
      message: 'Model and files deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting model:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

module.exports = {
  listModels,
  getModel,
  getModelMetrics,
  getModelInsights,
  getModelDownloadUrl,
  downloadModel,
  listCheckpoints,
  deleteModel
};

