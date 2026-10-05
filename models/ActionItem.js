const mongoose = require('mongoose');

/**
 * ActionItem Schema — a follow-up task raised against a corrosion finding
 * (e.g. "repair this before next survey"), tracked through to approval.
 *
 * Scoped by plain `company`/`project` strings, the same denormalized
 * pattern used by InferenceJob — there is no Mongo Company/Project
 * collection (those are canonical in Supabase Postgres, matched by name).
 *
 * `company`+`project` = one vessel (per product decision: one project is
 * always exactly one vessel, so no separate Vessel entity exists).
 */
const actionItemSchema = new mongoose.Schema(
  {
    actionId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },

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

    // Where the finding is — area of the vessel, and optionally which
    // survey/visit/photo it came from.
    surveyName: {
      type: String,
      default: null,
      index: true
    },
    regionName: {
      type: String,
      default: null,
      index: true
    },
    // The specific spot (area + component) this issue is about — see
    // models/Observation.js. Null on issues raised before observations existed.
    observationId: {
      type: String,
      default: null,
      index: true
    },
    componentName: {
      type: String,
      default: ''
    },
    inferenceId: {
      type: String,
      default: null,
      index: true
    },
    filename: {
      type: String,
      default: null
    },

    title: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      default: ''
    },

    // Human-assigned severity for this action — independent from any
    // automatic severity band derived from corrosion percentage.
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: true
    },

    status: {
      type: String,
      enum: ['open', 'in_review', 'approved', 'rejected', 'completed'],
      default: 'open',
      index: true
    },

    // The reviewer's maintenance decision — distinct from `status`, which is
    // this action's own approval workflow state, not what to actually do
    // about the finding.
    decision: {
      type: String,
      enum: ['monitor', 'inspect_further', 'repair', 'recoat', 'replace'],
      default: null
    },

    // Coating-damage modes the reviewer visually confirmed on the photo(s) —
    // independent from the AI's rust-severity detection.
    damageTags: {
      type: [String],
      enum: ['peeling', 'cracking', 'blistering', 'exposed_metal'],
      default: []
    },

    // Free-text reviewer commentary, separate from `description` (set once
    // when the action is raised) — meant to accumulate as the action moves
    // through review/approval.
    reviewerNotes: {
      type: String,
      default: ''
    },

    // The technical/engineering recommendation for how to address the
    // finding (e.g. coating type, procedure) — set when raising or
    // reviewing, distinct from `decision` (the short maintenance category).
    engineeringRecommendation: {
      type: String,
      default: ''
    },

    // What repair work was actually carried out in the field — set when the
    // action is closed out (`status: 'completed'`), distinct from the
    // recommendation above.
    repairActionTaken: {
      type: String,
      default: ''
    },

    // Filenames of after-repair photos, stored under
    // uploads/action-items/<actionId>/ — the "before" photo is just the
    // finding's own inferenceId/filename, already on the action.
    afterPhotos: {
      type: [String],
      default: []
    },

    // "Overdue" is always computed from dueDate + status at read time,
    // never stored, so it can't go stale.
    dueDate: {
      type: Date,
      default: null,
      index: true
    },

    // Supabase UUID strings — not Mongo ObjectId refs (no Mongo User model).
    createdBy: {
      type: String,
      required: true
    },
    assignedTo: {
      type: String,
      default: null
    },
    approvedBy: {
      type: String,
      default: null
    },
    approvedAt: {
      type: Date,
      default: null
    },
    // When this action was closed out (`status: 'completed'`) — distinct
    // from `approvedAt`, which may have been stamped earlier at a separate
    // "approved, proceed with repair" step.
    completedAt: {
      type: Date,
      default: null
    },

    // Snapshot of the finding's corrosion stats at the time the action was
    // raised, so a PDF/report generated later still reflects what was seen
    // even if later visits change the live numbers.
    findingSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  { timestamps: true }
);

actionItemSchema.index({ company: 1, project: 1, status: 1 });
actionItemSchema.index({ company: 1, project: 1, dueDate: 1 });

module.exports = mongoose.model('ActionItem', actionItemSchema);
