const fs = require('fs');
const InferenceJob = require('../models/InferenceJob');
const Model = require('../models/Model');
const { validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const { getClassNamesForTrainedModel } = require('../services/yoloClassNamesService');
const { classNamesFromMetadata, stampClassIds } = require('../utils/classLegend');
const { deriveSeverityFromPercent } = require('../utils/severity');
const Observation = require('../models/Observation');
const ActionItem = require('../models/ActionItem');
const auditService = require('../services/auditService');
const { normalizeKey } = require('../utils/observationService');

function readMetadata(job) {
  const metadataPath = job.results?.metadataPath;
  if (!metadataPath || !fs.existsSync(metadataPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return null;
  }
}

function readCorrosionFromJob(job) {
  if (job.results?.corrosionStats && typeof job.results.corrosionStats.meanCorrosionPercent === 'number') {
    return job.results.corrosionStats;
  }
  const metadata = readMetadata(job);
  return metadata?.corrosionStats || null;
}

async function resolveClassNamesForJobs(jobs) {
  for (const job of jobs || []) {
    const fromMeta = classNamesFromMetadata(readMetadata(job));
    if (fromMeta.length) return fromMeta;
  }
  const modelId = jobs?.[0]?.modelId;
  if (!modelId) return [];
  try {
    const model = await Model.findById(modelId);
    if (!model) return [];
    return await getClassNamesForTrainedModel(model, { skipCheckpoint: true });
  } catch (err) {
    console.warn('[mobile-inspect] classNames lookup failed:', err.message);
    return [];
  }
}

function mean(values) {
  const nums = values.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (!nums.length) return null;
  return round4(nums.reduce((s, n) => s + n, 0) / nums.length);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function mergeClassRows(rowsList) {
  const bucket = {};
  for (const rows of rowsList) {
    for (const row of rows || []) {
      const name = row.class || row.className;
      if (!name) continue;
      const item = bucket[name] || { class: name, percentSum: 0, n: 0, count: 0, classId: null };
      if (item.classId == null && typeof row.classId === 'number') item.classId = row.classId;
      const pct = row.meanPercent ?? row.percent;
      if (typeof pct === 'number') {
        item.percentSum += pct;
        item.n += 1;
      }
      item.count += Number(row.count) || 0;
      bucket[name] = item;
    }
  }
  return Object.values(bucket)
    .map((v) => ({
      class: v.class,
      classId: typeof v.classId === 'number' ? v.classId : undefined,
      meanPercent: v.n ? round4(v.percentSum / v.n) : 0,
      count: v.count,
    }))
    .sort((a, b) => b.meanPercent - a.meanPercent);
}

function inspectFilter(company, project, extra = {}) {
  return {
    company,
    project,
    sourceType: 'custom_folder',
    excludeFromHistory: { $ne: true },
    surveyName: { $nin: [null, ''] },
    regionName: { $nin: [null, ''] },
    ...extra,
  };
}

function hydrateJob(job, classNames) {
  const corrosion = job.status === 'completed' ? readCorrosionFromJob(job) : null;
  return {
    inferenceId: job.inferenceId,
    status: job.status,
    regionName: job.regionName,
    surveyName: job.surveyName,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    imageCount: corrosion?.imageCount ?? job.progress?.totalImages ?? 0,
    meanCorrosionPercent:
      typeof corrosion?.meanCorrosionPercent === 'number' ? corrosion.meanCorrosionPercent : null,
    byClass: stampClassIds(corrosion?.byClass || [], classNames),
    // Present when this job is an explicit resurvey of an earlier job — lets
    // the dashboard show a "Compare" button without a second round trip.
    baselineInferenceId: job.baselineInferenceId || null,
    observationId: job.observationId || null,
    componentName: job.componentName || '',
    notes: job.notes || '',
    inspectorName: job.inspectorName || null,
    assessment: job.assessment || null,
    previousInferenceId: job.previousInferenceId || null,
    review: publicReview(job.review),
  };
}

/** Identity of a part within a survey: its observation, or (legacy jobs) its area name. */
function partKeyOf(visit) {
  return visit.observationId || `region:${visit.regionName}`;
}

function buildSurveyFromJobs(surveyName, jobs, classNames = []) {
  const hydrated = jobs.map((job) => hydrateJob(job, classNames));
  const byPart = {};
  for (const visit of hydrated) {
    const key = partKeyOf(visit);
    if (!byPart[key]) byPart[key] = [];
    byPart[key].push(visit);
  }

  const parts = Object.keys(byPart)
    .map((partKey) => {
      const visits = byPart[partKey].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      const regionName = visits[0].regionName;
      const completedVisits = visits.filter((v) => v.status === 'completed' && v.meanCorrosionPercent != null);
      const latestCompleted = completedVisits[0] || null;
      const previousCompleted = completedVisits[1] || null;
      const meanCorrosionPercent = latestCompleted ? latestCompleted.meanCorrosionPercent : null;
      const detailVisit = latestCompleted || visits[0];
      return {
        partKey,
        regionName,
        observationId: visits[0].observationId,
        componentName: visits[0].componentName || '',
        inspectorName: detailVisit.inspectorName,
        notes: detailVisit.notes,
        assessment: detailVisit.assessment || null,
        visitCount: visits.length,
        latest: visits[0],
        latestCompleted: latestCompleted || null,
        meanCorrosionPercent,
        imageCount: latestCompleted ? latestCompleted.imageCount : 0,
        byClass: latestCompleted?.byClass || [],
        severityBand: deriveSeverityFromPercent(meanCorrosionPercent),
        changeFromPrevious: previousCompleted
          ? {
              delta: round4(meanCorrosionPercent - previousCompleted.meanCorrosionPercent),
              previousMeanCorrosionPercent: previousCompleted.meanCorrosionPercent,
            }
          : null,
        visits,
      };
    })
    .sort(
      (a, b) =>
        a.regionName.localeCompare(b.regionName) || (a.componentName || '').localeCompare(b.componentName || '')
    );

  const partPercents = parts
    .map((p) => p.meanCorrosionPercent)
    .filter((n) => typeof n === 'number');
  const completedParts = parts.filter((p) => p.latestCompleted);

  return {
    surveyName,
    partCount: parts.length,
    completedPartCount: completedParts.length,
    visitCount: hydrated.length,
    overallMeanCorrosionPercent: mean(partPercents),
    byClass: stampClassIds(mergeClassRows(completedParts.map((p) => p.byClass)), classNames),
    classNames,
    // `jobs` (and therefore `hydrated`) is always fetched sorted newest-first, so the first
    // entry is the most recent edit and the last is the very first inspection under this name.
    updatedAt: hydrated[0]?.createdAt || null,
    createdAt: hydrated[hydrated.length - 1]?.createdAt || null,
    parts,
  };
}

async function scopedCompanyProject(req, res) {
  const company = String(req.query.company || req.user?.company || '').trim();
  const project = String(req.query.project || '').trim();
  if (!company || !project) {
    res.status(400).json({
      error: 'Missing required query parameters',
      required: ['company', 'project'],
    });
    return null;
  }
  if (!canAccessAllWorkspaces(req.user)) {
    const access = validateWorkspaceAccess(req.user, company);
    if (!access.allowed) {
      res.status(403).json({
        error: 'Permission denied',
        message: access.error || 'You do not have access to this workspace',
      });
      return null;
    }
  }
  return { company, project };
}

/**
 * GET /api/mobile-inspect/surveys?company=&project=
 */
const listMobileInspectSurveys = async (req, res) => {
  try {
    const scope = await scopedCompanyProject(req, res);
    if (!scope) return;
    const { company, project } = scope;

    const jobs = await InferenceJob.find(inspectFilter(company, project))
      .sort({ createdAt: -1 })
      .lean();

    const byName = {};
    for (const job of jobs) {
      const name = job.surveyName;
      if (!byName[name]) byName[name] = [];
      byName[name].push(job);
    }

    const surveys = Object.keys(byName)
      .map((surveyName) => {
        const detail = buildSurveyFromJobs(surveyName, byName[surveyName], []);
        return {
          surveyName: detail.surveyName,
          partCount: detail.partCount,
          completedPartCount: detail.completedPartCount,
          visitCount: detail.visitCount,
          overallMeanCorrosionPercent: detail.overallMeanCorrosionPercent,
          updatedAt: detail.updatedAt,
          createdAt: detail.createdAt,
        };
      })
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    return res.status(200).json({ surveys, company, project });
  } catch (error) {
    console.error('[mobile-inspect] list surveys error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * GET /api/mobile-inspect/survey?company=&project=&surveyName=
 */
const getMobileInspectSurvey = async (req, res) => {
  try {
    const scope = await scopedCompanyProject(req, res);
    if (!scope) return;
    const { company, project } = scope;
    const surveyName = String(req.query.surveyName || '').trim();
    if (!surveyName) {
      return res.status(400).json({
        error: 'Missing required query parameter: surveyName',
      });
    }

    const jobs = await InferenceJob.find(inspectFilter(company, project, { surveyName }))
      .sort({ createdAt: -1 })
      .lean();

    const classNames = await resolveClassNamesForJobs(jobs);
    return res.status(200).json({
      survey: buildSurveyFromJobs(surveyName, jobs, classNames),
      company,
      project,
    });
  } catch (error) {
    console.error('[mobile-inspect] get survey error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/** Matches photo filenames by basename-without-extension, tolerating any format conversion during upload processing. */
function baseKey(filename) {
  return String(filename || '').replace(/\.[^./\\]+$/, '');
}

const isImageEntry = (f) => !f.fileType || f.fileType === 'image';
const entryName = (img) => img.filePath || img.filename;
const entryPercent = (img) => (typeof img.corrosionPercentTotal === 'number' ? img.corrosionPercentTotal : null);

/**
 * Pairs two visits' photos for the side-by-side view. Shared by the dashboard,
 * the phone and the PDF so all three always agree.
 *
 * - When `currentJob` is an explicit guided resurvey of `baselineJob`, photos
 *   are paired exactly as the inspector matched them (`photoMatches`), and any
 *   unmatched photos are "new" / "not re-photographed". pairing = 'matched'.
 * - For any other two visits of the same spot (no guided matching exists),
 *   photos are paired by capture order, best effort. pairing = 'by_order'.
 */
function buildComparison(currentJob, baselineJob) {
  const currentMeta = readMetadata(currentJob);
  const baselineMeta = readMetadata(baselineJob);
  const currentImages = (currentMeta?.images || currentMeta?.files || []).filter(isImageEntry);
  const baselineImages = (baselineMeta?.images || baselineMeta?.files || []).filter(isImageEntry);

  const explicit =
    currentJob.baselineInferenceId === baselineJob.inferenceId &&
    (currentJob.photoMatches || []).some((m) => m.matchedBaselineFilename);

  const toPair = (baselineImg, currentImg) => {
    const bPct = entryPercent(baselineImg);
    const cPct = entryPercent(currentImg);
    return {
      baselineFilename: entryName(baselineImg),
      currentFilename: entryName(currentImg),
      baselinePercent: bPct,
      currentPercent: cPct,
      delta: typeof bPct === 'number' && typeof cPct === 'number' ? round4(cPct - bPct) : null,
    };
  };
  const toExtra = (img) => ({ filename: entryName(img), percent: entryPercent(img) });

  let pairs = [];
  let extraCurrent = [];
  let unmatchedBaseline = [];

  if (explicit) {
    const currentByBase = {};
    for (const img of currentImages) if (entryName(img)) currentByBase[baseKey(entryName(img))] = img;
    const baselineByBase = {};
    for (const img of baselineImages) if (entryName(img)) baselineByBase[baseKey(entryName(img))] = img;

    const matchedCurrentKeys = new Set();
    const matchedBaselineKeys = new Set();
    for (const match of currentJob.photoMatches || []) {
      if (!match.matchedBaselineFilename) continue;
      const currentKey = baseKey(match.filename);
      const baselineKey = baseKey(match.matchedBaselineFilename);
      const currentImg = currentByBase[currentKey];
      const baselineImg = baselineByBase[baselineKey];
      if (!currentImg || !baselineImg) continue;
      matchedCurrentKeys.add(currentKey);
      matchedBaselineKeys.add(baselineKey);
      pairs.push(toPair(baselineImg, currentImg));
    }
    extraCurrent = currentImages.filter((img) => !matchedCurrentKeys.has(baseKey(entryName(img)))).map(toExtra);
    unmatchedBaseline = baselineImages.filter((img) => !matchedBaselineKeys.has(baseKey(entryName(img)))).map(toExtra);
  } else {
    const n = Math.min(currentImages.length, baselineImages.length);
    for (let i = 0; i < n; i += 1) pairs.push(toPair(baselineImages[i], currentImages[i]));
    extraCurrent = currentImages.slice(n).map(toExtra);
    unmatchedBaseline = baselineImages.slice(n).map(toExtra);
  }

  const baselineCorrosion = readCorrosionFromJob(baselineJob);
  const currentCorrosion = readCorrosionFromJob(currentJob);
  const baselinePercent =
    typeof baselineCorrosion?.meanCorrosionPercent === 'number' ? baselineCorrosion.meanCorrosionPercent : null;
  const currentPercent =
    typeof currentCorrosion?.meanCorrosionPercent === 'number' ? currentCorrosion.meanCorrosionPercent : null;

  return {
    pairing: explicit ? 'matched' : 'by_order',
    baseline: {
      inferenceId: baselineJob.inferenceId,
      surveyName: baselineJob.surveyName,
      createdAt: baselineJob.createdAt,
      meanCorrosionPercent: baselinePercent,
    },
    current: {
      inferenceId: currentJob.inferenceId,
      surveyName: currentJob.surveyName,
      createdAt: currentJob.createdAt,
      meanCorrosionPercent: currentPercent,
    },
    pairs,
    extraCurrent,
    unmatchedBaseline,
    overallDelta:
      typeof currentPercent === 'number' && typeof baselinePercent === 'number'
        ? round4(currentPercent - baselinePercent)
        : null,
  };
}

/**
 * Which visits of a spot count as a "baseline": its very first visit, and the
 * first visit after a repair on that spot was closed (the fixed surface is the
 * new reference). `visitsNewestFirst` are completed jobs; `completionDates`
 * are when repairs on the spot were closed. Returns Map(inferenceId -> kind).
 */
function labelBaselines(visitsNewestFirst, completionDates) {
  const asc = [...visitsNewestFirst].reverse();
  const kinds = new Map();
  asc.forEach((visit, i) => {
    if (i === 0) {
      kinds.set(visit.inferenceId, 'initial');
      return;
    }
    const prevAt = new Date(asc[i - 1].createdAt).getTime();
    const at = new Date(visit.createdAt).getTime();
    const repairedBetween = completionDates.some((d) => {
      const t = new Date(d).getTime();
      return t > prevAt && t <= at;
    });
    if (repairedBetween) kinds.set(visit.inferenceId, 'after_repair');
  });
  return kinds;
}

const publicReview = (review) =>
  review
    ? {
        verdict: review.verdict,
        note: review.note || '',
        reviewedBy: review.reviewedBy || null,
        reviewedAt: review.reviewedAt || null,
        comparedToInferenceId: review.comparedToInferenceId || null,
      }
    : null;

/** Every completed visit of the same spot, newest first, with baseline labels — the picker list for comparisons. */
async function loadObservationVisits(job) {
  if (!job.observationId) return [];
  const scope = { company: job.company, project: job.project, observationId: job.observationId };
  const [jobs, actions] = await Promise.all([
    InferenceJob.find({ ...scope, status: 'completed' }).sort({ createdAt: -1 }).lean(),
    ActionItem.find({ ...scope, status: 'completed' }).select('completedAt').lean(),
  ]);
  const kinds = labelBaselines(jobs, actions.map((a) => a.completedAt).filter(Boolean));
  return jobs.map((j) => ({
    inferenceId: j.inferenceId,
    surveyName: j.surveyName,
    createdAt: j.createdAt,
    meanCorrosionPercent: readCorrosionFromJob(j)?.meanCorrosionPercent ?? null,
    baselineKind: kinds.get(j.inferenceId) || null,
    review: publicReview(j.review),
  }));
}

/**
 * GET /api/mobile-inspect/compare?currentInferenceId=&baselineInferenceId=
 *
 * Side-by-side comparison of a visit against an earlier visit of the same
 * spot. `baselineInferenceId` is optional: it defaults to the guided-resurvey
 * baseline if there is one, otherwise the spot's previous visit. Also returns
 * every visit of the spot (`observationVisits`) so the client can offer "compare
 * against…", and the current visit's reviewer verdict.
 */
const compareWithBaseline = async (req, res) => {
  try {
    const currentInferenceId = String(req.query.currentInferenceId || '').trim();
    if (!currentInferenceId) {
      return res.status(400).json({ error: 'Missing required query parameter: currentInferenceId' });
    }

    const currentJob = await InferenceJob.findOne({ inferenceId: currentInferenceId }).lean();
    if (!currentJob) {
      return res.status(404).json({ error: 'Inference job not found', inferenceId: currentInferenceId });
    }
    if (!canAccessAllWorkspaces(req.user)) {
      const access = validateWorkspaceAccess(req.user, currentJob.company);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: access.error || 'You do not have access to this inference job',
        });
      }
    }

    const defaultBaselineId = currentJob.baselineInferenceId || currentJob.previousInferenceId || null;
    const baselineId = String(req.query.baselineInferenceId || '').trim() || defaultBaselineId;
    if (!baselineId) {
      return res.status(400).json({
        error: 'Nothing to compare against',
        message: 'This is the first recorded visit of this spot, so there is no earlier visit to compare with.',
      });
    }
    if (baselineId === currentInferenceId) {
      return res.status(400).json({ error: 'Pick two different visits to compare.' });
    }

    const baselineJob = await InferenceJob.findOne({ inferenceId: baselineId }).lean();
    if (!baselineJob) {
      return res.status(404).json({ error: 'Baseline inference job not found', inferenceId: baselineId });
    }
    if (baselineJob.company !== currentJob.company || baselineJob.project !== currentJob.project) {
      return res.status(400).json({ error: 'Both visits must belong to the same vessel.' });
    }

    return res.status(200).json({
      ...buildComparison(currentJob, baselineJob),
      defaultBaselineInferenceId: defaultBaselineId,
      observationId: currentJob.observationId || null,
      observationVisits: await loadObservationVisits(currentJob),
      review: publicReview(currentJob.review),
    });
  } catch (error) {
    console.error('[mobile-inspect] compare error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * PUT /api/mobile-inspect/review/:inferenceId
 * Body: { verdict: 'worse' | 'same' | 'better' | null, note?, comparedToInferenceId? }
 *
 * A reviewer's verdict on how this visit compares with an earlier one — the
 * "reviewer-confirmed deterioration" record. `verdict: null` clears it.
 */
const setVisitReview = async (req, res) => {
  try {
    const { inferenceId } = req.params;
    const job = await InferenceJob.findOne({ inferenceId });
    if (!job) {
      return res.status(404).json({ error: 'Inference job not found', inferenceId });
    }
    if (!canAccessAllWorkspaces(req.user)) {
      const access = validateWorkspaceAccess(req.user, job.company);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: access.error || 'You do not have access to this inference job',
        });
      }
    }

    const verdict = req.body?.verdict ?? null;
    if (verdict !== null && !['worse', 'same', 'better'].includes(verdict)) {
      return res.status(400).json({ error: 'Invalid verdict', message: "verdict must be 'worse', 'same', 'better' or null" });
    }

    job.review = verdict
      ? {
          verdict,
          note: String(req.body?.note || '').trim().slice(0, 1000),
          reviewedBy: req.user?.email || null,
          reviewedAt: new Date(),
          comparedToInferenceId: req.body?.comparedToInferenceId ? String(req.body.comparedToInferenceId) : null,
        }
      : null;
    await job.save();

    auditService.logAction({
      action: 'update',
      resourceType: 'inference',
      resourceId: job.inferenceId,
      details: {
        company: job.company,
        project: job.project,
        surveyName: job.surveyName,
        regionName: job.regionName,
        review: verdict ? { verdict, note: job.review.note } : null,
      },
      req,
    });

    return res.status(200).json({ inferenceId: job.inferenceId, review: publicReview(job.review) });
  } catch (error) {
    console.error('[mobile-inspect] review error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * GET /api/mobile-inspect/region-history?company=&project=&regionName=&componentName=&excludeSurveyName=
 *
 * Powers the mobile capture screen while naming a part:
 *  - `job`: the most recent COMPLETED job of this exact spot (area + component)
 *    from any survey other than `excludeSurveyName` — drives "surveyed before,
 *    resurvey instead?". Null if that spot has no earlier history.
 *  - `observation`: the matching observation (with its OBS-#### id), if any.
 *  - `observations`: every known spot in this area, so the app can offer the
 *    component names already in use (picking one = the same spot).
 */
const getLatestForRegion = async (req, res) => {
  try {
    const scope = await scopedCompanyProject(req, res);
    if (!scope) return;
    const { company, project } = scope;
    const regionName = String(req.query.regionName || '').trim();
    if (!regionName) {
      return res.status(400).json({ error: 'Missing required query parameter: regionName' });
    }
    const componentName = String(req.query.componentName || '').trim();
    const excludeSurveyName = String(req.query.excludeSurveyName || '').trim();
    const regionKey = normalizeKey(regionName);
    const componentKey = normalizeKey(componentName);

    const areaObservations = await Observation.find({ company, project, regionKey })
      .select('observationId componentName')
      .sort({ componentName: 1 })
      .lean();
    const observations = areaObservations.map((o) => ({
      observationId: o.observationId,
      componentName: o.componentName || '',
    }));
    const match = areaObservations.find((o) => normalizeKey(o.componentName) === componentKey) || null;

    const extra = { status: 'completed' };
    if (match) extra.observationId = match.observationId;
    else if (!componentKey) extra.regionName = regionName;
    const filter = inspectFilter(company, project, extra);
    if (excludeSurveyName) {
      filter.surveyName = { $nin: [null, '', excludeSurveyName] };
    }

    const job = match || !componentKey ? await InferenceJob.findOne(filter).sort({ createdAt: -1 }).lean() : null;
    const observation = match ? { observationId: match.observationId, componentName: match.componentName || '' } : null;
    if (!job) {
      return res.status(200).json({ job: null, observation, observations });
    }
    const corrosion = readCorrosionFromJob(job);
    return res.status(200).json({
      job: {
        inferenceId: job.inferenceId,
        surveyName: job.surveyName,
        createdAt: job.createdAt,
        observationId: job.observationId || null,
        componentName: job.componentName || '',
        meanCorrosionPercent: typeof corrosion?.meanCorrosionPercent === 'number' ? corrosion.meanCorrosionPercent : null,
      },
      observation,
      observations,
    });
  } catch (error) {
    console.error('[mobile-inspect] region-history error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * GET /api/mobile-inspect/observations?company=&project=
 *
 * Every observation (spot) on this vessel with its full inspection history
 * across surveys, newest first — the dashboard's "Observations" register.
 */
const listObservations = async (req, res) => {
  try {
    const scope = await scopedCompanyProject(req, res);
    if (!scope) return;
    const { company, project } = scope;

    const jobs = await InferenceJob.find(inspectFilter(company, project, { status: 'completed' }))
      .sort({ createdAt: -1 })
      .lean();
    const registry = await Observation.find({ company, project }).lean();
    const completedActions = await ActionItem.find({ company, project, status: 'completed', observationId: { $ne: null } })
      .select('observationId completedAt')
      .lean();
    const completionsByObservation = new Map();
    for (const a of completedActions) {
      if (!a.completedAt) continue;
      if (!completionsByObservation.has(a.observationId)) completionsByObservation.set(a.observationId, []);
      completionsByObservation.get(a.observationId).push(a.completedAt);
    }
    const registryById = new Map(registry.map((o) => [o.observationId, o]));

    const byObservation = new Map();
    for (const job of jobs) {
      const key = job.observationId || `region:${job.regionName}`;
      if (!byObservation.has(key)) byObservation.set(key, []);
      byObservation.get(key).push(job);
    }

    const observations = [...byObservation.entries()].map(([key, group]) => {
      const first = group[0];
      const reg = first.observationId ? registryById.get(first.observationId) : null;
      const kinds = labelBaselines(group, completionsByObservation.get(first.observationId) || []);
      const visits = group.map((job) => {
        const corrosion = readCorrosionFromJob(job);
        const pctValue = typeof corrosion?.meanCorrosionPercent === 'number' ? corrosion.meanCorrosionPercent : null;
        return {
          inferenceId: job.inferenceId,
          surveyName: job.surveyName,
          createdAt: job.createdAt,
          meanCorrosionPercent: pctValue,
          severityBand: deriveSeverityFromPercent(pctValue),
          imageCount: corrosion?.imageCount ?? job.progress?.totalImages ?? 0,
          inspectorName: job.inspectorName || null,
          notes: job.notes || '',
          assessment: job.assessment || null,
          baselineInferenceId: job.baselineInferenceId || null,
          previousInferenceId: job.previousInferenceId || null,
          baselineKind: kinds.get(job.inferenceId) || null,
          review: publicReview(job.review),
        };
      });
      const latestPct = visits[0].meanCorrosionPercent;
      const oldestPct = visits[visits.length - 1].meanCorrosionPercent;
      return {
        observationId: first.observationId || null,
        regionName: reg?.regionName || first.regionName,
        componentName: reg?.componentName ?? first.componentName ?? '',
        visitCount: visits.length,
        latestMeanCorrosionPercent: latestPct,
        severityBand: deriveSeverityFromPercent(latestPct),
        changeSinceFirst:
          visits.length > 1 && typeof latestPct === 'number' && typeof oldestPct === 'number'
            ? round4(latestPct - oldestPct)
            : null,
        lastInspectedAt: first.createdAt,
        lastInspector: first.inspectorName || null,
        visits,
      };
    });

    observations.sort(
      (a, b) =>
        String(a.observationId || 'zzz').localeCompare(String(b.observationId || 'zzz')) ||
        a.regionName.localeCompare(b.regionName)
    );
    return res.status(200).json({ observations, company, project });
  } catch (error) {
    console.error('[mobile-inspect] list observations error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

module.exports = {
  listMobileInspectSurveys,
  getMobileInspectSurvey,
  compareWithBaseline,
  setVisitReview,
  getLatestForRegion,
  listObservations,
  // Exported for reuse by the PDF export controller, so survey aggregation
  // logic lives in exactly one place.
  buildSurveyFromJobs,
  inspectFilter,
  resolveClassNamesForJobs,
  readMetadata,
  readCorrosionFromJob,
  buildComparison,
};
