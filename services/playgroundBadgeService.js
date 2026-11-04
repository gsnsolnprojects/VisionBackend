const Model = require('../models/Model');
const PlaygroundBadge = require('../models/PlaygroundBadge');
const TrainingJob = require('../models/TrainingJob');
const { listLevels } = require('./playgroundLevelService');

/**
 * Playground badges. They're worked out from the student's saved level progress, so they can't drift
 * from what really happened, and kept once earned. A step that was skipped earns nothing.
 */

const ACCURATE_LABELLER_SCORE = 0.8;
const NO_HINTS_PHOTOS = 5;
/** A low score isn't printed on the badge: it's for having a go */
const LOW_SCORE_HIDDEN = 0.5;
const HIGH_ACCURACY_SCORE = 0.9;

const percent = (score) => `${Math.round(score * 100)}%`;

/** A badge per step of a level that was really done */
const STEP_BADGES = {
  1: { dataset: 'data_explorer', training: 'training_fundamentals', test: 'first_model_test', report: 'first_report' },
  2: { upload: 'dataset_builder', label: 'data_labeller', train: 'model_trainer', test: 'model_evaluator', report: 'inspection_reporter' },
};
const LEVEL_BADGES = { 1: 'vision_m_foundations', 2: 'vision_m_builder' };

/** The student's best score among their trained Level 2 models that finished */
async function bestModelScore(user, levels) {
  const trained = levels.filter((l) => l.level === 2 && l.trainingJobId && l.training?.status === 'completed');
  let best = null;
  for (const level of trained) {
    // A level remembers the run's jobId; a model points at the run's own _id
    const job = await TrainingJob.findOne({ jobId: level.trainingJobId, company: user.company }).select('metrics.mAP50').lean();
    if (!job) continue;
    const model = await Model.findOne({ jobId: job._id }).select('metrics.mAP50').lean();
    const score = model?.metrics?.mAP50 ?? job.metrics?.mAP50;
    if (typeof score === 'number' && (!best || score > best.score)) best = { score, mission: level.mission };
  }
  return best;
}

/** Everything the student's progress has earned, by badge */
async function earnedFromProgress(user, levels) {
  const earned = new Map();
  const add = (badge, mission, detail = null) => {
    if (!earned.has(badge)) earned.set(badge, { mission, detail });
  };

  for (const level of levels) {
    for (const [step, badge] of Object.entries(STEP_BADGES[level.level] || {})) {
      if (level.completedSteps.includes(step) && !level.skippedSteps?.includes(step)) add(badge, level.mission);
    }
    if (level.finishedAt && LEVEL_BADGES[level.level]) add(LEVEL_BADGES[level.level], level.mission);
    // A score exists only if at least one practice photo was checked: skipping leaves none
    if (typeof level.practiceScore === 'number') add('labelling_practice', level.mission, level.practiceScore >= LOW_SCORE_HIDDEN ? `${percent(level.practiceScore)} match` : null);
    if (level.practiceScore >= ACCURATE_LABELLER_SCORE) add('accurate_labeller', level.mission, `${percent(level.practiceScore)} match`);
    if (level.cleanPhotos >= NO_HINTS_PHOTOS) add('no_hints_used', level.mission, `${level.cleanPhotos} photos without a hint`);
  }

  const best = await bestModelScore(user, levels);
  if (best && best.score >= HIGH_ACCURACY_SCORE) add('high_accuracy_model', best.mission, `${percent(best.score)} score`);
  return earned;
}

const toJson = (b) => ({
  id: b.badge,
  mission: b.mission,
  detail: b.detail,
  earnedAt: b.createdAt,
  seen: !!b.seenAt,
});

/** Saves badges newly earned and returns all of the student's badges, oldest first */
async function syncBadges(user) {
  const filter = { userId: user.id, company: user.company };
  const existing = await PlaygroundBadge.find(filter).select('badge').lean();
  const have = new Set(existing.map((b) => b.badge));
  const earned = await earnedFromProgress(user, await listLevels(user));
  const missing = [...earned].filter(([badge]) => !have.has(badge));

  if (missing.length) {
    // Several at once on the very first look is earlier work, from before badges existed: no parade of cards
    const seenAt = existing.length === 0 && missing.length > 1 ? new Date() : null;
    await PlaygroundBadge.insertMany(
      missing.map(([badge, { mission, detail }]) => ({ ...filter, badge, mission, detail, seenAt })),
      { ordered: false }
    ).catch((err) => {
      if (err.code !== 11000) throw err; // two requests at once: the other one saved it
    });
  }
  const all = await PlaygroundBadge.find(filter).sort({ createdAt: 1, _id: 1 }).lean();
  return all.map(toJson);
}

/** The student has been shown these */
async function markBadgesSeen(user, ids) {
  const badges = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string').slice(0, 50);
  if (!badges.length) return;
  await PlaygroundBadge.updateMany(
    { userId: user.id, company: user.company, badge: { $in: badges }, seenAt: null },
    { $set: { seenAt: new Date() } }
  );
}

module.exports = { syncBadges, markBadgesSeen };
