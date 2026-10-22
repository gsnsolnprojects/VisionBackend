const fs = require('fs');
const Dataset = require('../models/Dataset');
const Model = require('../models/Model');
const TrainingJob = require('../models/TrainingJob');
const InferenceJob = require('../models/InferenceJob');
const AuditLog = require('../models/AuditLog');
const Annotation = require('../models/Annotation');
const Category = require('../models/Category');
const { buildWorkspaceFilter, validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const auditService = require('../services/auditService');
const path = require('path');
const { deleteProjectRow } = require('../services/supabaseService');
const { removeLibraryEntriesForDatasets } = require('../services/sampleLibraryService');
const { countStoredImages, countTrainingRunsThisMonth, countPredictionsThisMonth } = require('../utils/usage');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Match a project name even if it was stored with spaces around it: some older projects
 * were saved as e.g. "webcam " while the app sends "webcam".
 */
const projectNameMatcher = (project) => new RegExp(`^\\s*${escapeRegex(String(project).trim())}\\s*$`);

/** Windows drops trailing spaces in paths ("webcam \\v2") unless the \\\\?\\ form is used */
const fsPath = (p) => path.toNamespacedPath(p);

/**
 * Dashboard Controller
 *
 * These endpoints are read-only and aggregate existing data
 * for the dashboard views. They do NOT modify any resources
 * and therefore do not change existing behaviour.
 */

/**
 * GET /api/dashboard/overview
 *
 * Query params:
 * - company (required)
 * - project (optional) – when provided, filter by project
 */
const getDashboardOverview = async (req, res) => {
  try {
    const { company, project } = req.query;

    if (!company) {
      return res.status(400).json({
        error: 'Missing required query parameter: company'
      });
    }

    const projectFilter = project ? { company, project } : { company };

    // Projects: distinct project names from datasets & models
    const datasetProjects = await Dataset.distinct('project', { company });
    const modelProjects = await Model.distinct('project', { company });
    const allProjects = Array.from(new Set([...datasetProjects, ...modelProjects]));

    // Datasets
    const totalDatasets = await Dataset.countDocuments(projectFilter);

    // Models
    const totalModels = await Model.countDocuments(projectFilter);

    // Training jobs by status
    const trainingAgg = await TrainingJob.aggregate([
      { $match: projectFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const trainingSummary = trainingAgg.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    const trainingJobsCount = trainingAgg.reduce((sum, item) => sum + (item.count || 0), 0);

    // Inference jobs by status
    const inferenceAgg = await InferenceJob.aggregate([
      { $match: projectFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const inferenceSummary = inferenceAgg.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    const inferenceRunsCount = inferenceAgg.reduce((sum, item) => sum + (item.count || 0), 0);

    // Last prediction (recent completed inference job for this scope)
    const lastInference = await InferenceJob.findOne({
      ...projectFilter,
      status: 'completed'
    })
      .sort({ completedAt: -1, createdAt: -1 })
      .select('inferenceId status createdAt completedAt company project')
      .lean();

    return res.status(200).json({
      company,
      project: project || null,
      summary: {
        // Legacy fields (to avoid breaking any existing usage)
        activeProjects: allProjects.length,
        totalDatasets,
        totalModels,
        // New fields expected by dashboard frontend
        projectsCount: allProjects.length,
        datasetsCount: totalDatasets,
        modelsCount: totalModels,
        trainingJobsCount,
        inferenceRunsCount
      },
      trainingJobsByStatus: trainingSummary,
      inferenceJobsByStatus: inferenceSummary,
      lastPrediction: lastInference
        ? {
          inferenceId: lastInference.inferenceId,
          status: lastInference.status,
          createdAt: lastInference.createdAt,
          completedAt: lastInference.completedAt,
          company: lastInference.company,
          project: lastInference.project
        }
        : null
    });
  } catch (error) {
    console.error('Error in getDashboardOverview:', error);
    return res.status(500).json({
      error: 'Failed to load dashboard overview',
      message: error.message
    });
  }
};

/**
 * GET /api/dashboard/activity
 *
 * Query params:
 * - company (required)
 * - project (optional)
 * - limit (optional, default 20)
 *
 * Returns recent activity based on AuditLog entries. If there are
 * no audit logs yet, this will simply return an empty list.
 */
const getDashboardActivity = async (req, res) => {
  try {
    const { company, project, limit = 20 } = req.query;

    if (!company) {
      return res.status(400).json({
        error: 'Missing required query parameter: company'
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this workspace'
        });
      }
    }

    const query = { company };
    if (project) {
      query.project = project;
    }

    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .limit(Number(limit))
      .lean();

    const activities = logs.map((log) => ({
      logId: log.logId,
      company: log.company,
      project: log.project,
      userId: log.userId,
      action: log.action,
      resourceType: log.resourceType,
      resourceId: log.resourceId,
      details: log.details || {},
      timestamp: log.timestamp
    }));

    return res.status(200).json({
      company,
      project: project || null,
      activities,
      total: activities.length
    });
  } catch (error) {
    console.error('Error in getDashboardActivity:', error);
    return res.status(500).json({
      error: 'Failed to load dashboard activity',
      message: error.message
    });
  }
};

/**
 * GET /api/dashboard/projects
 *
 * Query params:
 * - company (required)
 *
 * Returns a list of projects with basic counts. This is a read-only
 * aggregation over existing collections.
 */
const getDashboardProjects = async (req, res) => {
  try {
    const { company } = req.query;

    if (!company) {
      return res.status(400).json({
        error: 'Missing required query parameter: company'
      });
    }

    // ✅ Validate workspace access (for non-platform-admin users)
    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this workspace'
        });
      }
    }

    // Distinct projects from datasets, models, and training jobs
    const datasetProjects = await Dataset.distinct('project', { company });
    const modelProjects = await Model.distinct('project', { company });
    const trainingProjects = await TrainingJob.distinct('project', { company });

    const projects = Array.from(
      new Set([...datasetProjects, ...modelProjects, ...trainingProjects])
    );

    // For each project, compute simple counts
    const projectSummaries = await Promise.all(
      projects.map(async (projectName) => {
        const filter = { company, project: projectName };

        const [datasetsCount, modelsCount, trainingCount, inferenceCount] = await Promise.all([
          Dataset.countDocuments(filter),
          Model.countDocuments(filter),
          TrainingJob.countDocuments(filter),
          InferenceJob.countDocuments(filter)
        ]);

        // Last activity timestamp from training or inference jobs
        const lastTraining = await TrainingJob.findOne(filter)
          .sort({ updatedAt: -1 })
          .select('updatedAt')
          .lean();
        const lastInference = await InferenceJob.findOne(filter)
          .sort({ updatedAt: -1 })
          .select('updatedAt')
          .lean();

        const lastActivity = [lastTraining?.updatedAt, lastInference?.updatedAt]
          .filter(Boolean)
          .sort((a, b) => b - a)[0] || null;

        return {
          company,
          project: projectName,
          datasetsCount,
          modelsCount,
          trainingJobsCount: trainingCount,
          inferenceJobsCount: inferenceCount,
          lastActivity
        };
      })
    );

    return res.status(200).json({
      company,
      projects: projectSummaries,
      total: projectSummaries.length
    });
  } catch (error) {
    console.error('Error in getDashboardProjects:', error);
    return res.status(500).json({
      error: 'Failed to load dashboard projects',
      message: error.message
    });
  }
};

/**
 * GET /api/dashboard/project
 *
 * Query params: company (required), project (required)
 *
 * Returns counts for a single project (for delete confirmation modal).
 * Used by frontend to show "This will delete X datasets, Y models, ...".
 */
const getProjectSummary = async (req, res) => {
  try {
    const { company, project } = req.query;

    if (!company || !project) {
      return res.status(400).json({
        error: 'Missing required query parameters',
        message: 'company and project are required'
      });
    }

    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this workspace'
        });
      }
    }

    const filter = { company, project: projectNameMatcher(project) };

    const [datasetsCount, modelsCount, trainingJobsCount, inferenceJobsCount] = await Promise.all([
      Dataset.countDocuments({ ...filter, deletedAt: null }),
      Model.countDocuments(filter),
      TrainingJob.countDocuments(filter),
      InferenceJob.countDocuments(filter)
    ]);

    return res.status(200).json({
      company,
      project,
      datasetsCount,
      modelsCount,
      trainingJobsCount,
      inferenceJobsCount
    });
  } catch (error) {
    console.error('Error in getProjectSummary:', error);
    return res.status(500).json({
      error: 'Failed to load project summary',
      message: error.message
    });
  }
};

