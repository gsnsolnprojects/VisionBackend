// workers/trainingWorker.js
const dns = require('dns');

dns.setServers(['8.8.8.8', '1.1.1.1']);
const path = require('path');
require('dotenv').config({
  path: path.resolve(process.cwd(), '.env'),
});
 // load .env so process.env.MONGO_URI is available
 console.log('🧪 Worker ENV check:', {
  MONGO_URI: process.env.MONGO_URI ? 'FOUND' : 'MISSING',
  REDIS_HOST: process.env.REDIS_HOST || 'LOCAL',
});


    

const mongoose = require('mongoose');
const fs = require('fs');
const fsPromises = require('fs').promises;
const Bull = require('bull');
const { BlobServiceClient } = require('@azure/storage-blob');
const os = require('os');

const redisConfig = process.env.REDIS_HOST
  ? {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6380),
      password: process.env.REDIS_PASSWORD,
      username: null,
      tls: {},
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    }
  : {
      host: '127.0.0.1',
      port: 6379,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    };
    const trainingQueue = new Bull('train-model', {
      redis: redisConfig,
    });


const { spawn } = require('child_process');

const TrainingJob = require('../models/TrainingJob');
const Dataset = require('../models/Dataset');
const Model = require('../models/Model');
const storageAdapter = require('../services/storageAdapter');
const trainingService = require('../services/trainingService');
const {
  parseYoloAllMetricsLine,
  readBestMetricsFromResultsCsv,
  resultsCsvPath,
  buildFinalMetrics,
  formatMetric,
} = require('../utils/yoloTrainingMetrics');
const {
  ingestTrainingStreamChunk,
  flushTrainingStreamBuffer,
  appendTrainingLog: appendNormalizedTrainingLog,
  appendTrainingLogText
} = require('../services/trainingLogIngestion');

const AUGMENTATION_PRESETS = {
  none: {},
  color_invariant: {
    hsv_h: 0.0,
    hsv_s: 0.0,
    hsv_v: 0.6,
    mixup: 0.1
  },
  small_defect: {
    mosaic: 1.0,
    mixup: 0.2,
    scale: 0.5
  },
  low_light: {
    hsv_v: 0.8
  },
  robust: {
    hsv_s: 0.5,
    hsv_v: 0.5,
    fliplr: 0.5,
    mosaic: 1.0,
    mixup: 0.2
  }
};

/** Max log lines retained in MongoDB per training job */
const MAX_STORED_TRAINING_LOG_LINES = 300;

/** Append via shared ingestion (normalize, truncate, 300-line cap). */
function appendTrainingLog(logs, line, persistedLogIndexRef, options = {}) {
  appendNormalizedTrainingLog(logs, line, persistedLogIndexRef, MAX_STORED_TRAINING_LOG_LINES, options);
}

function estimatePersistPayloadBytes(newLogLines, fieldsToSet) {
  const logBytes = newLogLines.reduce(
    (sum, entry) => sum + Buffer.byteLength(String(entry), 'utf8'),
    0
  );
  const metaBytes = Buffer.byteLength(JSON.stringify(fieldsToSet), 'utf8');
  return logBytes + metaBytes;
}

/**
 * Persist progress/metrics/status via $set and new log lines via $push (not full-document rewrite).
 */
async function persistTrainingJobState({
  jobId,
  jobObjectId,
  logs,
  persistedLogIndexRef,
  progress,
  metrics,
  status,
  extraSet = {}
}) {
  const newLogLines = logs.slice(persistedLogIndexRef.value);
  const fieldsToSet = {
    progress,
    metrics,
    status,
    ...extraSet
  };

  const update = { $set: fieldsToSet };
  if (newLogLines.length > 0) {
    update.$push = {
      logs: {
        $each: newLogLines,
        $slice: -MAX_STORED_TRAINING_LOG_LINES
      }
    };
  }

  const payloadBytes = estimatePersistPayloadBytes(newLogLines, fieldsToSet);
  const saveStarted = Date.now();

  const result = await TrainingJob.updateOne({ _id: jobObjectId }, update);
  const durationMs = Date.now() - saveStarted;

  if (result.matchedCount === 0) {
    console.warn(`⚠️  Training job ${jobId} not found in DB (persist skipped)`);
    return { ok: false, durationMs, payloadBytes, newLogLineCount: newLogLines.length };
  }

  if (newLogLines.length > 0) {
    persistedLogIndexRef.value = logs.length;
  }

  console.log(
    `💾 Training job ${jobId} persisted in ${durationMs}ms ` +
      `(newLogLines=${newLogLines.length}, payload≈${payloadBytes} bytes, matched=${result.matchedCount})`
  );

  return { ok: true, durationMs, payloadBytes, newLogLineCount: newLogLines.length };
}

/**
 * Training Worker - Background Job Processor
 * 
 * This worker runs separately from the main API server and processes
 * training jobs by:
 * - Spawning Python training processes
 * - Streaming logs and parsing metrics
 * - Saving checkpoints
 * - Computing final metrics
 * - Registering trained models
 * 
 * Why run this in a worker?
 * - Training can take hours (keeps API responsive)
 * - Can run on separate machines/containers with GPU
 * - Can process multiple training jobs in parallel
 * - Jobs can be retried if they fail
 */

/**
 * Normalize modelSize into { version, size, explicitVersion }.
 * Accepts: "n", "v5n", "v8n", "v11s", "v26n", "base-v26n".
 */
function parseModelSize(modelSize = 'n') {
  const raw = String(modelSize).trim().replace(/^base-/, '');
  const versionMatch = raw.match(/^v?(5|8|11|26)([nsmlx])$/i);
  if (versionMatch) {
    return {
      version: versionMatch[1],
      size: versionMatch[2].toLowerCase(),
      explicitVersion: true
    };
  }

  const sizeMatch = raw.match(/^([nsmlx])$/i);
  if (sizeMatch) {
    return {
      version: null,
      size: sizeMatch[1].toLowerCase(),
      explicitVersion: false
    };
  }

  return {
    version: null,
    size: raw,
    explicitVersion: false
  };
}

/**
 * Resolve model size from modelKey (e.g., "base-v5n" -> "v5n").
 */
function parseModelKey(modelKey) {
  if (!modelKey) return null;
  const raw = String(modelKey).trim();
  const match = raw.match(/^base-v(5|8|11|26)([nsmlx])(-seg)?$/i);
  if (!match) return null;
  return {
    sizeToken: `v${match[1]}${match[2].toLowerCase()}`,
    isSeg: Boolean(match[3])
  };
}

/**
 * Get base model path for YOLO training
 * @param {string} modelType - Model type (YOLO)
 * @param {string} modelSize - Optional model size (n, s, m, l) - defaults to 'n' for YOLO
 * @returns {string} Path to base model file
 */
