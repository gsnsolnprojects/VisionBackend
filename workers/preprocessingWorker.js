// workers/preprocessingWorker.js (top of file)
const dns = require('dns');

dns.setServers(['8.8.8.8', '1.1.1.1']);

const path = require('path');
require('dotenv').config({
  path: path.resolve(process.cwd(), '.env'),
});

// ✅ Log Redis environment at startup
console.log('[WORKER-BOOT] Redis environment', {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  hasPassword: !!process.env.REDIS_PASSWORD,
  tlsEnabled: !!process.env.REDIS_HOST,
});

const mongoose = require('mongoose');
const fs = require('fs');
const fsPromises = require('fs').promises;
const sharp = require('sharp');
const { preprocessingQueue, augmentationQueue } = require('../queue');
const Dataset = require('../models/Dataset');
const Image = require('../models/Image');
const storageAdapter = require('../services/storageAdapter');
const { processAugmentationJob } = require('./augmentationWorker');
const { splitDataset } = require('../utils/splitDataset');

/**
 * Preprocessing Worker - Background Job Processor
 * 
 * This worker runs separately from the main API server and processes
 * heavy dataset operations like:
 * - Train/validation split
 * - Thumbnail generation
 * - Statistics computation
 * 
 * Why run this in a worker?
 * - Keeps API responsive (no 30+ second timeouts)
 * - Can run on separate machines/containers
 * - Can process multiple datasets in parallel
 * - Jobs can be retried if they fail
 */

/**
 * Parse YOLO label file and extract class IDs
 * @param {string} labelPath - Full path to label .txt file
 * @param {boolean} isAzure - Whether using Azure storage
 * @param {string} logicalDatasetRoot - Logical root path for Azure
 * @returns {Promise<number[]>} Array of unique class IDs found in the label file
 */
async function extractClassIdsFromLabel(labelPath, isAzure, logicalDatasetRoot) {
  try {
    let content;
    if (isAzure) {
      // For Azure, use storageAdapter to read file (returns Buffer)
      const fullPath = labelPath.startsWith('/') ? labelPath : `${logicalDatasetRoot}/${labelPath}`;
      const buffer = await storageAdapter.readFile(fullPath);
      content = buffer.toString('utf-8');
    } else {
      // For local filesystem
      content = await fsPromises.readFile(labelPath, 'utf-8');
    }
    
    const classIds = new Set();
    const lines = content.trim().split('\n');
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) { // YOLO format: class_id center_x center_y width height
        const classId = parseInt(parts[0], 10);
        if (!isNaN(classId) && classId >= 0) {
          classIds.add(classId);
        }
      }
    }
    
    return Array.from(classIds).sort((a, b) => a - b);
  } catch (error) {
    // If file doesn't exist or can't be read, return empty array
    console.warn(`Failed to parse label file ${labelPath}:`, error.message);
    return [];
  }
}

/**
 * Compute total size of a folder recursively
 * @param {string} rootPath - Root directory path
 * @returns {Promise<number>} Total size in bytes
 */
async function computeFolderSize(rootPath) {
  let total = 0;
  async function walk(dir) {
    const items = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        await walk(p);
      } else if (it.isFile()) {
        const st = await fsPromises.stat(p);
        total += st.size;
      }
    }
  }
  try {
    await walk(rootPath);
  } catch (err) {
    // ignore missing folder
  }
  return total;
}

/**
 * Process a single preprocessing job
 */
