/**
 * Turns raw GpuServerSession records into real GPU switch-ons.
 *
 * - One boot can leave two records (the old and new worker container both note the same boot,
 *   with different host names). Records that start within MERGE_MS of each other are one switch-on.
 * - A record the worker never closed (server cut off before it could write its stop time) is not
 *   "on" forever: it is on only while its heartbeat is fresh; otherwise it ended at its last
 *   heartbeat (or last update for records from before heartbeats), marked as estimated.
 */

const MERGE_MS = 2 * 60 * 1000;
/** The worker beats every minute; this long without one means the server is off */
const STALE_MS = 5 * 60 * 1000;
/** A worker without heartbeats: its latest open record counts as on for this long at most */
const LEGACY_MAX_MS = 12 * 60 * 60 * 1000;

const ms = (d) => (d ? new Date(d).getTime() : null);

function switchOns(records, now = Date.now()) {
  const sorted = [...records].sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  const groups = [];
  for (const r of sorted) {
    const last = groups[groups.length - 1];
    if (last && ms(r.startedAt) - ms(last[0].startedAt) <= MERGE_MS) last.push(r);
    else groups.push([r]);
  }

  return groups.map((group, index) => {
    const newest = index === groups.length - 1;
    const pick = (field) => group.find((r) => r[field])?.[field] || null;
    let running = false;
    let end = null;
    let estimated = false;
    for (const r of group) {
      if (r.stoppedAt) {
        end = Math.max(end ?? 0, ms(r.stoppedAt));
        continue;
      }
      const seen = ms(r.lastSeenAt);
      if (seen ? now - seen < STALE_MS : newest && now - ms(r.startedAt) < LEGACY_MAX_MS) {
        // A fresh heartbeat, or (worker without heartbeats) the latest switch-on, started recently
        running = true;
      } else {
        const guess = seen || ms(r.updatedAt) || ms(r.startedAt);
        end = Math.max(end ?? 0, guess);
        estimated = true;
      }
    }
    const closedEnds = group.filter((r) => r.stoppedAt).length;
    const start = ms(group[0].startedAt);
    return {
      id: String(group[0]._id),
      ids: group.map((r) => String(r._id)),
      region: pick('region'),
      zone: pick('zone'),
      instanceType: pick('instanceType'),
      instanceId: pick('instanceId'),
      startedAt: group[0].startedAt,
      stoppedAt: running ? null : new Date(end ?? start),
      running,
      // Only a guess when no record of this switch-on wrote a real stop time
      endEstimated: !running && estimated && closedEnds === 0,
      endMs: running ? now : end ?? start,
    };
  });
}

module.exports = { switchOns, MERGE_MS, STALE_MS };
