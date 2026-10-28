const InferenceJob = require('../models/InferenceJob');
const PlaygroundReport = require('../models/PlaygroundReport');
const AuditLog = require('../models/AuditLog');
const PlaygroundProgress = require('../models/PlaygroundProgress');

/**
 * The Playground challenge path: 1 guided challenge -> 2 learn to label -> 3 own project. The
 * overview soft-locks a card until the ones before it are done.
 *
 * - Guided challenge done: the company tested a model on held-out photos or made a report
 *   (training isn't open in the Playground yet). Worked out from its tests, reports and the audit
 *   log (which outlives deleted projects), then saved so it stays done.
 * - Label practice done: saved when the student reaches "Practice complete".
 */

async function hasFinishedGuided(company) {
  const [job, report, logged] = await Promise.all([
    InferenceJob.exists({ company, sourceType: 'test_folder', status: 'completed', purpose: { $ne: 'practice' } }),
    PlaygroundReport.exists({ company }),
    AuditLog.exists({
      $or: [{ company }, { 'details.company': company }],
      action: 'execute',
      resourceType: 'inference',
      'details.sourceType': 'test_folder',
    }),
  ]);
  return !!(job || report || logged);
}

/** { guidedDone, practiceDone } for a company */
async function getPathProgress(company) {
  if (!company) return { guidedDone: false, practiceDone: false };
  let progress = await PlaygroundProgress.findOne({ company }).lean();
  if (!progress?.guidedDoneAt && (await hasFinishedGuided(company))) {
    progress = await PlaygroundProgress.findOneAndUpdate(
      { company },
      { $set: { guidedDoneAt: new Date() } },
      { upsert: true, new: true }
    ).lean();
  }
  return { guidedDone: !!progress?.guidedDoneAt, practiceDone: !!progress?.practiceDoneAt };
}

/** Saves that the company finished label practice (the first time only) */
async function markPracticeDone(company) {
  const progress = await PlaygroundProgress.findOne({ company }).lean();
  if (!progress?.practiceDoneAt) {
    await PlaygroundProgress.updateOne({ company }, { $set: { practiceDoneAt: new Date() } }, { upsert: true });
  }
  return getPathProgress(company);
}

module.exports = { getPathProgress, markPracticeDone };
