const path = require('path');
const fs = require('fs').promises;
const GpuServerSession = require('../models/GpuServerSession');
const TrainingJob = require('../models/TrainingJob');
const { GPU_REGIONS, TRACKED_REGIONS, regionName, inrPerHour } = require('../utils/gpuRegions');

/**
 * GET /api/admin/gpu?days=30   (superadmin only)
 *
 * Where and when our GPU training server ran: every switch-on with its AWS region and zone,
 * how long it was on (what AWS bills), its cost and the trainings it ran; totals per zone;
 * the dispatcher's attempts (which zone it tried, full or started) and the hourly
 * spare-GPU scores per region. The last two come from files the main server's timers write
 * into gpu-tracking/ (see deploy/vision-gpu-dispatch.sh and deploy/vision-gpu-capacity.sh).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TRACKING_DIR = path.join(process.cwd(), 'gpu-tracking');
/** A score this high means AWS has GPUs to spare there */
const EASY_SCORE = 7;
/** Only the end of a long log file is read */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

const round1 = (n) => Math.round(n * 10) / 10;

/** Lines of a JSON-lines file written since `sinceMs` (missing file = none) */
async function readJsonl(file, sinceMs) {
  let text;
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - MAX_LOG_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the cut-off first line
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (new Date(row.at).getTime() >= sinceMs) rows.push(row);
    } catch {
      // a half-written or broken line: skip it
    }
  }
  return rows;
}

const getGpuUsage = async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const now = Date.now();
    const since = new Date(now - days * DAY_MS);

    // Switch-ons in the window (and one still on)
    const servers = await GpuServerSession.find({ $or: [{ startedAt: { $gte: since } }, { stoppedAt: null }] })
      .sort({ startedAt: -1 })
      .limit(500)
      .lean();

    // Trainings each one ran: linked directly since 16 Nov 2026, by time for older records
    const linked = await TrainingJob.find({ gpuSessionId: { $in: servers.map((s) => s._id) } })
      .select('jobId company project modelType modelSize status startedAt completedAt gpuSessionId gpuZone')
      .lean();
    const byTime = await TrainingJob.find({ device: 'gpu', gpuSessionId: null, startedAt: { $gte: since } })
      .select('jobId company project modelType modelSize status startedAt completedAt')
      .lean();

    const sessions = servers.map((s) => {
      const start = new Date(s.startedAt).getTime();
      const end = s.stoppedAt ? new Date(s.stoppedAt).getTime() : now;
      const minutes = round1(Math.max(0, end - start) / 60000);
      const jobs = [
        ...linked.filter((j) => String(j.gpuSessionId) === String(s._id)),
        ...byTime.filter((j) => {
          const t = new Date(j.startedAt).getTime();
          return t >= start && t <= end;
        }),
      ].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
      return {
        id: String(s._id),
        region: s.region || null,
        regionName: s.region ? regionName(s.region) : null,
        zone: s.zone || null,
        instanceType: s.instanceType || null,
        instanceId: s.instanceId || null,
        startedAt: s.startedAt,
        stoppedAt: s.stoppedAt,
        running: !s.stoppedAt,
        minutes,
        costInr: Math.round((minutes / 60) * inrPerHour(s.region)),
        trainings: jobs.map((j) => ({
          id: j.jobId,
          company: j.company,
          project: j.project,
          model: [j.modelType, j.modelSize].filter(Boolean).join(' '),
          status: j.status,
          startedAt: j.startedAt || null,
          completedAt: j.completedAt || null,
        })),
      };
    });

    // Totals per zone (records from before zones were noted are grouped as unknown)
    const zoneMap = new Map();
    for (const s of sessions) {
      const key = s.zone || 'unknown';
      const z = zoneMap.get(key) || {
        zone: s.zone,
        region: s.region,
        regionName: s.regionName,
        switchOns: 0,
        minutes: 0,
        costInr: 0,
        trainings: 0,
      };
      z.switchOns += 1;
      z.minutes = round1(z.minutes + s.minutes);
      z.costInr += s.costInr;
      z.trainings += s.trainings.length;
      zoneMap.set(key, z);
    }
    const zones = [...zoneMap.values()].sort((a, b) => b.minutes - a.minutes);

    // Last 7 days of dispatcher attempts and availability checks
    const weekAgo = now - 7 * DAY_MS;
    const [attempts, checks] = await Promise.all([
      readJsonl(path.join(TRACKING_DIR, 'dispatch.jsonl'), weekAgo),
      readJsonl(path.join(TRACKING_DIR, 'capacity.jsonl'), weekAgo),
    ]);

    const attemptMap = new Map();
    for (const a of attempts) {
      const key = a.zone || a.region;
      const row = attemptMap.get(key) || {
        zone: a.zone || null,
        region: a.region,
        regionName: regionName(a.region),
        tries: 0,
        started: 0,
        full: 0,
        errors: 0,
      };
      row.tries += 1;
      if (a.result === 'started') row.started += 1;
      else if (a.result === 'full') row.full += 1;
      else row.errors += 1;
      attemptMap.set(key, row);
    }

    const regionScores = Object.entries(TRACKED_REGIONS).map(([region, name]) => {
      const scores = checks.map((c) => c.scores?.[region]).filter((v) => typeof v === 'number');
      const latest = [...checks].reverse().find((c) => typeof c.scores?.[region] === 'number');
      return {
        region,
        name,
        isOurs: Boolean(GPU_REGIONS[region]),
        checks: scores.length,
        average: scores.length ? round1(scores.reduce((sum, v) => sum + v, 0) / scores.length) : null,
        easyPercent: scores.length ? Math.round((scores.filter((v) => v >= EASY_SCORE).length / scores.length) * 100) : null,
        latest: latest ? latest.scores[region] : null,
      };
    });

    res.json({
      days,
      regions: Object.entries(GPU_REGIONS).map(([region, r]) => ({ region, name: r.name, inrPerHour: inrPerHour(region) })),
      totals: {
        switchOns: sessions.length,
        minutes: round1(sessions.reduce((sum, s) => sum + s.minutes, 0)),
        costInr: sessions.reduce((sum, s) => sum + s.costInr, 0),
        trainings: sessions.reduce((sum, s) => sum + s.trainings.length, 0),
      },
      sessions,
      zones,
      dispatch: {
        summary: [...attemptMap.values()],
        recent: attempts.slice(-200).reverse(),
      },
      availability: {
        easyScore: EASY_SCORE,
        firstCheckAt: checks[0]?.at || null,
        lastCheckAt: checks[checks.length - 1]?.at || null,
        regions: regionScores.sort((a, b) => (b.average ?? -1) - (a.average ?? -1)),
        checks: checks.map((c) => ({ at: c.at, scores: c.scores })),
      },
    });
  } catch (error) {
    console.error('[admin] GPU usage failed:', error);
    res.status(500).json({ error: 'Could not load GPU usage', message: error.message });
  }
};

module.exports = { getGpuUsage };