/**
 * DELETE /api/dashboard/project
 *
 * Query params or body: company (required), project (required)
 *
 * Deletes all resources for the given project: inference jobs (and results),
 * models (and storage), training jobs, datasets (soft delete + remove files).
 * Pre-checks: no dataset processing/queued, no inference running/queued, no training running/queued.
 * Permission: deleteProjects.
 */
const deleteProject = async (req, res) => {
  try {
    const company = req.query.company || req.body.company;
    const project = req.query.project || req.body.project;

    if (!company || !project) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'company and project are required (query or body)'
      });
    }

    if (!canAccessAllWorkspaces(req.user)) {
      const accessValidation = validateWorkspaceAccess(req.user, company);
      if (!accessValidation.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: accessValidation.error || 'You do not have access to this workspace'
        });
      }
    }

    const filter = { company, project: projectNameMatcher(project) };

    // Every spelling the project was stored under (e.g. "webcam" and "webcam "), for its folders on disk
    const storedNames = new Set([String(project).trim()]);
    for (const M of [Dataset, Model, TrainingJob, InferenceJob]) {
      (await M.distinct('project', filter)).forEach((name) => storedNames.add(name));
    }

    // Pre-check: customers' linked samples still point at this project's datasets or models
    const [ownDatasetIds, ownModelIds] = await Promise.all([
      Dataset.find({ ...filter, linkedFrom: null }).distinct('_id'),
      Model.find({ ...filter, linkedFrom: null }).distinct('_id'),
    ]);
    const [linkedDatasets, linkedModels] = await Promise.all([
      Dataset.countDocuments({ linkedFrom: { $in: ownDatasetIds }, deletedAt: null }),
      Model.countDocuments({ linkedFrom: { $in: ownModelIds } }),
    ]);
    if (linkedDatasets + linkedModels > 0) {
      const message = `Customers use ${linkedDatasets + linkedModels} sample dataset/model${linkedDatasets + linkedModels === 1 ? '' : 's'} from this project, so it can't be deleted yet.`;
      return res.status(409).json({ error: message, message });
    }

    // Pre-check: no active datasets (processing/queued)
    const activeDatasets = await Dataset.countDocuments({
      ...filter,
      deletedAt: null,
      status: { $in: ['processing', 'queued'] }
    });
    if (activeDatasets > 0) {
      return res.status(400).json({
        error: 'Cannot delete project',
        message: `${activeDatasets} dataset(s) are still processing or queued. Please wait or cancel them before deleting the project.`,
        activeDatasets
      });
    }

    // Pre-check: no running/queued inference jobs
    const activeInference = await InferenceJob.countDocuments({
      ...filter,
      status: { $in: ['running', 'queued'] }
    });
    if (activeInference > 0) {
      return res.status(400).json({
        error: 'Cannot delete project',
        message: `${activeInference} inference job(s) are still running or queued. Please cancel them before deleting the project.`,
        activeInference
      });
    }

    // Pre-check: no running/queued training jobs
    const activeTraining = await TrainingJob.countDocuments({
      ...filter,
      status: { $in: ['running', 'queued'] }
    });
    if (activeTraining > 0) {
      return res.status(400).json({
        error: 'Cannot delete project',
        message: `${activeTraining} training job(s) are still running or queued. Please wait or cancel them before deleting the project.`,
        activeTraining
      });
    }

    const deleted = { datasets: 0, models: 0, trainingJobs: 0, inferenceJobs: 0, annotations: 0, categories: 0 };

    // Get all dataset IDs for this project (including already soft-deleted) for annotation/category cleanup
    const projectDatasetIds = (await Dataset.find(filter).select('_id').lean()).map((d) => d._id);

    // 1. Delete inference jobs (and their result folders + framesPath for live camera)
    const inferenceJobs = await InferenceJob.find(filter).lean();
    for (const job of inferenceJobs) {
      const results = job.results || {};
      if (results.resultsPath && fs.existsSync(fsPath(results.resultsPath))) {
        try {
          fs.rmSync(fsPath(results.resultsPath), { recursive: true, force: true });
        } catch (e) {
          console.warn(`Could not delete inference results: ${e.message}`);
        }
      }
      if (results.framesPath && fs.existsSync(fsPath(results.framesPath))) {
        try {
          fs.rmSync(fsPath(results.framesPath), { recursive: true, force: true });
        } catch (e) {
          console.warn(`Could not delete inference frames: ${e.message}`);
        }
      }
    }
    const inferenceResult = await InferenceJob.deleteMany(filter);
    deleted.inferenceJobs = inferenceResult.deletedCount || 0;

    // 2. Delete models (storage + document). Linked sample models use GSN's folder: record only.
    const models = await Model.find(filter).lean();
    for (const model of models) {
      if (model.linkedFrom) continue;
      if (model.storagePath && fs.existsSync(fsPath(model.storagePath))) {
        try {
          fs.rmSync(fsPath(model.storagePath), { recursive: true, force: true });
        } catch (e) {
          console.warn(`Could not delete model storage: ${e.message}`);
        }
      }
      if (model.chartDataPath && model.chartDataPath !== model.storagePath && fs.existsSync(fsPath(model.chartDataPath))) {
        try {
          fs.rmSync(fsPath(model.chartDataPath), { recursive: true, force: true });
        } catch (e) {
          console.warn(`Could not delete chart data: ${e.message}`);
        }
      }
    }
    const modelResult = await Model.deleteMany(filter);
    deleted.models = modelResult.deletedCount || 0;

    // 3. Delete training jobs (documents only; output is under model, already removed)
    const trainingResult = await TrainingJob.deleteMany(filter);
    deleted.trainingJobs = trainingResult.deletedCount || 0;

    // 4. Delete annotations and categories for all datasets in this project (no use once datasets are gone)
    if (projectDatasetIds.length > 0) {
      const annotationResult = await Annotation.deleteMany({ datasetId: { $in: projectDatasetIds } });
      const categoryResult = await Category.deleteMany({ datasetId: { $in: projectDatasetIds } });
      deleted.annotations = annotationResult.deletedCount || 0;
      deleted.categories = categoryResult.deletedCount || 0;
    }

    // 5. Datasets: delete files and soft-delete documents
    const datasets = await Dataset.find({ ...filter, deletedAt: null });
    for (const dataset of datasets) {
      if (dataset.status === 'processing' || dataset.status === 'queued') {
        continue; // Should not happen due to pre-check
      }
      // Linked sample datasets point at GSN's shared folder: only the record goes
      if (!dataset.linkedFrom && dataset.storagePath && fs.existsSync(fsPath(dataset.storagePath))) {
        try {
          fs.rmSync(fsPath(dataset.storagePath), { recursive: true, force: true });
        } catch (e) {
          console.warn(`Could not delete dataset files: ${e.message}`);
        }
      }
      dataset.deletedAt = new Date();
      dataset.status = 'failed';
      await dataset.save();
      deleted.datasets += 1;
    }

    // Sample library entries pointing at this project's datasets go with them
    deleted.sampleLibraryEntries = await removeLibraryEntriesForDatasets(projectDatasetIds);

    // 6. Remove project-level folders from disk (datasets/company/project, models/company/project,
    //    results/company/project) for every spelling the project was stored under
    const projectFolders = [];
    for (const name of storedNames) {
      if (!name.trim()) continue;
      for (const base of ['datasets', 'models', 'results']) {
        const baseDir = path.join(process.cwd(), base, company);
        const dir = path.join(baseDir, name);
        if (path.dirname(dir) === baseDir) projectFolders.push(dir); // never outside {base}/{company}
      }
    }
    for (const dir of projectFolders) {
      if (fs.existsSync(fsPath(dir))) {
        try {
          fs.rmSync(fsPath(dir), { recursive: true, force: true });
        } catch (e) {
          console.warn(`Could not remove project folder ${dir}: ${e.message}`);
        }
      }
    }

    // 7. Delete project row from Supabase (so project name disappears from frontend UI)
    const supabaseResult = await deleteProjectRow(company, project);
    if (!supabaseResult.success) {
      console.warn('Supabase project row delete failed (table may not exist or columns differ):', supabaseResult.error);
    }

    await auditService.logAction({
      action: 'delete',
      resourceType: 'project',
      resourceId: `${company}/${project}`,
      details: { company, project, deleted },
      req
    });

    return res.status(200).json({
      message: 'Project deleted successfully',
      company,
      project,
      deleted
    });
  } catch (error) {
    console.error('Error in deleteProject:', error);
    return res.status(500).json({
      error: 'Failed to delete project',
      message: error.message
    });
  }
};

