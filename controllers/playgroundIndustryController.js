const PlaygroundIndustrySetting = require('../models/PlaygroundIndustrySetting');
const { DIFFICULTIES } = require('../models/PlaygroundIndustrySetting');

/** Industry ids: letters, numbers, - and _ (the web app's ids, e.g. "food") */
const INDUSTRY_ID = /^[a-z0-9_-]{1,40}$/;

/** Starting levels, used until the superadmin sets one (agreed 19 Nov 2026) */
const DEFAULT_DIFFICULTY = {
  food: 'easy',
  electronics: 'medium',
  automotive: 'medium',
  pharma: 'medium',
  plastics: 'hard',
  textiles: 'hard',
};

/** { [industryId]: { difficulty } }: saved settings, the defaults for the rest */
async function loadSettings() {
  const rows = await PlaygroundIndustrySetting.find({}).select('industryId difficulty').lean();
  const settings = Object.fromEntries(Object.entries(DEFAULT_DIFFICULTY).map(([id, difficulty]) => [id, { difficulty }]));
  for (const r of rows) settings[r.industryId] = { difficulty: r.difficulty || null };
  return settings;
}

/**
 * GET /api/playground/industries
 * GET /api/admin/playground/industries
 * The Playground cards and the superadmin tab read the same settings.
 */
const getIndustrySettings = async (req, res) => {
  try {
    res.json({ industries: await loadSettings(), difficulties: DIFFICULTIES });
  } catch (error) {
    console.error('Error loading Playground industry settings:', error);
    res.status(500).json({ error: 'Could not load industry settings', message: error.message });
  }
};

/**
 * PUT /api/admin/playground/industries/:industryId  { difficulty: 'easy' | 'medium' | 'hard' | null }
 * Superadmin only (the admin router checks it).
 */
const setIndustryDifficulty = async (req, res) => {
  try {
    const industryId = String(req.params.industryId || '').trim().toLowerCase();
    if (!INDUSTRY_ID.test(industryId)) return res.status(400).json({ error: 'Unknown industry' });
    const raw = req.body?.difficulty;
    const difficulty = raw === null || raw === '' || raw === undefined ? null : String(raw).toLowerCase();
    if (difficulty !== null && !DIFFICULTIES.includes(difficulty)) {
      return res.status(400).json({ error: `Difficulty must be one of ${DIFFICULTIES.join(', ')}, or empty` });
    }
    await PlaygroundIndustrySetting.updateOne(
      { industryId },
      { $set: { difficulty, updatedBy: req.user?.email || null } },
      { upsert: true }
    );
    res.json({ industryId, difficulty });
  } catch (error) {
    console.error('Error saving Playground industry difficulty:', error);
    res.status(500).json({ error: 'Could not save the difficulty', message: error.message });
  }
};

module.exports = { getIndustrySettings, setIndustryDifficulty };
