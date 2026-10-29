const Dataset = require('../models/Dataset');
const TrainingJob = require('../models/TrainingJob');

/**
 * Training Service - Helper functions for training operations
 * 
 * This service provides reusable functions for:
 * - Validating datasets for training
 * - Generating job IDs
 * - Getting default hyperparameters
 * - Computing progress percentages
 */

/**
 * Resolve the active dataset for a company/project. Training must use this dataset.
 * @param {string} company - Company id
 * @param {string} project - Project id
 * @returns {Promise<{dataset?: object, error?: string}>}
 */
async function resolveActiveDataset(company, project) {
  try {
    const dataset = await Dataset.findOne({ company, project, isActive: true });
    if (!dataset) {
      return {
        error: 'No active dataset for this project. Run preprocessing, annotation, or augmentation first, or set an active dataset.'
      };
    }
    return { dataset };
  } catch (err) {
    return { error: err.message || 'Failed to resolve active dataset' };
  }
}

/**
 * Validate if a dataset is ready for training
 * @param {string} datasetId - MongoDB ObjectId of the dataset
 * @returns {Promise<{valid: boolean, error?: string, dataset?: object}>}
 */
async function validateDatasetForTraining(datasetId) {
  try {
    // Check if dataset exists
    const dataset = await Dataset.findById(datasetId);
    
    if (!dataset) {
      return {
        valid: false,
        error: 'Dataset not found'
      };
    }

    // Check if dataset status is 'ready' or 'ready_to_train'
    // 'ready' = dataset from preprocessing (labeled data upload)
    // 'ready_to_train' = dataset from annotation workflow (unlabeled data → annotated → converted)
    if (dataset.status !== 'ready' && dataset.status !== 'ready_to_train') {
      return {
        valid: false,
        error: `Dataset is not ready for training. Current status: ${dataset.status}`,
        dataset: dataset
      };
    }

    // Check if dataset has training images
    if (dataset.trainCount === 0) {
      return {
        valid: false,
        error: 'Dataset has no training images. Please ensure dataset preprocessing completed successfully.',
        dataset: dataset
      };
    }

    // All checks passed
    return {
      valid: true,
      dataset: dataset
    };

  } catch (error) {
    return {
      valid: false,
      error: `Error validating dataset: ${error.message}`
    };
  }
}

/**
 * Generate a unique job ID
 * @returns {string} Unique job identifier
 */
function generateJobId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 11); // 9 random chars
  return `job_${timestamp}_${random}`;
}

/**
 * Get default hyperparameters based on model type
 * @param {string} modelType - Model type ('YOLO')
 * @returns {object} Default hyperparameters
 */
function getDefaultHyperparameters(modelType) {
  const defaults = {
    YOLO: {
      epochs: 20,
      batchSize: 8,
      imgSize: 416,
      learningRate: 0.01,
      workers: 2
    },
    YOLO_SEG: {
      epochs: 20,
      batchSize: 8,
      imgSize: 416,
      learningRate: 0.01,
      workers: 2
    },
    RF_DETR: {
      epochs: 50,
      batchSize: 4,
      imgSize: 384,
      learningRate: 0.0001,
      workers: 2
    }
  };

  // Return defaults for the model type, or YOLO defaults as fallback
  return defaults[modelType] || defaults.YOLO;
}

/**
 * Merge user-provided hyperparameters with defaults
 * @param {string} modelType - Model type
 * @param {object} userHyperparameters - User-provided hyperparameters (partial or full)
 * @returns {object} Merged hyperparameters
 */
function mergeHyperparameters(modelType, userHyperparameters = {}) {
  const defaults = getDefaultHyperparameters(modelType);
  
  return {
    epochs: userHyperparameters.epochs ?? defaults.epochs,
    batchSize: userHyperparameters.batchSize ?? defaults.batchSize,
    imgSize: userHyperparameters.imgSize ?? defaults.imgSize,
    learningRate: userHyperparameters.learningRate ?? defaults.learningRate,
    workers: userHyperparameters.workers ?? defaults.workers
  };
}

/**
 * Compute progress percentage
 * @param {number} currentEpoch - Current epoch number
 * @param {number} totalEpochs - Total number of epochs
 * @returns {number} Progress percentage (0-100)
 */
