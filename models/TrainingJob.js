const mongoose = require('mongoose');

/**
 * TrainingJob Schema - Stores metadata about training jobs
 * 
 * This document tracks:
 * - Training job status and progress
 * - Hyperparameters used for training
 * - Real-time metrics during training
 * - Logs and checkpoints
 * - Error information if training fails
 */
const trainingJobSchema = new mongoose.Schema({
  // Unique job identifier
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Reference to the dataset being used for training
  datasetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dataset',
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

  // Model type selection
  modelType: {
    type: String,
    enum: ['YOLO', 'YOLO_SEG', 'RF_DETR'],
    required: true
  },

  // Model size (for YOLO: 'n', 's', 'm', 'l', 'x')
  modelSize: {
    type: String,
    enum: ['n', 's', 'm', 'l', 'x'],
    default: 'n' // Default to nano
  },

  // Optional display / storage folder name for the trained model (set from POST /api/train body.modelVersion)
  // When null, worker auto-assigns v1, v2, ...
  requestedModelVersion: {
    type: String,
    default: null
  },

  // Optional training augmentation strategy preset selected by frontend.
  augmentationPreset: {
    type: String,
    enum: ['none', 'color_invariant', 'small_defect', 'low_light', 'robust'],
    default: 'none'
  },

  // Training status
  // States: 'queued' → 'running' → 'completed' / 'failed' / 'cancelled'
  status: {
    type: String,
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    default: 'queued',
    index: true
  },

  // Hyperparameters for training
  hyperparameters: {
    epochs: {
      type: Number,
      required: true,
      default: 100,
      min: 1,
      max: 1000
    },
    batchSize: {
      type: Number,
      required: true,
      default: 16,
      min: 1,
      max: 128
    },
    imgSize: {
      type: Number,
      required: true,
      default: 640,
      min: 128,
      max: 2048
    },
    learningRate: {
      type: Number,
      required: true,
      default: 0.01,
      min: 0.0001,
      max: 1.0
    },
    workers: {
      type: Number,
      required: true,
      default: 4,
      min: 1,
      max: 16
    }
  },

  // Training progress
  progress: {
    currentEpoch: {
      type: Number,
      default: 0
    },
    totalEpochs: {
      type: Number,
      default: 0
    },
    progressPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    }
  },

  // Real-time metrics (updated during training)
  metrics: {
    currentLoss: {
      type: Number
    },
    currentLR: {
      type: Number // Current learning rate
    },
    bestLoss: {
      type: Number
    },
    bestEpoch: {
      type: Number
    },
    mAP50: {
      type: Number // mAP@0.5
    },
    mAP50_95: {
      type: Number // mAP@0.5:0.95
    },
    precision: {
      type: Number
    },
    recall: {
      type: Number
    }
  },

  // Final metrics (computed after training completes)
  finalMetrics: {
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
      type: Number
    },
    mAP50_95: {
      type: Number
    },
    perLabelStats: [{
      label: String,
      precision: Number,
      recall: Number,
      mAP50: Number
    }]
  },

  // Training logs (array of log lines)
  logs: [{
    type: String
  }],

  // Checkpoints saved during training
  checkpoints: [{
    epoch: {
      type: Number,
      required: true
    },
    path: {
      type: String,
      required: true // Path to checkpoint file
    },
    isBest: {
      type: Boolean,
      default: false
    },
    metrics: {
      loss: Number,
      mAP50: Number,
      mAP50_95: Number
    },
    savedAt: {
      type: Date,
      default: Date.now
    }
  }],

  // Error information (if status is 'failed')
  error: {
    type: String
  },

  // Timestamps
  startedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  },
  cancelledAt: {
    type: Date
  },

  // Where it trained: 'gpu' (the GPU server) or 'cpu'; set when the worker starts it (usage reports)
  device: {
    type: String,
    enum: ['gpu', 'cpu', null],
    default: null
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt
});

// ✅ Create compound index for faster queries
trainingJobSchema.index({ company: 1, project: 1 });
trainingJobSchema.index({ status: 1, createdAt: -1 }); // For querying active jobs

module.exports = mongoose.model('TrainingJob', trainingJobSchema);

