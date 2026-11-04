const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const sharp = require('sharp');
const InferenceJob = require('../models/InferenceJob');
const PlaygroundReport = require('../models/PlaygroundReport');

/**
 * Playground test runs and reports.
 *
 * A Playground test (batch inference started by a Playground workspace) is short-lived:
 *  - "Close test" deletes its photos (results and uploads) and keeps the record, so the
 *    month's prediction count is unchanged
 *  - "Generate report" writes a PDF, and an Excel file and a CSV with every photo, then closes
 *    the test; they are kept for PLAYGROUND_REPORT_LIFETIME_MS
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
      photos.push({ file, path: path.join(dir, file), originalName: meta.originalName || file, found, classes, width: meta.imageWidth, height: meta.imageHeight });
    }
  }
  return photos;
}

/**
 * A name fit to show: file names that are stored ids (long hex strings, uuids) or hold one are left
 * out, so people only see the photo's number. A leading id or timestamp is dropped from the rest.
 */
const LONG_ID = /[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;
const readableName = (name) => {
  const text = String(name || '').trim().replace(/^\d{10,}[-_]/, '');
  return text && text.length <= 60 && !LONG_ID.test(text) ? text : '';
};

/** The student's own file name when the page sent it (held-out photos are stored under another name) */
const shownName = (info, p) => {
  const name = info.names?.[p.originalName] || info.names?.[p.file];
  return readableName(typeof name === 'string' ? name : p.originalName);
};

/** Totals for the report: photos, and for each kind of defect its count, photos and average confidence */
function summarise(photos) {
  const defects = new Map();
  for (const p of photos) {
    for (const c of p.classes) {
      const row = defects.get(c.name) || { name: c.name, count: 0, photos: 0, confidenceSum: 0, confidenceCount: 0 };
      row.count += c.count;
      row.photos += 1;
      if (c.confidence !== null) {
        row.confidenceSum += c.confidence * c.count;
        row.confidenceCount += c.count;
      }
      defects.set(c.name, row);
    }
  }
  const rows = [...defects.values()].sort((x, y) => y.count - x.count);
  const defectPhotos = photos.filter((p) => p.classes.length > 0).length;
  return {
    rows,
    total: photos.length,
    defectPhotos,
    goodPhotos: photos.length - defectPhotos,
    totalDefects: rows.reduce((sum, r) => sum + r.count, 0),
  };
}

/**
 * One photo for each kind of defect. Best is a photo showing only that defect, not used for another
 * one yet, where the model was most sure.
 */
function pickSamples(photos, rows) {
  const used = new Set();
  return rows.map((row) => {
    const score = (p) => {
      const own = p.classes.find((c) => c.name === row.name);
      return [p.classes.length === 1 ? 1 : 0, used.has(p) ? 0 : 1, own.confidence ?? 0];
    };
    const best = photos
      .filter((p) => p.classes.some((c) => c.name === row.name))
      .sort((x, y) => {
        const [a, b] = [score(x), score(y)];
        return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
      })[0];
    used.add(best);
    return { row, photo: best };
  });
}

/**
 * Write the PDF report for a finished test: a summary, one photo for each kind of defect, and a link
 * to the Excel file with every photo.
 * @param {object} job InferenceJob (lean or document)
 * @param {{ title: string, industry?: string|null, modelName?: string|null, labelled?: Record<string, string[]>, annexureUrl?: string, expiresAt?: Date }} info
 *   labelled: what the dataset labels say for held-out photos, by original file name
 *   annexureUrl: where the Excel file can be downloaded, until expiresAt
 * @returns {Promise<{ filePath: string, csvPath: string, excelPath: string, previewPath: string|null, sizeBytes: number, photos: number }>}
 */
async function writeReport(job, info) {
  const photos = await readResultPhotos(job);
  photos.forEach((p, i) => {
    p.number = i + 1;
  });
  const dir = path.join(REPORTS_DIR, job.company);
  await fsPromises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${job.inferenceId}.pdf`);

  const headerH = 96;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: headerH + 18, bottom: 40, left: 40, right: 40 },
    info: { Title: `${info.title} – test report`, Author: 'GSN Solutions' },
  });
  const out = fs.createWriteStream(filePath);
  doc.pipe(out);

  const W = doc.page.width - 80;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  // GSN brand colours, taken from the logo
  const brand = '#43209a';
  const ink = '#160952';
  const muted = '#5f5a7a';
  const line = '#dcd7f3';
  const soft = '#f6f4fe';
  const photoBg = '#efecfd';

  // On every page: logo and company on the left, product and document on the right, a line under them
  const drawHeader = () => {
    if (fs.existsSync(GSN_LOGO)) doc.image(GSN_LOGO, 40, 28, { fit: [84, 46], valign: 'center' });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(brand).text('GSN SOLUTIONS', 134, 34, { lineBreak: false });
    doc.font('Helvetica').fontSize(9.5).fillColor(muted).text('AI Visual Inspection', 134, 54, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(brand).text('VISION-M', 40, 36, { width: W, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(9.5).fillColor(brand).text('TEST REPORT', 40, 54, { width: W, align: 'right', lineBreak: false });
    doc.moveTo(40, headerH - 10).lineTo(40 + W, headerH - 10).lineWidth(1.2).strokeColor(brand).stroke();
    doc.x = 40;
    doc.y = doc.page.margins.top;
  };
  drawHeader();
  doc.on('pageAdded', drawHeader);

  const sectionTitle = (text, needed) => {
    if (doc.y + needed > bottom()) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(brand).text(text, 40, doc.y, { width: W });
    doc.y += 6;
  };

  // Title
  doc.font('Helvetica').fontSize(9.5).fillColor(muted).text('VISION-M / INSPECTION TEST', 40, doc.y, { width: W });
  doc.y += 4;
  doc.font('Helvetica-Bold').fontSize(24).fillColor(brand).text(info.title, 40, doc.y, { width: W });
  doc.y += 6;

  // Details
  const facts = [
    ...(info.industry ? [['Industry', info.industry]] : []),
    ['Model', readableName(info.modelName) || '—'],
    ['Tested on', job.sourceType === 'test_folder' ? 'Held-out test photos from the dataset' : 'Photos uploaded for this test'],
    ['Date', new Date(job.completedAt || job.createdAt || Date.now()).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })],
  ];
  doc.font('Helvetica').fontSize(10);
  for (const [k, v] of facts) {
    const y = doc.y;
    doc.fillColor(muted).text(k, 40, y, { width: 90 });
    doc.fillColor(ink).text(v, 130, y, { width: W - 90 });
    doc.y += 3;
  }
  doc.y += 12;

  // Summary
  const summary = summarise(photos);
  sectionTitle('Summary', 150);
  const tiles = [
    ['Photos tested', summary.total],
    ['Good photos', summary.goodPhotos],
    ['Photos with defects', summary.defectPhotos],
    ['Total defects found', summary.totalDefects],
  ];
  const tileGap = 8;
  const tileW = (W - tileGap * 3) / 4;
  const tileY = doc.y;
  tiles.forEach(([label, value], i) => {
    const x = 40 + i * (tileW + tileGap);
    doc.roundedRect(x, tileY, tileW, 54, 5).fill(soft);
    doc.font('Helvetica').fontSize(8).fillColor(muted).text(label, x + 9, tileY + 9, { width: tileW - 18, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(19).fillColor(ink).text(String(value), x + 9, tileY + 24, { width: tileW - 18, lineBreak: false });
  });
  doc.x = 40;
  doc.y = tileY + 54 + 14;

  // Each defect's count
  if (summary.rows.length) {
    const cols = [
      { label: 'Defect', x: 48, w: W - 250 },
      { label: 'Defects found', x: 40 + W - 240, w: 70, align: 'right' },
      { label: 'Photos', x: 40 + W - 160, w: 60, align: 'right' },
      { label: 'Avg. confidence', x: 40 + W - 90, w: 82, align: 'right' },
    ];
    const tableHeader = () => {
      const y = doc.y;
      doc.rect(40, y, W, 20).fill(brand);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff');
      for (const c of cols) doc.text(c.label, c.x, y + 6, { width: c.w, align: c.align || 'left', lineBreak: false });
      doc.x = 40;
      doc.y = y + 20;
    };
    if (doc.y + 42 > bottom()) doc.addPage();
    tableHeader();
    summary.rows.forEach((r, i) => {
      if (doc.y + 20 > bottom()) {
        doc.addPage();
        tableHeader();
      }
      const y = doc.y;
      if (i % 2 === 1) doc.rect(40, y, W, 20).fill(soft);
      const cells = [r.name, r.count, r.photos, r.confidenceCount ? `${Math.round((r.confidenceSum / r.confidenceCount) * 100)}%` : '—'];
      cols.forEach((c, ci) => {
        doc.font(ci === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(ink)
          .text(String(cells[ci]), c.x, y + 5.5, { width: c.w, align: c.align || 'left', height: 12, ellipsis: true });
      });
      doc.x = 40;
      doc.y = y + 20;
    });
    doc.moveTo(40, doc.y).lineTo(40 + W, doc.y).lineWidth(0.75).strokeColor(line).stroke();
    doc.y += 18;
  }

  // One photo for each kind of defect, two per row
  const colW = (W - 16) / 2;
  const imgH = colW * 0.66;
  const cardH = imgH + 44;
  if (summary.rows.length) {
    sectionTitle('A sample photo of each defect', cardH + 24);
    let col = 0;
    let rowTop = doc.y;
    for (const { row, photo } of pickSamples(photos, summary.rows)) {
      if (col === 0 && rowTop + cardH > bottom()) {
        doc.addPage();
        rowTop = doc.y;
      }
      const x = 40 + col * (colW + 16);
      try {
        const jpeg = await sharp(photo.path).resize({ width: 900, height: 600, fit: 'inside' }).jpeg({ quality: 76 }).toBuffer();
        doc.rect(x, rowTop, colW, imgH).fill(photoBg);
        doc.image(jpeg, x, rowTop, { fit: [colW, imgH], align: 'center', valign: 'center' });
      } catch {
        doc.rect(x, rowTop, colW, imgH).fill('#e2ddfb');
      }
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(ink).text(row.name, x, rowTop + imgH + 6, { width: colW, height: 13, ellipsis: true });
      const name = shownName(info, photo);
      const own = photo.classes.find((c) => c.name === row.name);
      const caption = [
        `Photo ${photo.number}`,
        `${own.count} found`,
        own.confidence !== null ? `${Math.round(own.confidence * 100)}% confidence` : null,
        name || null,
      ].filter(Boolean).join(' · ');
      doc.font('Helvetica').fontSize(8).fillColor(muted).text(caption, x, rowTop + imgH + 21, { width: colW, height: 10, ellipsis: true });
      col = (col + 1) % 2;
      if (col === 0) rowTop += cardH + 8;
    }
    doc.x = 40;
    doc.y = col === 0 ? rowTop : rowTop + cardH + 8;
  } else {
    doc.font('Helvetica').fontSize(10).fillColor(ink).text('No defects were found in the photos tested, so there are no sample photos.', 40, doc.y, { width: W });
    doc.y += 14;
  }

  // Annexure: the link to the Excel file
  if (info.annexureUrl) {
    sectionTitle('Annexure: all photos', 70);
    doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(
      `Every one of the ${summary.total} photos tested is in an Excel file, each with its picture, labels, defect counts and confidence.`,
      40, doc.y, { width: W }
    );
    doc.y += 5;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(brand).text('Download the full photo list (Excel)', 40, doc.y, { link: info.annexureUrl, underline: true, width: W });
    doc.y += 4;
    if (info.expiresAt) {
      const until = new Date(info.expiresAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
      doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(`This link works for 24 hours, until ${until}.`, 40, doc.y, { width: W });
    }
  }

  doc.end();
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  const { size } = await fsPromises.stat(filePath);
  const csvPath = await writeReportCsv(info, photos, summary.rows, path.join(dir, `${job.inferenceId}.csv`));
  const excelPath = await writeReportExcel(info, photos, summary.rows, path.join(dir, `${job.inferenceId}.xlsx`));
  const previewPath = await writePreview(photos[0], path.join(dir, `${job.inferenceId}.jpg`));
  return { filePath, csvPath, excelPath, previewPath, sizeBytes: size, photos: photos.length };
}

const csvCell = (v) => {
  const raw = v === null || v === undefined ? '' : String(v);
  // Excel would run a file name starting with these as a formula
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** One row per photo: what the model found, with a count for each defect and confidence, next to the dataset labels */
async function writeReportCsv(info, photos, defects, csvPath) {
  const labelledOf = (p) => info.labelled?.[p.originalName] || info.labelled?.[p.file];
  const hasLabels = photos.some(labelledOf);
  const rows = [[
    'Photo',
    'File name',
    'Result',
    'Model found',
    'Total defects',
    ...defects.map((d) => d.name),
    'Confidence',
    ...(hasLabels ? ['Labelled in the dataset'] : []),
    'Photo size',
  ]];
  for (const p of photos) {
    const labelled = labelledOf(p);
    rows.push([
      p.number,
      shownName(info, p),
      p.classes.length ? 'Defect' : 'Good',
      p.found.length ? p.found.join('; ') : 'nothing',
      p.classes.reduce((sum, c) => sum + c.count, 0),
      ...defects.map((d) => p.classes.find((c) => c.name === d.name)?.count ?? 0),
      p.classes
        .filter((c) => c.confidence !== null)
        .map((c) => `${c.name} ${Math.round(c.confidence * 100)}%`)
        .join('; '),
      ...(hasLabels ? [labelled ? (labelled.length ? labelled.map((l) => l.replace(/_/g, ' ')).join('; ') : 'nothing') : ''] : []),
      p.width && p.height ? `${p.width} x ${p.height}` : '',
    ]);
  }
  // BOM so Excel opens the file as UTF-8
  await fsPromises.writeFile(csvPath, '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'utf8');
  return csvPath;
}

/** Pictures in the Excel file: shown at this size in pixels, stored at twice that so zooming stays clear */
const EXCEL_PHOTO = { width: 200, height: 130 };
const EXCEL_PHOTO_WORKERS = 4;

/** Small JPEGs of all the photos, by photo. A photo that can't be read just has no picture. */
async function excelThumbnails(photos) {
  const thumbnails = new Map();
  let next = 0;
  const worker = async () => {
    while (next < photos.length) {
      const photo = photos[next++];
      try {
        thumbnails.set(photo, await sharp(photo.path)
          .resize({ width: EXCEL_PHOTO.width * 2, height: EXCEL_PHOTO.height * 2, fit: 'inside' })
          .jpeg({ quality: 70 })
          .toBuffer({ resolveWithObject: true }));
      } catch (err) {
        console.warn(`[playground] no picture for ${photo.file}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: EXCEL_PHOTO_WORKERS }, worker));
  return thumbnails;
}

