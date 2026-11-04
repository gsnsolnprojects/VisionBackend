const mongoose = require('mongoose');

/**
 * A badge a student has earned in the Playground (services/playgroundBadgeService.js). The reward
 * stays even if the level is started over; resetting or deleting the company removes it.
 */
const playgroundBadgeSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    /** Which badge, as listed in the web app's badge list */
    badge: { type: String, required: true },
    /** The level's mission it was earned on */
    mission: { type: String, default: null },
    /** What earned it, for example "82% match" */
    detail: { type: String, default: null },
    /** When the student was shown it; null means its award card is still to come */
    seenAt: { type: Date, default: null },
  },
  { timestamps: true }
);

playgroundBadgeSchema.index({ userId: 1, company: 1, badge: 1 }, { unique: true });

module.exports = mongoose.model('PlaygroundBadge', playgroundBadgeSchema);
