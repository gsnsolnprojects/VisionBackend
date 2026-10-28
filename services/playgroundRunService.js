const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const InferenceJob = require('../models/InferenceJob');
const PlaygroundReport = require('../models/PlaygroundReport');

/**
 * Playground test runs and reports.
 *
 * A Playground test (batch inference started by a Playground workspace) is short-lived:
 *  - "Close test" deletes its photos (results and uploads) and keeps the record, so the
 *    month's prediction count is unchanged
 *  - "Generate report" writes a PDF, then closes the test; the PDF is kept for
 *    PLAYGROUND_REPORT_LIFETIME_MS
 *  - tests left open close themselves PLAYGROUND_TEST_LIFETIME_MS after they started, and
 *    expired reports are deleted, by sweepPlayground() (run every few minutes by the server)
 */

const PLAYGROUND_TEST_LIFETIME_MS = 60 * 60 * 1000; // 1 hour
/**
 * Labels Playground customers never see: some GSN samples mark the whole part ("product") so the
 * model finds it in the frame, but it isn't a defect and confuses students. Predictions skip
 * them and sample label views leave them out; GSN's own workspace still sees them.
 */
const PLAYGROUND_HIDDEN_CLASSES = ['product'];
const classKey = (name) => String(name || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const HIDDEN_KEYS = new Set(PLAYGROUND_HIDDEN_CLASSES.map(classKey));
/** Whether a label name is hidden in the Playground */
const isPlaygroundHiddenClass = (name) => HIDDEN_KEYS.has(classKey(name));
const PLAYGROUND_REPORT_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours
const REPORTS_DIR = path.join(process.cwd(), 'reports', 'playground');
const GSN_LOGO = path.join(__dirname, '..', 'assets', 'gsn-logo.png');
const MAX_REPORT_PHOTOS = 120;

const isPlaygroundCustomer = (user) =>
  user?.access?.plan === 'playground' && String(user?.company || '').trim().toLowerCase() !== 'gsn';

/** Delete a test's photos (results and uploaded originals) and mark it closed */
async function closeRun(job) {
  const folders = [job.results?.resultsPath, job.customFolderPath].filter(Boolean);
  for (const folder of folders) {
    await fsPromises.rm(folder, { recursive: true, force: true }).catch((err) =>
      console.warn(`[playground] could not remove ${folder}: ${err.message}`)
    );
  }
  await InferenceJob.updateOne({ _id: job._id }, { $set: { closedAt: new Date(), autoCloseAt: null } });
}

/** The test's result photos with what the model found on each, from its metadata.json */
async function readResultPhotos(job) {
  const root = job.results?.resultsPath;
  if (!root) return [];
  let metadata = null;
  const metadataPath = job.results?.metadataPath || path.join(root, 'metadata.json');
  try {
    metadata = JSON.parse(await fsPromises.readFile(metadataPath, 'utf8'));
  } catch {
    // older results without metadata: photos only
  }
  const byName = new Map();
  for (const img of metadata?.images || metadata?.files || []) {
    const name = path.basename(img.filePath || img.filename || '');
    if (name) byName.set(name, img);
  }

  const photos = [];
  for (const folder of ['defect', 'good', 'annotated']) {
    const dir = path.join(root, folder);
    if (!fs.existsSync(dir)) continue;
    for (const file of (await fsPromises.readdir(dir)).sort()) {
      if (!/\.(jpe?g|png)$/i.test(file) || photos.some((p) => p.file === file)) continue;
      const meta = byName.get(file) || {};
      const classes = (meta.byClass || [])
        .filter((c) => (c.count ?? 1) > 0)
        .map((c) => ({
          name: String(c.class || c.className || '').replace(/_/g, ' '),
          count: c.count ?? 1,
          confidence: typeof c.avgConfidence === 'number' ? c.avgConfidence : null,
        }));
      const found = classes.map((c) => `${c.name}${c.count > 1 ? ` ×${c.count}` : ''}`);
      photos.push({ file, path: path.join(dir, file), originalName: meta.originalName || file, found, classes });
    }
  }
  return photos;
}

/**
 * Write the PDF report for a finished test.
 * @param {object} job InferenceJob (lean or document)
 * @param {{ title: string, industry?: string|null, modelName?: string|null, labelled?: Record<string, string[]> }} info
 *   labelled: what the dataset labels say for held-out photos, by original file name
 * @returns {Promise<{ filePath: string, csvPath: string, previewPath: string|null, sizeBytes: number, photos: number }>}
 */
async function writeReport(job, info) {
  const photos = (await readResultPhotos(job)).slice(0, MAX_REPORT_PHOTOS);
  const dir = path.join(REPORTS_DIR, job.company);
  await fsPromises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${job.inferenceId}.pdf`);

  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${info.title} – test report`, Author: 'Vision-M Playground' } });
  const out = fs.createWriteStream(filePath);
  doc.pipe(out);

  const W = doc.page.width - 80;
  // GSN brand colours, taken from the logo
  const brand = '#5432e9';
  const ink = '#160952';
  const muted = '#5f5a7a';
  const accent = brand;
  const photoBg = '#efecfd';

  // Cover block
  doc.rect(40, 40, W, 92).fill(brand);
  doc.fillColor('#d9d1ff').font('Helvetica-Bold').fontSize(9).text('VISION-M PLAYGROUND · TEST REPORT', 56, 56, { characterSpacing: 1.2 });
  doc.fillColor('#ffffff').fontSize(22).text(info.title, 56, 74, { width: W - 140 });
  if (info.industry) doc.fillColor('#e4ddff').font('Helvetica').fontSize(10).text(info.industry, 56, 106);
  // GSN logo on a white badge so its purple swirl stands apart from the purple block
  if (fs.existsSync(GSN_LOGO)) {
    doc.roundedRect(40 + W - 112, 58, 96, 56, 6).fill('#ffffff');
    doc.image(GSN_LOGO, 40 + W - 104, 64, { fit: [80, 44], align: 'center', valign: 'center' });
  }
  doc.y = 150;

  const totals = new Map();
  for (const p of photos) {
    for (const f of p.found) {
      const [name, count] = f.split(' ×');
      totals.set(name, (totals.get(name) || 0) + (Number(count) || 1));
    }
  }
  const facts = [
    ['Model', info.modelName || '—'],
    ['Tested on', job.sourceType === 'test_folder' ? 'Held-out test photos from the dataset' : 'Photos uploaded for this test'],
    ['Photos', String(photos.length)],
    ['Date', new Date(job.completedAt || job.createdAt || Date.now()).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })],
    ['What the model found', totals.size ? [...totals].map(([n, c]) => `${n} (${c})`).join(', ') : 'Nothing'],
  ];
  doc.font('Helvetica').fontSize(10);
  for (const [k, v] of facts) {
    const y = doc.y;
    doc.fillColor(muted).text(k, 40, y, { width: 130 });
    doc.fillColor(ink).text(v, 175, y, { width: W - 135 });
    doc.moveDown(0.5);
  }
  doc.moveDown(0.5);
  doc.fillColor(muted).fontSize(8.5).text(
    'Boxes on each photo show what the model found, with its confidence. For held-out photos, compare them with what is labelled in the dataset. Look at the misses and the extra finds: they show which examples to add before training again.',
    40, doc.y, { width: W }
  );
  doc.moveDown(1);

  // Photos, two per row
  const colW = (W - 16) / 2;
  const imgH = colW * 0.66;
  const cardH = imgH + 46;
  let col = 0;
  let rowTop = doc.y;
  for (const p of photos) {
    if (col === 0 && rowTop + cardH > doc.page.height - 50) {
      doc.addPage();
      rowTop = 40;
    }
    const x = 40 + col * (colW + 16);
    try {
      const jpeg = await sharp(p.path).resize({ width: 640, height: 430, fit: 'inside' }).jpeg({ quality: 72 }).toBuffer();
      doc.rect(x, rowTop, colW, imgH).fill(photoBg);
      doc.image(jpeg, x, rowTop, { fit: [colW, imgH], align: 'center', valign: 'center' });
    } catch {
      doc.rect(x, rowTop, colW, imgH).fill('#e2ddfb');
    }
    doc.font('Helvetica').fontSize(8).fillColor(muted).text(p.originalName, x, rowTop + imgH + 5, { width: colW, height: 10, ellipsis: true });
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(8.5).text('Model found: ', x, rowTop + imgH + 18, { continued: true, width: colW });
    doc.font('Helvetica').text(p.found.length ? p.found.join(', ') : 'nothing', { width: colW, height: 11, ellipsis: true });
    const labelled = info.labelled?.[p.originalName] || info.labelled?.[p.file];
    if (labelled) {
      doc.fillColor(accent).font('Helvetica-Bold').text('Labelled in the dataset: ', x, rowTop + imgH + 31, { continued: true, width: colW });
      doc.font('Helvetica').text(labelled.length ? labelled.map((l) => l.replace(/_/g, ' ')).join(', ') : 'nothing', { width: colW, height: 11, ellipsis: true });
    }
    col = (col + 1) % 2;
    if (col === 0) rowTop += cardH + 10;
  }

  doc.end();
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  const { size } = await fsPromises.stat(filePath);
  const csvPath = await writeReportCsv(info, photos, path.join(dir, `${job.inferenceId}.csv`));
  const previewPath = await writePreview(photos[0], path.join(dir, `${job.inferenceId}.jpg`));
  return { filePath, csvPath, previewPath, sizeBytes: size, photos: photos.length };
}

