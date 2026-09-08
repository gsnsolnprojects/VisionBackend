const fs = require('fs');
const path = require('path');

/**
 * Finds a result image/video file on disk for a completed inference job.
 * Searches `good/` then `defect/` then `annotated/` (for backward
 * compatibility with jobs from before the good/defect split), unless a
 * specific `folder` is requested.
 *
 * Shared by `getAnnotatedImage` (GET /api/inference/:inferenceId/image/:filename)
 * and the PDF export generator, so there's exactly one place that knows how
 * result images are laid out on disk.
 *
 * @param {Object} inferenceJob - InferenceJob document (or .lean() object)
 * @param {string} filename
 * @param {string} [folder] - 'good' | 'defect' to force one folder
 * @returns {{ imagePath: string, basePath: string } | null}
 */
function resolveInferenceImagePath(inferenceJob, filename, folder) {
  const results = inferenceJob?.results;
  if (!results) return null;

  let searchPaths;
  if (folder === 'good' && results.goodImagesPath) {
    searchPaths = [results.goodImagesPath];
  } else if (folder === 'defect' && results.defectImagesPath) {
    searchPaths = [results.defectImagesPath];
  } else {
    searchPaths = [results.goodImagesPath, results.defectImagesPath, results.annotatedImagesPath].filter(Boolean);
  }

  for (const basePath of searchPaths) {
    const candidate = path.join(basePath, filename);
    if (fs.existsSync(candidate)) {
      // Prevent directory traversal via a crafted filename.
      const resolvedPath = path.resolve(candidate);
      const resolvedBasePath = path.resolve(basePath);
      if (!resolvedPath.startsWith(resolvedBasePath)) continue;
      return { imagePath: candidate, basePath };
    }
  }

  return null;
}

module.exports = { resolveInferenceImagePath };