function getBaseModelPath(modelType, modelSize = 'n', modelKey = null) {
  if (modelType === 'YOLO' || modelType === 'YOLO_SEG') {
    const baseModelsDir = path.join(process.cwd(), 'models', 'base');
    const isSegModel = modelType === 'YOLO_SEG';

    const keyInfo = parseModelKey(modelKey);
    const keyResolvedSize = keyInfo?.sizeToken || null;
    const resolvedModelSize = keyResolvedSize || modelSize;
    const { version, size, explicitVersion } = parseModelSize(resolvedModelSize);
    const suffix = isSegModel ? '-seg' : '';

    const makePath = (name) => path.join(baseModelsDir, name);
    const candidates = [];

    if (explicitVersion && version) {
      if (version === '26') {
        candidates.push(makePath(`yolov26${size}${suffix}.pt`), makePath(`yolo26${size}${suffix}.pt`));
      } else {
        candidates.push(makePath(`yolov${version}${size}${suffix}.pt`));
      }
    } else {
      // Prefer YOLOv26 (newest), then YOLOv11, then YOLOv8, then YOLOv5
      candidates.push(
        makePath(`yolov26${size}${suffix}.pt`),
        makePath(`yolo26${size}${suffix}.pt`),
        makePath(`yolov11${size}${suffix}.pt`),
        makePath(`yolov8${size}${suffix}.pt`),
        makePath(`yolov5${size}${suffix}.pt`)
      );
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // Fallback: return model name (YOLO will download if not found)
    console.warn(`⚠️  Base model not found locally: ${candidates.join(', ')}`);
    console.warn(`⚠️  YOLO will download it automatically (slower). Run: npm run download-models`);
    return `yolov8${size}${suffix}.pt`; // YOLO will download from internet (default to v8)
  }

  // For other model types, return null (let Python script handle it)
  return null;
}

/**
 * Download base model from Azure Blob Storage for a training job
 * @param {string} jobId - Training job ID
 * @param {string} modelSize - Model size (n, s, m, l, x)
 * @param {object} logger - Logger object (defaults to console)
 * @returns {Promise<{localModelPath: string, jobTempDir: string}>} Local model path and temp directory
 */
async function downloadBaseModelForJob({ jobId, modelType = 'YOLO', modelSize, modelKey = null, logger = console }) {
  // Validate inputs
  if (!jobId) {
    throw new Error('jobId is required');
  }
  if (!modelSize) {
    throw new Error('modelSize is required');
  }

  // Get Azure Storage connection string
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING environment variable is required');
  }

  // Initialize Blob Service Client
  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerName = 'models';
  const isSegModel = modelType === 'YOLO_SEG';
  const suffix = isSegModel ? '-seg' : '';
  const keyInfo = parseModelKey(modelKey);
  const keyResolvedSize = keyInfo?.sizeToken || null;
  const resolvedModelSize = keyResolvedSize || modelSize;
  const { version, size, explicitVersion } = parseModelSize(resolvedModelSize);
  const blobCandidates = explicitVersion && version
    ? (version === '26'
      ? [`base/yolov26${size}${suffix}.pt`, `base/yolo26${size}${suffix}.pt`]
      : [`base/yolov${version}${size}${suffix}.pt`]
    )
    : [
      `base/yolov26${size}${suffix}.pt`,
      `base/yolo26${size}${suffix}.pt`,
      `base/yolov11${size}${suffix}.pt`,
      `base/yolov8${size}${suffix}.pt`,
      `base/yolov5${size}${suffix}.pt`
    ];

  // Create job-specific temp directory
  const jobTempDir = path.join(process.cwd(), 'uploads', 'training-temp', jobId);
  const localModelPath = path.join(jobTempDir, 'base.pt');

  try {
    // Ensure temp directory exists
    await fsPromises.mkdir(jobTempDir, { recursive: true });
    logger.log(`✅ Created temp directory: ${jobTempDir}`);

    // Get blob client
    const containerClient = blobServiceClient.getContainerClient(containerName);

    let selectedBlobName = null;
    for (const candidate of blobCandidates) {
      const candidateClient = containerClient.getBlobClient(candidate);
      if (await candidateClient.exists()) {
        selectedBlobName = candidate;
        break;
      }
    }

    if (!selectedBlobName) {
      throw new Error(`Base model blob not found. Tried: ${blobCandidates.join(', ')}`);
    }

    const blobClient = containerClient.getBlobClient(selectedBlobName);
    logger.log(`📥 Downloading base model from Azure Blob: ${containerName}/${selectedBlobName}`);

    // Download blob
    const downloadResponse = await blobClient.download();
    if (!downloadResponse.readableStreamBody) {
      throw new Error('Failed to get download stream from blob');
    }

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    // Verify downloaded file size
    if (fileBuffer.length === 0) {
      throw new Error('Downloaded file is empty');
    }

    // Write file to local path
    await fsPromises.writeFile(localModelPath, fileBuffer);
    logger.log(`✅ Downloaded base model (${(fileBuffer.length / (1024 * 1024)).toFixed(2)} MB) to: ${localModelPath}`);

    // Verify file was written successfully
    const stats = await fsPromises.stat(localModelPath);
    if (stats.size === 0) {
      throw new Error('Downloaded file size is 0 after write');
    }

    return {
      localModelPath,
      jobTempDir
    };

  } catch (error) {
    // Clean up temp directory on error
    try {
      await fsPromises.rmdir(jobTempDir, { recursive: true });
    } catch (cleanupError) {
      logger.warn(`⚠️ Failed to clean up temp directory: ${cleanupError.message}`);
    }
    throw new Error(`Failed to download base model: ${error.message}`);
  }
}

/**
 * Generate YOLO training config file
 * @param {object} hyperparameters - Training hyperparameters
 * @param {string} datasetPath - Path to dataset directory
 * @param {string} outputPath - Path where config will be saved
 * @param {string} modelType - Model type (YOLO)
 * @param {string} modelSize - Optional model size (n, s, m, l) - defaults to 'n'
 * @returns {Promise<string>} Path to generated config file
 */