function computeProgressPercent(currentEpoch, totalEpochs) {
  if (totalEpochs === 0) return 0;
  const percent = Math.round((currentEpoch / totalEpochs) * 100);
  return Math.min(100, Math.max(0, percent)); // Clamp between 0 and 100
}

/**
 * Progress for PyTorch Lightning / RF-DETR tqdm lines (0-based epoch + batch step).
 * @param {number} epochIndex - 0-based epoch from log (Epoch 0, Epoch 1, ...)
 * @param {number} totalEpochs - Total training epochs from hyperparameters
 * @param {number} currentStep - Current batch step within epoch
 * @param {number} totalSteps - Total batch steps within epoch
 */
function computeProgressPercentWithBatch(epochIndex, totalEpochs, currentStep, totalSteps) {
  if (!totalEpochs || totalEpochs <= 0) return 0;
  const stepsInEpoch = totalSteps > 0 ? Math.min(1, currentStep / totalSteps) : 0;
  const fraction = (epochIndex + stepsInEpoch) / totalEpochs;
  return Math.min(100, Math.max(0, Math.round(fraction * 100)));
}

/**
 * Validate hyperparameters
 * @param {object} hyperparameters - Hyperparameters to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateHyperparameters(hyperparameters) {
  const errors = [];

  if (hyperparameters.epochs !== undefined) {
    if (typeof hyperparameters.epochs !== 'number' || hyperparameters.epochs < 1 || hyperparameters.epochs > 1000) {
      errors.push('epochs must be a number between 1 and 1000');
    }
  }

  if (hyperparameters.batchSize !== undefined) {
    if (typeof hyperparameters.batchSize !== 'number' || hyperparameters.batchSize < 1 || hyperparameters.batchSize > 128) {
      errors.push('batchSize must be a number between 1 and 128');
    }
  }

  if (hyperparameters.imgSize !== undefined) {
    if (typeof hyperparameters.imgSize !== 'number' || hyperparameters.imgSize < 128 || hyperparameters.imgSize > 2048) {
      errors.push('imgSize must be a number between 128 and 2048');
    }
  }

  if (hyperparameters.learningRate !== undefined) {
    if (typeof hyperparameters.learningRate !== 'number' || hyperparameters.learningRate < 0.0001 || hyperparameters.learningRate > 1.0) {
      errors.push('learningRate must be a number between 0.0001 and 1.0');
    }
  }

  if (hyperparameters.workers !== undefined) {
    if (typeof hyperparameters.workers !== 'number' || hyperparameters.workers < 1 || hyperparameters.workers > 16) {
      errors.push('workers must be a number between 1 and 16');
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      error: errors.join('; ')
    };
  }

  return { valid: true };
}

/**
 * Check if a training job can be cancelled
 * @param {string} status - Current job status
 * @returns {boolean} True if job can be cancelled
 */
function canCancelJob(status) {
  return status === 'queued' || status === 'running';
}

/**
 * Check if a training job can be retried
 * @param {string} status - Current job status
 * @returns {boolean} True if job can be retried
 */
function canRetryJob(status) {
  return status === 'failed' || status === 'cancelled';
}

/**
 * Find a job that is actually live (queued/running with a recent heartbeat).
 * Ignores months-old leftover "running"/"queued" rows in Mongo.
 */
const LIVE_TRAINING_WINDOW_MS = 10 * 60 * 1000;

async function findLiveTrainingJob(company) {
  const cutoff = new Date(Date.now() - LIVE_TRAINING_WINDOW_MS);
  return TrainingJob.findOne({
    ...(company ? { company } : {}),
    status: { $in: ['queued', 'running'] },
    $or: [
      { createdAt: { $gte: cutoff } },
      { updatedAt: { $gte: cutoff } }
    ]
  })
    .select('jobId status company project datasetId modelType modelSize requestedModelVersion')
    .sort({ updatedAt: -1 })
    .lean();
}

module.exports = {
  resolveActiveDataset,
  validateDatasetForTraining,
  generateJobId,
  getDefaultHyperparameters,
  mergeHyperparameters,
  computeProgressPercent,
  computeProgressPercentWithBatch,
  validateHyperparameters,
  canCancelJob,
  canRetryJob,
  findLiveTrainingJob
};

