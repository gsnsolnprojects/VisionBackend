const mongoose = require('mongoose');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const Image = require('../models/Image');
const Annotation = require('../models/Annotation');
const Category = require('../models/Category');
const Dataset = require('../models/Dataset');
const storageAdapter = require('../services/storageAdapter');
const { segmentAtClick } = require('../services/samClickWorker');
const { validateBbox } = require('../utils/bboxValidator');
const { sendError, sendValidationError, sendNotFoundError } = require('../utils/errors');
const {
  generateLabelFileContent,
  generateDataYaml,
  getLabelFilePath,
  convertYOLOValuesToBbox,
  normalizePolygonPoints,
  bboxToPolygon
} = require('../utils/yoloConverter');
const { splitDataset } = require('../utils/splitDataset');

/**
 * Annotation Controller
 * 
 * Handles all annotation-related operations.
 * Authentication is intentionally skipped in this phase.
 */

// System user ID for createdBy (since auth is skipped)
const SYSTEM_USER_ID = new mongoose.Types.ObjectId('000000000000000000000000');

/**
 * ✅ Repair path for augmented (or any) datasets that have files on disk / in
 * dataset.files but no Image Mongo documents. Without Image rows, Annotate shows
 * "No images found for this dataset."
 */
async function ensureImageIndexForDataset(dataset) {
  const datasetId = dataset._id;
  const existingCount = await Image.countDocuments({ datasetId });
  if (existingCount > 0) return existingCount;

  const datasetPath = storageAdapter.buildDatasetPath(
    dataset.company,
    dataset.project,
    dataset.version
  );

  /** @type {Array<{ storedName: string, storedPath: string, folder: string, size?: number }>} */
  let imageFiles = [];

  // Prefer dataset.files manifest (augmented datasets populate this)
  if (Array.isArray(dataset.files) && dataset.files.length > 0) {
    imageFiles = dataset.files
      .filter((f) => f && (f.type === 'image' || /\.(jpe?g|png)$/i.test(f.storedName || f.originalName || '')))
      .map((f) => ({
        storedName: f.storedName || path.basename(f.storedPath || f.originalName || ''),
        storedPath: f.storedPath || `images/${f.folder || 'train'}/${f.storedName}`,
        folder: f.folder || 'train',
        size: typeof f.size === 'number' ? f.size : 0,
      }))
      .filter((f) => f.storedName && f.storedPath);
  }

  // Fallback: scan images/train|val|test on disk
  if (imageFiles.length === 0) {
    for (const split of ['train', 'val', 'test', 'dataset']) {
      const splitDir = path.join(datasetPath, 'images', split);
      try {
        const entries = await fs.readdir(splitDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') continue;
          imageFiles.push({
            storedName: entry.name,
            storedPath: `images/${split}/${entry.name}`,
            folder: split,
            size: 0,
          });
        }
      } catch {
        // skip missing split
      }
    }
  }

  if (imageFiles.length === 0) return 0;

  let created = 0;
  let sharp = null;
  try {
    sharp = require('sharp');
  } catch {
    /* optional */
  }

  for (const file of imageFiles) {
    const fullPath = path.join(datasetPath, file.storedPath);
    let width = 1;
    let height = 1;
    let size = file.size || 0;
    try {
      if (sharp) {
        const meta = await sharp(fullPath).metadata();
        width = meta.width || 1;
        height = meta.height || 1;
      }
      const st = await fs.stat(fullPath);
      size = st.size || size;
    } catch {
      // keep defaults; file may be Azure-only or missing locally
    }

    let hasLabels = false;
    try {
      const labelRel = getLabelFilePath(file.storedPath);
      hasLabels = await storageAdapter.exists(path.join(datasetPath, labelRel));
    } catch {
      hasLabels = false;
    }

    await Image.findOneAndUpdate(
      { datasetId, storedPath: file.storedPath },
      {
        datasetId,
        filename: file.storedName,
        storedPath: file.storedPath,
        folder: file.folder,
        size,
        width,
        height,
        hasLabels,
        hasAnnotations: false,
        convertedAt: hasLabels ? new Date() : undefined,
      },
      { upsert: true, new: true }
    );
    created += 1;
  }

  // Copy categories from source dataset if this version has none (common for old augmentations)
  try {
    const catCount = await Category.countDocuments({ datasetId });
    if (catCount === 0 && dataset.backupDatasetId) {
      const sourceCats = await Category.find({ datasetId: dataset.backupDatasetId }).lean();
      for (const cat of sourceCats) {
        await Category.findOneAndUpdate(
          { datasetId, name: cat.name },
          {
            datasetId,
            name: cat.name,
            color: cat.color,
            description: cat.description,
            order: cat.order ?? 0,
            createdBy: cat.createdBy || SYSTEM_USER_ID,
          },
          { upsert: true, new: true }
        );
      }
    }
  } catch (catErr) {
    console.warn('[ensureImageIndexForDataset] category copy failed:', catErr.message);
  }

  // Align totalImages if it was wrong / zero
  try {
    if (!dataset.totalImages || dataset.totalImages < created) {
      dataset.totalImages = created;
      await dataset.save();
    }
  } catch {
    /* non-fatal */
  }

  console.log('[ensureImageIndexForDataset] Hydrated Image index', {
    datasetId: String(datasetId),
    created,
  });
  return created;
}

function validatePolygon(polygon) {
  if (!Array.isArray(polygon)) {
    return { valid: false, error: 'polygon must be an array of points [[x,y], ...]' };
  }
  if (polygon.length < 3) {
    return { valid: false, error: 'polygon must have at least 3 points' };
  }
  for (let i = 0; i < polygon.length; i++) {
    const pt = polygon[i];
    if (!Array.isArray(pt) || pt.length !== 2) {
      return { valid: false, error: `polygon[${i}] must be [x, y]` };
    }
    const [x, y] = pt;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { valid: false, error: `polygon[${i}] must contain numeric x and y` };
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return { valid: false, error: `polygon[${i}] values must be normalized between 0 and 1` };
    }
  }
  return { valid: true };
}

