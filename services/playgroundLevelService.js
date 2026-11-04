const PlaygroundLevelProgress = require('../models/PlaygroundLevelProgress');
const TrainingJob = require('../models/TrainingJob');

/**
 * Playground levels: each one is a list of steps, saved per student and mission. "Continue" on the
 * overview opens the first step not done yet. A training run's result is read from its job, so a
 * run that finished while the student was away already counts when they come back.
 */

const LEVEL_STEPS = {
  1: ['dataset', 'practice', 'training', 'test', 'report'],
  2: ['upload', 'label', 'augment', 'train', 'test', 'report'],
};
/** Steps a level can be finished without */
const OPTIONAL_STEPS = ['augment'];
/** Far more than the real missions: only stops a client from filling the collection */
const MAX_LEVELS_PER_USER = 50;

const requiredSteps = (level) => LEVEL_STEPS[level].filter((s) => !OPTIONAL_STEPS.includes(s));

const nextStep = (level, completed) => requiredSteps(level).find((s) => !completed.includes(s)) || null;

const shortText = (value, max) => {
  const text = typeof value === 'string' ? value.trim().slice(0, max) : '';
  return text || null;
};

/** Reads the training run's status; a completed run also completes the level's train step */
async function withTraining(progress) {
  if (!progress.trainingJobId) return { progress, training: null };
  const job = await TrainingJob.findOne({ jobId: progress.trainingJobId, company: progress.company }).select('status').lean();
  if (!job) return { progress, training: null };
  if (job.status === 'completed' && !progress.completedSteps.includes('train')) {
    const updated = await markStep(progress, 'train');
    return { progress: updated, training: { status: job.status } };
  }
  return { progress, training: { status: job.status } };
}

async function markStep(progress, step) {
  const completedSteps = [...new Set([...progress.completedSteps, step])];
  const finished = !nextStep(progress.level, completedSteps);
  return PlaygroundLevelProgress.findByIdAndUpdate(
    progress._id,
    {
      $addToSet: { completedSteps: step },
      ...(finished && !progress.finishedAt ? { $set: { finishedAt: new Date() } } : {}),
    },
    { new: true }
  ).lean();
}

const toJson = ({ progress: p, training }) => ({
  level: p.level,
  mission: p.mission,
  industry: p.industry,
  sample: p.sample,
  projectId: p.projectId,
  steps: requiredSteps(p.level),
  completedSteps: p.completedSteps,
  nextStep: nextStep(p.level, p.completedSteps),
  practiceScore: p.practiceScore,
  trainingJobId: p.trainingJobId,
  training,
  finishedAt: p.finishedAt,
  startedAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/** The student's levels, the one they touched last first */
async function listLevels(user) {
  const rows = await PlaygroundLevelProgress.find({ userId: user.id, company: user.company }).sort({ updatedAt: -1 }).lean();
  const levels = await Promise.all(rows.map(withTraining));
  return levels.map(toJson);
}

/**
 * Starts a level, or re-opens it (a project made since is remembered). A different project, or
 * projectId null when the old one was deleted, starts the level over. Null if the input is bad.
 */
async function startLevel(user, { level, mission, industry, sample, projectId }) {
  const missionName = shortText(mission, 120);
  if (!LEVEL_STEPS[level] || !missionName) return null;
  const key = { userId: user.id, company: user.company, mission: missionName };
  const existing = await PlaygroundLevelProgress.findOne(key).select('projectId').lean();
  if (!existing) {
    const count = await PlaygroundLevelProgress.countDocuments({ userId: user.id, company: user.company });
    if (count >= MAX_LEVELS_PER_USER) return null;
  }
  const project = shortText(projectId, 64);
  const startsOver = !!existing && projectId !== undefined && (existing.projectId || null) !== project;
  const set = startsOver
    ? { projectId: project, completedSteps: [], trainingJobId: null, finishedAt: null }
    : project
      ? { projectId: project }
      : null;
  const progress = await PlaygroundLevelProgress.findOneAndUpdate(
    key,
    {
      ...(set ? { $set: set } : {}),
      $setOnInsert: { level, industry: shortText(industry, 120), sample: shortText(sample, 120) },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return toJson(await withTraining(progress));
}

/**
 * Saves what happened in a mission. A project opened outside the levels has no progress row, and a
 * step from another level (both levels share the project page) is ignored: both are normal.
 */
async function saveProgress(user, { mission, step, practiceScore, trainingJobId }) {
  const missionName = shortText(mission, 120);
  if (!missionName) return null;
  let progress = await PlaygroundLevelProgress.findOne({ userId: user.id, company: user.company, mission: missionName }).lean();
  if (!progress) return null;

  const update = {};
  if (typeof practiceScore === 'number' && practiceScore >= 0 && practiceScore <= 1) {
    update.$max = { practiceScore };
  }
  const jobId = shortText(trainingJobId, 100);
  if (jobId && (await TrainingJob.exists({ jobId, company: user.company }))) {
    // A new run starts the step over until it finishes
    update.$set = { trainingJobId: jobId };
    update.$pull = { completedSteps: 'train' };
  }
  if (Object.keys(update).length) {
    progress = await PlaygroundLevelProgress.findByIdAndUpdate(progress._id, update, { new: true }).lean();
  }
  if (LEVEL_STEPS[progress.level].includes(step) && !progress.completedSteps.includes(step)) {
    progress = await markStep(progress, step);
  }
  return toJson(await withTraining(progress));
}

module.exports = { LEVEL_STEPS, listLevels, startLevel, saveProgress };
