const mongoose = require('mongoose');

/**
 * Superadmin settings for a Playground industry ("world"), keyed by the industry id the web app uses
 * (electronics, food, automotive, pharma, plastics, textiles). For now: how hard it is, shown as a
 * small bar on the industry card. null = no bar.
 */
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const playgroundIndustrySettingSchema = new mongoose.Schema(
  {
    industryId: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    difficulty: { type: String, enum: [...DIFFICULTIES, null], default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PlaygroundIndustrySetting', playgroundIndustrySettingSchema);
module.exports.DIFFICULTIES = DIFFICULTIES;