async function generateTrainingConfig(
  hyperparameters,
  datasetPath,
  outputPath,
  modelType,
  modelSize = 'n',
  modelPath = null,
  modelKey = null,
  augmentationPreset = 'none'
) {
  const dataYamlPath = path.join(datasetPath, 'data.yaml');
  
  // ✅ Check if data.yaml already exists with category names (from convertAnnotationsToYOLO)
  let dataYaml = null;
  let hasExistingNames = false;
  
  try {
    const existingContent = await fsPromises.readFile(dataYamlPath, 'utf8');
    // Check if it has names section with actual names (not empty)
    if (existingContent.includes('names:') && !existingContent.includes('names: []')) {
      hasExistingNames = true;
      console.log('✅ Found existing data.yaml with category names, preserving them');
      // Keep the existing content - Python script will update nc and preserve names
      dataYaml = existingContent;
    }
  } catch (error) {
    // File doesn't exist or can't be read, will create new one
  }
  
  // ✅ Create new data.yaml only if it doesn't exist or has no names
  if (!dataYaml) {
    dataYaml = `# YOLO Dataset Configuration
path: ${datasetPath}
train: images/train
val: images/val
test: images/test

# Number of classes (will be updated by Python script)
nc: 0

# Class names (will be updated by Python script)
names: []
`;
  }

  await fsPromises.writeFile(dataYamlPath, dataYaml, 'utf8');

  // ✅ Use provided modelPath (trained model checkpoint) or get base model path
  const finalModelPath = modelPath || getBaseModelPath(modelType, modelSize, modelKey);
  const augmentation = AUGMENTATION_PRESETS[augmentationPreset] || {};

  // Create training config
  const config = {
    epochs: hyperparameters.epochs,
    batch: hyperparameters.batchSize,
    imgsz: hyperparameters.imgSize,
    lr0: hyperparameters.learningRate,
    workers: hyperparameters.workers,
    data: dataYamlPath,
    project: path.join(path.dirname(outputPath), 'runs'),
    name: 'train',
    exist_ok: true,
    task: modelType === 'YOLO_SEG' ? 'segment' : 'detect',
    ...augmentation
  };

  // Add model path if available (for YOLO)
  if (finalModelPath) {
    config.model = finalModelPath; // YOLO uses 'model' parameter for pretrained weights
  }

  // Write config as JSON (Python script will read it)
  const configJson = JSON.stringify(config, null, 2);
  await fsPromises.writeFile(outputPath, configJson, 'utf8');

  console.log(`✅ Generated training config at: ${outputPath}`);
  if (finalModelPath) {
    if (modelPath) {
      console.log(`✅ Using trained model checkpoint: ${finalModelPath}`);
    } else if (fs.existsSync(finalModelPath)) {
      console.log(`✅ Using local base model: ${finalModelPath}`);
    }
  }
  return outputPath;
}

/**
 * Run a Python helper script and wait for exit code 0.
 */
