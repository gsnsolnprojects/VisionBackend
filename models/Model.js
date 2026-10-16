const mongoose = require('mongoose');

/**
 * Model Registry Schema - Stores metadata about trained models
 * 
 * This document tracks:
 * - Trained model files and their locations
 * - Final training metrics and performance
 * - Insights and recommendations
 * - Model versioning and organization
 * - Download URLs and storage paths
 */
const modelSchema = new mongoose.Schema({
  // Unique model identifier
  modelId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Reference to the training job that created this model
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainingJob',
    required: true,
    index: true
  },

  // Organization identifiers (for filtering)
  company: {
    type: String,
    required: true,
    index: true
  },
  project: {
    type: String,
    required: true,
    index: true
  },

  // Model versioning
  modelVersion: {
    type: String,
    required: true,
    default: 'v1' // e.g., "v1", "v2", "v3"
  },

  // Model type
  modelType: {
    type: String,
    enum: ['YOLO', 'YOLO_SEG', 'RF_DETR'],
    required: true
  },

  // Dataset information
  datasetVersion: {
    type: String,
    required: true // Version of dataset used for training
  },
  datasetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dataset',
    required: true,
    index: true
  },

  // Final training metrics (computed after training completes)
  metrics: {
    bestEpoch: {
      type: Number
    },
    bestLoss: {
      type: Number
    },
    precision: {
      type: Number
    },
    recall: {
      type: Number
    },
    mAP50: {
      type: Number // mAP@0.5
    },
    mAP50_95: {
      type: Number // mAP@0.5:0.95
    },
    perLabelStats: [{
      label: {
        type: String,
        required: true
      },
      precision: {
        type: Number
      },
      recall: {
        type: Number
      },
      mAP50: {
        type: Number
      }
    }]
  },

  // Insights and recommendations (generated after training)
  insights: {
    bestAccuracy: {
      type: Number
    },
    bestmAP: {
      type: Number
    },
    weakestLabels: [{
      type: String // Array of label names with poor performance
    }],
    classImbalanceWarnings: [{
      type: String // Warnings about underrepresented classes
    }],
    recommendations: [{
      type: String // Actionable recommendations for improvement
    }]
  },

  // Storage information
  storagePath: {
    type: String,
    required: true // Path to model directory: /models/{company}/{project}/{modelVersion}/
  },
  
  // Best checkpoint file path
  bestCheckpointPath: {
    type: String // Path to best.pt file
  },

  // Download URL (for cloud storage) or null for local filesystem
  downloadUrl: {
    type: String // Presigned URL if using cloud storage, null for local
  },

  // Chart data paths (for frontend visualization)
  chartDataPath: {
    type: String // Path to metrics directory with JSON files
  },

  // Linked sample model: points at GSN's original model (same folder, nothing copied).
  // Deleting a linked model removes only this record, never the shared files.
  linkedFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Model',
    default: null,
    index: true
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt
});

// ✅ Create compound index for faster queries
modelSchema.index({ company: 1, project: 1 });
modelSchema.index({ company: 1, project: 1, modelVersion: 1 }); // For version lookups
modelSchema.index({ createdAt: -1 }); // For sorting by newest first

module.exports = mongoose.model('Model', modelSchema);