const processPreprocessingJob = async (job) => {
  const { datasetId, storagePath, company, project, version } = job.data;

  console.log(`🔄 Processing dataset ${datasetId}...`);

  try {
    // ✅ Update status to 'processing'
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      throw new Error(`Dataset ${datasetId} not found`);
    }

    dataset.status = 'processing';
    await dataset.save();

    // ✅ Build paths
    const imagesPath = storageAdapter.buildImagesPath(company, project, version);
    const labelsPath = storageAdapter.buildLabelsPath(company, project, version);
    const thumbnailsPath = storageAdapter.buildThumbnailsPath(company, project, version);

    // ✅ Create train/val/test directories
    const trainImagesPath = path.join(imagesPath, 'train');
    const valImagesPath = path.join(imagesPath, 'val');
    const testImagesPath = path.join(imagesPath, 'test');
    const trainLabelsPath = path.join(labelsPath, 'train');
    const valLabelsPath = path.join(labelsPath, 'val');

    await storageAdapter.ensureDir(trainImagesPath);
    await storageAdapter.ensureDir(valImagesPath);
    await storageAdapter.ensureDir(testImagesPath);
    await storageAdapter.ensureDir(trainLabelsPath);
    await storageAdapter.ensureDir(valLabelsPath);
    await storageAdapter.ensureDir(thumbnailsPath);

    // ✅ Use manifest-based matching (dataset.files) with storedPath
    // Build maps: originalName (base) → { storedName, storedPath, fileEntry } for images and labels
    const imageManifest = new Map(); // originalName (base) → { storedName, storedPath, fileEntry }
    const labelManifest = new Map(); // originalName (base) → { storedName, storedPath, fileEntry }

    const datasetRoot = storageAdapter.buildDatasetPath(company, project, version);
    const isAzure = storageAdapter.mode === 'azure';
    const logicalDatasetRoot = `/datasets/${company}/${project}/${version}`;

    for (const fileEntry of dataset.files) {
      const originalBaseName = path.parse(fileEntry.originalName).name; // Remove extension
      
      if (fileEntry.type === 'image') {
        imageManifest.set(originalBaseName, {
          storedName: fileEntry.storedName,
          storedPath: fileEntry.storedPath, // e.g., "images/good/692..._img.jpg"
          fileEntry: fileEntry
        });
      } else if (fileEntry.type === 'label') {
        labelManifest.set(originalBaseName, {
          storedName: fileEntry.storedName,
          storedPath: fileEntry.storedPath, // e.g., "labels/good/692..._img.txt"
          fileEntry: fileEntry
        });
      }
    }

    // ✅ Read split strategy from environment (default: 'combined')
    const splitStrategy = (process.env.SPLIT_STRATEGY || 'combined').toLowerCase();

    // ✅ Separate labeled and unlabeled images using manifest
    const labeledImages = [];
    const unlabeledImages = [];
    const imageDocuments = []; // Array to collect Image documents for batch upsert

    for (const [originalBaseName, imageInfo] of imageManifest.entries()) {
      if (labelManifest.has(originalBaseName)) {
        labeledImages.push(imageInfo);
      } else {
        unlabeledImages.push(imageInfo);
      }
    }

    // ✅ Build combined list based on split strategy
    let combinedList = [];
    let testImages = [];

    if (splitStrategy === 'labeled-only') {
      // Only split labeled images, place unlabeled in test folder
      combinedList = [...labeledImages];
      testImages = [...unlabeledImages];
    } else {
      // Default 'combined': combine labeled + unlabeled for split
      combinedList = [...labeledImages, ...unlabeledImages];
    }

    // ✅ Canonical split: seeded shuffle + configurable ratios (utils/splitDataset.js)
    // Uses dataset.split_seed, split_ratio_train, split_ratio_val, test_sample_ratio when set; else defaults
    const { train: trainImages, val: valImages, test: testSampleImages } = splitDataset(combinedList, dataset);

    // ✅ Copy images and labels to train/val folders (flattened structure)
    // ⚠️ CAUTION: We COPY (not move) to preserve original folder structure for dashboard
    // Training requires flat structure (no folders), but dashboard needs folder view
    let trainCount = 0;
    let valCount = 0;
    let testCount = 0; // For labeled-only strategy unlabeled images
    const processingErrors = [];

    // ✅ Copy train images
    for (const imageInfo of trainImages) {
      try {
        // ✅ Use storedPath to find file in its original folder location
        const srcPath = isAzure
          ? `${logicalDatasetRoot}/${imageInfo.storedPath}`
          : path.join(datasetRoot, imageInfo.storedPath); // e.g., datasetRoot/images/good/storedName
        const destPath = path.join(trainImagesPath, imageInfo.storedName); // Flattened: train/images/storedName

        // Check if source file exists
        if (await storageAdapter.exists(srcPath)) {
          await storageAdapter.linkOrCopyFile(srcPath, destPath); // Keeps the original, no second copy on disk
          trainCount++;

          // ✅ Copy corresponding label file using manifest (if exists)
          // ⚠️ CRITICAL: Label filename must match image filename (without extension) for YOLO
          const originalBaseName = path.parse(imageInfo.fileEntry.originalName).name;
          const labelInfo = labelManifest.get(originalBaseName);
          
          let hasLabels = false;
          let classIds = []; // Extract class IDs from label file
          if (labelInfo) {
            const labelSrcPath = isAzure
              ? `${logicalDatasetRoot}/${labelInfo.storedPath}`
              : path.join(datasetRoot, labelInfo.storedPath); // e.g., datasetRoot/labels/good/storedName
            // Use image's storedName (without extension) + .txt for label filename
            const imageBaseName = path.parse(imageInfo.storedName).name; // Remove .jpg extension
            const labelDestPath = path.join(trainLabelsPath, `${imageBaseName}.txt`); // Match image filename
            if (await storageAdapter.exists(labelSrcPath)) {
              await storageAdapter.copyFile(labelSrcPath, labelDestPath); // Copy and rename to match image
              hasLabels = true;
              // ✅ Extract class IDs from label file (use source path before copy)
              classIds = await extractClassIdsFromLabel(labelSrcPath, isAzure, logicalDatasetRoot);
            }
          }

          // ✅ Extract image dimensions and create Image document
          try {
            const imageMetadata = await sharp(srcPath).metadata();
            const fileStats = await fsPromises.stat(srcPath);
            
            // Check if label file exists in train folder (after copy)
            const imageBaseName = path.parse(imageInfo.storedName).name;
            const trainLabelPath = path.join(trainLabelsPath, `${imageBaseName}.txt`);
            const labelExists = await storageAdapter.exists(trainLabelPath);
            
            // If label exists in train folder but we haven't extracted class IDs yet, try extracting from train label
            if (labelExists && classIds.length === 0) {
              classIds = await extractClassIdsFromLabel(trainLabelPath, false, logicalDatasetRoot);
            }
            
            imageDocuments.push({
              datasetId: datasetId,
              filename: imageInfo.storedName,
              storedPath: `images/train/${imageInfo.storedName}`, // Relative path in split structure
              folder: 'train',
              size: fileStats.size,
              width: imageMetadata.width || 0,
              height: imageMetadata.height || 0,
              hasLabels: hasLabels || labelExists, // Set true if label file exists
              classes: classIds.length > 0 ? classIds : undefined, // Store class IDs if found
              convertedAt: (hasLabels || labelExists) ? new Date() : undefined
            });
          } catch (dimError) {
            console.warn(`Failed to extract dimensions for ${imageInfo.storedName}:`, dimError.message);
            // Create Image document without dimensions (will need to be updated later)
            imageDocuments.push({
              datasetId: datasetId,
              filename: imageInfo.storedName,
              storedPath: `images/train/${imageInfo.storedName}`,
              folder: 'train',
              size: 0,
              width: 0,
              height: 0,
              hasLabels: hasLabels,
              classes: classIds.length > 0 ? classIds : undefined, // Store class IDs if found
              convertedAt: hasLabels ? new Date() : undefined
            });
          }
        } else {
          processingErrors.push({
            filename: imageInfo.storedName,
            reason: `Source file not found: ${srcPath}`
          });
        }
      } catch (error) {
        console.error(`Failed to copy train image ${imageInfo.storedName}:`, error.message);
        processingErrors.push({
          filename: imageInfo.storedName,
          reason: `Copy error: ${error.message}`
        });
      }
    }

    // ✅ Update progress: save train count
    dataset.trainCount = trainCount;
    if (processingErrors.length > 0) {
      dataset.uploadErrors = (dataset.uploadErrors || []).concat(processingErrors);
    }
    await dataset.save();

    // ✅ Copy val images
    for (const imageInfo of valImages) {
      try {
        // ✅ Use storedPath to find file in its original folder location
        const srcPath = isAzure
          ? `${logicalDatasetRoot}/${imageInfo.storedPath}`
          : path.join(datasetRoot, imageInfo.storedPath); // e.g., datasetRoot/images/good/storedName
        const destPath = path.join(valImagesPath, imageInfo.storedName); // Flattened: val/images/storedName

        // Check if source file exists
        if (await storageAdapter.exists(srcPath)) {
          await storageAdapter.linkOrCopyFile(srcPath, destPath); // Keeps the original, no second copy on disk
          valCount++;

          // ✅ Copy corresponding label file using manifest (if exists)
          // ⚠️ CRITICAL: Label filename must match image filename (without extension) for YOLO
          const originalBaseName = path.parse(imageInfo.fileEntry.originalName).name;
          const labelInfo = labelManifest.get(originalBaseName);
          
          let hasLabels = false;
          let classIds = []; // Extract class IDs from label file
          if (labelInfo) {
            const labelSrcPath = isAzure
              ? `${logicalDatasetRoot}/${labelInfo.storedPath}`
              : path.join(datasetRoot, labelInfo.storedPath); // e.g., datasetRoot/labels/good/storedName
            // Use image's storedName (without extension) + .txt for label filename
            const imageBaseName = path.parse(imageInfo.storedName).name; // Remove .jpg extension
            const labelDestPath = path.join(valLabelsPath, `${imageBaseName}.txt`); // Match image filename
            if (await storageAdapter.exists(labelSrcPath)) {
              await storageAdapter.copyFile(labelSrcPath, labelDestPath); // Copy and rename to match image
              hasLabels = true;
              // ✅ Extract class IDs from label file (use source path before copy)
              classIds = await extractClassIdsFromLabel(labelSrcPath, isAzure, logicalDatasetRoot);
            }
          }

          // ✅ Extract image dimensions and create Image document
          try {
            const imageMetadata = await sharp(srcPath).metadata();
            const fileStats = await fsPromises.stat(srcPath);
            
            // Check if label file exists in val folder (after copy)
            const imageBaseName = path.parse(imageInfo.storedName).name;
            const valLabelPath = path.join(valLabelsPath, `${imageBaseName}.txt`);
            const labelExists = await storageAdapter.exists(valLabelPath);
            
            // If label exists in val folder but we haven't extracted class IDs yet, try extracting from val label
            if (labelExists && classIds.length === 0) {
              classIds = await extractClassIdsFromLabel(valLabelPath, false, logicalDatasetRoot);
            }
            
            imageDocuments.push({
              datasetId: datasetId,
              filename: imageInfo.storedName,
              storedPath: `images/val/${imageInfo.storedName}`, // Relative path in split structure
              folder: 'val',
              size: fileStats.size,
              width: imageMetadata.width || 0,
              height: imageMetadata.height || 0,
              hasLabels: hasLabels || labelExists, // Set true if label file exists
              classes: classIds.length > 0 ? classIds : undefined, // Store class IDs if found
              convertedAt: (hasLabels || labelExists) ? new Date() : undefined
            });
          } catch (dimError) {
            console.warn(`Failed to extract dimensions for ${imageInfo.storedName}:`, dimError.message);
            // Create Image document without dimensions (will need to be updated later)
            imageDocuments.push({
              datasetId: datasetId,
              filename: imageInfo.storedName,
              storedPath: `images/val/${imageInfo.storedName}`,
              folder: 'val',
              size: 0,
              width: 0,
              height: 0,
              hasLabels: hasLabels,
              classes: classIds.length > 0 ? classIds : undefined, // Store class IDs if found
              convertedAt: hasLabels ? new Date() : undefined
            });
          }
        } else {
          processingErrors.push({
            filename: imageInfo.storedName,
            reason: `Source file not found: ${srcPath}`
          });
        }
      } catch (error) {
        console.error(`Failed to copy val image ${imageInfo.storedName}:`, error.message);
        processingErrors.push({
          filename: imageInfo.storedName,
          reason: `Copy error: ${error.message}`
        });
      }
    }

    // ✅ Update progress: save val count
    dataset.valCount = valCount;
    if (processingErrors.length > 0) {
      dataset.uploadErrors = (dataset.uploadErrors || []).concat(processingErrors);
    }
    await dataset.save();

    // ✅ Handle unlabeled images for 'labeled-only' strategy (copy to test folder)
    if (splitStrategy === 'labeled-only' && testImages.length > 0) {
      for (const imageInfo of testImages) {
        try {
          const srcPath = isAzure
            ? `${logicalDatasetRoot}/${imageInfo.storedPath}`
            : path.join(datasetRoot, imageInfo.storedPath);
          const destPath = path.join(testImagesPath, imageInfo.storedName);
          
          if (await storageAdapter.exists(srcPath)) {
            await storageAdapter.linkOrCopyFile(srcPath, destPath);
            testCount++;

            // ✅ Extract image dimensions and create Image document
            try {
              const imageMetadata = await sharp(srcPath).metadata();
              const fileStats = await fsPromises.stat(srcPath);
              
              imageDocuments.push({
                datasetId: datasetId,
                filename: imageInfo.storedName,
                storedPath: `images/test/${imageInfo.storedName}`, // Relative path in split structure
                folder: 'test',
                size: fileStats.size,
                width: imageMetadata.width || 0,
                height: imageMetadata.height || 0,
                hasLabels: false, // Unlabeled images
                convertedAt: undefined
              });
            } catch (dimError) {
              console.warn(`Failed to extract dimensions for ${imageInfo.storedName}:`, dimError.message);
              imageDocuments.push({
                datasetId: datasetId,
                filename: imageInfo.storedName,
                storedPath: `images/test/${imageInfo.storedName}`,
                folder: 'test',
                size: 0,
                width: 0,
                height: 0,
                hasLabels: false,
                convertedAt: undefined
              });
            }
          }
        } catch (error) {
          console.error(`Failed to copy test image ${imageInfo.storedName}:`, error.message);
          processingErrors.push({
            filename: imageInfo.storedName,
            reason: `Test copy error: ${error.message}`
          });
        }
      }
      dataset.testCount = testCount;
      await dataset.save();
    }

    // ✅ Copy test split to test folder (disjoint test set from splitDataset)
    await storageAdapter.ensureDir(testImagesPath);
    let testImagesCopied = 0;

    // Skip any test item already assigned to train/val (safety if old overlapping split is used)
    const alreadyAssignedNames = new Set(
      imageDocuments.map((d) => d.filename).filter(Boolean)
    );

    for (const imageInfo of testSampleImages) {
      try {
        if (alreadyAssignedNames.has(imageInfo.storedName)) {
          console.log(`   - Skipping test copy (already in train/val): ${imageInfo.storedName}`);
          continue;
        }

        const srcPath = isAzure
          ? `${logicalDatasetRoot}/${imageInfo.storedPath}`
          : path.join(datasetRoot, imageInfo.storedPath);
        const destPath = path.join(testImagesPath, imageInfo.storedName);
        
        if (await storageAdapter.exists(srcPath)) {
          await storageAdapter.linkOrCopyFile(srcPath, destPath);
          testImagesCopied++;
          alreadyAssignedNames.add(imageInfo.storedName);

          // ✅ Extract image dimensions and create Image document
          try {
            const imageMetadata = await sharp(srcPath).metadata();
            const fileStats = await fsPromises.stat(srcPath);
            
            // Check if label file exists (for test images that were labeled)
            const originalBaseName = path.parse(imageInfo.fileEntry.originalName).name;
            const labelInfo = labelManifest.get(originalBaseName);
            const hasLabels = labelInfo ? await storageAdapter.exists(path.join(datasetRoot, labelInfo.storedPath)) : false;
            
            imageDocuments.push({
              datasetId: datasetId,
              filename: imageInfo.storedName,
              storedPath: `images/test/${imageInfo.storedName}`, // Relative path in split structure
              folder: 'test',
              size: fileStats.size,
              width: imageMetadata.width || 0,
              height: imageMetadata.height || 0,
              hasLabels: hasLabels,
              convertedAt: hasLabels ? new Date() : undefined
            });
          } catch (dimError) {
            console.warn(`Failed to extract dimensions for ${imageInfo.storedName}:`, dimError.message);
            imageDocuments.push({
              datasetId: datasetId,
              filename: imageInfo.storedName,
              storedPath: `images/test/${imageInfo.storedName}`,
              folder: 'test',
              size: 0,
              width: 0,
              height: 0,
              hasLabels: false,
              convertedAt: undefined
            });
          }
        } else {
          processingErrors.push({
            filename: imageInfo.storedName,
            reason: `Test copy: source file not found: ${srcPath}`
          });
        }
      } catch (error) {
        console.error(`Failed to copy test image ${imageInfo.storedName}:`, error.message);
        processingErrors.push({
          filename: imageInfo.storedName,
          reason: `Test copy error: ${error.message}`
        });
      }
    }
    
    // Update test count (add to existing if labeled-only strategy already set it)
    const existingTestCount = splitStrategy === 'labeled-only' ? testCount : 0;
    dataset.testCount = existingTestCount + testImagesCopied;
    if (processingErrors.length > 0) {
      dataset.uploadErrors = (dataset.uploadErrors || []).concat(processingErrors);
    }
    await dataset.save();
    
    console.log(`   - Test sample: ${testImagesCopied} images copied`);

    // ✅ Generate thumbnails for all train+val images
    // ✅ Read from original folder locations (images/{folder}/...) to preserve quality
    const allImagesForThumbnails = [...trainImages, ...valImages];
    let thumbnailsGenerated = 0;

    console.log(`   - Generating thumbnails for ${allImagesForThumbnails.length} images...`);

    for (const imageInfo of allImagesForThumbnails) {
      try {
        // ✅ Use storedPath to read from original folder location
        const originalImagePath = isAzure
          ? `${logicalDatasetRoot}/${imageInfo.storedPath}`
          : path.join(datasetRoot, imageInfo.storedPath);

        if (await storageAdapter.exists(originalImagePath)) {
          if (isAzure) {
            const buffer = await storageAdapter.readFile(originalImagePath);

            const thumbBuffer = await sharp(buffer)
              .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
              .toBuffer();

            const blobThumbPath = `${logicalDatasetRoot}/thumbnails/thumb_${imageInfo.storedName}`;
            await storageAdapter.saveBuffer(thumbBuffer, blobThumbPath);
          } else {
            const thumbnailPath = path.join(thumbnailsPath, `thumb_${imageInfo.storedName}`);
            await sharp(originalImagePath)
              .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
              .toFile(thumbnailPath);
          }
          thumbnailsGenerated++;
        }
      } catch (error) {
        console.warn(`Failed to generate thumbnail for ${imageInfo.storedName}:`, error.message);
        processingErrors.push({
          filename: imageInfo.storedName,
          reason: `Thumbnail generation error: ${error.message}`
        });
      }
    }

    // ✅ Update progress: save thumbnail count
    dataset.thumbnailsGenerated = thumbnailsGenerated;
    if (processingErrors.length > 0) {
      dataset.uploadErrors = (dataset.uploadErrors || []).concat(processingErrors);
    }
    await dataset.save();

    // ✅ Extract labels from label files (read from both train and val)
    const labelsSet_final = new Set();
    
    if (!isAzure) {
      // Read from train labels
      try {
        const trainLabelFiles = await fsPromises.readdir(trainLabelsPath);
        for (const labelFile of trainLabelFiles) {
          try {
            const labelPath = path.join(trainLabelsPath, labelFile);
            const content = await fsPromises.readFile(labelPath, 'utf-8');
            const lines = content.trim().split('\n');
            for (const line of lines) {
              const parts = line.trim().split(' ');
              if (parts.length > 0) {
                const classId = parseInt(parts[0]);
                if (!isNaN(classId)) {
                  // ✅ In YOLO format, class ID is first number
                  // For now, we'll store class IDs. You can map to class names later
                  labelsSet_final.add(`class_${classId}`);
                }
              }
            }
          } catch (error) {
            console.warn(`Failed to read label file ${labelFile}:`, error.message);
          }
        }
      } catch (error) {
        // Directory might be empty, that's ok
        console.warn('Train labels directory read error (may be empty):', error.message);
      }

      // Read from val labels
      try {
        const valLabelFiles = await fsPromises.readdir(valLabelsPath);
        for (const labelFile of valLabelFiles) {
          try {
            const labelPath = path.join(valLabelsPath, labelFile);
            const content = await fsPromises.readFile(labelPath, 'utf-8');
            const lines = content.trim().split('\n');
            for (const line of lines) {
              const parts = line.trim().split(' ');
              if (parts.length > 0) {
                const classId = parseInt(parts[0]);
                if (!isNaN(classId)) {
                  labelsSet_final.add(`class_${classId}`);
                }
              }
            }
          } catch (error) {
            console.warn(`Failed to read label file ${labelFile}:`, error.message);
          }
        }
      } catch (error) {
        // Directory might be empty, that's ok
        console.warn('Val labels directory read error (may be empty):', error.message);
      }
    }

    // ✅ Create Image documents in batch (upsert to avoid duplicates)
    if (imageDocuments.length > 0) {
      try {
        console.log(`   - Creating ${imageDocuments.length} Image documents...`);
        for (const imgDoc of imageDocuments) {
          // Use upsert to avoid duplicates (based on datasetId + storedPath unique index)
          await Image.findOneAndUpdate(
            { datasetId: imgDoc.datasetId, storedPath: imgDoc.storedPath },
            imgDoc,
            { upsert: true, new: true }
          );
        }
        console.log(`   - ✅ Created/updated ${imageDocuments.length} Image documents`);
      } catch (imgError) {
        console.error('Failed to create Image documents:', imgError.message);
        // Don't fail the entire job if Image creation fails
      }
    }

    // ✅ Recalculate labeled/unlabeled counts from Image collection
    const labeledCount = await Image.countDocuments({ datasetId, hasLabels: true });
    const unlabeledCount = await Image.countDocuments({ datasetId, hasLabels: false });
    const uniqueImageCount = await Image.countDocuments({ datasetId });

    // ✅ Update final dataset metadata
    dataset.labeledImages = labeledCount; // Use count from Image collection
    dataset.unlabeledImages = unlabeledCount; // Use count from Image collection
    // Keep totalImages aligned with unique Image rows (train/val/test are disjoint)
    dataset.totalImages = uniqueImageCount;
    dataset.trainCount = trainCount;
    dataset.valCount = valCount;
    // testCount already updated during test folder copy
    dataset.labels = Array.from(labelsSet_final);
    
    // ✅ Recompute final dataset sizeBytes after preprocessing
    if (!isAzure) {
      try {
        const datasetRoot = storageAdapter.buildDatasetPath(company, project, version);
        const computedSize = await computeFolderSize(datasetRoot);
        dataset.sizeBytes = computedSize;
      } catch (err) {
        console.warn('Failed to compute final dataset size:', err.message);
      }
    }
    
    dataset.status = 'ready';
    await dataset.save();

    console.log(`✅ Dataset ${datasetId} processed successfully`);
    console.log(`   - Strategy: ${splitStrategy}`);
    console.log(`   - Train: ${trainCount}, Val: ${valCount}, Test: ${dataset.testCount}`);
    console.log(`   - Labeled: ${labeledImages.length}, Unlabeled: ${unlabeledImages.length}`);
    console.log(`   - Thumbnails: ${thumbnailsGenerated}`);

  } catch (error) {
    console.error(`❌ Error processing dataset ${datasetId}:`, error);

    // ✅ Update dataset status to 'failed'
    try {
      const dataset = await Dataset.findById(datasetId);
      if (dataset) {
        dataset.status = 'failed';
        dataset.errorMessage = error.message;
        await dataset.save();
      }
    } catch (updateError) {
      console.error('Failed to update dataset status:', updateError);
    }

    throw error; // Re-throw to mark job as failed
  }
};

