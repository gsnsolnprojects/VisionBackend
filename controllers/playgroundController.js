const fs = require('fs');
const fsPromises = require('fs').promises;
const mongoose = require('mongoose');
const InferenceJob = require('../models/InferenceJob');
const Model = require('../models/Model');
const PlaygroundReport = require('../models/PlaygroundReport');
const auditService = require('../services/auditService');
const { canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const { closeRun, writeReport, PLAYGROUND_REPORT_LIFETIME_MS } = require('../services/playgroundRunService');

/**
 * Playground tests and reports (see services/playgroundRunService.js)
 *
 * POST   /api/playground/runs/:inferenceId/close   delete the test's photos
 * POST   /api/playground/runs/:inferenceId/report  write a PDF report, then close the test
 * GET    /api/playground/reports?projectId=        reports still available for a project
 * GET    /api/playground/reports/:id/download      the PDF
 * DELETE /api/playground/reports/:id               delete a report early
 */

const ownsCompany = (req, company) =>
  canAccessAllWorkspaces(req.user) ||
  String(company || '').trim().toLowerCase() === String(req.user?.company || '').trim().toLowerCase();

async function loadRun(req, res) {
  const job = await InferenceJob.findOne({ inferenceId: req.params.inferenceId });
  if (!job || !ownsCompany(req, job.company)) {
    res.status(404).json({ error: 'Test not found', message: 'This test was not found.' });
    return null;
  }
  return job;
}

const closeTest = async (req, res) => {
  try {
    const job = await loadRun(req, res);
    if (!job) return;
    if (!job.closedAt) await closeRun(job);
    res.json({ success: true, closed: true });
  } catch (error) {
    console.error('[playground] close test failed:', error);
    res.status(500).json({ error: 'Could not close the test', message: error.message });
  }
};

const createReport = async (req, res) => {
  try {
    const job = await loadRun(req, res);
    if (!job) return;
    if (job.closedAt) {
      return res.status(409).json({ error: 'Test closed', message: 'This test was already closed, so its photos are gone.' });
    }
    if (job.status !== 'completed') {
      return res.status(409).json({ error: 'Test not finished', message: 'Wait for the test to finish first.' });
    }

    const { projectId, title, industry, labelled } = req.body || {};
    const model = job.modelId ? await Model.findById(job.modelId).select('modelVersion').lean() : null;
    const reportTitle = String(title || job.project).slice(0, 120);
    const written = await writeReport(job, {
      title: reportTitle,
      industry: industry ? String(industry).slice(0, 80) : null,
      modelName: model?.modelVersion || null,
      labelled: labelled && typeof labelled === 'object' ? labelled : undefined,
    });

    const report = await PlaygroundReport.create({
      company: job.company,
      project: job.project,
      projectId: projectId ? String(projectId) : null,
      title: reportTitle,
      industry: industry || null,
      modelName: model?.modelVersion || null,
      inferenceId: job.inferenceId,
      photos: written.photos,
      filePath: written.filePath,
      sizeBytes: written.sizeBytes,
      createdBy: req.user?.id || null,
      expiresAt: new Date(Date.now() + PLAYGROUND_REPORT_LIFETIME_MS),
    });
    await closeRun(job);

    auditService.logAction({
      action: 'create',
      resourceType: 'inference',
      resourceId: job.inferenceId,
      details: { company: job.company, project: job.project, change: 'playground report created', reportId: String(report._id), photos: written.photos },
      req,
    });

    res.status(201).json({ report: toJson(report) });
  } catch (error) {
    console.error('[playground] report failed:', error);
    res.status(500).json({ error: 'Could not create the report', message: error.message });
  }
};

const toJson = (r) => ({
  id: String(r._id),
  title: r.title,
  industry: r.industry,
  modelName: r.modelName,
  photos: r.photos,
  sizeBytes: r.sizeBytes,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
});

const listReports = async (req, res) => {
  try {
    const filter = { company: req.user?.company, expiresAt: { $gt: new Date() } };
    if (req.query.projectId) filter.projectId = String(req.query.projectId);
    const reports = await PlaygroundReport.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ reports: reports.map(toJson) });
  } catch (error) {
    res.status(500).json({ error: 'Could not load reports', message: error.message });
  }
};

async function loadReport(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'Report not found' });
    return null;
  }
  const report = await PlaygroundReport.findById(req.params.id);
  if (!report || !ownsCompany(req, report.company) || report.expiresAt <= new Date()) {
    res.status(404).json({ error: 'Report not found', message: 'This report has expired or was deleted.' });
    return null;
  }
  return report;
}

const downloadReport = async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    if (!fs.existsSync(report.filePath)) return res.status(404).json({ error: 'Report file missing' });
    const name = `${report.title.replace(/[^\w\- ]+/g, '').trim() || 'report'} - test report.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    fs.createReadStream(report.filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: 'Could not download the report', message: error.message });
  }
};

const deleteReport = async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    await fsPromises.rm(report.filePath, { force: true });
    await PlaygroundReport.deleteOne({ _id: report._id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not delete the report', message: error.message });
  }
};

module.exports = { closeTest, createReport, listReports, downloadReport, deleteReport };
