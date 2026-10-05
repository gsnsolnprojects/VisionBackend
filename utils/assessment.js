/**
 * The inspector's own assessment of a surveyed part: a severity they confirm
 * (the AI's corrosion-% band is only a suggestion) plus any coating damage
 * types they see. Stored on the InferenceJob as `assessment`.
 */
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const DAMAGE_TAGS = ['peeling', 'cracking', 'blistering', 'exposed_metal'];

/**
 * Validates untrusted input. Returns `{ severity, damageTags }`, or null when
 * nothing usable was supplied (so callers can skip touching `assessment`).
 * Throws an Error with a user-facing message for an invalid severity.
 */
function normalizeAssessment(input) {
  if (!input || typeof input !== 'object') return null;
  const severity = input.severity === undefined || input.severity === null || input.severity === '' ? null : input.severity;
  if (severity !== null && !SEVERITIES.includes(severity)) {
    throw new Error(`severity must be one of: ${SEVERITIES.join(', ')}`);
  }
  const tags = Array.isArray(input.damageTags) ? [...new Set(input.damageTags.filter((t) => DAMAGE_TAGS.includes(t)))] : [];
  if (severity === null && tags.length === 0) return null;
  return { severity, damageTags: tags };
}

/** Same as normalizeAssessment but for a JSON string coming from a multipart field. */
function parseAssessmentField(raw) {
  if (!raw) return null;
  try {
    return normalizeAssessment(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

module.exports = { SEVERITIES, DAMAGE_TAGS, normalizeAssessment, parseAssessmentField };