/**
 * Start the worker - process jobs from the queue
 */
const startWorker = async () => {
  // ✅ Connect to MongoDB
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/visiondb';
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 30000, // wait longer for Atlas primary
    socketTimeoutMS: 45000,
    family: 4, // FORCE IPv4 (critical on Windows)
  });
  console.log('✅ Worker connected to MongoDB');

  // ✅ Ensure queue readiness
  await preprocessingQueue.isReady();
  console.log('[WORKER-QUEUE] preprocessingQueue is ready and listening');

  // ✅ Add queue lifecycle event logs
  preprocessingQueue.on('error', (err) => {
    console.error('[WORKER-QUEUE] Redis/Queue error', err);
  });

  preprocessingQueue.on('waiting', (jobId) => {
    console.log('[WORKER-QUEUE] Job waiting', jobId);
  });

  preprocessingQueue.on('active', (job) => {
    console.log('[WORKER-QUEUE] Job active', {
      jobId: job.id,
      datasetId: job.data?.datasetId,
    });
  });

  // ✅ Process preprocessing jobs from the queue
  preprocessingQueue.process(1, async (job) => {
    console.log('[WORKER-JOB] Received preprocessing job', {
      jobId: job.id,
      datasetId: job.data?.datasetId,
    });
    return await processPreprocessingJob(job);
  });

  // ✅ Ensure augmentation queue readiness (so we can process augmentation jobs in the same worker)
  await augmentationQueue.isReady();
  console.log('[AUGMENT-QUEUE] augmentationQueue is ready and listening');

  augmentationQueue.on('error', (err) => {
    console.error('[AUGMENT-QUEUE] Redis/Queue error', err);
  });

  augmentationQueue.on('waiting', (jobId) => {
    console.log('[AUGMENT-QUEUE] Job waiting', jobId);
  });

  augmentationQueue.on('active', (job) => {
    console.log('[AUGMENT-QUEUE] Job active', {
      jobId: job.id,
      datasetId: job.data?.datasetId,
    });
  });

  // ✅ Process augmentation jobs from the augmentation queue
  augmentationQueue.process(1, async (job) => {
    console.log('[AUGMENT-WORKER] Received augmentation job', {
      jobId: job.id,
      datasetId: job.data?.datasetId,
    });
    return processAugmentationJob(job);
  });

  console.log('✅ Preprocessing worker started. Waiting for preprocessing and augmentation jobs...');
};

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

// ✅ Start worker if this file is run directly
if (require.main === module) {
  startWorker().catch((error) => {
    console.error('❌ Worker startup error:', error);
    process.exit(1);
  });
}

module.exports = { startWorker, processPreprocessingJob };
