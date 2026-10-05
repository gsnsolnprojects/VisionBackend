const mongoose = require('mongoose');
const InferenceJob = require('../models/InferenceJob');
const Model = require('../models/Model');
const Dataset = require('../models/Dataset');
const { getClassNamesForTrainedModel } = require('../services/yoloClassNamesService');
const { classNamesFromMetadata, stampClassIds } = require('../utils/classLegend');
const {
  hydrateAndPersistModelMetrics,
  formatModelNameWithMap,
} = require('../utils/yoloTrainingMetrics');
const { resolveModelCheckpointPath } = require('../services/resolveModelCheckpoint');
const { inferenceQueue } = require('../queue');
const storageAdapter = require('../services/storageAdapter');
const auditService = require('../services/auditService');
const { buildWorkspaceFilter, validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const { resolveInferenceImagePath } = require('../utils/resolveInferenceImagePath');
const { normalizeAssessment } = require('../utils/assessment');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

// ✅ Store long-lived Python processes for live camera inference
// Key: inferenceId, Value: { process, modelPath, defaultConf, model, inferenceJob }
const liveInferenceProcesses = new Map();

// ✅ Store pending frame requests for matching responses
// Key: inferenceId_requestId, Value: { resolve, reject, timestamp }
const pendingFrameRequests = new Map();

// ✅ Edge Live: in-memory store for latest payload from edge device (POST /api/inference/edge/live)
// Single global "latest" entry; overwritten on each valid POST. GET returns this for frontend polling.
let latestEdgeLiveEntry = null;

/**
 * Inference Controller - Handles inference/prediction job management
 * 
 * This controller provides endpoints for:
 * - Starting batch inference on test folders
 * - Starting live camera inference
 * - Checking inference status and progress
 * - Retrieving inference results
 * - Cancelling inference jobs
 * - Listing available models and datasets
 */

/**
 * POST /api/inference/start
 * 
 * Start batch inference on test folder from a dataset OR custom uploaded images/videos
 * 
 * For dataset-based inference:
 *   Body (JSON): { modelId, datasetId, confidenceThreshold? }
 * 
 * For custom image/video upload:
 *   Body (multipart/form-data): 
 *     - modelId (text field, required)
 *     - confidenceThreshold? (text field, optional)
 *     - images (file field, multiple images/videos allowed, required if no datasetId)
 */
const startBatchInference = async (req, res) => {
  try {
    // ✅ Log incoming request for debugging
    console.log('🔍 [Inference Start] Request received:', {
      method: req.method,
      contentType: req.headers['content-type'],
      body: req.body,
      filesCount: Array.isArray(req.files) ? req.files.length : 0,
      hasFiles: !!req.files
    });

    // ✅ Extract fields - support both JSON and form-data
    // ⚠️ NOTE: When using multer.array('images'), files are stored directly in req.files as an array
    // NOT in req.files.images (that would be for .fields() with named fields)
    const modelId = req.body.modelId;
    const datasetId = req.body.datasetId;
    const confidenceThreshold = req.body.confidenceThreshold;
    const regionName =
      typeof req.body.regionName === 'string' && req.body.regionName.trim()
        ? req.body.regionName.trim()
        : null;
    const uploadedImages = Array.isArray(req.files) ? req.files : [];

    // ✅ Determine inference type: dataset-based or custom upload
    const isCustomUpload = uploadedImages.length > 0;
    const isDatasetBased = !!datasetId;

    // ✅ Validate that either datasetId OR images are provided (not both, not neither)
    if (!modelId) {
      console.error('❌ [Inference Start] Missing modelId');
      return res.status(400).json({
        error: 'Missing required field: modelId',
        received: { body: req.body, files: req.files ? 'present' : 'missing' }
      });
    }

    if (!isDatasetBased && !isCustomUpload) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Either datasetId (for dataset-based inference) or images (for custom upload) must be provided',
        required: ['modelId', 'datasetId OR images']
      });
    }

    if (isDatasetBased && isCustomUpload) {
      return res.status(400).json({
        error: 'Conflicting parameters',
        message: 'Cannot provide both datasetId and custom images. Use either dataset-based inference OR custom upload.'
      });
    }

    // ✅ Validate confidence threshold (optional, default 0.25)
    let conf = 0.25; // Default value
    if (confidenceThreshold !== undefined) {
      conf = parseFloat(confidenceThreshold);
      if (isNaN(conf) || conf < 0 || conf > 1) {
        return res.status(400).json({
          error: 'Invalid confidence threshold',
          message: 'Confidence threshold must be a number between 0 and 1',
          provided: confidenceThreshold
        });
      }
    }

    // ✅ Validate model exists and get model info
    // Support both MongoDB _id (ObjectId) and custom modelId field
    let model;
    if (mongoose.Types.ObjectId.isValid(modelId) && modelId.length === 24) {
      // If it's a valid ObjectId, try finding by _id first
      model = await Model.findById(modelId);
    }
    // If not found or not a valid ObjectId, try finding by custom modelId field
    if (!model) {
      model = await Model.findOne({ modelId: modelId });
    }
    if (!model) {
      return res.status(404).json({
        error: 'Model not found',
        modelId: modelId
      });
    }

    const checkpointPath = resolveModelCheckpointPath(model);
    if (!checkpointPath || !fs.existsSync(checkpointPath)) {
      return res.status(404).json({
        error: 'Model checkpoint file not found',
        modelId: modelId,
        path: model.bestCheckpointPath
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

    let sourceType;
    let testFolderPath = null;
    let customFolderPath = null;
    let totalImages = 0;
    let datasetIdForJob = null;

    // ✅ Handle dataset-based inference
    if (isDatasetBased) {
    // ✅ Validate dataset exists
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return res.status(404).json({
        error: 'Dataset not found',
        datasetId: datasetId
      });
    }

    // ✅ Validate workspace access to dataset (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, dataset.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this dataset'
        });
      }
    }

    // ✅ Validate dataset is ready
    // 'ready' = dataset from preprocessing (labeled data upload)
    // 'ready_to_train' = dataset from annotation workflow (unlabeled data → annotated → converted)
    if (dataset.status !== 'ready' && dataset.status !== 'ready_to_train') {
      return res.status(400).json({
        error: 'Dataset is not ready for inference',
        status: dataset.status,
        message: 'Dataset must be in "ready" or "ready_to_train" status'
      });
    }

    // ✅ Validate dataset has test images
    if (!dataset.testCount || dataset.testCount === 0) {
      return res.status(400).json({
        error: 'Dataset has no test images',
        testCount: dataset.testCount
      });
    }

    // ✅ Validate company/project match
    if (model.company !== dataset.company || model.project !== dataset.project) {
      return res.status(400).json({
        error: 'Model and dataset must belong to the same company and project',
        modelCompany: model.company,
        modelProject: model.project,
        datasetCompany: dataset.company,
        datasetProject: dataset.project
      });
    }

    // ✅ Get test folder path
      testFolderPath = path.join(
      storageAdapter.buildDatasetPath(dataset.company, dataset.project, dataset.version),
      'images',
      'test'
    );

    // ✅ Validate test folder exists
    if (!fs.existsSync(testFolderPath)) {
      return res.status(404).json({
        error: 'Test folder not found',
        path: testFolderPath
      });
      }

      sourceType = 'test_folder';
      totalImages = dataset.testCount;
      datasetIdForJob = dataset._id.toString();
    }

    // ✅ Handle custom image/video upload
    if (isCustomUpload) {
      // ✅ Validate at least one file was uploaded
      if (uploadedImages.length === 0) {
        return res.status(400).json({
          error: 'No files uploaded',
          message: 'At least one image or video file is required for custom inference'
        });
      }

      // ✅ Create temporary folder for uploaded files (images/videos)
      const tempInferenceDir = path.join(process.cwd(), 'uploads', 'inference-temp', `inf_${Date.now()}_${uuidv4().substring(0, 8)}`);
      await storageAdapter.ensureDir(tempInferenceDir);

      // ✅ Move uploaded files to temp folder
      for (const file of uploadedImages) {
        const destPath = path.join(tempInferenceDir, file.originalname);
        try {
          await fs.promises.rename(file.path, destPath);
        } catch (error) {
          // If rename fails (cross-device), copy instead
          await fs.promises.copyFile(file.path, destPath);
          await fs.promises.unlink(file.path); // Delete temp file
        }
      }

      customFolderPath = tempInferenceDir;
      sourceType = 'custom_folder';
      totalImages = uploadedImages.length;
    }

    // ✅ Generate unique inference ID
    const inferenceId = `inf_${Date.now()}_${uuidv4().substring(0, 8)}`;

    // ✅ Create InferenceJob document
    const inferenceJobData = {
      inferenceId,
      modelId: model._id,
      company: model.company,
      project: model.project,
      sourceType: sourceType,
      status: 'queued',
      createdBy: req.user ? req.user.id : null, // Store user ID for ownership verification
      regionName: regionName || null,
      progress: {
        totalImages: totalImages,
        processedImages: 0,
        progressPercent: 0
      }
    };

    // ✅ Add source-specific fields
    if (sourceType === 'test_folder') {
      inferenceJobData.datasetId = datasetIdForJob;
      inferenceJobData.testFolderPath = testFolderPath;
    } else if (sourceType === 'custom_folder') {
      inferenceJobData.customFolderPath = customFolderPath;
    }

    const inferenceJob = new InferenceJob(inferenceJobData);
    await inferenceJob.save();

    // ✅ Prepare job data for queue
    const jobData = {
      inferenceId,
      modelId: model._id.toString(),
      company: model.company,
      project: model.project,
      sourceType: sourceType,
      confidenceThreshold: conf
    };

    // ✅ Add source-specific fields to job data
    if (sourceType === 'test_folder') {
      jobData.datasetId = datasetIdForJob;
      jobData.testFolderPath = testFolderPath;
    } else if (sourceType === 'custom_folder') {
      jobData.customFolderPath = customFolderPath;
    }

    // ✅ Enqueue inference job
    await inferenceQueue.add(jobData, {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false
    });

    // Log inference execution activity
    await auditService.logAction({
      action: 'execute',
      resourceType: 'inference',
      resourceId: inferenceId,
      details: {
        company: model.company,
        project: model.project,
        projectName: model.project,
        modelId: model._id.toString(),
        sourceType: sourceType,
        totalImages: totalImages
      },
      req
    });

    return res.status(202).json({
      inferenceId: inferenceJob.inferenceId,
      status: inferenceJob.status,
      message: isCustomUpload 
        ? 'Inference job queued successfully with custom files' 
        : 'Inference job queued successfully',
      sourceType: sourceType,
      totalImages: totalImages // Note: includes videos for backward compatibility
    });

  } catch (error) {
    console.error('Error starting batch inference:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * POST /api/inference/live/start
 *
 * Start live camera inference.
 *
 * Body: {
 *   modelId: string (required),
 *   confidenceThreshold?: number (optional, 0–1, default 0.25)
 * }
 */
const startLiveInference = async (req, res) => {
  try {
    const { modelId, confidenceThreshold } = req.body;

    // ✅ Validate required fields
    if (!modelId) {
      return res.status(400).json({
        error: 'Missing required field: modelId'
      });
    }

    // ✅ Validate model exists
    // Try finding by MongoDB _id first (if it's a valid ObjectId), then by custom modelId field
    let model;
    if (mongoose.Types.ObjectId.isValid(modelId) && modelId.length === 24) {
      // If it's a valid ObjectId, try finding by _id first
      model = await Model.findById(modelId);
    }
    // If not found or not a valid ObjectId, try finding by custom modelId field
    if (!model) {
      model = await Model.findOne({ modelId: modelId });
    }
    if (!model) {
      return res.status(404).json({
        error: 'Model not found',
        modelId: modelId
      });
    }

    const checkpointPath = resolveModelCheckpointPath(model);
    if (!checkpointPath || !fs.existsSync(checkpointPath)) {
      return res.status(404).json({
        error: 'Model checkpoint file not found',
        modelId: modelId,
        path: model.bestCheckpointPath
      });
    }

    // ✅ Generate unique inference ID
    const inferenceId = `inf_${Date.now()}_${uuidv4().substring(0, 8)}`;

    // ✅ Create temp directory for storing frames
    const framesDir = path.join(process.cwd(), 'uploads', 'live-frames', inferenceId);
    await storageAdapter.ensureDir(framesDir);

    // ✅ Create InferenceJob document (status: 'running' for live camera)
    const inferenceJob = new InferenceJob({
      inferenceId,
      modelId: model._id,
      company: model.company,
      project: model.project,
      sourceType: 'live_camera',
      excludeFromHistory: true,
      status: 'running',
      createdBy: req.user ? req.user.id : null, // Store user ID for ownership verification
      startedAt: new Date(),
      results: {
        framesPath: framesDir // Store frames directory path
      }
    });

    await inferenceJob.save();

    const isRfdetr = model.modelType === 'RF_DETR';
    const streamScriptName = isRfdetr
      ? 'process_frame_stream_rfdetr.py'
      : 'process_frame_stream.py';
    const pythonScriptPath = path.join(__dirname, '../inference-scripts', streamScriptName);
    const scriptExists = await fsPromises.access(pythonScriptPath).then(() => true).catch(() => false);
    
    if (!scriptExists) {
      return res.status(500).json({
        error: 'Inference script not found',
        path: pythonScriptPath
      });
    }

    // ✅ Get default confidence threshold from request or use 0.25
    let defaultConf = 0.25;
    if (confidenceThreshold !== undefined) {
      defaultConf = parseFloat(confidenceThreshold);
      if (Number.isNaN(defaultConf) || defaultConf < 0 || defaultConf > 1) {
        return res.status(400).json({
          error: 'Invalid confidence threshold',
          message: 'Confidence threshold must be a number between 0 and 1',
          provided: confidenceThreshold
        });
      }
    }

    // ✅ Spawn long-lived Python process
    const pythonProcess = spawn('python', [
      '-u', // Unbuffered output
      pythonScriptPath,
      '--model', checkpointPath,
      '--conf', defaultConf.toString()
    ], {
      cwd: path.join(__dirname, '../inference-scripts'),
      stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    let processReady = false;
    let processError = null;

    // ✅ Wait for process to be ready (read "Ready to process frames" from stderr)
    pythonProcess.stderr.on('data', (data) => {
      const message = data.toString();
      if (message.includes('Ready to process frames')) {
        processReady = true;
      }
      if (message.includes('ERROR')) {
        processError = message;
      }
    });

    // ✅ Wait a bit for process initialization (model loading)
    await new Promise((resolve) => {
      const checkReady = setInterval(() => {
        if (processReady || processError) {
          clearInterval(checkReady);
          resolve();
        }
      }, 100);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkReady);
        resolve();
      }, 10000);
    });

    // ✅ Check if process failed to start
    if (processError) {
      pythonProcess.kill();
      return res.status(500).json({
        error: 'Failed to start inference process',
        message: processError
      });
    }

    // ✅ Check if process is still alive
    if (pythonProcess.killed) {
      return res.status(500).json({
        error: 'Inference process died during startup'
      });
    }

    // ✅ Store process and cache model/inference job data
    liveInferenceProcesses.set(inferenceId, {
      process: pythonProcess,
      modelPath: checkpointPath,
      defaultConf: defaultConf,
      model: model,  // ✅ Cache model to avoid DB query per frame
      inferenceJob: inferenceJob  // ✅ Cache inference job to avoid DB query per frame
    });

    // ✅ Set up continuous response listener for this process
    // This listener routes responses to the correct pending request based on requestId
    let responseBuffer = '';
    pythonProcess.stdout.on('data', (data) => {
      responseBuffer += data.toString();
      
      // Process complete JSON lines
      const lines = responseBuffer.split('\n');
      responseBuffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        
        try {
          const result = JSON.parse(trimmedLine);
          
          // ✅ Route response to matching pending request
          if (result.requestId) {
            const requestKey = `${inferenceId}_${result.requestId}`;
            const pendingRequest = pendingFrameRequests.get(requestKey);
            
            if (pendingRequest) {
              pendingFrameRequests.delete(requestKey);
              pendingRequest.resolve(result);
            }
          }
        } catch (parseError) {
          // Not valid JSON, skip
          continue;
        }
      }
    });

    // ✅ Handle process errors and cleanup
    pythonProcess.on('error', (error) => {
      console.error(`Python process error for ${inferenceId}:`, error);
      // Reject all pending requests
      for (const [key, value] of pendingFrameRequests.entries()) {
        if (key.startsWith(`${inferenceId}_`)) {
          value.reject(new Error('Process error'));
          pendingFrameRequests.delete(key);
        }
      }
      liveInferenceProcesses.delete(inferenceId);
    });

    pythonProcess.on('exit', (code) => {
      console.log(`Python process exited for ${inferenceId} with code ${code}`);
      // Reject all pending requests
      for (const [key, value] of pendingFrameRequests.entries()) {
        if (key.startsWith(`${inferenceId}_`)) {
          value.reject(new Error('Process exited'));
          pendingFrameRequests.delete(key);
        }
      }
      liveInferenceProcesses.delete(inferenceId);
    });

    return res.status(200).json({
      inferenceId: inferenceJob.inferenceId,
      status: inferenceJob.status,
      message: 'Live camera inference started',
      frameEndpoint: `/api/inference/live/${inferenceId}/frame`,
      confidenceThreshold: defaultConf
    });

  } catch (error) {
    console.error('Error starting live inference:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * POST /api/inference/live/:inferenceId/frame
 * 
 * Process a single frame from live camera
 * 
 * Body: {
 *   image: "data:image/jpeg;base64,..." // Base64 encoded image
 *   confidenceThreshold?: 0.25 // Optional, overrides default
 * }
 */
const processLiveFrame = async (req, res) => {
  try {
    const { inferenceId } = req.params;
    const { image, confidenceThreshold, returnAnnotatedImage = true } = req.body;

    // ✅ Validate inferenceId
    if (!inferenceId) {
      return res.status(400).json({
        error: 'Missing required parameter: inferenceId'
      });
    }

    // ✅ Validate image data
    if (!image || typeof image !== 'string') {
      return res.status(400).json({
        error: 'Missing or invalid image data',
        message: 'Image must be a base64 encoded string (data URL format)'
      });
    }

    // ✅ Get cached process info (includes model and inference job - no DB query!)
    const processInfo = liveInferenceProcesses.get(inferenceId);
    
    if (!processInfo) {
      return res.status(400).json({
        error: 'Inference session not found',
        message: 'Please start the inference session first'
      });
    }

    // ✅ Use cached inference job and model (no DB query needed!)
    const inferenceJob = processInfo.inferenceJob;
    const model = processInfo.model;

    // ✅ Validate job is running
    if (inferenceJob.status !== 'running') {
      return res.status(400).json({
        error: 'Inference job is not running',
        status: inferenceJob.status,
        message: 'Only running inference jobs can process frames'
      });
    }

    // ✅ Validate job is live camera type
    if (inferenceJob.sourceType !== 'live_camera') {
      return res.status(400).json({
        error: 'Invalid inference job type',
        sourceType: inferenceJob.sourceType,
        message: 'This endpoint is only for live camera inference'
      });
    }

    // ✅ Get confidence threshold (use provided or default from process)
    const conf = confidenceThreshold !== undefined 
      ? parseFloat(confidenceThreshold) 
      : (processInfo.defaultConf || 0.25);

    if (isNaN(conf) || conf < 0 || conf > 1) {
      return res.status(400).json({
        error: 'Invalid confidence threshold',
        message: 'Confidence threshold must be a number between 0 and 1',
        provided: confidenceThreshold
      });
    }

    // ✅ Validate process is alive
    if (!processInfo.process || processInfo.process.killed) {
      return res.status(400).json({
        error: 'Inference process died',
        message: 'Please restart the inference session'
      });
    }

    const pythonProcess = processInfo.process;

    // ✅ Generate unique request ID for matching response
    const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // ✅ Prepare image data (remove data URL prefix if present)
    let base64Data = image;
    if (image.includes(',')) {
      base64Data = image.split(',')[1];
    }

    const startTime = Date.now();

    // ✅ Set up response promise (response will be routed by continuous listener)
    const responsePromise = new Promise((resolve, reject) => {
      const requestKey = `${inferenceId}_${requestId}`;
      
      // ✅ Store pending request (continuous listener will route response here)
      pendingFrameRequests.set(requestKey, {
        resolve,
        reject,
        timestamp: Date.now()
      });

      // ✅ Timeout after 5 seconds
      setTimeout(() => {
        const pendingRequest = pendingFrameRequests.get(requestKey);
        if (pendingRequest) {
          pendingFrameRequests.delete(requestKey);
          pendingRequest.reject(new Error('Timeout waiting for response'));
        }
      }, 5000);
    });

    // ✅ Send frame to Python process via stdin (JSON line) with request ID
    const requestData = {
      requestId: requestId,  // ✅ Include request ID for matching
      image: base64Data,
      conf: conf
    };

    // ✅ Send request to process
    pythonProcess.stdin.write(JSON.stringify(requestData) + '\n');

    let detectionData;
    try {
      detectionData = await responsePromise;
    } catch (error) {
      // ✅ Clean up pending request on error
      const requestKey = `${inferenceId}_${requestId}`;
      pendingFrameRequests.delete(requestKey);
      
      return res.status(500).json({
        error: 'Frame processing timeout or error',
        message: error.message
      });
    }

    const processingTime = Date.now() - startTime;

    // ✅ Check for errors in response
    if (detectionData.error) {
      return res.status(500).json({
        error: 'Frame processing failed',
        message: detectionData.error
      });
    }

    // ✅ Update inference job statistics (batch saves - every 20 frames to reduce DB load)
    if (!inferenceJob.results) {
      inferenceJob.results = {};
    }
    if (!inferenceJob.results.totalFramesProcessed) {
      inferenceJob.results.totalFramesProcessed = 0;
    }
    inferenceJob.results.totalFramesProcessed = (inferenceJob.results.totalFramesProcessed || 0) + 1;
    
    // ✅ Batch database saves (save every 20 frames instead of every frame)
    // Note: We update the cached object, but only save to DB periodically
    if (inferenceJob.results.totalFramesProcessed % 20 === 0) {
      // ✅ Update cached object in map
      processInfo.inferenceJob = inferenceJob;
      await inferenceJob.save();
    }

    // ✅ Return detection data with image dimensions
    const response = {
      detections: detectionData?.detections || [],
      totalDetections: detectionData?.totalDetections || 0,
      processingTime: processingTime, // milliseconds
      // ✅ Include image dimensions for coordinate scaling on frontend
      imageWidth: detectionData?.imageWidth || 0,
      imageHeight: detectionData?.imageHeight || 0
    };
    
    // ✅ Note: Annotated image not supported in stream mode (use overlay mode)
    // If returnAnnotatedImage is true, we'd need to draw annotations on backend
    // For now, overlay mode (returnAnnotatedImage: false) is recommended
    
    return res.status(200).json(response);

  } catch (error) {
    console.error('Error processing live frame:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * POST /api/inference/live/:inferenceId/stop
 * 
 * Stop live camera inference
 */
const stopLiveInference = async (req, res) => {
  try {
    const { inferenceId } = req.params;

    if (!inferenceId) {
      return res.status(400).json({
        error: 'Missing required parameter: inferenceId'
      });
    }

    // ✅ Find inference job
    const inferenceJob = await InferenceJob.findOne({ inferenceId });

    if (!inferenceJob) {
      return res.status(404).json({
        error: 'Inference job not found',
        inferenceId: inferenceId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, inferenceJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this inference job'
        });
      }
    }

    // ✅ Check if job is already stopped
    if (inferenceJob.status !== 'running') {
      return res.status(400).json({
        error: 'Inference job is not running',
        status: inferenceJob.status,
        message: 'Job is already stopped or completed'
      });
    }

    // ✅ Kill long-lived Python process if it exists
    const processInfo = liveInferenceProcesses.get(inferenceId);
    if (processInfo && processInfo.process && !processInfo.process.killed) {
      try {
        processInfo.process.stdin.end(); // Close stdin
        processInfo.process.kill('SIGTERM'); // Terminate process
        console.log(`✅ Terminated Python process for inference ${inferenceId}`);
      } catch (killError) {
        console.warn(`⚠️ Failed to kill Python process: ${killError.message}`);
      }
      liveInferenceProcesses.delete(inferenceId);
    }

    // ✅ Update job status
    inferenceJob.status = 'completed';
    inferenceJob.completedAt = new Date();
    await inferenceJob.save();

    // ✅ Clean up frames directory (optional - can keep for debugging)
    const framesDir = inferenceJob.results?.framesPath;
    if (framesDir && fs.existsSync(framesDir)) {
      try {
        // Delete all files in frames directory
        const files = await fsPromises.readdir(framesDir);
        for (const file of files) {
          try {
            await fsPromises.unlink(path.join(framesDir, file));
          } catch (e) {
            // Ignore individual file errors
          }
        }
        // Remove directory (recursive)
        await fsPromises.rm(framesDir, { recursive: true, force: true });
        console.log(`✅ Cleaned up frames directory: ${framesDir}`);
      } catch (cleanupError) {
        console.warn(`⚠️ Failed to cleanup frames directory: ${cleanupError.message}`);
        // Continue even if cleanup fails
      }
    }

    return res.status(200).json({
      inferenceId: inferenceJob.inferenceId,
      status: inferenceJob.status,
      message: 'Live camera inference stopped',
      totalFramesProcessed: inferenceJob.results?.totalFramesProcessed || 0,
      stoppedAt: inferenceJob.completedAt
    });

  } catch (error) {
    console.error('Error stopping live inference:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/inference/:inferenceId/status
 * 
 * Get inference job status and progress
 */
const getInferenceStatus = async (req, res) => {
  try {
    const { inferenceId } = req.params;

    if (!inferenceId) {
      return res.status(400).json({
        error: 'Missing required parameter: inferenceId'
      });
    }

    // ✅ Find inference job
    const inferenceJob = await InferenceJob.findOne({ inferenceId })
      .populate('modelId', 'modelId modelVersion modelType metrics')
      .populate('datasetId', 'company project version testCount deletedAt')
      .lean();

    if (!inferenceJob) {
      return res.status(404).json({
        error: 'Inference job not found',
        inferenceId: inferenceId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, inferenceJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this inference job'
        });
      }
    }

    // ✅ Format response
    const response = {
      inferenceId: inferenceJob.inferenceId,
      status: inferenceJob.status,
      progress: inferenceJob.progress,
      sourceType: inferenceJob.sourceType,
      regionName: inferenceJob.regionName || null,
      surveyName: inferenceJob.surveyName || null,
      model: {
        modelId: inferenceJob.modelId?.modelId,
        modelVersion: inferenceJob.modelId?.modelVersion,
        modelType: inferenceJob.modelId?.modelType,
        metrics: inferenceJob.modelId?.metrics
      },
      startedAt: inferenceJob.startedAt,
      completedAt: inferenceJob.completedAt,
      cancelledAt: inferenceJob.cancelledAt,
      error: inferenceJob.error
    };

    // ✅ Check if dataset is deleted (for test_folder type)
    if (inferenceJob.datasetId) {
      if (inferenceJob.datasetId.deletedAt) {
        response.dataset = {
          datasetId: inferenceJob.datasetId._id.toString(),
          deleted: true,
          deletedAt: inferenceJob.datasetId.deletedAt,
          message: 'Dataset has been deleted'
        };
      } else {
        response.dataset = {
          datasetId: inferenceJob.datasetId._id.toString(),
          company: inferenceJob.datasetId.company,
          project: inferenceJob.datasetId.project,
          version: inferenceJob.datasetId.version,
          testCount: inferenceJob.datasetId.testCount
        };
      }
    }

    // ✅ Include results summary if completed
    if (inferenceJob.status === 'completed' && inferenceJob.results) {
      response.results = {
        totalDetections: inferenceJob.results.totalDetections,
        averageConfidence: inferenceJob.results.averageConfidence,
        detectionsByClass: inferenceJob.results.detectionsByClass
      };
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('Error getting inference status:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/inference/:inferenceId/results
 * 
 * Get full inference results (annotated images list, metadata)
 * 
 * Query params:
 *   - filter: 'all' | 'good' | 'defect' (default: 'all')
 */
const getInferenceResults = async (req, res) => {
  try {
    const { inferenceId } = req.params;
    const { filter = 'all' } = req.query; // Filter: 'all', 'good', or 'defect'

    if (!inferenceId) {
      return res.status(400).json({
        error: 'Missing required parameter: inferenceId'
      });
    }

    // ✅ Validate filter parameter
    if (!['all', 'good', 'defect'].includes(filter)) {
      return res.status(400).json({
        error: 'Invalid filter parameter',
        message: 'Filter must be one of: all, good, defect',
        provided: filter
      });
    }

    // ✅ Find inference job
    const inferenceJob = await InferenceJob.findOne({ inferenceId }).lean();

    if (!inferenceJob) {
      return res.status(404).json({
        error: 'Inference job not found',
        inferenceId: inferenceId
      });
    }

    // ✅ Check if results are available
    if (inferenceJob.status !== 'completed') {
      return res.status(400).json({
        error: 'Inference job is not completed',
        status: inferenceJob.status,
        message: 'Results are only available for completed jobs'
      });
    }

    if (!inferenceJob.results || !inferenceJob.results.resultsPath) {
      return res.status(404).json({
        error: 'Results not found',
        inferenceId: inferenceId
      });
    }

    // ✅ Read metadata JSON file if it exists
    let metadata = null;
    if (inferenceJob.results.metadataPath && fs.existsSync(inferenceJob.results.metadataPath)) {
      try {
        const metadataContent = fs.readFileSync(inferenceJob.results.metadataPath, 'utf8');
        metadata = JSON.parse(metadataContent);
      } catch (error) {
        console.warn(`Could not read metadata file: ${error.message}`);
      }
    }

    // ✅ List images from good/ and defect/ folders
    let goodImages = [];
    let defectImages = [];

    // ✅ Get good images
    if (inferenceJob.results.goodImagesPath && fs.existsSync(inferenceJob.results.goodImagesPath)) {
      try {
        const files = fs.readdirSync(inferenceJob.results.goodImagesPath);
        goodImages = files
          .filter(file => /\.(jpg|jpeg|png)$/i.test(file))
          .map(file => ({
            filename: file,
            tag: 'good',
            url: `/api/inference/${inferenceId}/image/${file}?folder=good`
          }));
      } catch (error) {
        console.warn(`Could not list good images: ${error.message}`);
      }
    }

    // ✅ Get defect images
    if (inferenceJob.results.defectImagesPath && fs.existsSync(inferenceJob.results.defectImagesPath)) {
      try {
        const files = fs.readdirSync(inferenceJob.results.defectImagesPath);
        defectImages = files
          .filter(file => /\.(jpg|jpeg|png)$/i.test(file))
          .map(file => ({
            filename: file,
            tag: 'defect',
            url: `/api/inference/${inferenceId}/image/${file}?folder=defect`
          }));
      } catch (error) {
        console.warn(`Could not list defect images: ${error.message}`);
      }
    }

    // ✅ Always get videos from annotated folder (videos are not categorized into good/defect)
    let videos = [];
    if (inferenceJob.results.annotatedImagesPath && fs.existsSync(inferenceJob.results.annotatedImagesPath)) {
      try {
        const files = fs.readdirSync(inferenceJob.results.annotatedImagesPath);
        videos = files
          .filter(file => /\.(mp4|avi|mov|mkv|webm|flv|wmv|m4v)$/i.test(file))
          .map(file => ({
            filename: file,
            fileType: 'video',
            url: `/api/inference/${inferenceId}/image/${file}` // Uses same endpoint as images
          }));
      } catch (error) {
        console.warn(`Could not list videos from annotated folder: ${error.message}`);
      }
    }

    // ✅ Backward compatibility: If no good/defect folders exist, fall back to annotated folder for images
    let fallbackImages = [];
    const hasNewStructure = goodImages.length > 0 || defectImages.length > 0 || 
                            (inferenceJob.results.goodImagesPath && inferenceJob.results.defectImagesPath);
    
    if (!hasNewStructure && inferenceJob.results.annotatedImagesPath && fs.existsSync(inferenceJob.results.annotatedImagesPath)) {
      try {
        const files = fs.readdirSync(inferenceJob.results.annotatedImagesPath);
        fallbackImages = files
          .filter(file => /\.(jpg|jpeg|png)$/i.test(file))
          .map(file => ({
            filename: file,
            tag: 'unreviewed', // Old jobs don't have tags
            url: `/api/inference/${inferenceId}/image/${file}` // No folder param for old jobs
          }));
      } catch (error) {
        console.warn(`Could not list annotated images: ${error.message}`);
      }
    }

    // ✅ Calculate statistics
    const totalImages = hasNewStructure 
      ? (goodImages.length + defectImages.length)
      : fallbackImages.length;
    const totalVideos = videos.length;
    const totalFiles = totalImages + totalVideos;
    const goodCount = hasNewStructure 
      ? (inferenceJob.results.goodCount || goodImages.length)
      : 0;
    const defectCount = hasNewStructure
      ? (inferenceJob.results.defectCount || defectImages.length)
      : 0;

    const corrosionStats = metadata?.corrosionStats || null;
    let classNames = classNamesFromMetadata(metadata);
    if (!classNames.length && inferenceJob.modelId) {
      try {
        const model = await Model.findById(inferenceJob.modelId);
        // skipCheckpoint: never spawn Python just to label results — that can
        // add 15–60s AFTER the job already finished. New jobs write classNames
        // into metadata; yaml/json mapping is the fast fallback.
        if (model) classNames = await getClassNamesForTrainedModel(model, { skipCheckpoint: true });
      } catch (err) {
        console.warn('[inference results] classNames lookup failed:', err.message);
      }
    }
    if (corrosionStats) {
      corrosionStats.byClass = stampClassIds(corrosionStats.byClass || [], classNames);
      corrosionStats.classNames = classNames;
    }
    const imageStatsByName = {};
    const metaImages = metadata?.images || metadata?.files || [];
    const basename = (name) => String(name || '').split(/[/\\]/).pop();
    for (const img of metaImages) {
      const name = img.filePath || img.filename;
      if (!name) continue;
      const stats = {
        corrosionPercentTotal: img.corrosionPercentTotal,
        byClass: stampClassIds(img.byClass || [], classNames),
        instanceCount: img.instanceCount ?? img.detectionCount,
      };
      imageStatsByName[name] = stats;
      imageStatsByName[basename(name)] = stats;
    }

    const attachStats = (list) =>
      list.map((item) => ({
        ...item,
        ...(imageStatsByName[item.filename] || imageStatsByName[basename(item.filename)] || {}),
      }));

    goodImages = attachStats(goodImages);
    defectImages = attachStats(defectImages);
    fallbackImages = attachStats(fallbackImages);

    // ✅ Apply filter if specified
    let filteredImages = [];
    if (hasNewStructure) {
      if (filter === 'good') {
        filteredImages = goodImages;
      } else if (filter === 'defect') {
        filteredImages = defectImages;
      } else {
        filteredImages = [...goodImages, ...defectImages];
      }
    } else {
      filteredImages = fallbackImages;
    }

    // ✅ Format response
    const response = {
      inferenceId: inferenceJob.inferenceId,
      status: inferenceJob.status,
      regionName: inferenceJob.regionName || null,
      surveyName: inferenceJob.surveyName || null,
      filter: filter,
      results: {
        resultsPath: inferenceJob.results.resultsPath,
        annotatedImagesPath: inferenceJob.results.annotatedImagesPath,
        goodImagesPath: inferenceJob.results.goodImagesPath,
        defectImagesPath: inferenceJob.results.defectImagesPath,
        metadataPath: inferenceJob.results.metadataPath,
        totalDetections: inferenceJob.results.totalDetections || 0,
        averageConfidence: inferenceJob.results.averageConfidence || 0,
        detectionsByClass: inferenceJob.results.detectionsByClass || [],
        corrosion: corrosionStats,
        annotatedImages: {
          good: goodImages,
          defect: defectImages,
          all: filteredImages
        },
        // ✅ Videos (always from annotated folder, not categorized)
        videos: videos,
        // ✅ Backward compatibility: flat array for old jobs (deprecated, use annotatedImages.all)
        // This ensures old frontend code still works
        ...(fallbackImages.length > 0 && !hasNewStructure ? { 
          images: fallbackImages // Old format for backward compatibility
        } : {}),
        // ✅ Statistics
        statistics: {
          total: totalFiles, // Total files (images + videos)
          totalImages: totalImages,
          totalVideos: totalVideos,
          good: goodCount,
          defect: defectCount,
          // Indicate if this is an old job without tagging
          hasTags: hasNewStructure
        },
        metadata: metadata
      },
      completedAt: inferenceJob.completedAt,
      confirmed: inferenceJob.confirmed || false,
      confirmedAt: inferenceJob.confirmedAt || null,
      assessment: inferenceJob.assessment || null
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error('Error getting inference results:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/inference/:inferenceId/image/:filename
 * 
 * Serve annotated image or video file from inference results
 * 
 * Query params:
 *   - folder: 'good' | 'defect' | undefined (default: searches annotated folder, then good/defect)
 * 
 * Note: Videos are always served from annotated folder (not good/defect)
 */
const getAnnotatedImage = async (req, res) => {
  try {
    const { inferenceId, filename } = req.params;
    const { folder } = req.query; // Optional: 'good' or 'defect'

    if (!inferenceId || !filename) {
      return res.status(400).json({
        error: 'Missing required parameters: inferenceId and filename'
      });
    }

    // ✅ Find inference job to get results path
    const inferenceJob = await InferenceJob.findOne({ inferenceId }).lean();

    if (!inferenceJob) {
      return res.status(404).json({
        error: 'Inference job not found',
        inferenceId: inferenceId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, inferenceJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this inference job'
        });
      }
    }

    // ✅ Check if results are available
    if (inferenceJob.status !== 'completed') {
      return res.status(400).json({
        error: 'Inference job is not completed',
        status: inferenceJob.status,
        message: 'Images are only available for completed jobs'
      });
    }

    if (!inferenceJob.results || !inferenceJob.results.resultsPath) {
      return res.status(404).json({
        error: 'Results not found',
        inferenceId: inferenceId
      });
    }

    // ✅ Determine which folder to look in
    const resolved = resolveInferenceImagePath(inferenceJob, filename, folder);

    // ✅ If not found, return 404
    if (!resolved) {
      return res.status(404).json({
        error: 'File not found',
        filename: filename,
        inferenceId: inferenceId,
        searchedFolders: folder ? [folder] : ['good', 'defect', 'annotated'],
        message: 'Note: Videos are stored in annotated folder'
      });
    }

    const { imagePath } = resolved;

    // ✅ Send file (works for both images and videos)
    // Set appropriate content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    if (['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v'].includes(ext)) {
      res.setHeader('Content-Type', 'video/mp4'); // Default to mp4, browser will handle it
    }
    res.sendFile(imagePath);

  } catch (error) {
    console.error('Error serving annotated image:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * POST /api/inference/:inferenceId/cancel
 * 
 * Cancel a running inference job
 */
const cancelInference = async (req, res) => {
  try {
    const { inferenceId } = req.params;

    if (!inferenceId) {
      return res.status(400).json({
        error: 'Missing required parameter: inferenceId'
      });
    }

    // ✅ Find inference job
    const inferenceJob = await InferenceJob.findOne({ inferenceId });

    if (!inferenceJob) {
      return res.status(404).json({
        error: 'Inference job not found',
        inferenceId: inferenceId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, inferenceJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this inference job'
        });
      }
    }

    // ✅ Check if job can be cancelled
    if (inferenceJob.status === 'completed') {
      return res.status(400).json({
        error: 'Cannot cancel a completed job',
        status: inferenceJob.status
      });
    }

    if (inferenceJob.status === 'cancelled') {
      return res.status(400).json({
        error: 'Job is already cancelled',
        status: inferenceJob.status
      });
    }

    // ✅ Update status to cancelled
    inferenceJob.status = 'cancelled';
    inferenceJob.cancelledAt = new Date();
    await inferenceJob.save();

    // ✅ Try to remove from queue if still queued
    // Note: If job is already running, worker will check status and stop processing

    return res.status(200).json({
      inferenceId: inferenceJob.inferenceId,
      status: inferenceJob.status,
      message: 'Inference job cancelled successfully'
    });

  } catch (error) {
    console.error('Error cancelling inference:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * POST /api/inference/:inferenceId/confirm
 *
 * Marks a completed inference job as human-reviewed. The job is already
 * visible in its survey from the moment photos were uploaded — this is a
 * review acknowledgment recorded for the audit trail, not a gate on that
 * visibility. (POST, not PATCH: React Native's networking layer on Android
 * has a known history of unreliable PATCH support.)
 */
/**
 * PUT /api/inference/:inferenceId/assessment
 * Body: { severity?: 'low'|'medium'|'high'|'critical', damageTags?: string[] }
 *
 * Saves (or changes) the inspector's assessment of an already-saved part —
 * severity they confirm plus the coating damage types they see.
 */
const setInferenceAssessment = async (req, res) => {
  try {
    const { inferenceId } = req.params;
    const inferenceJob = await InferenceJob.findOne({ inferenceId });
    if (!inferenceJob) {
      return res.status(404).json({ error: 'Inference job not found', inferenceId });
    }
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, inferenceJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this inference job'
        });
      }
    }
    if (inferenceJob.status !== 'completed') {
      return res.status(400).json({ error: 'Cannot assess a job that is not completed', status: inferenceJob.status });
    }

    let assessment;
    try {
      assessment = normalizeAssessment(req.body);
    } catch (validationError) {
      return res.status(400).json({ error: 'Invalid assessment', message: validationError.message });
    }
    if (!assessment) {
      return res.status(400).json({ error: 'Nothing to save', message: 'Provide a severity and/or damage types.' });
    }

    inferenceJob.assessment = {
      ...assessment,
      assessedBy: req.user?.email || null,
      assessedAt: new Date()
    };
    await inferenceJob.save();

    auditService.logAction({
      action: 'update',
      resourceType: 'inference',
      resourceId: inferenceJob.inferenceId,
      details: {
        company: inferenceJob.company,
        project: inferenceJob.project,
        surveyName: inferenceJob.surveyName,
        regionName: inferenceJob.regionName,
        assessment
      },
      req
    });

    return res.status(200).json({ inferenceId: inferenceJob.inferenceId, assessment: inferenceJob.assessment });
  } catch (error) {
    console.error('Error saving inference assessment:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

const confirmInferenceJob = async (req, res) => {
  try {
    const { inferenceId } = req.params;

    if (!inferenceId) {
      return res.status(400).json({
        error: 'Missing required parameter: inferenceId'
      });
    }

    const inferenceJob = await InferenceJob.findOne({ inferenceId });

    if (!inferenceJob) {
      return res.status(404).json({
        error: 'Inference job not found',
        inferenceId: inferenceId
      });
    }

    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, inferenceJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this inference job'
        });
      }
    }

    if (inferenceJob.status !== 'completed') {
      return res.status(400).json({
        error: 'Cannot confirm a job that is not completed',
        status: inferenceJob.status
      });
    }

    // Confirming can carry the inspector's assessment (severity + damage
    // types) in the same call, so it's saved atomically with the sign-off.
    let assessment = null;
    try {
      assessment = normalizeAssessment(req.body && req.body.assessment);
    } catch (validationError) {
      return res.status(400).json({ error: 'Invalid assessment', message: validationError.message });
    }
    if (assessment) {
      inferenceJob.assessment = {
        ...assessment,
        assessedBy: req.user?.email || null,
        assessedAt: new Date()
      };
    }

    inferenceJob.confirmed = true;
    inferenceJob.confirmedAt = new Date();
    inferenceJob.confirmedBy = req.user ? req.user.id : null;
    await inferenceJob.save();

    auditService.logAction({
      action: 'update',
      resourceType: 'inference',
      resourceId: inferenceJob.inferenceId,
      details: {
        company: inferenceJob.company,
        project: inferenceJob.project,
        surveyName: inferenceJob.surveyName,
        regionName: inferenceJob.regionName,
        confirmed: true,
        ...(assessment ? { assessment } : {})
      },
      req
    });

    return res.status(200).json({
      inferenceId: inferenceJob.inferenceId,
      confirmed: inferenceJob.confirmed,
      confirmedAt: inferenceJob.confirmedAt,
      assessment: inferenceJob.assessment || null
    });

  } catch (error) {
    console.error('Error confirming inference job:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * DELETE /api/inference/:inferenceId
 *
 * Delete inference job and its results (files + MongoDB document)
 */
const deleteInference = async (req, res) => {
  try {
    const { inferenceId } = req.params;

    if (!inferenceId) {
      return res.status(400).json({
        error: 'Missing required parameter: inferenceId'
      });
    }

    // ✅ Get user permissions
    const { checkPermission } = require('../utils/permissions');
    const userRole = req.user ? req.user.role : null;
    const userId = req.user ? req.user.id : null;

    if (!userRole || !userId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required'
      });
    }

    const hasDeleteProjects = checkPermission(userRole, 'deleteProjects');
    const hasDeleteOwnInference = checkPermission(userRole, 'deleteOwnInference');

    // ✅ Check if user has any delete permission
    if (!hasDeleteProjects && !hasDeleteOwnInference) {
      return res.status(403).json({
        error: 'Permission denied',
        message: 'You do not have permission to delete inference jobs'
      });
    }

    // ✅ Find inference job
    const inferenceJob = await InferenceJob.findOne({ inferenceId });

    if (!inferenceJob) {
      return res.status(404).json({
        error: 'Inference job not found',
        inferenceId: inferenceId
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, inferenceJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this inference job'
        });
      }
    }

    // ✅ If user only has deleteOwnInference (not deleteProjects), check ownership
    if (!hasDeleteProjects && hasDeleteOwnInference) {
      if (!inferenceJob.createdBy || inferenceJob.createdBy !== userId) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'You can only delete your own inference jobs'
        });
      }
    }

    // ✅ Check if job is running (cannot delete running jobs)
    if (inferenceJob.status === 'running' || inferenceJob.status === 'queued') {
      return res.status(400).json({
        error: 'Cannot delete a running or queued job',
        status: inferenceJob.status,
        message: 'Please cancel the job first, then delete it'
      });
    }

    // ✅ Delete results folder from disk if it exists
    if (inferenceJob.results && inferenceJob.results.resultsPath) {
      const resultsPath = inferenceJob.results.resultsPath;
      
      if (fs.existsSync(resultsPath)) {
        try {
          // Use fs.rmSync with recursive option (Node.js 14+)
          fs.rmSync(resultsPath, { recursive: true, force: true });
          console.log(`✅ Deleted results folder: ${resultsPath}`);
        } catch (error) {
          console.warn(`⚠️ Could not delete results folder: ${error.message}`);
          // Continue with MongoDB deletion even if file deletion fails
        }
      }
    }

    // ✅ Delete MongoDB document
    await InferenceJob.deleteOne({ inferenceId });

    return res.status(200).json({
      inferenceId: inferenceId,
      message: 'Inference job and results deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting inference:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Recomputes job-level detection/corrosion aggregates from a filtered list of
 * per-image metadata entries. Mirrors the averaging the Python inference
 * script does at job-completion time (mean of per-image percents, weighted
 * by how many images actually had that class), so a job that's had an image
 * removed reports numbers consistent with a job that was simply never given
 * that image in the first place.
 */
function recomputeAggregatesFromImages(images, classNames) {
  let totalDetections = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  const byClassDetections = {}; // className -> { count, confidenceSum, confidenceCount }
  const corrosionBuckets = {}; // classId -> { class, classId, percentSum, n, count }

  for (const image of images) {
    for (const detection of image.detections || []) {
      totalDetections += 1;
      if (typeof detection.confidence === 'number') {
        confidenceSum += detection.confidence;
        confidenceCount += 1;
      }
      const key = detection.class || 'unknown';
      const bucket = byClassDetections[key] || { count: 0, confidenceSum: 0, confidenceCount: 0 };
      bucket.count += 1;
      if (typeof detection.confidence === 'number') {
        bucket.confidenceSum += detection.confidence;
        bucket.confidenceCount += 1;
      }
      byClassDetections[key] = bucket;
    }

    for (const row of image.byClass || []) {
      const key = row.classId ?? row.class;
      const bucket = corrosionBuckets[key] || {
        class: row.class,
        classId: row.classId ?? null,
        percentSum: 0,
        n: 0,
        count: 0,
      };
      if (typeof row.percent === 'number') {
        bucket.percentSum += row.percent;
        bucket.n += 1;
      }
      bucket.count += Number(row.count) || 0;
      corrosionBuckets[key] = bucket;
    }
  }

  const detectionsByClass = Object.entries(byClassDetections).map(([className, b]) => ({
    className,
    count: b.count,
    avgConfidence: b.confidenceCount ? b.confidenceSum / b.confidenceCount : 0,
  }));

  const percents = images
    .map((img) => img.corrosionPercentTotal)
    .filter((n) => typeof n === 'number' && Number.isFinite(n));
  const meanCorrosionPercent = percents.length
    ? percents.reduce((sum, n) => sum + n, 0) / percents.length
    : 0;

  const byClass = Object.values(corrosionBuckets)
    .map((b) => ({
      class: b.class,
      classId: b.classId,
      meanPercent: b.n ? b.percentSum / b.n : 0,
      count: b.count,
    }))
    .sort((a, b) => b.meanPercent - a.meanPercent);

  return {
    totalDetections,
    averageConfidence: confidenceCount ? confidenceSum / confidenceCount : 0,
    detectionsByClass,
    corrosionStats: {
      imageCount: images.length,
      meanCorrosionPercent,
      byClass,
      classNames: classNames || [],
    },
  };
}

/**
 * DELETE /api/inference/:inferenceId/image/:filename
 *
 * Deletes a single image from a completed inference job's results and
 * recomputes the job's aggregate stats (mean corrosion %, byClass, detection
 * counts) from the remaining images. Used by the mobile app so a crew member
 * can drop a bad/duplicate photo after inspecting a part, without having to
 * delete and redo the whole part.
 */
const deleteInferenceImage = async (req, res) => {
  try {
    const { inferenceId, filename } = req.params;

    if (!inferenceId || !filename) {
      return res.status(400).json({
        error: 'Missing required parameters: inferenceId, filename'
      });
    }

    const { checkPermission } = require('../utils/permissions');
    const userRole = req.user ? req.user.role : null;
    const userId = req.user ? req.user.id : null;

    if (!userRole || !userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const hasDeleteProjects = checkPermission(userRole, 'deleteProjects');
    const hasDeleteOwnInference = checkPermission(userRole, 'deleteOwnInference');

    if (!hasDeleteProjects && !hasDeleteOwnInference) {
      return res.status(403).json({
        error: 'Permission denied',
        message: 'You do not have permission to modify inference jobs'
      });
    }

    const inferenceJob = await InferenceJob.findOne({ inferenceId });
    if (!inferenceJob) {
      return res.status(404).json({ error: 'Inference job not found', inferenceId });
    }

    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, inferenceJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this inference job'
        });
      }
    }

    if (!hasDeleteProjects && hasDeleteOwnInference) {
      if (!inferenceJob.createdBy || inferenceJob.createdBy !== userId) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'You can only modify your own inference jobs'
        });
      }
    }

    if (inferenceJob.status === 'running' || inferenceJob.status === 'queued') {
      return res.status(400).json({
        error: 'Cannot modify a job that is still processing',
        status: inferenceJob.status
      });
    }

    const metadataPath = inferenceJob.results && inferenceJob.results.metadataPath;
    if (!metadataPath || !fs.existsSync(metadataPath)) {
      return res.status(404).json({ error: 'Results metadata not found for this job' });
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const matchesFile = (f) => f && path.basename(String(f.filePath || '')) === filename;

    const imageEntry = (metadata.images || []).find(matchesFile) || (metadata.files || []).find(matchesFile);
    if (!imageEntry) {
      return res.status(404).json({ error: 'Image not found in this job', filename });
    }
    if (imageEntry.fileType && imageEntry.fileType !== 'image') {
      return res.status(400).json({ error: 'Only images can be deleted this way, not videos' });
    }
    if ((metadata.images || []).length <= 1 && (metadata.files || []).filter((f) => f.fileType !== 'video').length <= 1) {
      return res.status(400).json({
        error: 'Cannot delete the last image',
        message: 'A part must keep at least one photo. Delete the whole part instead.'
      });
    }

    metadata.images = (metadata.images || []).filter((f) => !matchesFile(f));
    metadata.files = (metadata.files || []).filter((f) => !matchesFile(f));

    const recomputed = recomputeAggregatesFromImages(metadata.images, metadata.classNames);
    metadata.totalImages = metadata.images.length;
    metadata.totalFiles = metadata.files.length;
    metadata.totalDetections = recomputed.totalDetections;
    metadata.averageConfidence = recomputed.averageConfidence;
    metadata.detectionsByClass = recomputed.detectionsByClass;
    metadata.corrosionStats = recomputed.corrosionStats;

    // Write atomically so a crash mid-write can never leave a corrupt metadata.json.
    const tmpPath = `${metadataPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2));
    fs.renameSync(tmpPath, metadataPath);

    const wasDefect = (imageEntry.detectionCount ?? imageEntry.instanceCount ?? 0) > 0;
    const dirsToClean = [
      inferenceJob.results.goodImagesPath,
      inferenceJob.results.defectImagesPath,
      inferenceJob.results.annotatedImagesPath,
    ].filter(Boolean);
    for (const dir of dirsToClean) {
      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.warn(`⚠️ Could not delete image file: ${filePath} — ${err.message}`);
        }
      }
    }

    inferenceJob.results.totalDetections = recomputed.totalDetections;
    inferenceJob.results.averageConfidence = recomputed.averageConfidence;
    inferenceJob.results.detectionsByClass = recomputed.detectionsByClass;
    inferenceJob.results.corrosionStats = recomputed.corrosionStats;
    if (wasDefect) {
      inferenceJob.results.defectCount = Math.max(0, (inferenceJob.results.defectCount || 0) - 1);
    } else {
      inferenceJob.results.goodCount = Math.max(0, (inferenceJob.results.goodCount || 0) - 1);
    }
    inferenceJob.markModified('results');
    await inferenceJob.save();

    return res.status(200).json({
      inferenceId,
      filename,
      message: 'Image deleted',
      remainingImages: metadata.images.length,
      corrosionStats: recomputed.corrosionStats
    });

  } catch (error) {
    console.error('Error deleting inference image:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * POST /api/inference/:inferenceId/images
 * multipart: files[] (already-annotated images), stats (JSON string:
 * { classNames, images: [{filename, corrosionPercentTotal, byClass, instanceCount}] })
 *
 * Appends already-computed images (from the mobile app's on-device model) to
 * an EXISTING completed job's results and recomputes the job's aggregates
 * from the combined image set — the mirror image of deleteInferenceImage
 * above. Used when a crew member realizes they missed a photo for a part
 * that was already surveyed and wants to add it to that same survey entry
 * rather than create a separate one.
 */
const addInferenceImages = async (req, res) => {
  try {
    const { inferenceId } = req.params;
    const uploadedImages = Array.isArray(req.files) ? req.files : [];

    if (!inferenceId) {
      return res.status(400).json({ error: 'Missing required parameter: inferenceId' });
    }
    if (uploadedImages.length === 0) {
      return res.status(400).json({ error: 'No files uploaded', message: 'At least one image is required.' });
    }

    const { checkPermission } = require('../utils/permissions');
    const userRole = req.user ? req.user.role : null;
    const userId = req.user ? req.user.id : null;

    if (!userRole || !userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const hasDeleteProjects = checkPermission(userRole, 'deleteProjects');
    const hasDeleteOwnInference = checkPermission(userRole, 'deleteOwnInference');

    if (!hasDeleteProjects && !hasDeleteOwnInference) {
      return res.status(403).json({
        error: 'Permission denied',
        message: 'You do not have permission to modify inference jobs'
      });
    }

    const inferenceJob = await InferenceJob.findOne({ inferenceId });
    if (!inferenceJob) {
      return res.status(404).json({ error: 'Inference job not found', inferenceId });
    }

    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, inferenceJob.company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this inference job'
        });
      }
    }

    if (!hasDeleteProjects && hasDeleteOwnInference) {
      if (!inferenceJob.createdBy || inferenceJob.createdBy !== userId) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'You can only modify your own inference jobs'
        });
      }
    }

    if (inferenceJob.status === 'running' || inferenceJob.status === 'queued') {
      return res.status(400).json({
        error: 'Cannot modify a job that is still processing',
        status: inferenceJob.status
      });
    }

    const metadataPath = inferenceJob.results && inferenceJob.results.metadataPath;
    const annotatedImagesPath = inferenceJob.results && inferenceJob.results.annotatedImagesPath;
    if (!metadataPath || !fs.existsSync(metadataPath) || !annotatedImagesPath) {
      return res.status(404).json({ error: 'Results metadata not found for this job' });
    }

    let stats;
    try {
      stats = JSON.parse(req.body.stats || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid stats payload', message: 'stats must be valid JSON.' });
    }
    const statsByFilename = {};
    for (const img of Array.isArray(stats.images) ? stats.images : []) {
      if (img?.filename) statsByFilename[img.filename] = img;
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!fs.existsSync(annotatedImagesPath)) {
      await fs.promises.mkdir(annotatedImagesPath, { recursive: true });
    }

    const existingNames = new Set(
      (metadata.images || []).map((f) => path.basename(String(f.filePath || '')))
    );

    const newEntries = [];
    for (const file of uploadedImages) {
      let destName = file.originalname;
      if (existingNames.has(destName)) {
        const ext = path.extname(destName);
        const base = path.basename(destName, ext);
        destName = `${base}_${Date.now()}${ext}`;
      }
      existingNames.add(destName);
      const destPath = path.join(annotatedImagesPath, destName);
      try {
        await fs.promises.rename(file.path, destPath);
      } catch {
        await fs.promises.copyFile(file.path, destPath);
        await fs.promises.unlink(file.path);
      }
      const s = statsByFilename[file.originalname] || {};
      newEntries.push({
        filePath: destName,
        corrosionPercentTotal: typeof s.corrosionPercentTotal === 'number' ? s.corrosionPercentTotal : null,
        byClass: Array.isArray(s.byClass) ? s.byClass : [],
        instanceCount: typeof s.instanceCount === 'number' ? s.instanceCount : 0,
      });
    }

    metadata.images = [...(metadata.images || []), ...newEntries];
    metadata.files = [...(metadata.files || []), ...newEntries];
    if (Array.isArray(stats.classNames) && stats.classNames.length > 0) {
      metadata.classNames = stats.classNames;
    }

    const recomputed = recomputeAggregatesFromImages(metadata.images, metadata.classNames);
    metadata.totalImages = metadata.images.length;
    metadata.totalFiles = metadata.files.length;
    metadata.totalDetections = recomputed.totalDetections;
    metadata.averageConfidence = recomputed.averageConfidence;
    metadata.detectionsByClass = recomputed.detectionsByClass;
    metadata.corrosionStats = recomputed.corrosionStats;

    // Write atomically so a crash mid-write can never leave a corrupt metadata.json.
    const tmpPath = `${metadataPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2));
    fs.renameSync(tmpPath, metadataPath);

    inferenceJob.results.totalDetections = recomputed.totalDetections;
    inferenceJob.results.averageConfidence = recomputed.averageConfidence;
    inferenceJob.results.detectionsByClass = recomputed.detectionsByClass;
    inferenceJob.results.corrosionStats = recomputed.corrosionStats;
    for (const entry of newEntries) {
      if ((entry.instanceCount || 0) > 0) {
        inferenceJob.results.defectCount = (inferenceJob.results.defectCount || 0) + 1;
      } else {
        inferenceJob.results.goodCount = (inferenceJob.results.goodCount || 0) + 1;
      }
    }
    if (inferenceJob.progress) {
      inferenceJob.progress.totalImages = metadata.images.length;
      inferenceJob.progress.processedImages = metadata.images.length;
    }
    inferenceJob.markModified('results');
    inferenceJob.markModified('progress');
    await inferenceJob.save();

    await auditService.logAction({
      action: 'update',
      resourceType: 'inference',
      resourceId: inferenceId,
      details: { addedImages: newEntries.length, totalImages: metadata.images.length },
      req,
    });

    return res.status(200).json({
      inferenceId,
      addedImages: newEntries.length,
      totalImages: metadata.images.length,
      corrosionStats: recomputed.corrosionStats,
    });
  } catch (error) {
    console.error('Error adding inference images:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/inference/models
 * 
 * List available trained models for company/project
 * 
 * Query params: company, project
 */
const listAvailableModels = async (req, res) => {
  try {
    const { company, project } = req.query;

    // ✅ Validate required query parameters
    if (!company || !project) {
      return res.status(400).json({
        error: 'Missing required query parameters',
        required: ['company', 'project']
      });
    }

    // ✅ Find all models for company/project
    const models = await Model.find({ company, project })
      .sort({ createdAt: -1 }) // Newest first
      .select(
        'modelId modelVersion modelType metrics bestCheckpointPath storagePath datasetVersion createdAt'
      )
      .lean();

    // ✅ Filter models that have valid checkpoint files
    const validModels = models.filter(model => {
      return model.bestCheckpointPath && fs.existsSync(model.bestCheckpointPath);
    });

    // ✅ Format response (classNames: ordered label strings matching inference detection `class`)
    const formattedModels = await Promise.all(
      validModels.map(async (model) => {
        const metrics = await hydrateAndPersistModelMetrics(Model, model);
        const classNames = await getClassNamesForTrainedModel(model);

        return {
          modelId: model.modelId,
          modelVersion: model.modelVersion,
          modelType: model.modelType,
          name: formatModelNameWithMap(model.modelType, model.modelVersion, metrics?.mAP50),
          metrics: {
            mAP50: metrics?.mAP50,
            precision: metrics?.precision,
            recall: metrics?.recall
          },
          createdAt: model.createdAt,
          classNames
        };
      })
    );

    return res.status(200).json({
      models: formattedModels,
      total: formattedModels.length
    });

  } catch (error) {
    console.error('Error listing available models:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/inference
 * 
 * List all inference jobs for company/project
 * 
 * Query params: company (required), project (required), status (optional)
 */
const listInferenceJobs = async (req, res) => {
  try {
    const { company, project, status } = req.query;

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

    // ✅ Build query filter
    const filter = {
      company,
      project,
      sourceType: { $nin: ['live_camera', 'live'] },
      excludeFromHistory: { $ne: true }
    };
    if (status) {
      filter.status = status;
    }

    // ✅ Find inference jobs
    const inferenceJobs = await InferenceJob.find(filter)
      .populate('modelId', 'modelId modelVersion modelType metrics')
      .populate('datasetId', 'company project version testCount deletedAt')
      .sort({ createdAt: -1 }) // Newest first
      .lean();

    // ✅ Format response
    const formattedJobs = inferenceJobs.map(job => {
      const formatted = {
        inferenceId: job.inferenceId,
        status: job.status,
        sourceType: job.sourceType,
        regionName: job.regionName || null,
        surveyName: job.surveyName || null,
        progress: job.progress,
        model: job.modelId ? {
          modelId: job.modelId.modelId,
          modelVersion: job.modelId.modelVersion,
          modelType: job.modelId.modelType,
          metrics: job.modelId.metrics
        } : null,
        dataset: job.datasetId ? (job.datasetId.deletedAt ? {
          datasetId: job.datasetId._id.toString(),
          deleted: true,
          deletedAt: job.datasetId.deletedAt,
          message: 'Dataset has been deleted'
        } : {
          datasetId: job.datasetId._id.toString(),
          version: job.datasetId.version,
          testCount: job.datasetId.testCount
        }) : null,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
      };

      // ✅ Include results summary if completed
      if (job.status === 'completed' && job.results) {
        formatted.results = {
          totalDetections: job.results.totalDetections,
          averageConfidence: job.results.averageConfidence,
          detectionsByClass: job.results.detectionsByClass,
          hasAnnotatedImages: !!job.results.annotatedImagesPath
        };
      }

      // ✅ Include error if failed
      if (job.status === 'failed' && job.error) {
        formatted.error = job.error;
      }

      return formatted;
    });

    return res.status(200).json({
      inferenceJobs: formattedJobs,
      total: formattedJobs.length,
      company,
      project
    });

  } catch (error) {
    console.error('Error listing inference jobs:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/inference/datasets
 * 
 * List datasets with test folders for company/project
 * 
 * Query params: company, project
 */
const listDatasetsWithTestFolders = async (req, res) => {
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

    // ✅ Find datasets with status 'ready' or 'ready_to_train' and testCount > 0
    const datasets = await Dataset.find({
      company,
      project,
      status: { $in: ['ready', 'ready_to_train'] },
      testCount: { $gt: 0 }
    })
      .sort({ createdAt: -1 }) // Newest first
      .select('_id company project version status testCount totalImages createdAt datasetType annotationStatus isAugmented labelSource backupDatasetId augmentedFromVersion')
      .lean();

    // ✅ Format response (include datasetType, annotationStatus, is_augmented, labelSource for frontend badges)
    const getLabelSource = (d) => {
      if (d.isAugmented && d.labelSource) return d.labelSource;
      const dt = d.datasetType ?? (d.status === 'ready_to_train' ? 'labeled' : null);
      if (dt === 'unlabeled') return 'unlabeled';
      if (d.status === 'ready_to_train') return 'manually_labeled';
      if (d.status === 'ready' && dt === 'labeled') return 'pre_labelled';
      return null;
    };
    // For augmented datasets with null labelSource (created before fix), fetch source to derive correct labelSource
    const augmentedWithoutLabelSource = datasets.filter(
      (d) => d.isAugmented && !d.labelSource && d.backupDatasetId
    );
    const sourceLabelSourceMap = new Map();
    if (augmentedWithoutLabelSource.length > 0) {
      const sourceIds = [...new Set(augmentedWithoutLabelSource.map((d) => d.backupDatasetId.toString()))];
      const sources = await Dataset.find({ _id: { $in: sourceIds } })
        .select('_id status labelSource')
        .lean();
      for (const src of sources) {
        const ls = src.labelSource ?? (src.status === 'ready_to_train' ? 'manually_labeled' : 'pre_labelled');
        sourceLabelSourceMap.set(src._id.toString(), ls);
      }
    }
    const formattedDatasets = datasets.map(dataset => {
      let labelSource = getLabelSource(dataset);
      if (dataset.isAugmented && !labelSource && dataset.backupDatasetId) {
        labelSource = sourceLabelSourceMap.get(dataset.backupDatasetId.toString()) ?? 'pre_labelled';
      }
      return {
        datasetId: dataset._id.toString(),
        company: dataset.company,
        project: dataset.project,
        version: dataset.version,
        status: dataset.status,
        datasetType: dataset.datasetType ?? (dataset.status === 'ready_to_train' ? 'labeled' : null),
        annotationStatus: dataset.annotationStatus ?? null,
        labelSource,
        is_augmented: dataset.isAugmented ?? false,
        backup_dataset_id: dataset.backupDatasetId ? dataset.backupDatasetId.toString() : null,
        augmentedFromVersion: dataset.augmentedFromVersion || null,
        testCount: dataset.testCount,
        totalImages: dataset.totalImages,
        createdAt: dataset.createdAt
      };
    });

    return res.status(200).json({
      datasets: formattedDatasets,
      total: formattedDatasets.length
    });

  } catch (error) {
    console.error('Error listing datasets with test folders:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * POST /api/inference/edge/live — Receive inference result from edge device.
 * Accepts two formats:
 * 1. Edge format: { project_id?, class_name, confidence?, timestamp (Unix number), image (base64) }
 * 2. Original spec: { timestamp (ISO string), imageBase64, defectClasses (array) }
 * No auth required for MVP (edge devices may not send user headers).
 */
const postEdgeLive = async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({
        error: 'Invalid request body',
        message: 'Body must be valid JSON'
      });
    }

    let timestampIso;
    let imageBase64;
    let defectClasses;

    // Detect edge format: has "image" and "class_name" (and numeric timestamp)
    const isEdgeFormat = body.image != null && body.class_name != null;

    if (isEdgeFormat) {
      const { project_id, class_name, confidence, timestamp: ts, image } = body;

      if (!class_name || typeof class_name !== 'string' || class_name.trim() === '') {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'class_name is required and must be a non-empty string'
        });
      }
      if (!image || typeof image !== 'string' || image.trim() === '') {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'image is required and must be a non-empty string (base64)'
        });
      }

      const tsNum = typeof ts === 'number' ? ts : parseFloat(ts);
      if (typeof tsNum !== 'number' || Number.isNaN(tsNum)) {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'timestamp is required and must be a number (Unix seconds)'
        });
      }

      // Unix seconds (with optional fractional part) → ISO 8601
      timestampIso = new Date(tsNum * 1000).toISOString();
      imageBase64 = image.trim();
      defectClasses = [{ className: class_name.trim(), count: 1 }];
      if (typeof confidence === 'number' && !Number.isNaN(confidence)) {
        defectClasses[0].confidence = confidence;
      }
    } else {
      // Original spec: timestamp (string), imageBase64, defectClasses (array)
      const { timestamp, imageBase64: imgB64, defectClasses: dc } = body;

      if (!timestamp || typeof timestamp !== 'string' || timestamp.trim() === '') {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'timestamp is required and must be a non-empty string'
        });
      }
      if (!imgB64 || typeof imgB64 !== 'string' || imgB64.trim() === '') {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'imageBase64 is required and must be a non-empty string'
        });
      }
      if (!Array.isArray(dc)) {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'defectClasses is required and must be an array'
        });
      }

      timestampIso = timestamp.trim();
      imageBase64 = imgB64.trim();
      defectClasses = dc.map((item) => {
        if (typeof item === 'string') {
          return { className: item };
        }
        if (item && typeof item === 'object' && typeof item.className === 'string') {
          return { className: item.className, count: item.count, confidence: item.confidence };
        }
        return { className: String(item) };
      });
    }

    latestEdgeLiveEntry = {
      timestamp: timestampIso,
      imageBase64,
      defectClasses,
      receivedAt: Date.now()
    };

    return res.status(200).json({ ok: true, message: 'Received' });
  } catch (error) {
    console.error('Error in postEdgeLive:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * GET /api/inference/edge/live — Return latest edge live payload for frontend polling.
 * Frontend polls every 5s when Live Logs tab is active. Auth required (same as other inference APIs).
 */
const getEdgeLive = async (req, res) => {
  try {
    if (!latestEdgeLiveEntry) {
      return res.status(204).send();
    }

    return res.status(200).json({
      timestamp: latestEdgeLiveEntry.timestamp,
      imageBase64: latestEdgeLiveEntry.imageBase64,
      defectClasses: latestEdgeLiveEntry.defectClasses
    });
  } catch (error) {
    console.error('Error in getEdgeLive:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

module.exports = {
  startBatchInference,
  startLiveInference,
  processLiveFrame,
  stopLiveInference,
  getInferenceStatus,
  getInferenceResults,
  getAnnotatedImage,
  cancelInference,
  confirmInferenceJob,
  setInferenceAssessment,
  deleteInference,
  deleteInferenceImage,
  addInferenceImages,
  listInferenceJobs,
  listAvailableModels,
  listDatasetsWithTestFolders,
  postEdgeLive,
  getEdgeLive
};