const csvCell = (v) => {
  const text = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** One row per photo: what the model found, with counts and confidence, next to the dataset labels */
async function writeReportCsv(info, photos, csvPath) {
  const rows = [['Photo', 'Model found', 'Total finds', 'Confidence', 'Labelled in the dataset']];
  for (const p of photos) {
    const labelled = info.labelled?.[p.originalName] || info.labelled?.[p.file];
    rows.push([
      p.originalName,
      p.found.length ? p.found.join('; ') : 'nothing',
      p.classes.reduce((sum, c) => sum + c.count, 0),
      p.classes
        .filter((c) => c.confidence !== null)
        .map((c) => `${c.name} ${Math.round(c.confidence * 100)}%`)
        .join('; '),
      labelled ? (labelled.length ? labelled.map((l) => l.replace(/_/g, ' ')).join('; ') : 'nothing') : '',
    ]);
  }
  // BOM so Excel opens the file as UTF-8
  await fsPromises.writeFile(csvPath, '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'utf8');
  return csvPath;
}

/** A small picture of the first result photo, for the reports list */
async function writePreview(photo, previewPath) {
  if (!photo) return null;
  try {
    await sharp(photo.path).resize({ width: 480, height: 320, fit: 'cover' }).jpeg({ quality: 70 }).toFile(previewPath);
    return previewPath;
  } catch {
    return null;
  }
}

/** Delete a report's files (PDF, CSV, preview) */
async function removeReportFiles(report) {
  for (const file of [report.filePath, report.csvPath, report.previewPath].filter(Boolean)) {
    await fsPromises.rm(file, { force: true }).catch(() => undefined);
  }
}

/** Close tests left open past their time and delete expired reports */
async function sweepPlayground() {
  const now = new Date();
  // Running tests get a little longer before they're closed regardless
  const due = await InferenceJob.find({
    autoCloseAt: { $ne: null, $lte: now },
    closedAt: null,
    $or: [
      { status: { $nin: ['queued', 'running'] } },
      { autoCloseAt: { $lte: new Date(now.getTime() - 2 * PLAYGROUND_TEST_LIFETIME_MS) } },
    ],
  })
    .select('_id inferenceId results customFolderPath')
    .lean();
  for (const job of due) await closeRun(job);

  const expired = await PlaygroundReport.find({ expiresAt: { $lte: now } }).select('_id filePath csvPath previewPath').lean();
  for (const report of expired) {
    await removeReportFiles(report);
    await PlaygroundReport.deleteOne({ _id: report._id });
  }
  if (due.length || expired.length) {
    console.log(`[playground] closed ${due.length} test(s), deleted ${expired.length} expired report(s)`);
  }
}

module.exports = {
  PLAYGROUND_TEST_LIFETIME_MS,
  PLAYGROUND_HIDDEN_CLASSES,
  isPlaygroundHiddenClass,
  PLAYGROUND_REPORT_LIFETIME_MS,
  isPlaygroundCustomer,
  closeRun,
  writeReport,
  removeReportFiles,
  sweepPlayground,
};
