// workers/inferenceWorker.js
const dns = require('dns');

dns.setServers(['8.8.8.8', '1.1.1.1']);
const path = require('path');
require('dotenv').config({
  path: path.resolve(process.cwd(), '.env'),
});

const mongoose = require('mongoose');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { spawn } = require('child_process');
const { inferenceQueue } = require('../queue');
const InferenceJob = require('../models/InferenceJob');
const Model = require('../models/Model');
const Dataset = require('../models/Dataset');
const storageAdapter = require('../services/storageAdapter');
const { getClassNamesForTrainedModel } = require('../services/yoloClassNamesService');

/**
 * Inference Worker - Background Job Processor
 * 
 * This worker runs separately from the main API server and processes
 * inference jobs by:
 * - Loading trained models
 * - Running YOLO inference on test images
 * - Generating annotated images with bounding boxes
 * - Saving metadata (detections, confidence scores)
 * - Updating progress in MongoDB
 * 
 * Why run this in a worker?
 * - Inference can take time for large image sets (keeps API responsive)
 * - Can run on separate machines/containers with GPU
 * - Can process multiple inference jobs in parallel
 * - Jobs can be retried if they fail
 */

/**
 * Process a single inference job
 */
const processInferenceJob = async (job) => {
  const { inferenceId, modelId, company, project, sourceType, datasetId, testFolderPath, customFolderPath } = job.data;

  console.log(`🔮 Starting inference job ${inferenceId}...`);

  let inferenceJob = null;
  let pythonProcess = null;
  let isSaving = false; // Flag to prevent parallel saves
  let sourceFolderPath = null; // Will be set based on sourceType

  try {
    // ✅ Helper function to check if error is retryable (for document loading)
    const isRetryableErrorForLoad = (error) => {
      const retryableErrors = [
        'MongoNetworkError',
        'MongoTimeoutError',
        'MongoServerSelectionError',
        'MongoWriteConcernError'
      ];
      
      return retryableErrors.some(errorType => 
        error.name === errorType || error.constructor.name === errorType
      );
    };

    // ✅ Load inference job from MongoDB with retry
    let inferenceJob = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;

    while (!inferenceJob && retryCount < MAX_RETRIES) {
      try {
        inferenceJob = await InferenceJob.findOne({ inferenceId });
        
        if (!inferenceJob) {
          if (retryCount < MAX_RETRIES - 1) {
            console.warn(`⚠️ Inference job ${inferenceId} not found, retrying... (${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            retryCount++;
            continue;
          } else {
            throw new Error(`Inference job ${inferenceId} not found in MongoDB after ${MAX_RETRIES} attempts`);
          }
        }
      } catch (error) {
        if (isRetryableErrorForLoad(error) && retryCount < MAX_RETRIES - 1) {
          console.warn(`⚠️ MongoDB error loading inference job, retrying... (${retryCount + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
          retryCount++;
          continue;
        } else {
          throw error;
        }
      }
    }

    // ✅ Check if job was cancelled
    if (inferenceJob.status === 'cancelled') {
      console.log(`⚠️ Job ${inferenceId} was cancelled, skipping...`);
      return;
    }

    // ✅ Helper function to check if error is retryable
    const isRetryableError = (error) => {
      // Retry on network errors, timeouts, and connection issues
      const retryableErrors = [
        'MongoNetworkError',
        'MongoTimeoutError',
        'MongoServerSelectionError',
        'MongoWriteConcernError'
      ];
      
      return retryableErrors.some(errorType => 
        error.name === errorType || error.constructor.name === errorType
      );
    };

    // ✅ Helper function to recreate missing document
    const recreateInferenceJobDocument = async (inferenceId, localJob) => {
      // Only recreate if we have enough information
      if (!localJob || !localJob.modelId) {
        return null;
      }
      
      try {
        // Get model to extract company/project
        const model = await Model.findById(localJob.modelId);
        if (!model) {
          return null;
        }
        
        // Recreate document with current state
        const recreatedJob = new InferenceJob({
          inferenceId: localJob.inferenceId,
          modelId: localJob.modelId,
          company: model.company,
          project: model.project,
          sourceType: localJob.sourceType,
          status: localJob.status || 'running',
          progress: localJob.progress || {},
          results: localJob.results || {},
          startedAt: localJob.startedAt,
          completedAt: localJob.completedAt,
          cancelledAt: localJob.cancelledAt,
          error: localJob.error
        });
        
        // Add source-specific fields
        if (localJob.sourceType === 'test_folder') {
          recreatedJob.datasetId = localJob.datasetId;
          recreatedJob.testFolderPath = localJob.testFolderPath;
        } else if (localJob.sourceType === 'custom_folder') {
          recreatedJob.customFolderPath = localJob.customFolderPath;
        }
        
        return await recreatedJob.save();
      } catch (error) {
        console.error(`Failed to recreate document: ${error.message}`);
        return null;
      }
    };

    // ✅ Helper function to save inference job (prevents parallel saves)
    const saveInferenceJob = async (retryCount = 0) => {
      const MAX_RETRIES = 3;
      const RETRY_DELAY = 1000; // 1 second

      if (isSaving) {
        return; // Already saving, skip
      }
      
      try {
        isSaving = true;
        
        console.log(`💾 [SAVE] Starting save for ${inferenceId}, status: ${inferenceJob.status}`);
        
        // Fetch fresh document from DB
        const freshJob = await InferenceJob.findOne({ inferenceId });
        
        if (!freshJob) {
          const errorMsg = `Inference job ${inferenceId} not found in MongoDB during save operation`;
          console.error(`❌ ${errorMsg}`);
          console.error(`   Current status: ${inferenceJob?.status || 'unknown'}`);
          console.error(`   Attempting to recreate document...`);
          
          // Try to recreate document if it was deleted
          try {
            const recreatedJob = await recreateInferenceJobDocument(inferenceId, inferenceJob);
            if (recreatedJob) {
              console.log(`✅ Recreated inference job document: ${inferenceId}`);
              console.log(`✅ [SAVE] Successfully saved ${inferenceId} (recreated), status: ${recreatedJob.status}`);
              return;
            }
          } catch (recreateError) {
            console.error(`❌ Failed to recreate document: ${recreateError.message}`);
          }
          
          // Throw error to stop processing
          throw new Error(errorMsg);
        }
        
        // Update fresh document with current state
        freshJob.status = inferenceJob.status;
        freshJob.progress = inferenceJob.progress;
        freshJob.results = inferenceJob.results;
        freshJob.startedAt = inferenceJob.startedAt;
        freshJob.completedAt = inferenceJob.completedAt;
        freshJob.cancelledAt = inferenceJob.cancelledAt;
        freshJob.error = inferenceJob.error;
        
        // Save and validate
        const savedJob = await freshJob.save();
        
        // Validate save succeeded
        if (!savedJob || !savedJob._id) {
          throw new Error(`Save operation returned invalid result for ${inferenceId}`);
        }
        
        // Verify document exists after save
        const verifyJob = await InferenceJob.findOne({ inferenceId });
        if (!verifyJob) {
          throw new Error(`Document verification failed: ${inferenceId} not found after save`);
        }
        
        console.log(`✅ [SAVE] Successfully saved ${inferenceId}, status: ${savedJob.status}`);
        
      } catch (error) {
        // Retry on transient errors
        if (retryCount < MAX_RETRIES && isRetryableError(error)) {
          console.warn(`⚠️ Retry ${retryCount + 1}/${MAX_RETRIES} for ${inferenceId}: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
          isSaving = false;
          return saveInferenceJob(retryCount + 1);
        }
        
        // Log detailed error
        console.error(`❌ [SAVE] Failed to save ${inferenceId}:`, {
          error: error.message,
          errorType: error.constructor.name,
          status: inferenceJob?.status,
          retryCount,
          hasResults: !!inferenceJob?.results,
          stack: error.stack
        });
        
        // Re-throw to stop processing
        throw error;
      } finally {
        isSaving = false;
      }
    };

    // ✅ Get model
    const model = await Model.findById(modelId);
    if (!model) {
      throw new Error(`Model ${modelId} not found`);
    }

    const { resolveModelCheckpointPath } = require('../services/resolveModelCheckpoint');
    const checkpointPath = resolveModelCheckpointPath(model);
    if (!checkpointPath || !fs.existsSync(checkpointPath)) {
      throw new Error(`Model checkpoint not found: ${model.bestCheckpointPath}`);
    }

    // ✅ Update status to 'running'
    inferenceJob.status = 'running';
    inferenceJob.startedAt = new Date();
    await saveInferenceJob();

    console.log(`✅ Inference job ${inferenceId} status updated to 'running'`);

    // ✅ Handle different source types
    if (sourceType === 'test_folder') {
      // ✅ Validate test folder exists
      if (!testFolderPath || !fs.existsSync(testFolderPath)) {
        throw new Error(`Test folder not found: ${testFolderPath}`);
      }

      sourceFolderPath = testFolderPath;
    } else if (sourceType === 'custom_folder') {
      // ✅ Validate custom folder exists
      if (!customFolderPath || !fs.existsSync(customFolderPath)) {
        throw new Error(`Custom folder not found: ${customFolderPath}`);
      }

      sourceFolderPath = customFolderPath;
    } else if (sourceType === 'live_camera') {
      // ✅ Live camera inference (will be implemented in Phase 5)
      console.log(`📹 Live camera inference not yet implemented`);
      inferenceJob.status = 'failed';
      inferenceJob.error = 'Live camera inference not yet implemented';
      inferenceJob.completedAt = new Date();
      await saveInferenceJob();
      return; // Exit early for live_camera
    } else {
      throw new Error(`Unsupported source type: ${sourceType}`);
    }

    // ✅ Detect files in source folder (images and videos)
    const allFiles = fs.readdirSync(sourceFolderPath);
    const imageFiles = allFiles.filter(file => /\.(jpg|jpeg|png)$/i.test(file));
    const videoFiles = allFiles.filter(file => /\.(mp4|avi|mov|mkv|webm|flv|wmv|m4v)$/i.test(file));
    const totalFiles = imageFiles.length + videoFiles.length;

    if (totalFiles === 0) {
      throw new Error(`No images or videos found in folder: ${sourceFolderPath}`);
    }

    // ✅ Determine if this is a video-only, image-only, or mixed job
    const hasVideos = videoFiles.length > 0;
    const hasImages = imageFiles.length > 0;
    const isVideoOnly = hasVideos && !hasImages;
    const isMixed = hasVideos && hasImages;

    // ✅ Store file type info in job for later use
    inferenceJob.sourceFiles = {
      images: imageFiles,
      videos: videoFiles,
      total: totalFiles,
      isVideoOnly: isVideoOnly,
      isMixed: isMixed
    };

    // ✅ Update total files count (images + videos)
    inferenceJob.progress.totalImages = totalFiles; // Keep field name for backward compatibility
    await saveInferenceJob();

    console.log(`📁 Source folder: ${sourceFolderPath}`);
    console.log(`📊 Total files: ${totalFiles} (${imageFiles.length} images, ${videoFiles.length} videos)`);
    console.log(`🔍 Source type: ${sourceType}`);
    if (isVideoOnly) {
      console.log(`🎬 Video-only inference detected`);
    } else if (isMixed) {
      console.log(`⚠️ Mixed images and videos detected - videos will be processed separately`);
    }

      // ✅ Build results paths
      const resultsPath = storageAdapter.buildResultsPath(company, project, model.modelId, inferenceId);
      const annotatedImagesPath = storageAdapter.buildAnnotatedImagesPath(resultsPath);
      const metadataPath = storageAdapter.buildMetadataPath(resultsPath);

      // ✅ Create results directories
      await storageAdapter.ensureDir(resultsPath);
      await storageAdapter.ensureDir(annotatedImagesPath);

      console.log(`📦 Results path: ${resultsPath}`);

      const isRfdetr = model.modelType === 'RF_DETR';
      const pythonScriptPath = isRfdetr
        ? path.join(__dirname, '../inference-scripts/run_inference_rfdetr.py')
        : path.join(__dirname, '../inference-scripts/run_inference.py');

      const scriptExists = await fsPromises.access(pythonScriptPath).then(() => true).catch(() => false);

      if (!scriptExists) {
        throw new Error(`Python inference script not found at ${pythonScriptPath}`);
      }

      const confidenceThreshold = job.data.confidenceThreshold !== undefined
        ? parseFloat(job.data.confidenceThreshold)
        : 0.25;

      // Do not spawn a second Python process to extract class names here.
      // run_inference.py already reads model.names after YOLO() loads — this
      // extra spawn was loading the .pt file twice (often 15–60s wasted).
      // The training dataset's class names, for models whose checkpoint only has placeholders
      // (class_0, class_1, ...); run_inference.py uses them only in that case. Read from files,
      // not the checkpoint, so nothing extra is loaded.
      const classNames = await getClassNamesForTrainedModel(model.toObject(), { skipCheckpoint: true }).catch(() => []);

      const config = {
        model: checkpointPath,
        source: sourceFolderPath,
        output: resultsPath,
        conf: confidenceThreshold,
        modelType: model.modelType,
        classNames,
        // Labels the model should skip (Playground hides e.g. "product")
        hiddenClasses: Array.isArray(job.data.hiddenClasses) ? job.data.hiddenClasses : []
      };

      const configPath = path.join(resultsPath, 'inference-config.json');
      await fsPromises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

      // ✅ Spawn Python inference process
      // Use -u flag for unbuffered output (real-time logs)
      pythonProcess = spawn('python', ['-u', pythonScriptPath, '--config', configPath], {
        cwd: path.join(__dirname, '../inference-scripts'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      let logBuffer = '';
      let processedCount = 0;

      // ✅ Stream stdout (logs)
      pythonProcess.stdout.on('data', async (data) => {
        const chunk = data.toString();
        logBuffer += chunk;

        // Process line by line
        const lines = logBuffer.split('\n');
        logBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            console.log(`[Inference ${inferenceId}] ${line}`);

            // ✅ Parse progress from logs (e.g., "Processing image 5/10" or "Processing video 3/5")
            const imageProgressMatch = line.match(/Processing\s+image\s+(\d+)\/(\d+)/i);
            const videoProgressMatch = line.match(/Processing\s+video\s+(\d+)\/(\d+)/i);
            const progressMatch = imageProgressMatch || videoProgressMatch;
            
            if (progressMatch) {
              processedCount = parseInt(progressMatch[1]);
              const total = parseInt(progressMatch[2]);

              // Update progress in MongoDB
              inferenceJob.progress.processedImages = processedCount;
              inferenceJob.progress.progressPercent = Math.round((processedCount / total) * 100);
              await saveInferenceJob();
            }
          }
        }
      });

      // ✅ Stream stderr (errors and warnings)
      pythonProcess.stderr.on('data', (data) => {
        const errorLine = data.toString().trim();
        if (!errorLine) return;

        // Filter out common Python warnings
        const isWarning = /RuntimeWarning|UserWarning|FutureWarning|DeprecationWarning/i.test(errorLine);
        if (isWarning) {
          console.warn(`[Inference ${inferenceId}] Warning: ${errorLine}`);
        } else {
          console.error(`[Inference ${inferenceId}] Error: ${errorLine}`);
        }
      });

      // ✅ Handle process completion
      pythonProcess.on('close', async (code) => {
        // ✅ Wait for any pending saves to complete
        while (isSaving) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (code === 0) {
          console.log(`✅ Inference job ${inferenceId} completed successfully`);

          // ✅ Read metadata JSON file
          let metadata = null;
          if (fs.existsSync(metadataPath)) {
            try {
              const metadataContent = await fsPromises.readFile(metadataPath, 'utf8');
              metadata = JSON.parse(metadataContent);
            } catch (error) {
              console.warn(`Could not read metadata file: ${error.message}`);
            }
          }

          // ✅ Organize images into good/defect folders based on detections
          // ✅ Videos stay in annotated folder (can't be easily categorized)
          let goodImagesPath = null;
          let defectImagesPath = null;
          let goodCount = 0;
          let defectCount = 0;
          let videoCount = 0;

          // ✅ Support both old metadata format (images array) and new format (files/images/videos arrays)
          const filesToProcess = metadata?.files || metadata?.images || [];
          const imageFiles = metadata?.images || filesToProcess.filter(f => f.fileType !== 'video');
          const videoFiles = metadata?.videos || filesToProcess.filter(f => f.fileType === 'video');

          // Mobile inspect: leave JPEGs in annotated/. The results API already
          // falls back to that folder. Copying into good/defect is extra disk I/O
          // the phone flow does not use.
          const isMobileInspect = Boolean(job.data.surveyName || job.data.mobileInspect);

          if (isMobileInspect && imageFiles.length > 0) {
            for (const imageData of imageFiles) {
              if (imageData.fileType === 'video') continue;
              const hasDetections = imageData.detections && Array.isArray(imageData.detections) && imageData.detections.length > 0;
              if (hasDetections) defectCount++;
              else goodCount++;
            }
            videoCount = videoFiles.length;
            console.log(`📱 Mobile inspect: skipped good/defect copy (${goodCount} good, ${defectCount} defect stay in annotated/)`);
          } else if (metadata && (imageFiles.length > 0 || videoFiles.length > 0)) {
            // ✅ Create good/ and defect/ folders for images
            if (imageFiles.length > 0) {
              goodImagesPath = path.join(resultsPath, 'good');
              defectImagesPath = path.join(resultsPath, 'defect');
              
              await storageAdapter.ensureDir(goodImagesPath);
              await storageAdapter.ensureDir(defectImagesPath);

              console.log(`📁 Organizing images into good/defect folders...`);

              // ✅ Process each image from metadata
              for (const imageData of imageFiles) {
                // ✅ Skip video files immediately (they stay in annotated folder, not moved to good/defect)
                if (imageData.fileType === 'video') {
                  continue; // Skip videos - they're handled separately
                }
                
                const imageFilename = imageData.filePath || imageData.imagePath || imageData.annotatedPath?.split('/').pop() || imageData.annotatedPath?.split('\\').pop();
                if (!imageFilename) continue;

                // ✅ Source path: annotated image in annotatedImagesPath
                const sourceImagePath = path.join(annotatedImagesPath, imageFilename);
                
                // ✅ Check if image has detections
                const hasDetections = imageData.detections && Array.isArray(imageData.detections) && imageData.detections.length > 0;
                
                // ✅ Determine destination folder
                const destFolder = hasDetections ? defectImagesPath : goodImagesPath;
                const destImagePath = path.join(destFolder, imageFilename);

                try {
                  // ✅ Check if source image exists
                  if (fs.existsSync(sourceImagePath)) {
                    // ✅ Move image to appropriate folder
                    await fsPromises.rename(sourceImagePath, destImagePath);
                    
                    if (hasDetections) {
                      defectCount++;
                    } else {
                      goodCount++;
                    }
                  } else {
                    console.warn(`⚠️ Source image not found: ${sourceImagePath}`);
                  }
                } catch (error) {
                  console.error(`❌ Failed to move image ${imageFilename}:`, error.message);
                  // If rename fails (cross-device), try copy + delete
                  try {
                    await fsPromises.copyFile(sourceImagePath, destImagePath);
                    await fsPromises.unlink(sourceImagePath);
                    
                    if (hasDetections) {
                      defectCount++;
                    } else {
                      goodCount++;
                    }
                  } catch (copyError) {
                    console.error(`❌ Failed to copy image ${imageFilename}:`, copyError.message);
                  }
                }
              }

              console.log(`✅ Images organized: ${goodCount} good, ${defectCount} defect`);
            }

            // ✅ Count videos (they stay in annotated folder)
            videoCount = videoFiles.length;
            if (videoCount > 0) {
              console.log(`🎬 ${videoCount} video(s) processed and saved to annotated folder`);
            }
          } else {
            // ✅ If no metadata, count files in annotated folder as fallback
            if (fs.existsSync(annotatedImagesPath)) {
              const allFiles = fs.readdirSync(annotatedImagesPath);
              const imageFiles = allFiles.filter(file => /\.(jpg|jpeg|png)$/i.test(file));
              const videoFiles = allFiles.filter(file => /\.(mp4|avi|mov|mkv|webm|flv|wmv|m4v)$/i.test(file));
              
              // ✅ Create folders anyway
              if (imageFiles.length > 0) {
                goodImagesPath = path.join(resultsPath, 'good');
                defectImagesPath = path.join(resultsPath, 'defect');
                await storageAdapter.ensureDir(goodImagesPath);
                await storageAdapter.ensureDir(defectImagesPath);
              }
              
              videoCount = videoFiles.length;
              
              // ✅ Without detection data, we can't determine good/defect, so keep in annotated folder
              // But still set paths for API consistency
              console.log(`⚠️ No metadata available, files remain in annotated/ folder`);
            }
          }

          // ✅ Update inference job with results
          inferenceJob.status = 'completed';
          inferenceJob.completedAt = new Date();
          inferenceJob.progress.processedImages = inferenceJob.progress.totalImages;
          inferenceJob.progress.progressPercent = 100;

          if (metadata) {
            inferenceJob.results = {
              resultsPath: resultsPath,
              annotatedImagesPath: annotatedImagesPath,
              goodImagesPath: goodImagesPath,
              defectImagesPath: defectImagesPath,
              metadataPath: metadataPath,
              totalDetections: metadata.totalDetections || 0,
              averageConfidence: metadata.averageConfidence || 0,
              goodCount: goodCount,
              defectCount: defectCount,
              videoCount: videoCount, // ✅ Add video count
              totalFiles: metadata.totalFiles || metadata.totalImages || 0,
              totalImages: metadata.totalImages || imageFiles.length || 0,
              totalVideos: metadata.totalVideos || videoCount || 0,
              detectionsByClass: metadata.detectionsByClass || [],
              corrosionStats: metadata.corrosionStats || null
            };
          } else {
            // Fallback: set basic results structure
            inferenceJob.results = {
              resultsPath: resultsPath,
              annotatedImagesPath: annotatedImagesPath,
              goodImagesPath: goodImagesPath,
              defectImagesPath: defectImagesPath,
              metadataPath: metadataPath,
              totalDetections: 0,
              averageConfidence: 0,
              goodCount: 0,
              defectCount: 0,
              videoCount: videoCount,
              totalFiles: 0,
              totalImages: 0,
              totalVideos: videoCount,
              detectionsByClass: []
            };
          }

          await saveInferenceJob();
          console.log(`✅ Inference job ${inferenceId} results saved`);

          // ✅ Clean up custom folder after successful inference
          if (sourceType === 'custom_folder' && customFolderPath && fs.existsSync(customFolderPath)) {
            try {
              fs.rmSync(customFolderPath, { recursive: true, force: true });
              console.log(`🗑️ Cleaned up custom folder: ${customFolderPath}`);
            } catch (cleanupError) {
              console.warn(`⚠️ Failed to cleanup custom folder ${customFolderPath}: ${cleanupError.message}`);
            }
          }

        } else {
          console.error(`❌ Inference job ${inferenceId} failed with exit code ${code}`);
          // Fetch fresh job for final update
          const freshJob = await InferenceJob.findOne({ inferenceId });
          if (freshJob) {
            freshJob.status = 'failed';
            freshJob.error = `Python process exited with code ${code}`;
            freshJob.completedAt = new Date();
            await freshJob.save();
          }

          // ✅ Clean up custom folder even on failure
          if (sourceType === 'custom_folder' && customFolderPath && fs.existsSync(customFolderPath)) {
            try {
              fs.rmSync(customFolderPath, { recursive: true, force: true });
              console.log(`🗑️ Cleaned up custom folder after failure: ${customFolderPath}`);
            } catch (cleanupError) {
              console.warn(`⚠️ Failed to cleanup custom folder ${customFolderPath}: ${cleanupError.message}`);
            }
          }
        }
      });

      // ✅ Handle cancellation
      const cancellationCheck = setInterval(async () => {
        const updatedJob = await InferenceJob.findOne({ inferenceId });
        if (updatedJob && updatedJob.status === 'cancelled') {
          console.log(`⚠️ Inference job ${inferenceId} cancelled, terminating Python process...`);
          if (pythonProcess && !pythonProcess.killed) {
            pythonProcess.kill('SIGTERM');
          }
          
          // ✅ Clean up custom folder on cancellation
          if (sourceType === 'custom_folder' && customFolderPath && fs.existsSync(customFolderPath)) {
            try {
              fs.rmSync(customFolderPath, { recursive: true, force: true });
              console.log(`🗑️ Cleaned up custom folder after cancellation: ${customFolderPath}`);
            } catch (cleanupError) {
              console.warn(`⚠️ Failed to cleanup custom folder ${customFolderPath}: ${cleanupError.message}`);
            }
          }
          
          clearInterval(cancellationCheck);
        }
      }, 2000); // Check every 2 seconds

      pythonProcess.on('exit', () => {
        clearInterval(cancellationCheck);
      });

  } catch (error) {
    console.error(`❌ Error processing inference job ${inferenceId}:`, error);

    if (inferenceJob) {
      // ✅ Wait for any pending saves to complete
      while (isSaving) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // Update status using fresh document
      const freshJob = await InferenceJob.findOne({ inferenceId });
      if (freshJob) {
        freshJob.status = 'failed';
        freshJob.error = error.message;
        freshJob.completedAt = new Date();
        await freshJob.save();
      }
    }

    // ✅ Clean up custom folder on error
    if (sourceType === 'custom_folder' && customFolderPath && fs.existsSync(customFolderPath)) {
      try {
        fs.rmSync(customFolderPath, { recursive: true, force: true });
        console.log(`🗑️ Cleaned up custom folder after error: ${customFolderPath}`);
      } catch (cleanupError) {
        console.warn(`⚠️ Failed to cleanup custom folder ${customFolderPath}: ${cleanupError.message}`);
      }
    }

    // ✅ Kill Python process if it's still running
    if (pythonProcess && !pythonProcess.killed) {
      pythonProcess.kill('SIGTERM');
    }
  }
};

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
    console.log('✅ Inference worker connected to MongoDB');

    // ✅ Process inference jobs from queue
    inferenceQueue.process(async (job) => {
      // ✅ Ensure MongoDB connection is ready before processing
      await ensureMongoConnection();
      await processInferenceJob(job);
    });

    console.log('✅ Inference worker started. Waiting for jobs...');

  } catch (error) {
    console.error('❌ Failed to start inference worker:', error);
    process.exit(1);
  }
};

// ✅ Handle MongoDB connection errors with reconnection
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
  // Don't exit - let mongoose handle reconnection
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected - attempting reconnection...');
  // Mongoose will automatically attempt to reconnect
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected successfully');
});

// ✅ Ensure connection is ready before processing
const ensureMongoConnection = async () => {
  if (mongoose.connection.readyState !== 1) { // 1 = connected
    console.warn('⚠️ MongoDB not connected, waiting for connection...');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MongoDB connection timeout'));
      }, 30000);
      
      mongoose.connection.once('connected', () => {
        clearTimeout(timeout);
        resolve();
      });
      
      mongoose.connection.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
};

// ✅ Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

// ✅ Start the worker
startWorker();

