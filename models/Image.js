const mongoose = require('mongoose');
const path = require('path');

/**
 * Image Schema - Tracks individual images in datasets
 * 
 * This document tracks:
 * - Image metadata (dimensions, size, path)
 * - Label state (hasLabels = true means YOLO .txt file exists)
 * - Folder location (unlabeled/train/val/test)
 * - Conversion timestamps
 */
const imageSchema = new mongoose.Schema({
  // Reference to dataset
  datasetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dataset',
    required: true
  },

  // Image file information
  filename: {
    type: String,
    required: true
  },
  storedPath: {
    type: String,
    required: true // Storage path (e.g., "images/unlabeled/image_001.jpg")
  },
  folder: {
    type: String,
    // Allow any folder name (e.g., 'train', 'val', 'test', 'good', 'defect1', 'test data pcb')
    // Default is 'unlabeled' for images without a specific folder
    default: 'unlabeled'
  },
  size: {
    type: Number // File size in bytes
  },

  // Image dimensions (extracted during upload/preprocessing)
  width: {
    type: Number,
    required: true // Image width in pixels
  },
  height: {
    type: Number,
    required: true // Image height in pixels
  },

  // Label state
  // hasLabels = true means a YOLO .txt file exists (empty or non-empty)
  hasLabels: {
    type: Boolean,
    required: true,
    default: false
  },

  // Annotation state
  // hasAnnotations = true means at least one non-deleted Annotation document exists for this image
  hasAnnotations: {
    type: Boolean,
    required: true,
    default: false
  },

  // Class IDs present in this image (for labeled datasets)
  // Array of numeric class IDs (e.g., [0, 1, 2]) extracted from label .txt files
  // Used to find representative images for each class during class name mapping
  classes: {
    type: [Number],
    default: undefined // Optional field - only set for labeled images
  },

  // Conversion metadata
  convertedAt: {
    type: Date // Timestamp of last YOLO conversion
  },

  // Groups images added together via the "Add Photos" flow (controllers/datasetController.js
  // addDatasetFiles), so the app can later offer to label/augment just that batch.
  batchId: {
    type: String,
    default: null,
    index: true
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt
});

// ✅ Create indexes for faster queries
// Index for filtering by dataset
imageSchema.index({ datasetId: 1 });

// Composite index for unlabeled image queries (CRITICAL)
imageSchema.index({ datasetId: 1, hasLabels: 1 });

// Composite index for folder filtering
imageSchema.index({ datasetId: 1, folder: 1 });

// Index for querying images by class ID (for sample image lookup)
imageSchema.index({ datasetId: 1, classes: 1 });

// Composite unique index for storedPath per dataset
imageSchema.index({ datasetId: 1, storedPath: 1 }, { unique: true });

/**
 * Static method: Find unlabeled images for a dataset
 * @param {ObjectId} datasetId - Dataset ID
 * @param {Number} page - Page number (default: 1)
 * @param {Number} limit - Items per page (default: 50)
 * @returns {Promise<{images: Array, total: Number}>}
 */
imageSchema.statics.findUnlabeled = async function(datasetId, page = 1, limit = 50) {
  const skip = (page - 1) * limit;

  const [images, total] = await Promise.all([
    this.find({ datasetId, hasLabels: false })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    this.countDocuments({ datasetId, hasLabels: false })
  ]);

  return {
    images,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
};

/**
 * Instance method: Get corresponding label file path
 * Returns parallel labels/... path structure
 * @returns {String} Label file path (e.g., "labels/unlabeled/image_001.txt")
 */
imageSchema.methods.getLabelPath = function() {
  // Normalize path separators to forward slashes for consistent processing
  // This handles both Windows backslashes (images\train\image.jpg) and Unix forward slashes (images/train/image.jpg)
  const normalized = this.storedPath.replace(/\\/g, '/');
  
  // Replace "images/" with "labels/" in normalized path
  // e.g., "images/unlabeled/image_001.jpg" → "labels/unlabeled/image_001.txt"
  const labelPath = normalized.replace(/^images\//, 'labels/');
  
  // Replace image extension with .txt
  const ext = path.extname(labelPath);
  return labelPath.replace(ext, '.txt');
};

module.exports = mongoose.model('Image', imageSchema);

