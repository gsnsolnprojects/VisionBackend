const mongoose = require('mongoose');

/**
 * One period the GPU training server was switched on (what AWS bills, including start-up and
 * idle minutes). Written by the training worker on the GPU server: opened when it starts,
 * closed when the server shuts down (SIGTERM).
 */
const gpuServerSessionSchema = new mongoose.Schema(
  {
    host: { type: String, required: true },
    startedAt: { type: Date, required: true, index: true },
    stoppedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GpuServerSession', gpuServerSessionSchema);