/**
 * GET /api/dashboard/learning-progress
 * Counts behind the Playground learning path and allowance meters, for the caller's own
 * company: datasets (and how many are GSN sample links), own trained models, finished
 * predictions, images stored in its own datasets, and this month's training runs and
 * predicted images (see utils/usage.js).
 */
const getLearningProgress = async (req, res) => {
  try {
    const company = req.user?.company;
    if (!company) {
      return res.json({
        datasets: 0, sampleDatasets: 0, models: 0, predictions: 0,
        storedImages: 0, trainingRunsThisMonth: 0, predictionsThisMonth: 0,
      });
    }

    const [datasets, sampleDatasets, models, predictions, storedImages, trainingRunsThisMonth, predictionsThisMonth] =
      await Promise.all([
        Dataset.countDocuments({ company, deletedAt: null }),
        Dataset.countDocuments({ company, deletedAt: null, linkedFrom: { $ne: null } }),
        Model.countDocuments({ company, linkedFrom: null }),
        InferenceJob.countDocuments({ company, status: 'completed' }),
        countStoredImages(company),
        countTrainingRunsThisMonth(company),
        countPredictionsThisMonth(company),
      ]);
    res.json({ datasets, sampleDatasets, models, predictions, storedImages, trainingRunsThisMonth, predictionsThisMonth });
  } catch (error) {
    console.error('Error getting learning progress:', error);
    res.status(500).json({ error: 'Could not load learning progress', message: error.message });
  }
};

module.exports = {
  getLearningProgress,
  getDashboardOverview,
  getDashboardActivity,
  getDashboardProjects,
  getProjectSummary,
  deleteProject
};

