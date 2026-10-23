const mongoose = require('mongoose');

/**
 * A Playground test report: a PDF made from a finished test, kept for a short time
 * (PLAYGROUND_REPORT_LIFETIME_MS) and then deleted with its file by the cleanup sweep.
 */
const playgroundReportSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, index: true },
    project: { type: String, required: true },
    /** Supabase project id, to list the reports of one project */
    projectId: { type: String, default: null, index: true },
    title: { type: String, required: true },
    industry: { type: String, default: null },
    modelName: { type: String, default: null },
    inferenceId: { type: String, required: true },
    photos: { type: Number, default: 0 },
    filePath: { type: String, required: true },
    /** The same results as a spreadsheet (reports made before CSVs existed have none) */
    csvPath: { type: String, default: null },
    /** Small picture of the first photo, for the reports list */
    previewPath: { type: String, default: null },
    sizeBytes: { type: Number, default: 0 },
    createdBy: { type: String, default: null },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PlaygroundReport', playgroundReportSchema);
