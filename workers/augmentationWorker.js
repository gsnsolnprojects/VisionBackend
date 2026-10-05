const path = require('path');
require('dotenv').config({
  path: path.resolve(process.cwd(), '.env'),
});
const dns = require('dns');

dns.setServers(['8.8.8.8', '1.1.1.1']);

const { spawn } = require('child_process');
const mongoose = require('mongoose');
const fs = require('fs').promises;

const { augmentationQueue } = require('../queue');
const Dataset = require('../models/Dataset');
const Image = require('../models/Image');
const Category = require('../models/Category');
const storageAdapter = require('../services/storageAdapter');
const { splitDataset } = require('../utils/splitDataset');
const { getLabelFilePath } = require('../utils/yoloConverter');

/**
 * Augmentation Worker - Background Job Processor
 *
 * This worker orchestrates the Python-based image data augmentation using the
 * existing `image_data_augmentation` code. It is designed to be additive and
 * not to interfere with existing preprocessing/training workers.
 */

/**
 * Track active augmentation jobs and their Python processes.
 * Map: jobId (string) -> { pythonProcess, datasetId }
 * Exported so controller can access it for cancellation.
 */
const activeAugmentations = new Map();

/**
 * Compute next dataset version string for a given company/project.
 * Existing convention is simple strings like "v1", "v2", ...
 * We keep that convention and increment the numeric suffix.
 */
