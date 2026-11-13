const fs = require('fs');
const path = require('path');

/**
 * What a student waiting for a GPU is told: whether AWS has no GPU free right now, when we last tried
 * and when we try next, and about how long the run takes once a GPU is found.
 *
 * The server that starts the GPU (vision-gpu-dispatch, every 2 minutes, trying all 3 Mumbai zones)
 * touches this marker file each round AWS has no GPU to give, and removes it once one starts.
 */
const NO_GPU_MARKER = path.join(process.cwd(), '.gpu-no-capacity');
const TRY_EVERY_MS = 2 * 60 * 1000;
/** Older than this, the marker is left over from an earlier wait */
const MARKER_FRESH_MS = 5 * 60 * 1000;
/** Switching the GPU server on, before training starts */
const STARTUP_MINUTES = 3;

async function gpuWait(now = Date.now()) {
  const stat = await fs.promises.stat(NO_GPU_MARKER).catch(() => null);
  if (!stat || now - stat.mtimeMs >= MARKER_FRESH_MS) return { noGpuAvailable: false };
  const last = stat.mtimeMs;
  // The next round is 2 minutes after the last; if that's already past, it's happening now
  const next = Math.max(last + TRY_EVERY_MS, now);
  return {
    noGpuAvailable: true,
    gpuLastTryAt: new Date(last).toISOString(),
    gpuNextTryAt: new Date(next).toISOString(),
  };
}

/**
 * Rough minutes a run takes on the GPU once it starts, from past runs: 97 photos x 50 epochs took
 * about a minute, 292 photos x 20 epochs about a minute and a half. Bigger images and the Small
 * model take longer. Only a guide for the student; never shown as exact.
 */
function estimateTrainingMinutes({ photos, epochs, imgSize, modelSize }) {
  const n = Math.max(1, Number(photos) || 0);
  const e = Math.max(1, Number(epochs) || 50);
  const sizeFactor = ((Number(imgSize) || 640) / 640) ** 2;
  const modelFactor = String(modelSize || '').toLowerCase().startsWith('s') ? 2.2 : 1;
  const seconds = 40 + n * e * 0.013 * sizeFactor * modelFactor;
  return Math.max(1, Math.ceil(seconds / 60));
}

module.exports = { gpuWait, estimateTrainingMinutes, STARTUP_MINUTES, TRY_EVERY_MS };
