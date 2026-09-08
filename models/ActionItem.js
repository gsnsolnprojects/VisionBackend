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
