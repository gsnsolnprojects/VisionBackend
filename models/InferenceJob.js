const mongoose = require('mongoose');

/**
 * InferenceJob Schema - Stores metadata about inference/prediction jobs
 * 
 * This document tracks:
 * - Which model was used for inference
 * - Source of images (test folder or live camera)
 * - Job status and progress
 * - Results metadata (detections, confidence scores, annotated images)
 * - Error information if inference fails
 */
const assessmentSchema = new mongoose.Schema(
  {
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: null },
    damageTags: { type: [String], default: [] },
    assessedBy: { type: String, default: null },
    assessedAt: { type: Date, default: null }
  },
  { _id: false }
);

// A reviewer's verdict on how this visit compares with an earlier one ("confirmed
// deterioration" etc.), set from the web dashboard.
const reviewSchema = new mongoose.Schema(
  {
    verdict: { type: String, enum: ['worse', 'same', 'better'], required: true },
    note: { type: String, default: '' },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    comparedToInferenceId: { type: String, default: null }
  },
  { _id: false }
);

const inferenceJobSchema = new mongoose.Schema({
  // Unique inference job identifier
  inferenceId: {
    type: String,
    required: true,
    unique: true,
    index: true // ✅ Indexed for faster queries
  },

  // Reference to the trained model used for inference
  modelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Model',
    required: true
    // Note: Index created explicitly below to avoid duplicate
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

  // User who created this inference job (for ownership verification)
  createdBy: {
    type: String, // User ID from X-User-Id header
    index: true
  },

  // Optional location label from the Android inspect app
  regionName: {
    type: String,
    default: null
  },

  // The specific spot this job inspected (area + optional component), minted
  // automatically as OBS-#### — see models/Observation.js. Null on jobs from
  // before observations existed until the backfill script assigns one.
  observationId: {
    type: String,
    default: null,
    index: true
  },
  componentName: {
    type: String,
    default: ''
  },
  // Set automatically when a spot that has been inspected before is captured
  // again: the most recent earlier completed visit of the same observation.
  // Lets any visit be compared with the one before it, resurvey or not.
  previousInferenceId: {
    type: String,
    default: null,
    index: true
  },
  // Reviewer's verdict on this visit vs an earlier one (null until reviewed).
  review: {
    type: reviewSchema,
    default: null
  },
  // The inspector's confirmed assessment of this part — severity they signed
  // off on (the AI's corrosion-% band is only a suggestion) and the coating
  // damage types they saw. Null until an inspector confirms one.
  assessment: {
    type: assessmentSchema,
    default: null
  },
  // Free-text note the inspector typed at capture time.
  notes: {
    type: String,
    default: ''
  },
  // Email of the inspector who captured it (createdBy holds their user id).
  inspectorName: {
    type: String,
    default: null
  },

  // Groups many region inspects into one ship/visit survey
  surveyName: {
    type: String,
    default: null,
    index: true
  },

  // Set when this job is an explicit "resurvey" of a specific earlier job for
  // the same regionName (possibly in a different survey, weeks/months later)
  // — powers the dashboard's baseline photo comparison. Null for a normal,
  // first-time inspection.
  baselineInferenceId: {
    type: String,
    default: null,
    index: true
  },

  // Which of THIS job's own photos (by filename) correspond to which photo
  // on the baseline job, set once by the client at upload time for both the
  // server and on-device submission paths identically — a photo present here
  // with no matchedBaselineFilename, or simply absent, is a new/extra photo
  // not present in the baseline. Matching against the baseline's actual
  // stored filenames is done by basename-without-extension (see
  // compareWithBaseline) to tolerate any format conversion during upload.
  photoMatches: {
    type: [{ filename: String, matchedBaselineFilename: String }],
    default: []
  },

  // Source type: 'test_folder', 'custom_folder', or 'live_camera'
  sourceType: {
    type: String,
    enum: ['test_folder', 'custom_folder', 'live_camera'],
    required: true
  },

  // Exclude ephemeral/live jobs from /inference/history responses
  excludeFromHistory: {
    type: Boolean,
    default: false,
    index: true
  },

  // Reference to dataset (only for test_folder sourceType)
  datasetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dataset',
    required: function() {
      return this.sourceType === 'test_folder';
    }
  },

  // Path to test folder (only for test_folder sourceType)
  testFolderPath: {
    type: String,
    required: function() {
      return this.sourceType === 'test_folder';
    }
  },

  // Path to custom uploaded folder (only for custom_folder sourceType)
  customFolderPath: {
    type: String,
    required: function() {
      return this.sourceType === 'custom_folder';
    }
  },

  // Inference job status
  status: {
    type: String,
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    default: 'queued',
    index: true
  },

  // Progress tracking
  progress: {
    totalImages: {
      type: Number,
      default: 0
    },
    processedImages: {
      type: Number,
      default: 0
    },
    progressPercent: {
      type: Number,
      default: 0
    }
  },

  // Results metadata
  results: {
    resultsPath: {
      type: String // Full path to results folder
    },
    annotatedImagesPath: {
      type: String // Path to annotated images directory (original, before sorting)
    },
    goodImagesPath: {
      type: String // Path to good/ folder (images with no detections)
    },
    defectImagesPath: {
      type: String // Path to defect/ folder (images with detections)
    },
    framesPath: {
      type: String // Path to frames directory (for live camera inference)
    },
    totalFramesProcessed: {
      type: Number,
      default: 0 // Count of frames processed (for live camera inference)
    },
    metadataPath: {
      type: String // Path to JSON metadata file
    },
    totalDetections: {
      type: Number,
      default: 0
    },
    averageConfidence: {
      type: Number,
      default: 0
    },
    goodCount: {
      type: Number,
      default: 0 // Count of images with no detections (good)
    },
    defectCount: {
      type: Number,
      default: 0 // Count of images with detections (defect)
    },
    detectionsByClass: [{
      className: {
        type: String,
        required: true
      },
      count: {
        type: Number,
        default: 0
      },
      avgConfidence: {
        type: Number,
        default: 0
      }
    }],
    corrosionStats: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },

  // Error information (if inference fails)
  error: {
    type: String
  },

  // Explicit human confirmation that this part's results should count as
  // part of the survey, set from the mobile app's Results screen. The part
  // is already visible in the survey the moment photos are uploaded — this
  // is a review acknowledgment, not a gate on that visibility.
  confirmed: {
    type: Boolean,
    default: false
  },
  confirmedAt: {
    type: Date,
    default: null
  },
  confirmedBy: {
    type: String, // User ID from X-User-Id header
    default: null
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
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt
});

// ✅ Create compound indexes for faster queries
inferenceJobSchema.index({ company: 1, project: 1, surveyName: 1 });
inferenceJobSchema.index({ company: 1, project: 1, status: 1 }); // For filtering by status
inferenceJobSchema.index({ modelId: 1 }); // For model-based queries
inferenceJobSchema.index({ createdAt: -1 }); // For sorting by newest first

module.exports = mongoose.model('InferenceJob', inferenceJobSchema);

