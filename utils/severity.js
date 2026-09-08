/**
 * Fixed thresholds for auto-classifying a corrosion percentage into a
 * display severity band. This is purely an automatic classification for
 * showing a badge/color on the dashboard and PDF — independent from
 * ActionItem.severity, which a human sets deliberately when raising or
 * approving an action (and may intentionally differ from this band).
 */
const THRESHOLDS = [
  { max: 5, band: 'low' },
  { max: 15, band: 'medium' },
  { max: 30, band: 'high' },
  { max: Infinity, band: 'critical' },
];

/**
 * @param {number|null|undefined} pct - mean corrosion percentage
 * @returns {'low'|'medium'|'high'|'critical'|null} null if pct isn't a usable number
 */
function deriveSeverityFromPercent(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) return null;
  return THRESHOLDS.find((t) => pct < t.max).band;
}

module.exports = { deriveSeverityFromPercent };
