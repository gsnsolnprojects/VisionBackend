const mongoose = require('mongoose');

/**
 * Dataset Schema - Stores metadata about uploaded datasets
 * 
 * This document tracks:
 * - Where files are stored on disk
 * - Upload statistics (counts, sizes)
 * - Processing status
 * - Label information
 * - Any errors during upload
 * - File manifest (mapping of stored names to original names)
 */
const datasetSchema = new mongoose.Schema({
  // Organization identifiers
  company: {
    type: String,
    required: true,
    index: true // ✅ Indexed for faster queries by company
  },
  project: {
    type: String,
    required: true,
    index: true
  },
  version: {
    type: String,
    default: 'v1' // Default version if not provided
  },

  // Storage path on disk/cloud
  storagePath: {
    type: String,
    required: true
  },

  // File manifest - tracks all uploaded files
  files: [{
    storedName: {
      type: String,
      required: true // The actual filename on disk (with UUID prefix)
    },
    originalName: {
      type: String,
      required: true // The original filename from user
    },
    type: {
      type: String,
      enum: ['image', 'label'],
      required: true
    },
    size: {
      type: Number,
      required: true // File size in bytes
    },
    folder: {
      type: String,
      required: true,
      default: 'dataset' // Virtual folder name (e.g., 'good', 'defect1', 'dataset')
    },
    storedPath: {
      type: String,
      required: true // Relative path inside dataset folder e.g. "images/good/....jpg"
    }
  }],

  // File statistics
  totalImages: {
    type: Number,
    default: 0
  },
  sizeBytes: {
    type: Number,
    default: 0
  },

  // Label information
  labels: [{
    type: String // List of class names found in .txt files
  }],

  // High-level dataset lifecycle metadata
  // datasetType: 'labeled' datasets have labels present at upload or after annotation,
  // 'unlabeled' datasets start without labels and can be annotated later.
  datasetType: {
    type: String,
    enum: ['labeled', 'unlabeled'],
    default: null
  },
  // Annotation status is only used for unlabeled datasets during the annotation flow.
  // Labeled datasets should keep this as null.
  annotationStatus: {
    type: String,
    enum: ['pending', 'completed'],
    default: null
  },
  // Cached count of unlabeled images for this dataset version (for UI enable/disable logic).
  unlabeledImagesCount: {
    type: Number,
    default: 0
  },

  // Upload errors (invalid files, rejected files)
  uploadErrors: [{
    filename: String,
    reason: String // e.g., "Invalid extension", "File too large"
  }],

  // Processing status
  // States: 'uploaded' → 'queued' → 'processing' → 'ready' → 'failed'
  // Annotation states: 'unlabeled' → 'ready_to_train'
  status: {
    type: String,
    enum: ['uploaded', 'queued', 'processing', 'ready', 'failed', 'unlabeled', 'ready_to_train'],
    default: 'uploaded',
    index: true
  },

  // Preprocessing statistics (filled by worker)
  labeledImages: {
    type: Number,
    default: 0
  },
  unlabeledImages: {
    type: Number,
    default: 0
  },
  trainCount: {
    type: Number,
    default: 0
  },
  valCount: {
    type: Number,
    default: 0
  },
  testCount: {
    type: Number,
    default: 0
  },
  thumbnailsGenerated: {
    type: Number,
    default: 0
  },

  // Error message if status is 'failed'
  errorMessage: {
    type: String
  },

  // Augmentation metadata (for image data augmentation feature)
  augmentationStatus: {
    // not_started → running → succeeded | failed | cancelled
    type: String,
    enum: ['not_started', 'running', 'succeeded', 'failed', 'cancelled'],
    default: 'not_started',
    index: true
  },
  isAugmented: {
    type: Boolean,
    default: false
  },
  backupDatasetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dataset',
    default: null
  },
  // Lineage tracking for grouping related versions in the UI (augment AND duplicate chains).
  // parentDatasetId: immediate source dataset this one was created from.
  // rootDatasetId: shared by every dataset in a lineage tree, however deep — the grouping key.
  parentDatasetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dataset',
    default: null,
    index: true
  },
  rootDatasetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dataset',
    default: null,
    index: true
  },
  augmentationError: {
    type: String
  },
  // Augmentation configuration metadata
  augmentationMultiplier: {
    // e.g. 2x, 5x; purely informational and used for UX
    type: Number,
    default: null
  },
  augmentedFromVersion: {
    // Original version string this dataset was augmented from (e.g. 'v3')
    type: String,
    default: null
  },
  // Label source: where labels came from (for frontend badges: Unlabeled, Pre-Labelled, Manually Labelled)
  // Set for augmented datasets from source; derived for non-augmented from status/datasetType
  labelSource: {
    type: String,
    enum: ['unlabeled', 'pre_labelled', 'manually_labeled'],
    default: null
  },

  // Soft delete: Mark dataset as deleted without removing the document
  deletedAt: {
    type: Date,
    default: null,
    index: true // Indexed for faster queries to filter deleted datasets
  },

  // Active dataset flag (for augmentation feature)
  // When augmentation completes, the augmented dataset becomes active and original becomes inactive
  isActive: {
    type: Boolean,
    default: true,
    index: true // Indexed for faster queries to filter active datasets
  },

  // YOLO conversion metadata (for annotation feature)
  conversionMetadata: {
    convertedAt: {
      type: Date // Timestamp of last YOLO conversion
    },
    categoryOrder: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category' // Snapshot of category IDs in order at conversion time
    }],
    categoryNames: [{
      type: String // Snapshot of category names at conversion time
    }]
  },

  // Canonical split configuration (used by utils/splitDataset.js)
  // If not set, workers use defaults: seed 42, train 0.8, val 0.2, test 0.1
  split_seed: { type: Number, default: null },
  split_ratio_train: { type: Number, default: null },
  split_ratio_val: { type: Number, default: null },
  test_sample_ratio: { type: Number, default: null }
}, {
  timestamps: true // ✅ Automatically adds createdAt and updatedAt
});

// ✅ Create compound index for faster queries
datasetSchema.index({ company: 1, project: 1, version: 1 });
// ✅ Index for active dataset queries (used by file browser and training)
datasetSchema.index({ company: 1, project: 1, isActive: 1 });
// ✅ Index for grouping versions by lineage in the Versions panel
datasetSchema.index({ company: 1, project: 1, rootDatasetId: 1 });

module.exports = mongoose.model('Dataset', datasetSchema);
