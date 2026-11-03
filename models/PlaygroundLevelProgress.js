const mongoose = require('mongoose');

/**
 * One student's progress through one Playground level (services/playgroundLevelService.js), so
 * they can leave and resume from any computer. A level belongs to a mission: Level 1 is the guided
 * GSN sample, Level 2 the student's own photos.
 */
const playgroundLevelProgressSchema = new mongoose.Schema(
  {
    company: { type: String, required: true },
    userId: { type: String, required: true },
    level: { type: Number, required: true },
    /** The mission's title, which is also its project's name */
    mission: { type: String, required: true },
    industry: { type: String, default: null },
    /** The GSN sample's project name in the library (Level 1) */
    sample: { type: String, default: null },
    /** Supabase project id; null until a project exists (practice needs none) */
    projectId: { type: String, default: null },
    completedSteps: { type: [String], default: [] },
    /** Best label practice score so far, 0-1 */
    practiceScore: { type: Number, default: null },
    /** The latest training run, so its result shows on resume even if the browser was closed */
    trainingJobId: { type: String, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

playgroundLevelProgressSchema.index({ userId: 1, company: 1, mission: 1 }, { unique: true });

module.exports = mongoose.model('PlaygroundLevelProgress', playgroundLevelProgressSchema);