function runPythonScript(scriptPath, args, cwd) {
  const pythonBin = process.env.TRAIN_PYTHON_BIN || process.env.PYTHON || 'python';
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ['-u', scriptPath, ...args], {
      cwd: cwd || path.dirname(scriptPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Python exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

/**
 * Convert Ultralytics dataset layout to RF-DETR layout in job temp dir.
 */
async function prepareRfdetrDatasetForJob(datasetPath, jobId) {
  const jobTempDir = path.join(process.cwd(), 'uploads', 'training-temp', jobId);
  const rfdetrDatasetPath = path.join(jobTempDir, 'rfdetr-dataset');
  const scriptPath = path.join(__dirname, '../training-scripts/prepare_rfdetr_dataset.py');
  await fsPromises.mkdir(jobTempDir, { recursive: true });
  console.log(`📂 Preparing RF-DETR dataset adapter: ${rfdetrDatasetPath}`);
  await runPythonScript(
    scriptPath,
    ['--source', datasetPath, '--output', rfdetrDatasetPath],
    path.join(__dirname, '../training-scripts')
  );
  return rfdetrDatasetPath;
}

/**
 * Generate RF-DETR training config JSON.
 */
async function generateRfdetrTrainingConfig(
  hyperparameters,
  rfdetrDatasetPath,
  outputPath,
  modelStoragePath,
  modelPath = null
) {
  const outputDir = path.join(modelStoragePath, 'rfdetr-output');
  await fsPromises.mkdir(outputDir, { recursive: true });

  let resume = null;
  let pretrain_weights = null;
  if (modelPath && fs.existsSync(modelPath)) {
    const checkpointPth = path.join(path.dirname(modelPath), 'checkpoint.pth');
    if (fs.existsSync(checkpointPth)) {
      resume = checkpointPth;
    } else {
      pretrain_weights = modelPath;
    }
  }

  const config = {
    dataset_dir: rfdetrDatasetPath,
    output_dir: outputDir,
    epochs: hyperparameters.epochs,
    batch_size: hyperparameters.batchSize,
    grad_accum_steps: 4,
    lr: hyperparameters.learningRate,
    resolution: hyperparameters.imgSize,
    skip_best_epochs: 3,
    device: process.env.RFDETR_DEVICE || 'cuda',
    resume,
    pretrain_weights
  };

  await fsPromises.writeFile(outputPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`✅ Generated RF-DETR training config at: ${outputPath}`);
  return outputPath;
}

/**
 * Parse log line for metrics
 * @param {string} logLine - Log line from training output
 * @returns {object|null} Parsed metrics or null
 */
function parseLogLine(logLine) {
  const metrics = {};

  // YOLO_SEG epoch: "98/100 1.87G box_loss seg_loss cls_loss dfl_loss sem_loss instances size"
  const yoloSegEpochMatch = logLine.match(
    /(\d+)\/(\d+)\s+[\d.]+G\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)/
  );
  if (yoloSegEpochMatch) {
    metrics.currentEpoch = parseInt(yoloSegEpochMatch[1], 10);
    metrics.totalEpochs = parseInt(yoloSegEpochMatch[2], 10);
    const boxLoss = parseFloat(yoloSegEpochMatch[3]);
    const segLoss = parseFloat(yoloSegEpochMatch[4]);
    const clsLoss = parseFloat(yoloSegEpochMatch[5]);
    const dflLoss = parseFloat(yoloSegEpochMatch[6]);
    metrics.currentLoss = boxLoss + segLoss + clsLoss + dflLoss;
  } else {
    // YOLO detect epoch: "1/20 0.438G box_loss cls_loss dfl_loss"
    const yoloEpochLineMatch = logLine.match(/\s*(\d+)\/(\d+)\s+[\d.]+G\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (yoloEpochLineMatch) {
      metrics.currentEpoch = parseInt(yoloEpochLineMatch[1], 10);
      metrics.totalEpochs = parseInt(yoloEpochLineMatch[2], 10);
      const boxLoss = parseFloat(yoloEpochLineMatch[3]);
      const clsLoss = parseFloat(yoloEpochLineMatch[4]);
      const dflLoss = parseFloat(yoloEpochLineMatch[5]);
      metrics.currentLoss = boxLoss + clsLoss + dflLoss;
    } else {
    // ✅ RF-DETR / PyTorch Lightning tqdm: "Epoch 0: 66%|...| 142/216 [..., train/lr=0.0001]"
    const ptlEpochColonMatch = logLine.match(/Epoch\s+(\d+)\s*:/i);
    if (ptlEpochColonMatch) {
      const epochIndex = parseInt(ptlEpochColonMatch[1], 10);
      metrics.ptlEpochIndex = epochIndex;
      // 1-based epoch for UI parity with YOLO "1/50" style displays
      metrics.currentEpoch = epochIndex + 1;

      const ptlStepMatch = logLine.match(/(\d+)\/(\d+)\s*\[/);
      if (ptlStepMatch) {
        metrics.currentStep = parseInt(ptlStepMatch[1], 10);
        metrics.totalSteps = parseInt(ptlStepMatch[2], 10);
      }

      const ptlPercentMatch = logLine.match(/Epoch\s+\d+\s*:\s*(\d+)%/i);
      if (ptlPercentMatch) {
        metrics.epochProgressPercent = parseInt(ptlPercentMatch[1], 10);
      }
    } else {
      // ✅ Fallback: Parse epoch: "Epoch 25/100" (with "Epoch" word - more specific)
      const epochMatch = logLine.match(/Epoch\s+(\d+)\/(\d+)/i);
      if (epochMatch) {
        metrics.currentEpoch = parseInt(epochMatch[1]);
        metrics.totalEpochs = parseInt(epochMatch[2]);
      }
    }
    }
  }

  // ✅ PyTorch Lightning: train/loss=0.42, val/loss=0.38
  const trainLossMatch = logLine.match(/train\/loss=([\d.e+-]+)/i);
  if (trainLossMatch) {
    metrics.currentLoss = parseFloat(trainLossMatch[1]);
  }

  // ✅ Parse loss: "loss=0.45" or "train_loss=0.45" (fallback for other formats)
  const lossMatch = logLine.match(/(?:^|,\s*)(?:train_)?loss[:\s=]+([\d.e+-]+)/i);
  if (lossMatch && metrics.currentLoss === undefined) {
    metrics.currentLoss = parseFloat(lossMatch[1]);
  }

  // ✅ Parse learning rate: lr=, train/lr=, etc.
  const lrMatch = logLine.match(/(?:train\/|val\/)?lr[:\s=]+([\d.e+-]+)/i);
  if (lrMatch) {
    metrics.currentLR = parseFloat(lrMatch[1]);
  }

  // ✅ YOLO val table: detect (6 numbers) or YOLO_SEG (10 numbers = box + mask)
  const yoloAll = parseYoloAllMetricsLine(logLine);
  if (yoloAll) {
    metrics.precision = yoloAll.precision;
    metrics.recall = yoloAll.recall;
    metrics.mAP50 = yoloAll.mAP50;
    metrics.mAP50_95 = yoloAll.mAP50_95;
  }

  // ✅ Fallback: Parse mAP50: "mAP50=0.72" or "mAP@0.5=0.72"
  const map50Match = logLine.match(/mAP(?:@|50)[:\s=]+([\d.]+)/i);
  if (map50Match && metrics.mAP50 === undefined) {
    metrics.mAP50 = parseFloat(map50Match[1]);
  }

  // ✅ Fallback: Parse mAP50-95: "mAP50-95=0.58" or "mAP@0.5:0.95=0.58"
  const map50_95Match = logLine.match(/mAP(?:50-95|@0\.5:0\.95)[:\s=]+([\d.]+)/i);
  if (map50_95Match && metrics.mAP50_95 === undefined) {
    metrics.mAP50_95 = parseFloat(map50_95Match[1]);
  }

  // ✅ Fallback: Parse precision: "precision=0.85"
  const precisionMatch = logLine.match(/precision[:\s=]+([\d.]+)/i);
  if (precisionMatch && metrics.precision === undefined) {
    metrics.precision = parseFloat(precisionMatch[1]);
  }

  // ✅ Fallback: Parse recall: "recall=0.78"
  const recallMatch = logLine.match(/recall[:\s=]+([\d.]+)/i);
  if (recallMatch && metrics.recall === undefined) {
    metrics.recall = parseFloat(recallMatch[1]);
  }

  return Object.keys(metrics).length > 0 ? metrics : null;
}

/**
 * Process a single training job
 */
const processTrainingJob = async (job) => {
  const {
    jobId,
    datasetId,
    company,
    project,
    modelType,
    modelSize = 'n',
    modelKey = null,
    modelId,
    hyperparameters,
    requestedModelVersion: queueRequestedVersion = null,
    augmentationPreset = 'none'
  } = job.data;

  console.log(`🚀 Starting training job ${jobId}...`);

  let trainingJob = null;
  let pythonProcess = null;
  let isSaving = false;

  try {
    // ✅ Load training job from MongoDB
    trainingJob = await TrainingJob.findOne({ jobId });
    if (!trainingJob) {
      throw new Error(`Training job ${jobId} not found`);
    }

    // ✅ Check if job was cancelled
    if (trainingJob.status === 'cancelled') {
      console.log(`⚠️ Job ${jobId} was cancelled, skipping...`);
      return;
    }

    // ✅ Get dataset
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      throw new Error(`Dataset ${datasetId} not found`);
    }

    // ✅ Update status to 'running' and seed progress/metrics for live status API
    trainingJob.status = 'running';
    trainingJob.startedAt = new Date();
    trainingJob.progress.totalEpochs = hyperparameters.epochs || 0;
    trainingJob.progress.currentEpoch = 0;
    trainingJob.progress.progressPercent = 0;
    if (hyperparameters.learningRate !== undefined) {
      trainingJob.metrics.currentLR = hyperparameters.learningRate;
    }
    await trainingJob.save();

    console.log(`✅ Training job ${jobId} status updated to 'running'`);

    // ✅ Build dataset path
    const datasetPath = storageAdapter.datasetRoot(dataset);
    console.log(`📁 Dataset path: ${datasetPath}`);

    // ✅ Create model storage directory — use client display name or auto v1, v2, …
    let modelVersion;
    const fromJob =
      (trainingJob.requestedModelVersion && String(trainingJob.requestedModelVersion).trim()) ||
      (queueRequestedVersion && String(queueRequestedVersion).trim()) ||
      null;
    if (fromJob) {
      modelVersion = fromJob;
    } else {
      const existingModels = await Model.find({ company, project }).sort({ createdAt: -1 });
      modelVersion =
        existingModels.length > 0 ? `v${existingModels.length + 1}` : 'v1';
    }

    const modelStoragePath = path.join(
      process.cwd(),
      'models',
      company,
      project,
      modelVersion
    );

    await storageAdapter.ensureDir(modelStoragePath);
    await storageAdapter.ensureDir(path.join(modelStoragePath, 'checkpoints'));
    await storageAdapter.ensureDir(path.join(modelStoragePath, 'metrics'));

    console.log(`📦 Model storage: ${modelStoragePath}`);

    const isRfdetr = modelType === 'RF_DETR';

    const persistedLogIndexRef = { value: trainingJob.logs?.length || 0 };

    if (isRfdetr && augmentationPreset && augmentationPreset !== 'none') {
      const warnMsg =
        `⚠️ augmentationPreset "${augmentationPreset}" is ignored for RF_DETR (YOLO-only presets)`;
      console.warn(warnMsg);
      appendTrainingLogText(trainingJob.logs, warnMsg, persistedLogIndexRef, MAX_STORED_TRAINING_LOG_LINES);
    }

    // ✅ Determine which model to use for training (base model or trained model checkpoint)
    let modelPath = null;
    if (modelId) {
      // ✅ Use trained model checkpoint for continued training
      const trainedModel = await Model.findOne({ modelId });
      if (!trainedModel) {
        throw new Error(`Trained model ${modelId} not found`);
      }

      if (trainedModel.modelType !== 'RF_DETR' && isRfdetr) {
        throw new Error(`Trained model ${modelId} is not RF_DETR`);
      }
      if (trainedModel.modelType === 'RF_DETR' && !isRfdetr) {
        throw new Error(`Cannot use RF_DETR checkpoint for ${modelType} training`);
      }
      
      // Validate model belongs to same company/project
      if (trainedModel.company !== company || trainedModel.project !== project) {
        throw new Error(`Trained model does not belong to company ${company} / project ${project}`);
      }
      
      // Use the trained model's best checkpoint
      modelPath = trainedModel.bestCheckpointPath;
      console.log(`✅ Using trained model checkpoint: ${modelPath}`);
      console.log(`📊 Previous model metrics - mAP50: ${(trainedModel.metrics?.mAP50 || 0).toFixed(4)}, Precision: ${(trainedModel.metrics?.precision || 0).toFixed(4)}`);
    } else if (!isRfdetr) {
      // ✅ Download base model from Azure Blob Storage (if Azure connection string exists)
      if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
        try {
          const { localModelPath, jobTempDir } = await downloadBaseModelForJob({
            jobId,
            modelType,
            modelSize,
            modelKey,
            logger: console
          });
          modelPath = localModelPath;
          console.log(`🔒 Using base model from Blob: ${localModelPath}`);
        } catch (downloadError) {
          // Update training job status to failed
          trainingJob.status = 'failed';
          trainingJob.error = downloadError.message;
          appendTrainingLog(
            trainingJob.logs,
            `❌ Failed to download base model: ${downloadError.message}`,
            persistedLogIndexRef
          );
          await persistTrainingJobState({
            jobId: trainingJob.jobId,
            jobObjectId: trainingJob._id,
            logs: trainingJob.logs,
            persistedLogIndexRef,
            progress: trainingJob.progress,
            metrics: trainingJob.metrics,
            status: trainingJob.status,
            extraSet: { error: trainingJob.error }
          });
          throw downloadError;
        }
      } else {
        // ✅ Use base model (existing local logic)
        modelPath = getBaseModelPath(modelType, modelSize, modelKey);
        console.log(`✅ Using base model: ${modelPath}`);
      }
    } else {
      console.log('✅ RF-DETR base: using COCO pretrained weights from rfdetr package');
    }

    let rfdetrDatasetPath = null;
    const configPath = path.join(modelStoragePath, 'training-config.json');

    if (isRfdetr) {
      rfdetrDatasetPath = await prepareRfdetrDatasetForJob(datasetPath, jobId);
      await generateRfdetrTrainingConfig(
        hyperparameters,
        rfdetrDatasetPath,
        configPath,
        modelStoragePath,
        modelPath
      );
    } else {
      await generateTrainingConfig(
        hyperparameters,
        datasetPath,
        configPath,
        modelType,
        modelSize,
        modelPath,
        modelKey,
        augmentationPreset
      );
    }

    // ✅ Spawn Python training process
    const pythonScriptPath = isRfdetr
      ? path.join(__dirname, '../training-scripts/train_rfdetr.py')
      : path.join(__dirname, '../training-scripts/train.py');
    
    // Check if Python script exists, if not, we'll simulate training for now
    const scriptExists = await fsPromises.access(pythonScriptPath).then(() => true).catch(() => false);

    if (!scriptExists) {
      console.log(`⚠️ Python training script not found at ${pythonScriptPath}`);
      console.log(`⚠️ Simulating training for demonstration...`);
      
      // Simulate training (for testing without Python script)
      await simulateTraining(trainingJob, hyperparameters, modelStoragePath, modelVersion);
      return;
    }

    // Spawn actual Python process
    // ✅ IMPORTANT: Process is attached (not detached) so we can stream logs
    // The training worker itself runs as a separate Node.js process, so this
    // Python process will survive dev server restarts as long as the training
    // worker process remains running.
    // ✅ Use -u flag and PYTHONUNBUFFERED for real-time log streaming
    pythonProcess = spawn('python', ['-u', pythonScriptPath, '--config', configPath], {
      cwd: path.join(__dirname, '../training-scripts'),
      stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored, stdout/stderr piped
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      },
      // Note: We keep process attached to capture logs, but training worker
      // runs independently, so Python process survives dev server restarts
    });

    const stdoutStream = { buffer: '' };
    const stderrStream = { buffer: '' };
    let lastSaveTime = Date.now();
    const SAVE_INTERVAL = 5000; // Save to DB every 5 seconds
    isSaving = false; // Flag to prevent parallel saves
    
    // ✅ Track epoch timing for ETA calculation
    const trainingStartTime = Date.now();
    let lastEpochNumber = 0;
    let lastEpochStartTime = trainingStartTime;
    let epochDurations = []; // Track duration of completed epochs

    // ✅ Incremental persist (avoids rewriting full logs array on each save)
    const saveTrainingJob = async () => {
      if (isSaving) {
        return;
      }

      isSaving = true;
      lastSaveTime = Date.now();

      try {
        const result = await persistTrainingJobState({
          jobId: trainingJob.jobId,
          jobObjectId: trainingJob._id,
          logs: trainingJob.logs,
          persistedLogIndexRef,
          progress: trainingJob.progress,
          metrics: trainingJob.metrics,
          status: trainingJob.status
        });

        if (!result.ok) {
          console.warn(
            `⚠️  Training job ${trainingJob.jobId} save returned not ok ` +
              `(duration=${result.durationMs}ms, payload≈${result.payloadBytes} bytes)`
          );
        }
      } catch (error) {
        console.error(
          `❌ Error saving training job:`,
          error.message,
          `(jobId=${trainingJob.jobId})`
        );
      } finally {
        isSaving = false;
      }
    };

    const handleTrainingOutputLine = (line) => {
      appendTrainingLog(trainingJob.logs, line, persistedLogIndexRef, { alreadyNormalized: true });

      const parsedMetrics = parseLogLine(line);
      if (parsedMetrics) {
        const totalEpochs =
          parsedMetrics.totalEpochs ||
          trainingJob.progress.totalEpochs ||
          hyperparameters.epochs;

        if (parsedMetrics.currentEpoch !== undefined) {
          const currentEpoch = parsedMetrics.currentEpoch;

          if (currentEpoch > lastEpochNumber && currentEpoch > 0) {
            const now = Date.now();

            if (lastEpochNumber > 0) {
              const epochDuration = now - lastEpochStartTime;
              epochDurations.push(epochDuration);
              if (epochDurations.length > 10) {
                epochDurations.shift();
              }
            }

            if (epochDurations.length > 0 && totalEpochs > 0) {
              const avgEpochTime = epochDurations.reduce((a, b) => a + b, 0) / epochDurations.length;
              const remainingEpochs = totalEpochs - currentEpoch;
              const estimatedTimeRemainingMs = remainingEpochs * avgEpochTime;
              const elapsedMs = now - trainingStartTime;
              const elapsedMinutes = Math.floor(elapsedMs / 1000 / 60);
              const elapsedSeconds = Math.floor((elapsedMs / 1000) % 60);
              const estimatedMinutes = Math.floor(estimatedTimeRemainingMs / 1000 / 60);
              const estimatedSeconds = Math.floor((estimatedTimeRemainingMs / 1000) % 60);

              let progressMsg = `\n${'='.repeat(80)}\n`;
              progressMsg += `📊 EPOCH ${currentEpoch}/${totalEpochs} PROGRESS\n`;
              progressMsg += `${'='.repeat(80)}\n`;
              progressMsg += `⏱️  Elapsed time: ${elapsedMinutes}m ${elapsedSeconds}s\n`;
              progressMsg += `⏳ Estimated time remaining: ~${estimatedMinutes}m ${estimatedSeconds}s\n`;
              progressMsg += `📈 Progress: ${trainingService.computeProgressPercent(currentEpoch, totalEpochs)}%\n`;
              progressMsg += `${'='.repeat(80)}\n`;

              appendTrainingLogText(
                trainingJob.logs,
                progressMsg,
                persistedLogIndexRef,
                MAX_STORED_TRAINING_LOG_LINES
              );
            }

            lastEpochStartTime = now;
            lastEpochNumber = currentEpoch;
          }

          trainingJob.progress.currentEpoch = currentEpoch;
          trainingJob.progress.totalEpochs = totalEpochs;

          if (
            parsedMetrics.ptlEpochIndex !== undefined &&
            parsedMetrics.currentStep !== undefined &&
            parsedMetrics.totalSteps > 0
          ) {
            trainingJob.progress.progressPercent = trainingService.computeProgressPercentWithBatch(
              parsedMetrics.ptlEpochIndex,
              totalEpochs,
              parsedMetrics.currentStep,
              parsedMetrics.totalSteps
            );
          } else {
            trainingJob.progress.progressPercent = trainingService.computeProgressPercent(
              currentEpoch,
              totalEpochs
            );
          }
        }

        if (parsedMetrics.currentLoss !== undefined) {
          trainingJob.metrics.currentLoss = parsedMetrics.currentLoss;

          if (!trainingJob.metrics.bestLoss || parsedMetrics.currentLoss < trainingJob.metrics.bestLoss) {
            trainingJob.metrics.bestLoss = parsedMetrics.currentLoss;
            trainingJob.metrics.bestEpoch = parsedMetrics.currentEpoch || trainingJob.progress.currentEpoch;
          }
        }

        if (parsedMetrics.currentLR !== undefined) {
          trainingJob.metrics.currentLR = parsedMetrics.currentLR;
        }

        if (parsedMetrics.mAP50 !== undefined) {
          trainingJob.metrics.mAP50 = parsedMetrics.mAP50;
        }

        if (parsedMetrics.mAP50_95 !== undefined) {
          trainingJob.metrics.mAP50_95 = parsedMetrics.mAP50_95;
        }

        if (parsedMetrics.precision !== undefined) {
          trainingJob.metrics.precision = parsedMetrics.precision;
        }

        if (parsedMetrics.recall !== undefined) {
          trainingJob.metrics.recall = parsedMetrics.recall;
        }
      }
    };

    // ✅ Stream stdout — split on \n and \r, strip ANSI, cap line length
    pythonProcess.stdout.on('data', async (data) => {
      ingestTrainingStreamChunk(stdoutStream, data.toString(), handleTrainingOutputLine);

      const now = Date.now();
      if (now - lastSaveTime > SAVE_INTERVAL) {
        await saveTrainingJob();
      }
    });

    // ✅ Stream stderr — same normalization path as stdout
    pythonProcess.stderr.on('data', (data) => {
      ingestTrainingStreamChunk(stderrStream, data.toString(), (line) => {
        const isWarning = /RuntimeWarning|UserWarning|FutureWarning|DeprecationWarning/i.test(line);
        const isMetricsWarning = /Mean of empty slice|invalid value encountered in divide/i.test(line);

        if (isWarning || isMetricsWarning) {
          console.warn(`[Training ${jobId}] Warning:`, line);
          appendTrainingLog(trainingJob.logs, `[WARNING] ${line}`, persistedLogIndexRef, {
            alreadyNormalized: true
          });
        } else {
          console.error(`[Training ${jobId}] Error:`, line);
          appendTrainingLog(trainingJob.logs, `[ERROR] ${line}`, persistedLogIndexRef, {
            alreadyNormalized: true
          });
        }
      });
    });

    // ✅ Hold this Bull job until Python exits.
    // Previously we returned after spawn(), so concurrency=1 still started job B on the GPU.
    let cancelledDuringRun = false;
    const cancellationCheck = setInterval(async () => {
      try {
        const updatedJob = await TrainingJob.findOne({ jobId }).select('status').lean();
        if (updatedJob && updatedJob.status === 'cancelled') {
          cancelledDuringRun = true;
          console.log(`⚠️ Job ${jobId} cancelled, terminating process...`);
          if (pythonProcess && !pythonProcess.killed) {
            pythonProcess.kill('SIGTERM');
          }
          clearInterval(cancellationCheck);
        }
      } catch (err) {
        console.warn(`[Training ${jobId}] cancel check failed:`, err.message);
      }
    }, 2000);

    const exitCode = await new Promise((resolve) => {
      pythonProcess.once('close', (code) => resolve(code));
      pythonProcess.once('error', (err) => {
        console.error(`❌ Training process error for ${jobId}:`, err);
        resolve(1);
      });
    });

    clearInterval(cancellationCheck);

    flushTrainingStreamBuffer(stdoutStream, handleTrainingOutputLine);
    flushTrainingStreamBuffer(stderrStream, (line) => {
      appendTrainingLog(trainingJob.logs, `[ERROR] ${line}`, persistedLogIndexRef, {
        alreadyNormalized: true
      });
    });

    while (isSaving) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await saveTrainingJob();

    const latestStatus = await TrainingJob.findOne({ jobId }).select('status').lean();
    if (cancelledDuringRun || latestStatus?.status === 'cancelled') {
      console.log(`⚠️ Training job ${jobId} cancelled`);
      await TrainingJob.updateOne(
        { _id: trainingJob._id },
        {
          $set: {
            status: 'cancelled',
            cancelledAt: new Date()
          }
        }
      );
      return;
    }

    if (exitCode === 0) {
      console.log(`✅ Training job ${jobId} completed successfully`);

      const csvMetrics = readBestMetricsFromResultsCsv(resultsCsvPath(modelStoragePath));
      const hydrated = buildFinalMetrics(
        trainingJob.metrics || {},
        trainingJob.progress || {},
        csvMetrics
      );
      if (hydrated.mAP50 !== undefined) trainingJob.metrics.mAP50 = hydrated.mAP50;
      if (hydrated.mAP50_95 !== undefined) trainingJob.metrics.mAP50_95 = hydrated.mAP50_95;
      if (hydrated.precision !== undefined) trainingJob.metrics.precision = hydrated.precision;
      if (hydrated.recall !== undefined) trainingJob.metrics.recall = hydrated.recall;
      if (hydrated.bestEpoch !== undefined) trainingJob.metrics.bestEpoch = hydrated.bestEpoch;
      if (hydrated.bestLoss !== undefined) trainingJob.metrics.bestLoss = hydrated.bestLoss;

      const completionTime = Date.now();
      const totalDurationMs = completionTime - trainingStartTime;
      const totalMinutes = Math.floor(totalDurationMs / 1000 / 60);
      const totalSeconds = Math.floor((totalDurationMs / 1000) % 60);

      const completionMsg = `\n${'='.repeat(80)}\n` +
        `✅ TRAINING COMPLETED SUCCESSFULLY!\n` +
        `${'='.repeat(80)}\n` +
        `Completed at: ${new Date().toLocaleString()}\n` +
        `Total duration: ${totalMinutes}m ${totalSeconds}s\n` +
        `Total epochs: ${trainingJob.progress.totalEpochs || hyperparameters.epochs}\n` +
        `Best epoch: ${trainingJob.metrics.bestEpoch || trainingJob.progress.currentEpoch || 'N/A'}\n` +
        `\nFinal Metrics:\n` +
        `  📊 mAP50: ${formatMetric(trainingJob.metrics.mAP50)}\n` +
        `  📊 mAP50-95: ${formatMetric(trainingJob.metrics.mAP50_95)}\n` +
        `  🎯 Precision: ${formatMetric(trainingJob.metrics.precision)}\n` +
        `  🎯 Recall: ${formatMetric(trainingJob.metrics.recall)}\n` +
        `  📉 Best Loss: ${formatMetric(trainingJob.metrics.bestLoss || trainingJob.metrics.currentLoss)}\n` +
        `\n${'='.repeat(80)}\n` +
        `Model is being saved and registered...\n` +
        `${'='.repeat(80)}\n`;

      appendTrainingLogText(
        trainingJob.logs,
        completionMsg,
        persistedLogIndexRef,
        MAX_STORED_TRAINING_LOG_LINES
      );
      await saveTrainingJob();

      await finalizeTraining(
        trainingJob,
        dataset,
        modelStoragePath,
        modelVersion,
        company,
        project,
        persistedLogIndexRef
      );
    } else {
      console.error(`❌ Training job ${jobId} failed with exit code ${exitCode}`);
      await TrainingJob.updateOne(
        { _id: trainingJob._id },
        {
          $set: {
            status: 'failed',
            error: `Training process exited with code ${exitCode}`,
            completedAt: new Date()
          }
        }
      );
    }

  } catch (error) {
    console.error(`❌ Error processing training job ${jobId}:`, error);
    
    if (trainingJob) {
      // Wait for any pending save
      while (isSaving) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // Update status using fresh document
      await TrainingJob.updateOne(
        { _id: trainingJob._id },
        {
          $set: {
            status: 'failed',
            error: error.message,
            completedAt: new Date()
          }
        }
      );
    }

    // Kill Python process if running
    if (pythonProcess && !pythonProcess.killed) {
      pythonProcess.kill('SIGTERM');
    }
  }
};

/**
 * Simulate training (for testing without Python script)
 */
async function simulateTraining(trainingJob, hyperparameters, modelStoragePath, modelVersion) {
  console.log(`🎭 Simulating training for job ${trainingJob.jobId}...`);

  const persistedLogIndexRef = { value: trainingJob.logs?.length || 0 };
  const totalEpochs = hyperparameters.epochs;
  let currentEpoch = 0;

  while (currentEpoch < totalEpochs) {
    // Check if cancelled
    const updatedJob = await TrainingJob.findOne({ jobId: trainingJob.jobId }).select('status').lean();
    if (updatedJob && updatedJob.status === 'cancelled') {
      console.log(`⚠️ Job ${trainingJob.jobId} cancelled during simulation`);
      return;
    }

    currentEpoch++;
    const progress = trainingService.computeProgressPercent(currentEpoch, totalEpochs);
    
    // Simulate metrics
    const loss = 1.0 - (currentEpoch / totalEpochs) * 0.6; // Decreasing loss
    const mAP50 = 0.5 + (currentEpoch / totalEpochs) * 0.3; // Increasing mAP

    // Update training job
    trainingJob.progress.currentEpoch = currentEpoch;
    trainingJob.progress.progressPercent = progress;
    trainingJob.metrics.currentLoss = loss;
    trainingJob.metrics.currentLR = 0.01;
    
    if (!trainingJob.metrics.bestLoss || loss < trainingJob.metrics.bestLoss) {
      trainingJob.metrics.bestLoss = loss;
      trainingJob.metrics.bestEpoch = currentEpoch;
    }

    trainingJob.metrics.mAP50 = mAP50;
    appendTrainingLog(
      trainingJob.logs,
      `Epoch ${currentEpoch}/${totalEpochs}: loss=${loss.toFixed(4)}, lr=0.01, mAP50=${mAP50.toFixed(4)}`,
      persistedLogIndexRef
    );

    await persistTrainingJobState({
      jobId: trainingJob.jobId,
      jobObjectId: trainingJob._id,
      logs: trainingJob.logs,
      persistedLogIndexRef,
      progress: trainingJob.progress,
      metrics: trainingJob.metrics,
      status: trainingJob.status
    });

    // Simulate epoch duration
    await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second per epoch
  }

  // Finalize
  await finalizeTraining(
    trainingJob,
    await Dataset.findById(trainingJob.datasetId),
    modelStoragePath,
    modelVersion,
    trainingJob.company,
    trainingJob.project,
    persistedLogIndexRef
  );
}

/**
 * Finalize training: compute final metrics, register model
 */
async function finalizeTraining(
  trainingJob,
  dataset,
  modelStoragePath,
  modelVersion,
  company,
  project,
  persistedLogIndexRef = { value: trainingJob.logs?.length || 0 }
) {
  try {
    console.log(`📊 Finalizing training job ${trainingJob.jobId}...`);

    const isRfdetr = trainingJob.modelType === 'RF_DETR';
    const bestCheckpointPath = path.join(
      modelStoragePath,
      isRfdetr ? 'best.pth' : 'best.pt',
    );

    if (isRfdetr) {
      const outputDir = path.join(modelStoragePath, 'rfdetr-output');
      const candidates = [
        path.join(outputDir, 'checkpoint_best_total.pth'),
        path.join(outputDir, 'checkpoint_best_ema.pth'),
        path.join(outputDir, 'checkpoint_best_regular.pth'),
        path.join(outputDir, 'checkpoint.pth')
      ];
      let found = null;
      for (const c of candidates) {
        if (await storageAdapter.exists(c)) {
          found = c;
          break;
        }
      }
      if (found) {
        console.log(`✅ Found RF-DETR checkpoint: ${found}`);
        await storageAdapter.copyFile(found, bestCheckpointPath);
        console.log(`✅ Copied to: ${bestCheckpointPath}`);
      } else {
        console.warn(`⚠️  RF-DETR checkpoint not found under: ${outputDir}`);
        await fsPromises.writeFile(
          bestCheckpointPath,
          'placeholder checkpoint file - training may have failed',
          'utf8'
        );
      }

      const datasetPath = storageAdapter.datasetRoot(dataset);
      const datasetYaml = path.join(datasetPath, 'data.yaml');
      const modelYaml = path.join(modelStoragePath, 'data.yaml');
      if (fs.existsSync(datasetYaml)) {
        await storageAdapter.copyFile(datasetYaml, modelYaml);
        console.log(`✅ Copied class names data.yaml to model storage`);
      }
    } else {
      const runsDir = path.join(modelStoragePath, 'runs', 'train');
      const yoloBestPath = path.join(runsDir, 'weights', 'best.pt');

      if (await storageAdapter.exists(yoloBestPath)) {
        console.log(`✅ Found YOLO checkpoint: ${yoloBestPath}`);
        await storageAdapter.copyFile(yoloBestPath, bestCheckpointPath);
        console.log(`✅ Copied best.pt to: ${bestCheckpointPath}`);
      } else {
        console.warn(`⚠️  YOLO checkpoint not found at: ${yoloBestPath}`);
        await fsPromises.writeFile(
          bestCheckpointPath,
          'placeholder checkpoint file - training may have failed',
          'utf8'
        );
      }
    }

    // Prefer metrics parsed from the "all ..." val line; fill gaps from results.csv.
    // ❗ Never invent 0.72 / 0.85 / 0.78 — that made every YOLO_SEG card look identical.
    const csvMetrics = readBestMetricsFromResultsCsv(resultsCsvPath(modelStoragePath));
    const finalMetrics = buildFinalMetrics(
      trainingJob.metrics || {},
      trainingJob.progress || {},
      csvMetrics
    );

    trainingJob.finalMetrics = finalMetrics;

    // ✅ Generate insights (simplified for now)
    const insights = {
      bestAccuracy: finalMetrics.precision,
      bestmAP: finalMetrics.mAP50,
      weakestLabels: [],
      classImbalanceWarnings: [],
      recommendations: []
    };

    // ✅ Create Model registry entry
    const model = new Model({
      modelId: `model_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      jobId: trainingJob._id,
      company,
      project,
      modelVersion,
      modelType: trainingJob.modelType,
      datasetVersion: dataset.version,
      datasetId: dataset._id,
      metrics: finalMetrics,
      insights,
      storagePath: modelStoragePath,
      bestCheckpointPath,
      chartDataPath: path.join(modelStoragePath, 'metrics')
    });

    await model.save();

    // ✅ Update training job status
    trainingJob.status = 'completed';
    trainingJob.completedAt = new Date();
    
    // ✅ Add model registration confirmation to logs
    const registrationMsg = `\n${'='.repeat(80)}\n` +
      `✅ MODEL REGISTERED SUCCESSFULLY\n` +
      `${'='.repeat(80)}\n` +
      `Model ID: ${model.modelId}\n` +
      `Model Version: ${modelVersion}\n` +
      `Storage Path: ${modelStoragePath}\n` +
      `Best Checkpoint: ${bestCheckpointPath}\n` +
      `\nYou can now use this model for inference!\n` +
      `${'='.repeat(80)}\n`;
    
    appendTrainingLogText(
      trainingJob.logs,
      registrationMsg,
      persistedLogIndexRef,
      MAX_STORED_TRAINING_LOG_LINES
    );
    trainingJob.status = 'completed';

    await persistTrainingJobState({
      jobId: trainingJob.jobId,
      jobObjectId: trainingJob._id,
      logs: trainingJob.logs,
      persistedLogIndexRef,
      progress: trainingJob.progress,
      metrics: trainingJob.metrics,
      status: trainingJob.status,
      extraSet: {
        finalMetrics: trainingJob.finalMetrics,
        completedAt: trainingJob.completedAt
      }
    });

    console.log(`✅ Training job ${trainingJob.jobId} completed and model registered: ${model.modelId}`);

  } catch (error) {
    console.error(`❌ Error finalizing training:`, error);
    await TrainingJob.updateOne(
      { _id: trainingJob._id },
      {
        $set: {
          status: 'failed',
          error: `Finalization error: ${error.message}`,
          completedAt: new Date()
        }
      }
    );
  }
}

/**
 * Connect to MongoDB and start processing jobs
 */
const startWorker = async () => {
  try {
    // ✅ Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/visiondb';
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 30000, // wait longer for Atlas primary
      socketTimeoutMS: 45000,
      family: 4, // FORCE IPv4 (critical on Windows)
    });
    
    console.log('✅ Training worker connected to MongoDB');

    // ✅ Process jobs from queue (concurrency 1). processTrainingJob now awaits Python,
    // so the next job cannot start until the GPU is free.
    trainingQueue.process(1, async (job) => {
      await processTrainingJob(job);
    });
    

    console.log('✅ Training worker started. Waiting for jobs...');

  } catch (error) {
    console.error('❌ Failed to start training worker:', error);
    process.exit(1);
  }
};

// ✅ Handle MongoDB connection errors
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected');
});

// ✅ Global error handlers
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ✅ Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

// ✅ Start the worker
startWorker();