async function getNextVersion(company, project) {
  const datasets = await Dataset.find({ company, project }).select('version').lean();
  if (!datasets.length) {
    return 'v1';
  }

  let maxNum = 1;
  for (const d of datasets) {
    const match = typeof d.version === 'string' && d.version.match(/^v(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!Number.isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  }

  return `v${maxNum + 1}`;
}

/**
 * Run Python augmentation script as a child process.
 * Returns { exitCode, stdout, stderr, process }.
 * The process is also tracked in activeAugmentations map.
 */
function runPythonAugmentation({
  inputRoot,
  outputRoot,
  targetTrainTotal,
  valTestMultiplier,
  targetSize,
  jobId,
  datasetId,
}) {
  return new Promise((resolve, reject) => {
    const pythonBin = process.env.AUG_PYTHON_BIN || 'python';
    const scriptPath = path.join(
      process.cwd(),
      'image_data_augmentation',
      'run_augmentation.py',
    );

    const args = [
      scriptPath,
      '--input-root',
      inputRoot,
      '--output-root',
      outputRoot,
      '--target-train-total',
      String(targetTrainTotal),
      '--val-test-multiplier',
      String(valTestMultiplier),
      '--target-size',
      String(targetSize),
    ];

    console.log('[AUGMENT-WORKER] Spawning Python augmentation process', {
      pythonBin,
      scriptPath,
      inputRoot,
      outputRoot,
      targetTrainTotal,
      valTestMultiplier,
      targetSize,
    });

    const child = spawn(pythonBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Track process in activeAugmentations map
    if (jobId && datasetId) {
      activeAugmentations.set(jobId, {
        pythonProcess: child,
        datasetId,
      });
      console.log('[AUGMENT-WORKER] Tracked Python process', {
        jobId,
        datasetId,
        pid: child.pid,
      });
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      console.log('[AUGMENT-PYTHON-STDOUT]', text.trimEnd());
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      console.error('[AUGMENT-PYTHON-STDERR]', text.trimEnd());
    });

    child.on('close', (code, signal) => {
      // Remove from tracking map
      if (jobId) {
        activeAugmentations.delete(jobId);
        console.log('[AUGMENT-WORKER] Removed job from active map', {
          jobId,
          code,
          signal,
        });
      }

      if (signal === 'SIGTERM') {
        console.log('[AUGMENT-WORKER] Python terminated due to cancellation', {
          jobId,
          pid: child.pid,
        });
        reject(new Error('Python augmentation process terminated by cancellation'));
      } else {
        console.log('[AUGMENT-WORKER] Python process exited with code', code);
        resolve({
          exitCode: code,
          stdout,
          stderr,
          process: child,
        });
      }
    });

    child.on('error', (error) => {
      if (jobId) {
        activeAugmentations.delete(jobId);
      }
      reject(error);
    });
  });
}

/**
 * Run Python fix_labels script against the labels root directory.
 * Returns { exitCode, stdout, stderr }.
 */
function runPythonFixLabels({ labelsRoot }) {
  return new Promise((resolve) => {
    const pythonBin = process.env.AUG_PYTHON_BIN || 'python';
    const scriptPath = path.join(
      process.cwd(),
      'image_data_augmentation',
      'fix_labels.py',
    );

    const args = [scriptPath, labelsRoot];

    console.log('[AUGMENT-WORKER] Spawning Python fix_labels process', {
      pythonBin,
      scriptPath,
      labelsRoot,
    });

    const child = spawn(pythonBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      console.log('[FIX-LABELS-PYTHON-STDOUT]', text.trimEnd());
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      console.error('[FIX-LABELS-PYTHON-STDERR]', text.trimEnd());
    });

    child.on('close', (code) => {
      console.log('[AUGMENT-WORKER] fix_labels process exited with code', code);
      resolve({
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Compute recursive folder size in bytes.
 */
async function computeFolderSize(rootPath) {
  let total = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const st = await fs.stat(fullPath);
          total += st.size;
        } catch {
          // ignore
        }
      }
    }
  }
  await walk(rootPath);
  return total;
}

/**
 * Process a single augmentation job.
 *
 * Job data:
 * {
 *   datasetId: string (original dataset),
 *   targetTrainTotal?: number,
 *   valTestMultiplier?: number,
 *   targetSize?: number
 * }
 */
const processAugmentationJob = async (job) => {
  const {
    datasetId,
    versionName,
    targetTrainTotal,
    valTestMultiplier,
    targetSize,
    augmentationMultiplier,
    imageIds,
  } = job.data || {};

  console.log('[AUGMENT-WORKER] Processing augmentation job', {
    jobId: job.id,
    datasetId,
  });

  let originalDataset;
  let augmentedDataset;
  let pythonProcess = null;

  try {
    originalDataset = await Dataset.findById(datasetId);
    if (!originalDataset) {
      throw new Error(`Dataset ${datasetId} not found`);
    }

    // Check for cancellation before starting
    if (originalDataset.augmentationStatus === 'cancelled') {
      throw new Error('Augmentation cancelled by user');
    }

    if (originalDataset.status !== 'ready' && originalDataset.status !== 'ready_to_train') {
      throw new Error(
        `Dataset must be in 'ready' or 'ready_to_train' status for augmentation. Current status: ${originalDataset.status}`,
      );
    }

    if (originalDataset.augmentationStatus === 'running') {
      // Check if there is an in-flight augmented dataset for this original dataset.
      // If yes, this really is a duplicate job and we should no-op.
      // If not, treat the 'running' status as stale and allow augmentation to proceed.
      const existingRunningAugmented = await Dataset.findOne({
        backupDatasetId: originalDataset._id,
        augmentationStatus: 'running',
        deletedAt: null,
      })
        .select('_id version')
        .lean();

      if (existingRunningAugmented) {
        console.log('[AUGMENT-WORKER] Duplicate augmentation job detected; ignoring', {
          jobId: job.id,
          datasetId,
          existingAugmentedDatasetId: existingRunningAugmented._id,
          existingAugmentedVersion: existingRunningAugmented.version,
        });
        // Treat duplicate jobs as a no-op so they don't appear as hard failures
        return {
          skipped: true,
          reason: 'Augmentation already running for this dataset',
        };
      }

      console.warn(
        '[AUGMENT-WORKER] Original dataset marked as augmentationStatus=running but no active augmented dataset found; treating as stale state and continuing',
        {
          jobId: job.id,
          datasetId,
        },
      );
    }

    // Mark original as running (non-destructive to status)
    originalDataset.augmentationStatus = 'running';
    await originalDataset.save();

    const versionNameTrimmed = typeof versionName === 'string' ? versionName.trim() : '';
    if (!versionNameTrimmed) {
      throw new Error('Augmentation job missing required versionName. Re-submit with a version name.');
    }
    if (versionNameTrimmed.length > 50 || !/^[a-zA-Z0-9_-]+$/.test(versionNameTrimmed)) {
      throw new Error('Invalid versionName in job (length ≤ 50, only a-z, A-Z, 0-9, _, -).');
    }
    const { company, project } = originalDataset;
    const existingWithVersion = await Dataset.findOne({
      company,
      project,
      version: versionNameTrimmed,
      deletedAt: null,
    });
    if (existingWithVersion) {
      throw new Error(`Version name "${versionNameTrimmed}" already exists for this project.`);
    }
    if (versionNameTrimmed === originalDataset.version) {
      throw new Error('Version name cannot be the same as the source version.');
    }

    const newVersion = versionNameTrimmed;

    const outputRoot = storageAdapter.buildDatasetPath(company, project, newVersion);
    const inputRoot = storageAdapter.buildDatasetPath(
      company,
      project,
      originalDataset.version,
    );

    // Create augmented dataset document (minimal fields; will be updated after success)
    // Start as inactive; will be set to active after successful augmentation
    // Augmented datasets always have labels (from source); set datasetType for frontend badges
    // labelSource: inherit from source so "Manually Labelled" vs "Pre-Labelled" badge is correct
    const labelSource = originalDataset.status === 'ready_to_train' ? 'manually_labeled' : 'pre_labelled';
    augmentedDataset = new Dataset({
      company,
      project,
      version: newVersion,
      storagePath: outputRoot,
      status: 'processing',
      augmentationStatus: 'running',
      isAugmented: true,
      datasetType: 'labeled',
      annotationStatus: null,
      labelSource,
      labels: Array.isArray(originalDataset.labels) ? originalDataset.labels : [],
      backupDatasetId: originalDataset._id,
      parentDatasetId: originalDataset._id,
      rootDatasetId: originalDataset.rootDatasetId || originalDataset._id,
      augmentationMultiplier: augmentationMultiplier || null,
      augmentedFromVersion: originalDataset.version,
      isActive: false, // Will be set to true after successful augmentation
      totalImages: 0,
      sizeBytes: 0,
      uploadErrors: [],
      files: [],
    });

    await augmentedDataset.save();

    console.log('[AUGMENT-WORKER] Created augmented dataset', {
      originalDatasetId: originalDataset._id.toString(),
      augmentedDatasetId: augmentedDataset._id.toString(),
      company,
      project,
      inputRoot,
      outputRoot,
    });

    await storageAdapter.ensureDir(outputRoot);

    // ---------- 1. Build full labeled pool from source (before any split) ----------
    // ✅ Dedupe by filename: old overlapping train/test copies must not enter the pool twice
    // (that caused 105 unique images → 115 files and Simulation showing the wrong count).
    // Prefer train > val > test when the same name appears in multiple splits.
    const pool = [];
    const poolNamesSeen = new Set();
    for (const split of ['train', 'val', 'test']) {
      const splitImagesDir = path.join(inputRoot, 'images', split);
      try {
        const entries = await fs.readdir(splitImagesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const storedName = entry.name;
          const ext = path.extname(storedName).toLowerCase();
          if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') continue;
          const nameKey = storedName.toLowerCase();
          if (poolNamesSeen.has(nameKey)) continue;
          const storedPath = `images/${split}/${storedName}`;
          const labelPath = getLabelFilePath(storedPath);
          const fullLabelPath = path.join(inputRoot, labelPath);
          const exists = await storageAdapter.exists(fullLabelPath);
          if (!exists) continue;
          poolNamesSeen.add(nameKey);
          pool.push({
            storedName,
            storedPath,
            sourcePath: path.join(inputRoot, storedPath),
            labelPath: fullLabelPath,
          });
        }
      } catch {
        // Skip missing split dir
      }
    }

    if (pool.length === 0) {
      throw new Error('No labeled images found in source dataset. Ensure images have corresponding .txt labels in labels/train, val, or test.');
    }

    console.log('[AUGMENT-WORKER] Labeled pool built (unique filenames)', {
      uniqueImages: pool.length,
      sourceVersion: originalDataset.version,
    });

    // ---------- 1.5 Optional scoping: augment only a subset of images ----------
    // When imageIds is set (e.g. a newly added-and-labeled batch), only those images go
    // through Python augmentation; the rest of the source dataset passes through to the
    // new version unchanged. Resolve imageIds -> filenames since the pool above is keyed
    // by storedName, not Mongo _id.
    let scopedPool = pool;
    let passthroughPool = [];
    if (Array.isArray(imageIds) && imageIds.length > 0) {
      const scopedImages = await Image.find({ _id: { $in: imageIds }, datasetId: originalDataset._id })
        .select('filename')
        .lean();
      const scopedNames = new Set(scopedImages.map((img) => String(img.filename).toLowerCase()));
      scopedPool = pool.filter((p) => scopedNames.has(p.storedName.toLowerCase()));
      passthroughPool = pool.filter((p) => !scopedNames.has(p.storedName.toLowerCase()));
      if (scopedPool.length === 0) {
        throw new Error('None of the selected images have labels yet. Label them first, then try augmenting again.');
      }
      console.log('[AUGMENT-WORKER] Scoped augmentation to a subset of images', {
        scoped: scopedPool.length,
        passthrough: passthroughPool.length,
      });
    }

    // ---------- 2. Temp dirs: input pool (scoped images) and output pool (Python writes augmented here) ----------
    const inputPoolRoot = path.join(outputRoot, '_input_pool');
    const outputPoolRoot = path.join(outputRoot, '_output_pool');
    const poolImagesDir = path.join(inputPoolRoot, 'images', 'train');
    const poolLabelsDir = path.join(inputPoolRoot, 'labels', 'train');
    await storageAdapter.ensureDir(poolImagesDir);
    await storageAdapter.ensureDir(poolLabelsDir);

    for (const item of scopedPool) {
      const destImage = path.join(poolImagesDir, item.storedName);
      const destLabel = path.join(poolLabelsDir, path.parse(item.storedName).name + '.txt');
      if (path.resolve(item.sourcePath) !== path.resolve(destImage)) {
        await storageAdapter.copyFile(item.sourcePath, destImage);
      }
      if (path.resolve(item.labelPath) !== path.resolve(destLabel)) {
        await storageAdapter.copyFile(item.labelPath, destLabel);
      }
    }

    // ---------- 3. Augmentation parameters: desired FINAL image count (for the scoped pool) ----------
    // targetTrainTotal from the UI = "number of images after augmentation" — when scoped,
    // this means "final count for just the scoped subset", not the whole dataset.
    let desiredTotal =
      typeof targetTrainTotal === 'number' && targetTrainTotal > 0
        ? targetTrainTotal
        : 0;
    if (augmentationMultiplier && !desiredTotal) {
      desiredTotal = Math.max(
        scopedPool.length,
        Math.round(scopedPool.length * augmentationMultiplier),
      );
    }
    if (!desiredTotal) {
      desiredTotal = Math.max(scopedPool.length * 2, 100);
    }
    // Never ask for fewer images than we already have
    desiredTotal = Math.max(desiredTotal, scopedPool.length);

    // Python generates additional variants; aim so originals + augs ≈ desiredTotal
    const additionalNeeded = Math.max(0, desiredTotal - scopedPool.length);
    // Ask Python for at least `additionalNeeded` variants (it creates ceil(target/n)*n files)
    const effectiveTargetTrainTotal =
      additionalNeeded > 0 ? Math.max(additionalNeeded, scopedPool.length) : scopedPool.length;

    const effectiveValTestMultiplier =
      typeof valTestMultiplier === 'number' && valTestMultiplier > 0 ? valTestMultiplier : 2;

    // Check for cancellation before starting Python
    const checkBeforePython = await Dataset.findById(datasetId);
    if (checkBeforePython?.augmentationStatus === 'cancelled') {
      throw new Error('Augmentation cancelled by user');
    }

    // Skip Python when user asked for the same count as current (no extra images needed)
    if (additionalNeeded > 0) {
      const result = await runPythonAugmentation({
        inputRoot: inputPoolRoot,
        outputRoot: outputPoolRoot,
        targetTrainTotal: effectiveTargetTrainTotal,
        valTestMultiplier: effectiveValTestMultiplier,
        targetSize: typeof targetSize === 'number' && targetSize > 0 ? targetSize : 640,
        jobId: job.id,
        datasetId,
      });

      if (result.process) {
        pythonProcess = result.process;
      }

      const checkAfterPython = await Dataset.findById(datasetId);
      if (checkAfterPython?.augmentationStatus === 'cancelled') {
        throw new Error('Augmentation cancelled by user');
      }

      if (result.exitCode !== 0) {
        const message =
          result.stderr ||
          result.stdout ||
          `Python augmentation exited with code ${result.exitCode}`;
        throw new Error(message);
      }
    }

    // ---------- 4. Combined list: passthrough (unchanged) + scoped originals + augmented ----------
    // (augmented-variant cap is against the SCOPED portion only — desiredTotal means "final
    // count for the scoped subset", so passthrough images must never count against it)
    const combinedList = [
      ...passthroughPool.map((p) => ({ ...p })),
      ...scopedPool.map((p) => ({ ...p })),
    ];
    const combinedNames = new Set(combinedList.map((p) => p.storedName.toLowerCase()));
    let scopedCount = scopedPool.length;

    try {
      const augImagesDir = path.join(outputPoolRoot, 'images', 'train');
      const augEntries = await fs.readdir(augImagesDir, { withFileTypes: true });
      for (const entry of augEntries) {
        if (scopedCount >= desiredTotal) break;
        if (!entry.isFile()) continue;
        const storedName = entry.name;
        const nameKey = storedName.toLowerCase();
        // ✅ Skip if this filename is already in the list (original or prior aug)
        if (combinedNames.has(nameKey)) continue;
        const storedPath = `images/train/${storedName}`;
        const labelPath = getLabelFilePath(storedPath);
        const fullLabelPath = path.join(outputPoolRoot, labelPath);
        const labelExists = await storageAdapter.exists(fullLabelPath);
        if (!labelExists) continue;
        combinedNames.add(nameKey);
        combinedList.push({
          storedName,
          storedPath,
          sourcePath: path.join(outputPoolRoot, storedPath),
          labelPath: fullLabelPath,
        });
        scopedCount += 1;
      }
    } catch {
      // No augmented images dir
    }

    // ---------- 5. Canonical split once (same seed/ratios as preprocessing and post-annotation) ----------
    let { train: trainList, val: valList, test: testList } = splitDataset(combinedList, originalDataset);

    // ✅ Hard guarantee: no filename in more than one split (defensive; splitDataset is already disjoint by item)
    const enforceDisjointByFilename = (train, val, test) => {
      const used = new Set();
      const take = (list) => {
        const out = [];
        for (const item of list) {
          const key = String(item.storedName || '').toLowerCase();
          if (!key || used.has(key)) continue;
          used.add(key);
          out.push(item);
        }
        return out;
      };
      return { train: take(train), val: take(val), test: take(test) };
    };
    ({ train: trainList, val: valList, test: testList } = enforceDisjointByFilename(
      trainList,
      valList,
      testList,
    ));

    // ---------- 6. Write new version train/val/test from split (no reuse of old structure) ----------
    const imagesTrainPath = path.join(outputRoot, 'images', 'train');
    const imagesValPath = path.join(outputRoot, 'images', 'val');
    const imagesTestPath = path.join(outputRoot, 'images', 'test');
    const labelsTrainPath = path.join(outputRoot, 'labels', 'train');
    const labelsValPath = path.join(outputRoot, 'labels', 'val');
    const labelsTestPath = path.join(outputRoot, 'labels', 'test');
    await storageAdapter.ensureDir(imagesTrainPath);
    await storageAdapter.ensureDir(imagesValPath);
    await storageAdapter.ensureDir(imagesTestPath);
    await storageAdapter.ensureDir(labelsTrainPath);
    await storageAdapter.ensureDir(labelsValPath);
    await storageAdapter.ensureDir(labelsTestPath);

    // ✅ Track written names so we never copy the same file into a second split on disk
    const writtenNames = new Set();
    const writeSplit = async (list, imagesDir, labelsDir, splitName) => {
      let written = 0;
      let skippedDup = 0;
      for (const item of list) {
        const nameKey = String(item.storedName || '').toLowerCase();
        if (!nameKey || writtenNames.has(nameKey)) {
          skippedDup += 1;
          continue;
        }
        writtenNames.add(nameKey);
        const destImage = path.join(imagesDir, item.storedName);
        const destLabel = path.join(labelsDir, path.parse(item.storedName).name + '.txt');
        await storageAdapter.copyFile(item.sourcePath, destImage);
        await storageAdapter.copyFile(item.labelPath, destLabel);
        written += 1;
      }
      if (skippedDup > 0) {
        console.warn('[AUGMENT-WORKER] Skipped duplicate filenames while writing split', {
          split: splitName,
          written,
          skippedDup,
        });
      }
      return written;
    };

    await writeSplit(trainList, imagesTrainPath, labelsTrainPath, 'train');
    await writeSplit(valList, imagesValPath, labelsValPath, 'val');
    await writeSplit(testList, imagesTestPath, labelsTestPath, 'test');

    // ---------- 7. Clean up temp pools ----------
    try {
      await fs.rm(path.join(outputRoot, '_input_pool'), { recursive: true, force: true });
      await fs.rm(path.join(outputRoot, '_output_pool'), { recursive: true, force: true });
    } catch (e) {
      console.warn('[AUGMENT-WORKER] Could not remove temp pools:', e.message);
    }

    // ---------- 8. fix_labels on final labels ----------
    const labelsRootForFix = path.join(outputRoot, 'labels');
    const fixResult = await runPythonFixLabels({ labelsRoot: labelsRootForFix });
    if (fixResult.exitCode !== 0) {
      const message =
        fixResult.stderr ||
        fixResult.stdout ||
        `Python fix_labels exited with code ${fixResult.exitCode}`;
      throw new Error(message);
    }

    // ---------- 8.5. Copy dataset metadata files (data.yaml, class-mapping.json) from source ----------
    const metadataFiles = ['data.yaml', 'class-mapping.json'];
    const filesCopied = [];
    const filesMissing = [];

    for (const fileName of metadataFiles) {
      const sourcePath = path.join(inputRoot, fileName);
      const targetPath = path.join(outputRoot, fileName);

      try {
        const exists = await storageAdapter.exists(sourcePath);
        if (exists) {
          await storageAdapter.copyFile(sourcePath, targetPath);
          filesCopied.push(fileName);

          // ✅ For data.yaml: update 'path' to point to augmented output, not source
          // Otherwise YOLO training loads from source dataset (e.g. 47 images) instead of augmented (e.g. 849)
          if (fileName === 'data.yaml') {
            let content = await fs.readFile(targetPath, 'utf8');
            const outputPathNormalized = outputRoot.replace(/\\/g, '/');
            content = content.replace(/^path:\s*.*$/m, `path: ${outputPathNormalized}`);
            await fs.writeFile(targetPath, content, 'utf8');
          }
        } else {
          filesMissing.push(fileName);
          console.warn('[AUGMENT-WORKER] Metadata file missing in source', {
            file: fileName,
            sourceVersion: originalDataset.version,
            sourcePath,
          });
        }
      } catch (copyError) {
        // Copy failure is critical - fail the augmentation job
        throw new Error(
          `Failed to copy metadata file "${fileName}" from source dataset: ${copyError.message}`,
        );
      }
    }

    console.log('[AUGMENT-WORKER] Copied dataset metadata files', {
      sourceVersion: originalDataset.version,
      targetVersion: newVersion,
      filesCopied,
      filesMissing: filesMissing.length > 0 ? filesMissing : undefined,
    });

    // ---------- 9. Build files manifest and counts from outputRoot ----------
    // ✅ totalImages = unique image filenames (never train+val+test with overlapping copies)
    const imagesRoot = path.join(outputRoot, 'images');
    const labelRoot = path.join(outputRoot, 'labels');
    let totalImages = 0;
    let trainCount = 0;
    let valCount = 0;
    let testCount = 0;
    const filesManifest = [];
    const countedImageNames = new Set();

    for (const split of ['train', 'val', 'test']) {
      const splitImagesDir = path.join(imagesRoot, split);
      const splitLabelsDir = path.join(labelRoot, split);

      try {
        const imageEntries = await fs.readdir(splitImagesDir, { withFileTypes: true });
        for (const entry of imageEntries) {
          if (!entry.isFile()) continue;
          const storedName = entry.name;
          const nameKey = storedName.toLowerCase();
          // Prefer first split we visit (train → val → test); skip overlapping copies
          if (countedImageNames.has(nameKey)) {
            console.warn('[AUGMENT-WORKER] Overlapping image copy ignored for counts', {
              split,
              storedName,
            });
            continue;
          }
          countedImageNames.add(nameKey);
          const fullPath = path.join(splitImagesDir, storedName);
          let stat;
          try {
            stat = await fs.stat(fullPath);
          } catch {
            continue;
          }
          const storedPath = path.relative(outputRoot, fullPath).replace(/\\/g, '/');

          filesManifest.push({
            storedName,
            originalName: storedName,
            type: 'image',
            size: stat.size,
            folder: split,
            storedPath,
          });
          totalImages += 1;
          if (split === 'train') trainCount += 1;
          else if (split === 'val') valCount += 1;
          else if (split === 'test') testCount += 1;
        }
      } catch {}

      try {
        const labelEntries = await fs.readdir(splitLabelsDir, { withFileTypes: true });
        for (const entry of labelEntries) {
          if (!entry.isFile()) continue;
          const storedName = entry.name;
          const fullPath = path.join(splitLabelsDir, storedName);
          let stat;
          try {
            stat = await fs.stat(fullPath);
          } catch {
            continue;
          }
          const storedPath = path.relative(outputRoot, fullPath).replace(/\\/g, '/');
          filesManifest.push({
            storedName,
            originalName: storedName,
            type: 'label',
            size: stat.size,
            folder: split,
            storedPath,
          });
        }
      } catch {}
    }

    const sizeBytes = await computeFolderSize(outputRoot);
    // Attach files manifest and update final metadata
    if (filesManifest.length > 0) {
      augmentedDataset.files = filesManifest;
    }

    // Extract labels (class_0, class_1, ...) from label files for detected-classes endpoint
    const labelsSet = new Set();
    for (const split of ['train', 'val', 'test']) {
      const splitLabelsDir = path.join(labelRoot, split);
      try {
        const entries = await fs.readdir(splitLabelsDir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isFile() && ent.name.endsWith('.txt')) {
            const labelPath = path.join(splitLabelsDir, ent.name);
            const content = await fs.readFile(labelPath, 'utf-8');
            const lines = content.trim().split('\n');
            for (const line of lines) {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 5) {
                const classId = parseInt(parts[0], 10);
                if (!isNaN(classId) && classId >= 0) labelsSet.add(`class_${classId}`);
              }
            }
          }
        }
      } catch {}
    }
    augmentedDataset.labels = Array.from(labelsSet).sort((a, b) => {
      const idA = parseInt(a.replace('class_', ''), 10);
      const idB = parseInt(b.replace('class_', ''), 10);
      return idA - idB;
    });

    // Final cancellation check before activation (race condition safety)
    const latestDataset = await Dataset.findById(datasetId);
    if (latestDataset?.augmentationStatus === 'cancelled') {
      throw new Error('Augmentation cancelled before activation');
    }

    // ---------- 9b. Create Image documents so Annotate / Edit can load the new version ----------
    // Without these, Simulation → Edit annotations shows empty / "no images" for augmented datasets.
    try {
      const sharp = require('sharp');
      let imageDocsCreated = 0;
      const indexedFilenames = new Set();
      for (const split of ['train', 'val', 'test']) {
        const splitImagesDir = path.join(imagesRoot, split);
        let imageEntries = [];
        try {
          imageEntries = await fs.readdir(splitImagesDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of imageEntries) {
          if (!entry.isFile()) continue;
          const storedName = entry.name;
          const ext = path.extname(storedName).toLowerCase();
          if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') continue;
          const nameKey = storedName.toLowerCase();
          // ✅ One Image doc per unique filename (train wins over val/test)
          if (indexedFilenames.has(nameKey)) continue;
          indexedFilenames.add(nameKey);
          const storedPath = `images/${split}/${storedName}`;
          const fullPath = path.join(outputRoot, storedPath);
          const labelRel = getLabelFilePath(storedPath);
          const labelFull = path.join(outputRoot, labelRel);
          const hasLabels = await storageAdapter.exists(labelFull);

          let width = 0;
          let height = 0;
          let size = 0;
          try {
            const meta = await sharp(fullPath).metadata();
            width = meta.width || 0;
            height = meta.height || 0;
            const st = await fs.stat(fullPath);
            size = st.size || 0;
          } catch {
            // keep zeros; Image schema requires width/height — use 1 as fallback
            width = width || 1;
            height = height || 1;
          }

          await Image.findOneAndUpdate(
            { datasetId: augmentedDataset._id, storedPath },
            {
              datasetId: augmentedDataset._id,
              filename: storedName,
              storedPath,
              folder: split,
              size,
              width: width || 1,
              height: height || 1,
              hasLabels,
              hasAnnotations: false,
              convertedAt: hasLabels ? new Date() : undefined,
            },
            { upsert: true, new: true }
          );
          imageDocsCreated += 1;
        }
      }
      console.log('[AUGMENT-WORKER] Created Image documents for augmented dataset', {
        augmentedDatasetId: augmentedDataset._id.toString(),
        imageDocsCreated,
      });
    } catch (imgErr) {
      console.error('[AUGMENT-WORKER] Failed to create Image documents:', imgErr.message);
      throw new Error(`Augmented dataset files ready but Image index failed: ${imgErr.message}`);
    }

    // ---------- 9c. Copy categories from source so Edit annotations has class names ----------
    try {
      const sourceCategories = await Category.find({ datasetId: originalDataset._id }).lean();
      for (const cat of sourceCategories) {
        await Category.findOneAndUpdate(
          { datasetId: augmentedDataset._id, name: cat.name },
          {
            datasetId: augmentedDataset._id,
            name: cat.name,
            color: cat.color,
            description: cat.description,
            order: cat.order ?? 0,
            createdBy: cat.createdBy,
          },
          { upsert: true, new: true }
        );
      }
      console.log('[AUGMENT-WORKER] Copied categories to augmented dataset', {
        count: sourceCategories.length,
        augmentedDatasetId: augmentedDataset._id.toString(),
      });
    } catch (catErr) {
      console.warn('[AUGMENT-WORKER] Failed to copy categories (non-fatal):', catErr.message);
    }

    augmentedDataset.status = 'ready';
    augmentedDataset.augmentationStatus = 'succeeded';
    augmentedDataset.totalImages = totalImages;
    augmentedDataset.trainCount = trainCount;
    augmentedDataset.valCount = valCount;
    augmentedDataset.testCount = testCount;
    augmentedDataset.sizeBytes = sizeBytes;
    augmentedDataset.labeledImages = totalImages;
    augmentedDataset.unlabeledImages = 0;
    augmentedDataset.unlabeledImagesCount = 0;
    augmentedDataset.augmentationError = undefined;
    augmentedDataset.isActive = true; // Make augmented dataset active
    await augmentedDataset.save();

    // Update original dataset: mark as inactive and update augmentation status
    // Original files are preserved but dataset is no longer the active version
    const previousVersion = originalDataset.version;
    originalDataset.isActive = false;
    originalDataset.augmentationStatus = 'succeeded';
    await originalDataset.save();

    // Remove from active tracking map on success
    activeAugmentations.delete(job.id);
    console.log('[AUGMENT-WORKER] Removed job from active map (success)', {
      jobId: job.id,
    });

    console.log('[AUGMENTATION] augmentation_completed', {
      originalDatasetId: originalDataset._id.toString(),
      originalVersion: previousVersion,
      augmentedDatasetId: augmentedDataset._id.toString(),
      augmentedVersion: augmentedDataset.version,
      totalImages,
      sizeBytes,
      augmentationMultiplier: augmentedDataset.augmentationMultiplier
    });

    console.log('[DATASET] dataset_version_switched', {
      company,
      project,
      fromVersion: previousVersion,
      toVersion: augmentedDataset.version,
      originalDatasetId: originalDataset._id.toString(),
      augmentedDatasetId: augmentedDataset._id.toString()
    });

    return {
      augmentedDatasetId: augmentedDataset._id.toString(),
    };
  } catch (err) {
    console.error('[AUGMENT-WORKER] Error processing augmentation job', {
      jobId: job.id,
      datasetId,
      error: err.message,
    });

    // Check if this is a cancellation
    const isCancellation =
      err.message?.includes('cancelled') ||
      err.message?.includes('terminated by cancellation') ||
      (originalDataset && (await Dataset.findById(datasetId))?.augmentationStatus === 'cancelled');

    if (isCancellation) {
      console.log('[AUGMENT-WORKER] Cancellation detected', {
        jobId: job.id,
        datasetId,
      });

      // Kill Python process if still running
      if (pythonProcess && !pythonProcess.killed) {
        try {
          pythonProcess.kill('SIGTERM');
          console.log('[AUGMENT-WORKER] Sent SIGTERM to Python process', {
            jobId: job.id,
            pid: pythonProcess.pid,
          });
        } catch (killError) {
          console.warn('[AUGMENT-WORKER] Failed to kill Python process', {
            jobId: job.id,
            error: killError.message,
          });
        }
      }

      // Cleanup: Delete augmented dataset files and MongoDB document (plan: no orphan folder or document)
      if (augmentedDataset && augmentedDataset._id) {
        // Delete files from disk (best-effort)
        if (augmentedDataset.storagePath) {
          try {
            const storagePathExists = await storageAdapter.exists(augmentedDataset.storagePath);
            if (storagePathExists) {
              await fs.rm(augmentedDataset.storagePath, { recursive: true, force: true });
              console.log('[AUGMENT-WORKER] Deleted augmented dataset files', {
                augmentedDatasetId: augmentedDataset._id.toString(),
                storagePath: augmentedDataset.storagePath,
              });
            }
          } catch (folderErr) {
            console.error('[AUGMENT-WORKER] Failed to delete augmented dataset folder', {
              augmentedDatasetId: augmentedDataset._id.toString(),
              error: folderErr.message,
            });
          }
        }
        // Always delete MongoDB document so list endpoints never return the cancelled version
        try {
          await Dataset.findByIdAndDelete(augmentedDataset._id);
          console.log('[AUGMENT-WORKER] Deleted augmented dataset from MongoDB', {
            augmentedDatasetId: augmentedDataset._id.toString(),
            version: augmentedDataset.version,
          });
        } catch (docErr) {
          console.error('[AUGMENT-WORKER] Failed to delete augmented dataset document', {
            augmentedDatasetId: augmentedDataset._id.toString(),
            error: docErr.message,
          });
        }
      }

      console.log('[AUGMENT-WORKER] Cleanup completed', {
        jobId: job.id,
        datasetId,
      });
    }

    // Remove from active tracking map
    activeAugmentations.delete(job.id);
    console.log('[AUGMENT-WORKER] Removed job from active map', {
      jobId: job.id,
    });

    try {
      // Special case: if the error is "Augmentation already running for this dataset",
      // this job is effectively a duplicate/no-op and we should NOT overwrite the
      // original dataset's augmentationStatus/augmentationError, which may reflect
      // a real in-flight augmentation. We still allow Bull to mark the job as failed.
      if (err.message !== 'Augmentation already running for this dataset') {
        if (!isCancellation) {
          // Only update status if not cancelled (cancellation is handled by controller)
          if (augmentedDataset && augmentedDataset._id) {
            augmentedDataset.status = 'failed';
            augmentedDataset.augmentationStatus = 'failed';
            augmentedDataset.augmentationError = err.message;
            await augmentedDataset.save();
          }

          if (originalDataset) {
            // Do not touch original status for duplicate jobs; for real failures we
            // mark the augmentation as failed with the error message.
            originalDataset.augmentationStatus = 'failed';
            originalDataset.augmentationError = err.message;
            await originalDataset.save();
          }
        }
      }
    } catch (updateErr) {
      console.error(
        '[AUGMENT-WORKER] Failed to update dataset augmentation state after error',
        updateErr,
      );
    }

    throw err;
  }
};

/**
 * Start the augmentation worker.
 *
 * This is similar to preprocessingWorker.startWorker but only attaches a
 * processor to augmentationQueue and does not affect other queues.
 */
const startWorker = async () => {
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/visiondb';
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    family: 4,
  });
  console.log('✅ Augmentation worker connected to MongoDB');

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

  augmentationQueue.process(1, async (job) => {
    return processAugmentationJob(job);
  });

  console.log('✅ Augmentation worker started. Waiting for jobs...');
};

// Global error handlers
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down augmentation worker gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

if (require.main === module) {
  startWorker().catch((error) => {
    console.error('❌ Augmentation worker startup error:', error);
    process.exit(1);
  });
}

module.exports = {
  startWorker,
  processAugmentationJob,
  activeAugmentations, // Export for controller to access for cancellation
};

