const fsPromises = require('fs').promises;
const path = require('path');
const sharp = require('sharp');

/**
 * Size rules for uploaded photos, from the plan's limits (null or missing = no rule):
 *  - maxImageSizeMB / minImageSizeKB: the file's size
 *  - minImageSide: the shorter side in pixels (smaller photos lose small defects when the model
 *    shrinks them to 640 px)
 *  - maxImageSide: the longer side in pixels
 * Used for dataset uploads and for photos uploaded to a test. The web app checks the same rules
 * before uploading; this is the check that can't be skipped.
 */

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const isImage = (file) => IMAGE_EXTENSIONS.has(path.extname(file.originalname || '').toLowerCase());

const hasRules = (limits = {}) =>
  ['maxImageSizeMB', 'minImageSizeKB', 'minImageSide', 'maxImageSide'].some((k) => typeof limits[k] === 'number');

/** Names of a few photos, for a message */
const listNames = (files) => {
  const names = files.slice(0, 3).map((f) => path.basename(f.originalname || 'photo')).join(', ');
  return files.length > 3 ? `${names} and ${files.length - 3} more` : names;
};

/**
 * Checks multer's uploaded files against the plan's rules. Returns null when every photo is fine,
 * or { message, code } for the first rule broken.
 */
async function checkImageFiles(files, limits = {}) {
  const images = (files || []).filter(isImage);
  if (!images.length || !hasRules(limits)) return null;
  const { maxImageSizeMB: maxMB, minImageSizeKB: minKB, minImageSide: minSide, maxImageSide: maxSide } = limits;

  if (typeof maxMB === 'number') {
    const tooBig = images.filter((f) => f.size > maxMB * 1024 * 1024);
    if (tooBig.length) return { message: `Photos can be up to ${maxMB} MB each. Too large: ${listNames(tooBig)}.`, code: 'plan_image_size' };
  }
  if (typeof minKB === 'number') {
    const tooSmall = images.filter((f) => f.size < minKB * 1024);
    if (tooSmall.length) {
      return { message: `Photos must be at least ${minKB} KB. Too small or damaged: ${listNames(tooSmall)}.`, code: 'plan_image_min_size' };
    }
  }
  if (typeof minSide === 'number' || typeof maxSide === 'number') {
    const unreadable = [];
    const small = [];
    const large = [];
    for (const f of images) {
      try {
        const source = f.path ? f.path : f.buffer;
        const { width, height } = await sharp(source).metadata();
        if (!width || !height) throw new Error('no size');
        if (typeof minSide === 'number' && Math.min(width, height) < minSide) small.push(f);
        if (typeof maxSide === 'number' && Math.max(width, height) > maxSide) large.push(f);
      } catch {
        unreadable.push(f);
      }
    }
    if (unreadable.length) return { message: `These photos couldn't be read: ${listNames(unreadable)}.`, code: 'plan_image_unreadable' };
    if (small.length) {
      return {
        message: `Photos need at least ${minSide} px on their shorter side. Too small: ${listNames(small)}.`,
        code: 'plan_image_min_side',
      };
    }
    if (large.length) {
      return {
        message: `Photos can be up to ${maxSide} px on their longer side. Too large: ${listNames(large)}.`,
        code: 'plan_image_max_side',
      };
    }
  }
  return null;
}

/** Deletes multer's temp files after a refused upload */
async function removeUploadedFiles(files) {
  await Promise.all((files || []).map((f) => (f.path ? fsPromises.unlink(f.path).catch(() => {}) : null)));
}

/**
 * Middleware for routes that take photos (after multer): refuses the upload if a photo breaks the
 * plan's rules, and deletes the uploaded files
 */
const enforceImageRules = async (req, res, next) => {
  try {
    const files = Array.isArray(req.files) ? req.files : req.files?.files || [];
    const problem = await checkImageFiles(files, req.user?.access?.limits || {});
    if (!problem) return next();
    await removeUploadedFiles(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat());
    return res.status(400).json({ error: problem.message, message: problem.message, code: problem.code });
  } catch (err) {
    return next(err);
  }
};

module.exports = { checkImageFiles, enforceImageRules, isImage };
