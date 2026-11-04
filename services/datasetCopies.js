const fs = require('fs').promises;
const path = require('path');
const Image = require('../models/Image');
const storageAdapter = require('./storageAdapter');
const { getLabelFilePath } = require('../utils/yoloConverter');

/**
 * A customer's extra training photos live inside their own dataset, so they only ever have one set.
 * A copy is known by its stored name: "board1_aug_3.jpg" is a copy of "board1.jpg".
 */

const COPY_NAME = /_aug_\d+\.[^.]+$/i;

const isCopyName = (name) => COPY_NAME.test(String(name || ''));

/** The stored name without extension of the photo a copy was made from */
const photoOfCopy = (name) => path.parse(String(name)).name.replace(/_aug_\d+$/i, '');

/**
 * Removes copies from disk, the photo index and the dataset's file list. The caller saves the dataset.
 * @param {Object} dataset - Dataset document
 * @param {string} [photo] - Only the copies of this photo (stored name without extension)
 * @returns {Promise<number>} Copies removed
 */
async function removeCopies(dataset, photo) {
  const filter = photo
    ? (name) => isCopyName(name) && photoOfCopy(name).toLowerCase() === photo.toLowerCase()
    : isCopyName;
  const root = storageAdapter.datasetRoot(dataset);
  const copies = (await Image.find({ datasetId: dataset._id, filename: COPY_NAME }).select('filename storedPath').lean())
    .filter((img) => filter(img.filename));
  for (const copy of copies) {
    for (const file of [copy.storedPath, getLabelFilePath(copy.storedPath)]) {
      await fs.unlink(path.join(root, file)).catch(() => undefined);
    }
  }
  if (copies.length) await Image.deleteMany({ _id: { $in: copies.map((c) => c._id) } });
  dataset.files = (dataset.files || []).filter((f) => !filter(f.storedName));
  return copies.length;
}

module.exports = { COPY_NAME, isCopyName, photoOfCopy, removeCopies };