/** One row per photo: the same as the CSV, with the labelled picture next to it */
async function writeReportExcel(info, photos, defects, excelPath) {
  const labelledOf = (p) => info.labelled?.[p.originalName] || info.labelled?.[p.file];
  const hasLabels = photos.some(labelledOf);
  const brand = 'FF43209A';

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GSN Solutions';
  const sheet = workbook.addWorksheet('All photos', { views: [{ state: 'frozen', ySplit: 1 }] });
  const columns = [
    { header: 'No.', width: 6 },
    { header: 'Photo', width: 30 },
    { header: 'File name', width: 28 },
    { header: 'Result', width: 9 },
    { header: 'Model found', width: 26 },
    { header: 'Total defects', width: 9 },
    ...defects.map((d) => ({ header: d.name, width: 10 })),
    { header: 'Confidence', width: 26 },
    ...(hasLabels ? [{ header: 'Labelled in the dataset', width: 26 }] : []),
    { header: 'Photo size', width: 13 },
  ];
  sheet.columns = columns;
  const lastColumn = sheet.getColumn(columns.length).letter;
  sheet.autoFilter = `A1:${lastColumn}1`;

  const header = sheet.getRow(1);
  header.height = 34;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brand } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });

  const thumbnails = await excelThumbnails(photos);
  photos.forEach((p, i) => {
    const labelled = labelledOf(p);
    const row = sheet.addRow([
      p.number,
      null,
      shownName(info, p),
      p.classes.length ? 'Defect' : 'Good',
      p.found.length ? p.found.join(', ') : 'nothing',
      p.classes.reduce((sum, c) => sum + c.count, 0),
      ...defects.map((d) => p.classes.find((c) => c.name === d.name)?.count ?? 0),
      p.classes
        .filter((c) => c.confidence !== null)
        .map((c) => `${c.name} ${Math.round(c.confidence * 100)}%`)
        .join(', '),
      ...(hasLabels ? [labelled ? (labelled.length ? labelled.map((l) => l.replace(/_/g, ' ')).join(', ') : 'nothing') : ''] : []),
      p.width && p.height ? `${p.width} x ${p.height}` : '',
    ]);
    // Row heights are in points, pictures in pixels: 3 points to 4 pixels, with a little room around
    row.height = (EXCEL_PHOTO.height * 3) / 4 + 8;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true, ...(typeof cell.value === 'number' ? { horizontal: 'center' } : {}) };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFDCD7F3' } } };
    });
    row.getCell(4).font = { bold: true, color: { argb: p.classes.length ? 'FFC0392B' : 'FF1E8449' } };

    const thumbnail = thumbnails.get(p);
    if (thumbnail) {
      const image = workbook.addImage({ buffer: thumbnail.data, extension: 'jpeg' });
      sheet.addImage(image, {
        tl: { col: 1.03, row: i + 1.05 },
        ext: { width: thumbnail.info.width / 2, height: thumbnail.info.height / 2 },
        editAs: 'oneCell',
      });
    }
  });

  await workbook.xlsx.writeFile(excelPath);
  return excelPath;
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

/** Delete a report's files (PDF, CSV, Excel, preview) */
async function removeReportFiles(report) {
  for (const file of [report.filePath, report.csvPath, report.excelPath, report.previewPath].filter(Boolean)) {
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

  const expired = await PlaygroundReport.find({ expiresAt: { $lte: now } }).select('_id filePath csvPath excelPath previewPath').lean();
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
