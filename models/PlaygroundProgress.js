const mongoose = require('mongoose');

/**
 * A Playground company's progress along the challenge path (services/playgroundProgressService.js):
 * when it finished the guided challenge and label practice. Once set, a step stays done even if
 * the project behind it is deleted.
 */
const playgroundProgressSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, unique: true },
    guidedDoneAt: { type: Date, default: null },
    practiceDoneAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PlaygroundProgress', playgroundProgressSchema);
