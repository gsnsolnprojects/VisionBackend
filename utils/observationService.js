const Observation = require('../models/Observation');
const ObservationCounter = require('../models/ObservationCounter');
const InferenceJob = require('../models/InferenceJob');

/** Trim, lower-case and collapse whitespace so near-identical names match. */
function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function formatObservationId(seq) {
  return `OBS-${String(seq).padStart(4, '0')}`;
}

/**
 * Returns the observation for this area + component, creating it (and minting
 * the next OBS-#### for the vessel) if it's the first time it's been captured.
 */
async function findOrCreateObservation({ company, project, regionName, componentName, createdBy }) {
  const region = cleanName(regionName);
  const component = cleanName(componentName);
  const regionKey = normalizeKey(region);
  const componentKey = normalizeKey(component);
  const scope = { company, project, regionKey, componentKey };

  const existing = await Observation.findOne(scope);
  if (existing) return existing;

  const counter = await ObservationCounter.findOneAndUpdate(
    { company, project },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  try {
    return await Observation.create({
      company,
      project,
      observationId: formatObservationId(counter.seq),
      regionName: region,
      componentName: component,
      regionKey,
      componentKey,
      createdBy: createdBy || null,
    });
  } catch (err) {
    // Two captures of a brand-new spot at the same moment: the other one won,
    // use its observation (this counter number is simply skipped).
    if (err && err.code === 11000) {
      const winner = await Observation.findOne(scope);
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Decides which observation a newly created job belongs to. A resurvey
 * inherits its baseline's observation (so it can never drift onto a different
 * spot); otherwise the area + component identify it.
 * @returns {Promise<{observationId: string, regionName: string, componentName: string}>}
 */
async function resolveObservationForNewJob({
  company,
  project,
  regionName,
  componentName,
  baselineInferenceId,
  createdBy,
}) {
  if (baselineInferenceId) {
    const baseline = await InferenceJob.findOne({ inferenceId: baselineInferenceId })
      .select('observationId regionName componentName')
      .lean();
    if (baseline && baseline.observationId) {
      return {
        observationId: baseline.observationId,
        regionName: baseline.regionName || regionName,
        componentName: baseline.componentName || '',
      };
    }
    if (baseline) {
      regionName = baseline.regionName || regionName;
      componentName = baseline.componentName || componentName;
    }
  }
  const observation = await findOrCreateObservation({ company, project, regionName, componentName, createdBy });
  return {
    observationId: observation.observationId,
    regionName: observation.regionName,
    componentName: observation.componentName,
  };
}

/** The latest COMPLETED visit of a spot, i.e. what a new visit should link back to. */
async function findPreviousVisit({ company, project, observationId }) {
  if (!observationId) return null;
  const previous = await InferenceJob.findOne({ company, project, observationId, status: 'completed' })
    .sort({ createdAt: -1 })
    .select('inferenceId')
    .lean();
  return previous ? previous.inferenceId : null;
}

module.exports = { normalizeKey, cleanName, findOrCreateObservation, resolveObservationForNewJob, findPreviousVisit };