function polygonToBbox(polygon) {
  const xs = polygon.map(pt => pt[0]);
  const ys = polygon.map(pt => pt[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return [minX, minY, maxX - minX, maxY - minY];
}

/**
 * GET /api/dataset/:datasetId/images/unannotated
 * 
 * Get images with zero annotations (for good images confirmation)
 */
const getUnannotatedImages = async (req, res) => {
  try {
    const { datasetId } = req.params;

    // Validate datasetId
    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Check dataset exists
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Get all images in dataset
    const images = await Image.find({ datasetId });

    // Filter images with zero annotations
    const unannotatedImages = [];
    for (const image of images) {
      const annotationCount = await Annotation.countDocuments({
        imageId: image._id,
        deletedAt: null
      });

      if (annotationCount === 0) {
        // Generate signed URLs for image
        const imageUrl = await storageAdapter.generateSignedUrl(image.storedPath, 3600, {
          datasetId: datasetId.toString()
        });
        const thumbnailPath = image.storedPath.replace(/^images\//, 'thumbnails/');
        const datasetPath = storageAdapter.buildDatasetPath(dataset.company, dataset.project, dataset.version);
        const fullThumbnailPath = path.join(datasetPath, thumbnailPath);
        const thumbnailExists = await storageAdapter.exists(fullThumbnailPath);
        const thumbnailUrl = await storageAdapter.generateSignedUrl(
          thumbnailExists ? thumbnailPath : image.storedPath,
          3600,
          { datasetId: datasetId.toString() }
        );

        unannotatedImages.push({
          id: image._id,
          filename: image.filename,
          url: imageUrl,
          thumbnailUrl: thumbnailUrl,
          folder: image.folder,
          size: image.size
        });
      }
    }

    return res.status(200).json({
      unannotatedImages: unannotatedImages,
      count: unannotatedImages.length
    });

  } catch (error) {
    console.error('Error getting unannotated images:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * GET /api/dataset/:datasetId/unlabeled-images
 * 
 * Get unlabeled images for a dataset (paginated)
 */
const getUnlabeledImages = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    // Validate datasetId
    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Check dataset exists
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Get unlabeled images using model static method
    const result = await Image.findUnlabeled(datasetId, page, limit);

    // Format response with signed URLs
    const images = await Promise.all(
      result.images.map(async (img) => {
        // Build full file path relative to dataset root
        const imagePath = img.storedPath; // e.g., "images/unlabeled/image_001.jpg"
        
        // Generate signed URL for image (1 hour expiration)
        const imageUrl = await storageAdapter.generateSignedUrl(imagePath, 3600, {
          datasetId: datasetId.toString()
        });
        
        // Build thumbnail path
        const thumbnailPath = imagePath.replace(/^images\//, 'thumbnails/');
        
        // Check if thumbnail exists, if not use image path
        const datasetPath = storageAdapter.buildDatasetPath(dataset.company, dataset.project, dataset.version);
        const fullThumbnailPath = path.join(datasetPath, thumbnailPath);
        const thumbnailExists = await storageAdapter.exists(fullThumbnailPath);
        
        // Generate signed URL for thumbnail (or use image if thumbnail doesn't exist)
        const thumbnailUrl = await storageAdapter.generateSignedUrl(
          thumbnailExists ? thumbnailPath : imagePath,
          3600,
          { datasetId: datasetId.toString() }
        );
        
        return {
          id: img._id,
          filename: img.filename,
          url: imageUrl,
          thumbnailUrl: thumbnailUrl,
          folder: img.folder,
          size: img.size,
          width: img.width,
          height: img.height
        };
      })
    );

    return res.status(200).json({
      images,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages
    });

  } catch (error) {
    console.error('Error getting unlabeled images:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * GET /api/dataset/:datasetId/images
 *
 * Get all images for a dataset with optional status filter.
 * This endpoint is additive and does not change existing behavior of getUnlabeledImages.
 *
 * Query params:
 * - status: 'all' | 'unannotated' | 'annotated' (default: 'all')
 */
const getDatasetImages = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { status = 'all' } = req.query;

    // Validate datasetId
    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Check dataset exists
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // ✅ Auto-heal: augmented datasets created before Image indexing had files but no Image rows
    await ensureImageIndexForDataset(dataset);

    // Build base filter
    const imageFilter = { datasetId };

    // Apply optional annotation status filter (based on hasAnnotations flag)
    if (status === 'annotated') {
      imageFilter.hasAnnotations = true;
    } else if (status === 'unannotated') {
      imageFilter.hasAnnotations = false;
    }

    // Fetch images in a stable order (by createdAt ascending, then _id)
    const images = await Image.find(imageFilter)
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    // ✅ Deduplicate by filename: overlapping train/test splits used to create
    // two Image rows for the same photo (e.g. 30 uploads → 33 annotate images).
    // Prefer annotated / labeled / train over val/test when colliding.
    const folderPriority = { train: 0, val: 1, test: 2 };
    const byFilename = new Map();
    for (const img of images) {
      const key = String(img.filename || path.basename(img.storedPath || '') || img._id).toLowerCase();
      const existing = byFilename.get(key);
      if (!existing) {
        byFilename.set(key, img);
        continue;
      }
      const score = (i) =>
        (i.hasAnnotations ? 100 : 0) +
        (i.hasLabels ? 10 : 0) +
        (100 - (folderPriority[i.folder] ?? 50));
      if (score(img) > score(existing)) {
        byFilename.set(key, img);
      }
    }
    const uniqueImages = Array.from(byFilename.values()).sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return String(a._id).localeCompare(String(b._id));
    });

    // Format response with signed URLs
    const formatted = await Promise.all(
      uniqueImages.map(async (img) => {
        const imagePath = img.storedPath;

        const imageUrl = await storageAdapter.generateSignedUrl(imagePath, 3600, {
          datasetId: datasetId.toString()
        });

        const thumbnailPath = imagePath.replace(/^images\//, 'thumbnails/');
        const datasetPath = storageAdapter.buildDatasetPath(dataset.company, dataset.project, dataset.version);
        const fullThumbnailPath = path.join(datasetPath, thumbnailPath);
        const thumbnailExists = await storageAdapter.exists(fullThumbnailPath);

        const thumbnailUrl = await storageAdapter.generateSignedUrl(
          thumbnailExists ? thumbnailPath : imagePath,
          3600,
          { datasetId: datasetId.toString() }
        );

        return {
          id: img._id,
          filename: img.filename,
          url: imageUrl,
          thumbnailUrl,
          folder: img.folder,
          size: img.size,
          width: img.width,
          height: img.height,
          hasAnnotations: img.hasAnnotations === true,
          hasLabels: img.hasLabels === true,
          batchId: img.batchId || null
        };
      })
    );

    return res.status(200).json({
      images: formatted,
      total: formatted.length
    });
  } catch (error) {
    console.error('Error getting dataset images:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * GET /api/dataset/:datasetId/annotations
 * 
 * Get annotations for a dataset (optionally filtered by imageId)
 */
const getAnnotations = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { imageId } = req.query;

    // Validate datasetId
    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Check dataset exists
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Get annotations using model static method
    const annotations = await Annotation.findByDatasetId(
      datasetId,
      imageId ? new mongoose.Types.ObjectId(imageId) : null
    );

    // Get image dimensions if querying by imageId (for frontend coordinate normalization)
    let imageDimensions = null;
    if (imageId) {
      const image = await Image.findById(imageId);
      if (image) {
        imageDimensions = {
          width: image.width,
          height: image.height
        };
      }
    }

    // Format response
    const formattedAnnotations = annotations.map(ann => ({
      id: ann._id,
      imageId: ann.imageId,
      bbox: ann.bbox,
      polygon: ann.polygon,
      categoryId: ann.categoryId,
      categoryName: ann.categoryName,
      state: ann.state,
      createdAt: ann.createdAt,
      updatedAt: ann.updatedAt,
      createdBy: ann.createdBy,
      updatedBy: ann.updatedBy,
      reviewedBy: ann.reviewedBy,
      reviewedAt: ann.reviewedAt,
      approvedBy: ann.approvedBy,
      approvedAt: ann.approvedAt
    }));

    const response = {
      annotations: formattedAnnotations,
      total: formattedAnnotations.length
    };

    // Include image dimensions if available (when querying by imageId)
    if (imageDimensions) {
      response.imageDimensions = imageDimensions;
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('Error getting annotations:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * POST /api/dataset/:datasetId/annotations
 * 
 * Create a new annotation
 */
const createAnnotation = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { imageId, bbox, polygon, categoryId } = req.body;

    // Validate required fields
    if (!imageId || (!bbox && !polygon) || !categoryId) {
      return sendValidationError(res, 'body', 'Missing required fields: imageId, categoryId, and either bbox or polygon');
    }

    // Validate datasetId
    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Check dataset exists
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    let finalBbox = bbox;
    let finalPolygon = polygon;
    if (finalPolygon !== undefined) {
      const polygonValidation = validatePolygon(finalPolygon);
      if (!polygonValidation.valid) {
        return sendValidationError(res, 'polygon', polygonValidation.error);
      }
      finalPolygon = normalizePolygonPoints(finalPolygon);
      finalBbox = polygonToBbox(finalPolygon);
    }
    const bboxValidation = validateBbox(finalBbox);
    if (!bboxValidation.valid) {
      return sendValidationError(res, 'bbox', bboxValidation.error);
    }

    // Validate imageId
    if (!mongoose.Types.ObjectId.isValid(imageId)) {
      return sendNotFoundError(res, 'Image', imageId);
    }

    // Check image exists and belongs to dataset
    const image = await Image.findOne({ _id: imageId, datasetId });
    if (!image) {
      return sendNotFoundError(res, 'Image', imageId);
    }

    // Validate categoryId
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return sendNotFoundError(res, 'Category', categoryId);
    }

    // Check category exists and belongs to dataset
    const category = await Category.findOne({ _id: categoryId, datasetId });
    if (!category) {
      return sendNotFoundError(res, 'Category', categoryId);
    }

    // Create annotation
    const annotation = new Annotation({
      datasetId,
      imageId,
      bbox: finalBbox,
      polygon: finalPolygon,
      categoryId,
      categoryName: category.name, // Denormalize category name
      state: 'draft',
      createdBy: SYSTEM_USER_ID
    });

    await annotation.save();

    console.log('[ANNOTATION] annotation_saved', {
      datasetId: datasetId.toString(),
      imageId: imageId.toString(),
      annotationId: annotation._id.toString()
    });

    // Update image annotation state (this image now has at least one annotation)
    if (image.hasAnnotations !== true) {
      image.hasAnnotations = true;
      await image.save();
    }

    // Format response
    return res.status(200).json({
      annotation: {
        id: annotation._id,
        imageId: annotation.imageId,
        bbox: annotation.bbox,
        polygon: annotation.polygon,
        categoryId: annotation.categoryId,
        categoryName: annotation.categoryName,
        state: annotation.state,
        createdAt: annotation.createdAt,
        createdBy: annotation.createdBy
      },
      message: 'Annotation saved successfully'
    });

  } catch (error) {
    console.error('Error creating annotation:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * PUT /api/dataset/:datasetId/annotations/:annotationId
 * 
 * Update an existing annotation
 */
const updateAnnotation = async (req, res) => {
  try {
    const { datasetId, annotationId } = req.params;
    const { bbox, polygon, categoryId } = req.body;

    // Validate annotationId
    if (!mongoose.Types.ObjectId.isValid(annotationId)) {
      return sendNotFoundError(res, 'Annotation', annotationId);
    }

    // Check annotation exists and belongs to dataset
    const annotation = await Annotation.findOne({ _id: annotationId, datasetId, deletedAt: null });
    if (!annotation) {
      return sendNotFoundError(res, 'Annotation', annotationId);
    }

    // Get image to check hasLabels
    const image = await Image.findById(annotation.imageId);
    if (!image) {
      return sendNotFoundError(res, 'Image', annotation.imageId);
    }

    // Update bbox if provided
    if (bbox !== undefined) {
      const bboxValidation = validateBbox(bbox);
      if (!bboxValidation.valid) {
        return sendValidationError(res, 'bbox', bboxValidation.error);
      }
      annotation.bbox = bbox;
      if (!annotation.polygon || annotation.polygon.length < 3) {
        annotation.polygon = bboxToPolygon(bbox);
      }
    }

    if (polygon !== undefined) {
      const polygonValidation = validatePolygon(polygon);
      if (!polygonValidation.valid) {
        return sendValidationError(res, 'polygon', polygonValidation.error);
      }
      const normalizedPolygon = normalizePolygonPoints(polygon);
      annotation.polygon = normalizedPolygon;
      annotation.bbox = polygonToBbox(normalizedPolygon);
    }

    // Update category if provided
    if (categoryId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return sendNotFoundError(res, 'Category', categoryId);
      }

      const category = await Category.findOne({ _id: categoryId, datasetId });
      if (!category) {
        return sendNotFoundError(res, 'Category', categoryId);
      }

      annotation.categoryId = categoryId;
      // Update denormalized category name
      annotation.categoryName = category.name;
    }

    // Update timestamps
    annotation.updatedBy = SYSTEM_USER_ID;
    await annotation.save();

    // Format response
    return res.status(200).json({
      annotation: {
        id: annotation._id,
        imageId: annotation.imageId,
        bbox: annotation.bbox,
        polygon: annotation.polygon,
        categoryId: annotation.categoryId,
        categoryName: annotation.categoryName,
        updatedAt: annotation.updatedAt,
        updatedBy: annotation.updatedBy
      },
      message: 'Annotation updated'
    });

  } catch (error) {
    console.error('Error updating annotation:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * DELETE /api/dataset/:datasetId/annotations/:annotationId
 * 
 * Delete an annotation (soft delete)
 */
const deleteAnnotation = async (req, res) => {
  try {
    const { datasetId, annotationId } = req.params;

    // Validate annotationId
    if (!mongoose.Types.ObjectId.isValid(annotationId)) {
      return sendNotFoundError(res, 'Annotation', annotationId);
    }

    // Check annotation exists and belongs to dataset
    const annotation = await Annotation.findOne({ _id: annotationId, datasetId, deletedAt: null });
    if (!annotation) {
      return sendNotFoundError(res, 'Annotation', annotationId);
    }

    // Soft delete
    annotation.deletedAt = new Date();
    await annotation.save();

    // After deletion, check if any active annotations remain for this image
    const remainingCount = await Annotation.countDocuments({
      datasetId,
      imageId: annotation.imageId,
      deletedAt: null
    });

    if (remainingCount === 0) {
      // Safely update image annotation state
      const image = await Image.findById(annotation.imageId);
      if (image && image.hasAnnotations !== false) {
        image.hasAnnotations = false;
        await image.save();
      }
    }

    return res.status(200).json({
      message: 'Annotation deleted',
      annotationId: annotationId
    });

  } catch (error) {
    console.error('Error deleting annotation:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * POST /api/dataset/:datasetId/annotations/batch
 * 
 * Save multiple annotations atomically
 * Always creates new annotations (no upsert behavior)
 * For updates, use PUT /api/dataset/:datasetId/annotations/:annotationId
 */
const batchSaveAnnotations = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { annotations } = req.body;

    // Validate input
    if (!Array.isArray(annotations)) {
      return sendValidationError(res, 'annotations', 'annotations must be an array');
    }

    // Validate datasetId
    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Check dataset exists
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Validate all annotations before processing
    const validationErrors = [];
    const validAnnotations = [];

    for (let i = 0; i < annotations.length; i++) {
      const ann = annotations[i];
      const errors = [];

      // Check required fields
      if (!ann.imageId || (!ann.bbox && !ann.polygon) || !ann.categoryId) {
        errors.push('Missing required fields: imageId, categoryId, and either bbox or polygon');
      } else {
        let candidateBbox = ann.bbox;
        if (ann.polygon !== undefined) {
          const polygonValidation = validatePolygon(ann.polygon);
          if (!polygonValidation.valid) {
            errors.push(`polygon: ${polygonValidation.error}`);
          } else {
            ann.polygon = normalizePolygonPoints(ann.polygon);
            candidateBbox = polygonToBbox(ann.polygon);
          }
        }
        // Validate bbox
        const bboxValidation = validateBbox(candidateBbox);
        if (!bboxValidation.valid) {
          errors.push(`bbox: ${bboxValidation.error}`);
        } else {
          ann.bbox = candidateBbox;
        }

        // Validate imageId
        if (mongoose.Types.ObjectId.isValid(ann.imageId)) {
          const image = await Image.findOne({ _id: ann.imageId, datasetId });
          if (!image) {
            errors.push(`Image not found: ${ann.imageId}`);
          }
        } else {
          errors.push(`Invalid imageId: ${ann.imageId}`);
        }

        // Validate categoryId
        if (mongoose.Types.ObjectId.isValid(ann.categoryId)) {
          const category = await Category.findOne({ _id: ann.categoryId, datasetId });
          if (!category) {
            errors.push(`Category not found: ${ann.categoryId}`);
          }
        } else {
          errors.push(`Invalid categoryId: ${ann.categoryId}`);
        }
      }

      if (errors.length > 0) {
        validationErrors.push({
          imageId: ann.imageId,
          error: errors.join('; ')
        });
      } else {
        validAnnotations.push(ann);
      }
    }

    // Process valid annotations in transaction
    let saved = 0;
    let skippedDuplicates = 0;
    const createdDocs = [];
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (validAnnotations.length > 0) {
        // Keep hasAnnotations true for affected images.
        // IMPORTANT: Do NOT soft-delete existing annotations here.
        // Batch save is used during navigation autosave; replacing can drop boxes
        // when frontend sends only a subset of annotations for an image.
        const uniqueImageIds = [
          ...new Set(validAnnotations.map(ann => ann.imageId.toString()))
        ].map(id => new mongoose.Types.ObjectId(id));

        await Image.updateMany(
          { _id: { $in: uniqueImageIds } },
          { $set: { hasAnnotations: true } },
          { session }
        );
      }

      for (const ann of validAnnotations) {
        // Get image and category for denormalization
        const image = await Image.findById(ann.imageId).session(session);
        const category = await Category.findById(ann.categoryId).session(session);

        // Avoid inserting exact duplicate annotation rows on repeated autosaves.
        const duplicate = await Annotation.findOne({
          datasetId,
          imageId: ann.imageId,
          categoryId: ann.categoryId,
          bbox: ann.bbox,
          ...(ann.polygon ? { polygon: ann.polygon } : {}),
          deletedAt: null
        }).session(session);

        if (duplicate) {
          skippedDuplicates++;
          createdDocs.push(duplicate);
          continue;
        }

        // ✅ Create new annotation record (append behavior).
        // Updates should use PUT /api/dataset/:datasetId/annotations/:annotationId endpoint.
        const annotation = new Annotation({
          datasetId,
          imageId: ann.imageId,
          bbox: ann.bbox,
          polygon: ann.polygon,
          categoryId: ann.categoryId,
          categoryName: category.name,
          state: 'draft',
          createdBy: SYSTEM_USER_ID
        });
        await annotation.save({ session });
        createdDocs.push(annotation);
        saved++;
      }

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }

    return res.status(200).json({
      saved,
      skippedDuplicates,
      failed: validationErrors.length,
      errors: validationErrors,
      annotations: createdDocs.map((ann) => ({
        id: ann._id,
        imageId: ann.imageId,
        bbox: ann.bbox,
        polygon: ann.polygon,
        categoryId: ann.categoryId,
        categoryName: ann.categoryName,
        state: ann.state,
        createdAt: ann.createdAt,
        updatedAt: ann.updatedAt,
      })),
    });

  } catch (error) {
    console.error('Error batch saving annotations:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * POST /api/dataset/:datasetId/import-labels-to-annotations
 *
 * Reads YOLO bbox/segmentation .txt files on disk and creates Annotation rows so pre-labeled
 * images can be edited in the annotation UI.
 *
 * Body:
 * - imageIds?: string[] — if omitted, all images with hasLabels === true are considered
 * - replace?: boolean — default false; if false, skips images that already have active annotations
 */
const importLabelsToAnnotations = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { imageIds: rawImageIds, replace = false } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    const categories = await Category.getOrderedCategories(datasetId);
    if (categories.length === 0) {
      return sendError(res, 400, 'Validation Error', 'No categories found. Create categories before importing labels.');
    }

    let images;
    if (Array.isArray(rawImageIds) && rawImageIds.length > 0) {
      const ids = rawImageIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));
      images = await Image.find({ _id: { $in: ids }, datasetId });
    } else {
      images = await Image.find({ datasetId, hasLabels: true });
    }

    if (images.length === 0) {
      return res.status(200).json({
        imported: 0,
        skipped: 0,
        imagesProcessed: 0,
        details: [],
        message: 'No images matched import criteria'
      });
    }

    const datasetPath = storageAdapter.buildDatasetPath(dataset.company, dataset.project, dataset.version);
    const details = [];
    let imported = 0;
    let skipped = 0;

    const session = await mongoose.startSession();

    try {
      for (let idx = 0; idx < images.length; idx++) {
        const image = images[idx];
        const labelRel = getLabelFilePath(image.storedPath);
        const fullLabelPath = path.join(datasetPath, labelRel);

        const imageSummary = {
          imageId: image._id.toString(),
          filename: image.filename,
          status: 'pending',
          annotationsCreated: 0,
          warnings: []
        };

        if (!(await storageAdapter.exists(fullLabelPath))) {
          imageSummary.status = 'skipped';
          imageSummary.reason = 'Label file not found';
          details.push(imageSummary);
          skipped++;
          continue;
        }

        const existingCount = await Annotation.countDocuments({
          datasetId,
          imageId: image._id,
        });

        if (!replace && existingCount > 0) {
          imageSummary.status = 'skipped';
          imageSummary.reason = 'Image already has annotation history; pass replace=true to replace from file';
          details.push(imageSummary);
          skipped++;
          continue;
        }

        let fileContent;
        try {
          const buf = await storageAdapter.readFile(fullLabelPath);
          fileContent = buf.toString('utf8');
        } catch (readErr) {
          imageSummary.status = 'error';
          imageSummary.reason = readErr.message || 'Failed to read label file';
          details.push(imageSummary);
          continue;
        }

        const lines = fileContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const annotationsToInsert = [];
        const classIdsInFile = new Set();

        for (let li = 0; li < lines.length; li++) {
          const parts = lines[li].split(/\s+/);
          const classNum = parseInt(parts[0], 10);
          let bbox = null;
          let polygon = undefined;

          if (
            !Number.isInteger(classNum) ||
            classNum < 0 ||
            classNum >= categories.length
          ) {
            imageSummary.warnings.push(
              `line ${li + 1}: invalid class_id ${parts[0]} (must be 0..${categories.length - 1})`
            );
            continue;
          }

          if (parts.length === 5) {
            const cx = parseFloat(parts[1]);
            const cy = parseFloat(parts[2]);
            const bw = parseFloat(parts[3]);
            const bh = parseFloat(parts[4]);
            if (![cx, cy, bw, bh].every(n => Number.isFinite(n))) {
              imageSummary.warnings.push(`line ${li + 1}: non-numeric bbox values`);
              continue;
            }
            bbox = convertYOLOValuesToBbox(cx, cy, bw, bh);
            if (!bbox) {
              imageSummary.warnings.push(`line ${li + 1}: bbox unusable after normalization`);
              continue;
            }
            polygon = bboxToPolygon(bbox);
          } else if (parts.length >= 7 && parts.length % 2 === 1) {
            const coords = parts.slice(1).map(v => parseFloat(v));
            if (!coords.every(n => Number.isFinite(n))) {
              imageSummary.warnings.push(`line ${li + 1}: non-numeric polygon values`);
              continue;
            }
            const rawPolygon = [];
            for (let pi = 0; pi < coords.length; pi += 2) {
              rawPolygon.push([coords[pi], coords[pi + 1]]);
            }
            const polygonValidation = validatePolygon(rawPolygon);
            if (!polygonValidation.valid) {
              imageSummary.warnings.push(`line ${li + 1}: ${polygonValidation.error}`);
              continue;
            }
            polygon = normalizePolygonPoints(rawPolygon);
            bbox = polygonToBbox(polygon);
          } else {
            imageSummary.warnings.push(
              `line ${li + 1}: expected YOLO bbox (5 values) or segmentation polygon (odd values >= 7), got ${parts.length}`
            );
            continue;
          }

          const v = validateBbox(bbox);
          if (!v.valid) {
            imageSummary.warnings.push(`line ${li + 1}: ${v.error}`);
            continue;
          }

          const category = categories[classNum];
          annotationsToInsert.push({
            datasetId,
            imageId: image._id,
            categoryId: category._id,
            categoryName: category.name,
            bbox,
            polygon,
            state: 'draft',
            createdBy: SYSTEM_USER_ID
          });
          classIdsInFile.add(classNum);
        }

        session.startTransaction();
        try {
          if (replace && existingCount > 0) {
            await Annotation.updateMany(
              { datasetId, imageId: image._id, deletedAt: null },
              { $set: { deletedAt: new Date() } },
              { session }
            );
          }

          for (const payload of annotationsToInsert) {
            const ann = new Annotation(payload);
            await ann.save({ session });
          }

          image.hasAnnotations = annotationsToInsert.length > 0;
          if (annotationsToInsert.length > 0) {
            image.classes = Array.from(classIdsInFile).sort((a, b) => a - b);
          } else {
            image.classes = undefined;
          }
          await image.save({ session });

          await session.commitTransaction();
        } catch (txErr) {
          await session.abortTransaction();
          imageSummary.status = 'error';
          imageSummary.reason = txErr.message || 'Transaction failed';
          details.push(imageSummary);
          continue;
        }

        imageSummary.status = 'imported';
        imageSummary.annotationsCreated = annotationsToInsert.length;
        details.push(imageSummary);
        imported++;
      }
    } finally {
      session.endSession();
    }

    return res.status(200).json({
      imported,
      skipped,
      imagesProcessed: details.length,
      details,
      message:
        imported > 0
          ? 'Label files imported into annotations where applicable'
          : 'No images imported (see details)'
    });
  } catch (error) {
    console.error('Error importing labels to annotations:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * POST /api/dataset/:datasetId/convert-annotations-to-labels
 * 
 * Convert annotations to YOLO format label files
 * Only processes images that have annotations (skips images with no annotations)
 * CRITICAL: Sets hasLabels = true only for images with annotations
 */
const convertAnnotationsToYOLO = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { imageIds, createEmptyLabels = false, modelType = 'YOLO' } = req.body; // Optional: if provided, convert only those images. createEmptyLabels: create empty .txt for unannotated images
    const exportMode = modelType === 'YOLO_SEG' ? 'segment' : 'detect';

    // Validate datasetId
    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Check dataset exists
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Get ordered categories (for class_id mapping)
    const categories = await Category.getOrderedCategories(datasetId);
    if (categories.length === 0) {
      return sendError(res, 400, 'Validation Error', 'No categories found. Create categories before converting annotations.');
    }

    // Store category order snapshot (for reproducibility)
    const categoryOrder = categories.map(cat => cat._id);
    const categoryNames = categories.map(cat => cat.name);

    // Get images to process
    let images;
    if (imageIds && Array.isArray(imageIds) && imageIds.length > 0) {
      // Convert only specified images
      const validImageIds = imageIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));
      
      images = await Image.find({
        _id: { $in: validImageIds },
        datasetId
      });
    } else {
      // Convert all images in dataset
      images = await Image.find({ datasetId });
    }

    if (images.length === 0) {
      return sendError(res, 400, 'Validation Error', 'No images found to convert');
    }

    // Build dataset path
    const datasetPath = storageAdapter.buildDatasetPath(dataset.company, dataset.project, dataset.version);
    const labelsBasePath = storageAdapter.buildLabelsPath(dataset.company, dataset.project, dataset.version);

    // Ensure labels directory exists
    await storageAdapter.ensureDir(labelsBasePath);

    let converted = 0;
    let labelFilesCreated = 0;
    let emptyLabelsCreated = 0;
    const unannotatedImageList = [];

    // Process each image
    for (const image of images) {
      // Get annotations for this image
      const annotations = await Annotation.findByImageId(image._id);

      // Get label file path (parallel structure)
      const labelFilePath = getLabelFilePath(image.storedPath);
      const fullLabelPath = path.join(datasetPath, labelFilePath);

      // Ensure label directory exists
      const labelDir = path.dirname(fullLabelPath);
      await storageAdapter.ensureDir(labelDir);

      // ✅ Handle images with no annotations
      if (!annotations || annotations.length === 0) {
        if (createEmptyLabels) {
          // ✅ Create empty label file (good image)
          await fs.writeFile(fullLabelPath, '', 'utf8'); // Empty file
          emptyLabelsCreated++;
          labelFilesCreated++;
        } else {
          // Track unannotated images for response
          unannotatedImageList.push({
            id: image._id,
            filename: image.filename
          });
        }
        continue;
      }

      // Generate label file content
      const labelContent = generateLabelFileContent(annotations, categoryOrder, { mode: exportMode });

      // Write label file (only for images with annotations)
      await fs.writeFile(fullLabelPath, labelContent, 'utf8');
      labelFilesCreated++;

      // Set hasLabels = true for this image (only if it has annotations)
      image.hasLabels = true;
      image.convertedAt = new Date();
      await image.save();

      converted++;
    }

    // Create/update data.yaml
    const dataYamlPath = path.join(datasetPath, 'data.yaml');
    const dataYamlContent = generateDataYaml(categories, datasetPath);
    await fs.writeFile(dataYamlPath, dataYamlContent, 'utf8');

    // ✅ Create class-mapping.json file (Option 1: separate mapping file for reference)
    const classMappingPath = path.join(datasetPath, 'class-mapping.json');
    const classMapping = {};
    categories.forEach((category, index) => {
      classMapping[index.toString()] = category.name;
    });
    await fs.writeFile(classMappingPath, JSON.stringify(classMapping, null, 2), 'utf8');

    // ================= RE-SPLIT USING CANONICAL SPLIT (utils/splitDataset) =================
    // Build full labeled pool and re-run split so train/val/test match configured seed and ratios
    const labeledImagesForSplit = await Image.find({ datasetId, hasLabels: true });
    if (labeledImagesForSplit.length > 0) {
      // ✅ Deduplicate by filename so overlapping historical rows don't inflate the pool
      const labeledByFilename = new Map();
      for (const img of labeledImagesForSplit) {
        const key = String(img.filename || path.basename(img.storedPath || '') || img._id).toLowerCase();
        if (!labeledByFilename.has(key)) labeledByFilename.set(key, img);
      }
      const uniqueLabeled = Array.from(labeledByFilename.values());

      // Paths already taken by OTHER images — exclude each image's own current path when moving
      const reservedPaths = new Set();
      const allDatasetImages = await Image.find({ datasetId }, { storedPath: 1 });
      for (const img of allDatasetImages) {
        reservedPaths.add(img.storedPath);
      }

      const pool = uniqueLabeled.map((img) => ({
        storedName: path.basename(img.storedPath),
        storedPath: img.storedPath,
        imageDoc: img,
      }));
      const { train: trainList, val: valList, test: testList } = splitDataset(pool, dataset);

      const imagesTrainPath = path.join(datasetPath, 'images', 'train');
      const imagesValPath = path.join(datasetPath, 'images', 'val');
      const imagesTestPath = path.join(datasetPath, 'images', 'test');
      const labelsTrainPath = path.join(datasetPath, 'labels', 'train');
      const labelsValPath = path.join(datasetPath, 'labels', 'val');
      const labelsTestPath = path.join(datasetPath, 'labels', 'test');
      await storageAdapter.ensureDir(imagesTrainPath);
      await storageAdapter.ensureDir(imagesValPath);
      await storageAdapter.ensureDir(imagesTestPath);
      await storageAdapter.ensureDir(labelsTrainPath);
      await storageAdapter.ensureDir(labelsValPath);
      await storageAdapter.ensureDir(labelsTestPath);

      const copyAndUpdate = async (list, folder, imagesDir, labelsDir) => {
        for (const item of list) {
          let newPath = `images/${folder}/${item.storedName}`;
          // ✅ Only rename when a *different* image already owns that path
          if (reservedPaths.has(newPath) && newPath !== item.storedPath) {
            const ext = path.extname(item.storedName);
            const base = path.basename(item.storedName, ext);
            item.storedName = `${base}_${item.imageDoc._id.toString()}${ext}`;
            newPath = `images/${folder}/${item.storedName}`;
          }
          reservedPaths.delete(item.storedPath);
          reservedPaths.add(newPath);

          const srcImage = path.join(datasetPath, item.storedPath);
          const destImage = path.join(imagesDir, item.storedName);
          const labelPath = getLabelFilePath(item.storedPath);
          const srcLabel = path.join(datasetPath, labelPath);
          const labelBaseName = path.parse(item.storedName).name + '.txt';
          const destLabel = path.join(labelsDir, labelBaseName);

          const imageMoved = path.resolve(srcImage) !== path.resolve(destImage);
          const labelMoved = path.resolve(srcLabel) !== path.resolve(destLabel);

          if (imageMoved && (await storageAdapter.exists(srcImage))) {
            await storageAdapter.copyFile(srcImage, destImage);
            try {
              await fs.unlink(srcImage);
            } catch (e) {
              // ignore if delete fails (e.g. read-only)
            }
          }
          if (labelMoved && (await storageAdapter.exists(srcLabel))) {
            await storageAdapter.copyFile(srcLabel, destLabel);
            try {
              await fs.unlink(srcLabel);
            } catch (e) {
              // ignore if delete fails
            }
          }

          item.imageDoc.storedPath = newPath;
          item.imageDoc.folder = folder;
          await item.imageDoc.save();
        }
      };

      await copyAndUpdate(trainList, 'train', imagesTrainPath, labelsTrainPath);
      await copyAndUpdate(valList, 'val', imagesValPath, labelsValPath);
      await copyAndUpdate(testList, 'test', imagesTestPath, labelsTestPath);

      dataset.trainCount = trainList.length;
      dataset.valCount = valList.length;
      dataset.testCount = testList.length;
      // Keep totalImages = unique labeled+unlabeled images after split
      dataset.totalImages = await Image.countDocuments({ datasetId });
    }

    // Update Dataset conversion metadata
    dataset.conversionMetadata = {
      convertedAt: new Date(),
      categoryOrder: categoryOrder,
      categoryNames: categoryNames
    };

    // Recalculate labeled/unlabeled counts
    const labeledCount = await Image.countDocuments({ datasetId, hasLabels: true });
    const unlabeledCount = await Image.countDocuments({ datasetId, hasLabels: false });

    dataset.labeledImages = labeledCount;
    dataset.unlabeledImages = unlabeledCount;

    // ================= DATASET LIFECYCLE METADATA =================
    // After converting annotations to YOLO labels, this dataset version becomes
    // a labeled dataset with completed annotation flow.
    dataset.datasetType = 'labeled';
    dataset.annotationStatus = 'completed';
    dataset.labelSource = 'manually_labeled';
    dataset.unlabeledImagesCount = 0;
    // ==============================================================

    // ✅ Update dataset status to ready_to_train and make it the active version for training
    dataset.status = 'ready_to_train';
    dataset.isActive = true;
    await Dataset.updateMany(
      {
        company: dataset.company,
        project: dataset.project,
        deletedAt: null,
        _id: { $ne: dataset._id },
      },
      { $set: { isActive: false } }
    );

    await dataset.save();

    const responsePayload = {
      converted: converted,
      labelFilesCreated: labelFilesCreated,
      emptyLabelsCreated: emptyLabelsCreated,
      status: 'ready_to_train',
      unannotatedImages: unannotatedImageList.length > 0 ? unannotatedImageList : undefined,
      message: 'Annotations converted to YOLO format. Dataset ready for training.'
    };

    console.log('[ANNOTATION] yolo_conversion_completed', {
      datasetId: datasetId.toString(),
      converted,
      labelFilesCreated,
      emptyLabelsCreated
    });

    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error('Error converting annotations to YOLO:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

/**
 * Resolve a dataset image to a local filesystem path SAM can open.
 * Azure / missing-local files are copied into a temp file keyed by image id.
 */
async function resolveLocalImagePath(dataset, imageDoc) {
  const datasetPath = storageAdapter.buildDatasetPath(dataset.company, dataset.project, dataset.version);
  const fullPath = path.join(datasetPath, imageDoc.storedPath);
  const resolvedPath = path.resolve(fullPath);
  const resolvedDatasetPath = path.resolve(datasetPath);
  if (!resolvedPath.startsWith(resolvedDatasetPath)) {
    const err = new Error('Invalid file path');
    err.statusCode = 403;
    throw err;
  }

  if (await storageAdapter.exists(fullPath)) {
    if (storageAdapter.mode === 'local') {
      return resolvedPath;
    }
  }

  const buf = await storageAdapter.readFile(fullPath);
  const ext = path.extname(imageDoc.storedPath || '') || '.jpg';
  const tmpPath = path.join(os.tmpdir(), `vision-sam-${String(imageDoc._id)}${ext}`);
  await fs.writeFile(tmpPath, buf);
  return tmpPath;
}

/**
 * POST /api/dataset/:datasetId/click-to-mask
 *
 * Click-prompt SAM: return a simplified polygon for one image click.
 * Body: { imageId, x, y } with x,y normalized 0–1.
 */
const clickToMask = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { imageId, x, y } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }
    if (!imageId || !mongoose.Types.ObjectId.isValid(imageId)) {
      return sendValidationError(res, 'imageId', 'A valid imageId is required');
    }

    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      return sendValidationError(res, 'point', 'x and y must be numbers in [0, 1]');
    }

    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    const imageDoc = await Image.findOne({ _id: imageId, datasetId: dataset._id });
    if (!imageDoc) {
      return sendNotFoundError(res, 'Image', imageId);
    }

    req.setTimeout(180000);
    if (typeof res.setTimeout === 'function') {
      res.setTimeout(180000);
    }

    const localPath = await resolveLocalImagePath(dataset, imageDoc);
    const result = await segmentAtClick({ imagePath: localPath, x: nx, y: ny });

    if (!result || !Array.isArray(result.polygon) || result.polygon.length < 3) {
      return res.status(422).json({
        error: 'No mask',
        message: 'No object found at that click. Try the center of the defect.',
      });
    }

    return res.status(200).json({
      polygon: result.polygon,
      pointCount: result.pointCount || result.polygon.length,
    });
  } catch (error) {
    console.error('Error in click-to-mask:', error);
    const status = error.statusCode || 500;
    return sendError(
      res,
      status,
      status === 403 ? 'Forbidden' : 'Internal Server Error',
      error.message || 'Click-to-mask failed'
    );
  }
};

/**
 * GET /api/dataset/:datasetId/image-signed
 * 
 * Serve image file by path.
 * 
 * Security:
 * - Auth and permissions are enforced by route middleware.
 * - Path traversal is prevented by checking the resolved path stays under the
 *   dataset root directory.
 * 
 * We no longer require or validate signed URL tokens here.
 */
const serveSignedImage = async (req, res) => {
  try {
    const { datasetId } = req.params;
    const { path: filePath } = req.query;

    // Validate required parameters
    if (!filePath) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required parameter: path'
      });
    }

    // Decode file path
    const decodedPath = decodeURIComponent(filePath);

    // Validate datasetId
    if (!mongoose.Types.ObjectId.isValid(datasetId)) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Check dataset exists
    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return sendNotFoundError(res, 'Dataset', datasetId);
    }

    // Build full file path
    const datasetPath = storageAdapter.buildDatasetPath(dataset.company, dataset.project, dataset.version);
    const fullPath = path.join(datasetPath, decodedPath);

    // Security: Prevent directory traversal
    const resolvedPath = path.resolve(fullPath);
    const resolvedDatasetPath = path.resolve(datasetPath);
    
    if (!resolvedPath.startsWith(resolvedDatasetPath)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid file path'
      });
    }

    // Check if file exists
    if (!await storageAdapter.exists(fullPath)) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Image file not found'
      });
    }

    // Determine content type based on file extension
    const ext = path.extname(decodedPath).toLowerCase();
    let contentType = 'image/jpeg'; // Default
    
    if (ext === '.png') {
      contentType = 'image/png';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      contentType = 'image/jpeg';
    }

    // Read and serve file
    const fileBuffer = await storageAdapter.readFile(fullPath);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600'); // Cache for 1 hour
    res.send(fileBuffer);

  } catch (error) {
    console.error('Error serving signed image:', error);
    return sendError(res, 500, 'Internal Server Error', error.message);
  }
};

module.exports = {
  getUnlabeledImages,
  getUnannotatedImages,
  getDatasetImages,
  getAnnotations,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  batchSaveAnnotations,
  importLabelsToAnnotations,
  convertAnnotationsToYOLO,
  clickToMask,
  serveSignedImage
};

