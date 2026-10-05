const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const InferenceJob = require('../models/InferenceJob');
const ActionItem = require('../models/ActionItem');
const { validateWorkspaceAccess, canAccessAllWorkspaces } = require('../utils/workspaceScoping');
const {
  buildSurveyFromJobs,
  buildComparison,
  inspectFilter,
  resolveClassNamesForJobs,
  readMetadata,
  readCorrosionFromJob,
} = require('./mobileInspectSurveyController');
const { attachResurveyFlags } = require('./actionItemController');
const { deriveSeverityFromPercent } = require('../utils/severity');
const { resolveInferenceImagePath } = require('../utils/resolveInferenceImagePath');
const auditService = require('../services/auditService');
const { getUserProfile } = require('../services/supabaseService');

const actionItemsDir = path.join(process.cwd(), 'uploads', 'action-items');

// ---------------------------------------------------------------- layout ---
const PAGE = { left: 40, right: 40, top: 62, bottom: 54 };
const CONTENT_W = 595.28 - PAGE.left - PAGE.right;

const C = {
  navy: '#0f172a',
  ink: '#1e293b',
  muted: '#64748b',
  line: '#e2e8f0',
  soft: '#f8fafc',
  accent: '#2563eb',
  good: '#16a34a',
  warn: '#d97706',
  bad: '#dc2626',
};

const SEVERITY_COLORS = {
  low: '#16a34a',
  medium: '#ca8a04',
  high: '#ea580c',
  critical: '#dc2626',
};

// Same palette/index as the overlay masks drawn on result photos.
const CLASS_COLORS = ['#e6c800', '#ff00ff', '#00b800', '#005aff', '#ff8c00', '#00b4c8', '#ff00b4', '#78c800'];

const DECISION_LABELS = {
  monitor: 'Monitor',
  inspect_further: 'Inspect further',
  repair: 'Repair',
  recoat: 'Recoat',
  replace: 'Replace',
};

const DAMAGE_LABELS = {
  peeling: 'Peeling',
  cracking: 'Cracking',
  blistering: 'Blistering',
  exposed_metal: 'Exposed metal',
};

const MAX_LATEST_PHOTOS = 6;
const MAX_PAIRS = 4;
const MAX_EXTRA_PHOTOS = 3;
const IMAGE_MAX_WIDTH = 700;
const CHANGE_EPSILON = 0.05;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- format ---
const pct = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(2)}%` : '-');
const signedPct = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%` : '-');
const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
const fmtDateTime = (d) =>
  d
    ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '-';
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const sevLabel = (band) => (band ? cap(band) : 'N/A');
const sevColor = (band) => SEVERITY_COLORS[band] || C.muted;
const flag = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
};

function changeColor(delta) {
  if (typeof delta !== 'number') return C.muted;
  if (delta > CHANGE_EPSILON) return C.bad;
  if (delta < -CHANGE_EPSILON) return C.good;
  return C.muted;
}

function changeWord(delta) {
  if (typeof delta !== 'number') return 'No comparison';
  if (delta > CHANGE_EPSILON) return 'Worsened';
  if (delta < -CHANGE_EPSILON) return 'Improved';
  return 'Unchanged';
}

/** The severity to show: the inspector's confirmed rating when there is one, otherwise the AI's corrosion-% band. */
const effSeverity = (p) => (p.assessment && p.assessment.severity) || p.severityBand;
const differsFromAi = (p) => !!(p.assessment && p.assessment.severity && p.severityBand && p.assessment.severity !== p.severityBand);

/** "Engine room > Fuel pump", or just the area when the spot has no component. */
const partLabel = (p) => (p.componentName ? `${p.regionName} > ${p.componentName}` : p.regionName);

// ---------------------------------------------------------------- data -----
function jobImages(job) {
  const metadata = readMetadata(job);
  if (!metadata) return [];
  const list = metadata.images || metadata.files || [];
  return list
    .filter((f) => !f.fileType || f.fileType === 'image')
    .map((f) => ({
      filename: path.basename(String(f.filePath || f.filename || '')),
      percent: typeof f.corrosionPercentTotal === 'number' ? f.corrosionPercentTotal : null,
    }))
    .filter((f) => f.filename);
}

/** Downscaled JPEG buffer of a result image, so the PDF stays a sensible size. */
async function imageBuffer(job, filename) {
  const resolved = job ? resolveInferenceImagePath(job, path.basename(filename)) : null;
  if (!resolved) return null;
  try {
    return await sharp(resolved.imagePath, { failOn: 'none' })
      .rotate()
      .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
  } catch (err) {
    console.warn(`[pdf-export] Could not read image ${filename}:`, err.message);
    return null;
  }
}

async function actionPhotoBuffer(actionId, filename) {
  const filePath = path.resolve(path.join(actionItemsDir, actionId, path.basename(filename)));
  if (!filePath.startsWith(path.resolve(actionItemsDir)) || !fs.existsSync(filePath)) return null;
  try {
    return await sharp(filePath, { failOn: 'none' })
      .rotate()
      .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** Supabase user ids -> email, falling back to the raw value (assignedTo can be free text). */
async function resolveUserLabels(ids) {
  const labels = new Map();
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  await Promise.all(
    unique.map(async (id) => {
      if (!UUID_RE.test(id)) {
        labels.set(id, id);
        return;
      }
      const profile = await getUserProfile(id);
      labels.set(id, profile?.email || `user ${id.slice(0, 8)}`);
    })
  );
  return (id) => (id ? labels.get(String(id)) || String(id) : '-');
}

function actionStatus(action) {
  if (action.status === 'completed') {
    return action.needsResurvey
      ? { label: 'Resolved - awaiting resurvey', color: C.warn, resolved: true }
      : { label: 'Resolved & confirmed', color: C.good, resolved: true };
  }
  return action.isOverdue
    ? { label: 'Open - overdue', color: C.bad, resolved: false }
    : { label: 'Open', color: C.accent, resolved: false };
}

// ---------------------------------------------------------------- drawing --
const maxY = (doc) => doc.page.height - doc.page.margins.bottom;

// Faint nautical watermarks, same icon family as the mobile app's login screen.
const ICON_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'MaterialCommunityIcons.ttf');
const ICON = {
  ferry: 0xf0213,
  wheel: 0xf0833,
  anchor: 0xf0031,
  waves: 0xf078d,
  compass: 0xf018c,
};

function drawIcon(doc, glyph, x, y, size, angle, color, opacity) {
  doc.save();
  doc.fillColor(color).fillOpacity(opacity);
  doc.rotate(angle, { origin: [x + size / 2, y + size / 2] });
  doc.font('mci').fontSize(size).text(String.fromCodePoint(glyph), x, y, { lineBreak: false });
  doc.restore();
}

/** Drawn as each page is created, so it always sits underneath the page content. */
function drawWatermark(doc, isCover) {
  if (!doc._iconFontReady) return;
  const savedX = doc.x;
  const savedY = doc.y;
  const W = doc.page.width;
  const H = doc.page.height;

  if (isCover) {
    // Soft slate icons on the white part of the cover (the navy band's light icons are drawn by drawCover, on top of the band).
    drawIcon(doc, ICON.ferry, W - 285, H - 225, 320, -8, '#64748b', 0.08);
    drawIcon(doc, ICON.wheel, -34, H - 235, 125, 12, '#64748b', 0.07);
    drawIcon(doc, ICON.anchor, 30, H - 120, 85, -15, '#64748b', 0.08);
    drawIcon(doc, ICON.waves, 130, H - 150, 32, 0, '#64748b', 0.09);
    drawIcon(doc, ICON.waves, 174, H - 128, 32, 0, '#64748b', 0.07);
  } else {
    drawIcon(doc, ICON.ferry, W - 260, H - 210, 280, -8, '#64748b', 0.07);
    drawIcon(doc, ICON.wheel, -38, H - 300, 130, 12, '#64748b', 0.06);
    drawIcon(doc, ICON.anchor, W - 96, 70, 80, 14, '#64748b', 0.06);
    drawIcon(doc, ICON.waves, 26, H - 130, 30, 0, '#64748b', 0.08);
  }

  doc.x = savedX;
  doc.y = savedY;
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > maxY(doc)) {
    doc.addPage();
    return true;
  }
  return false;
}

function heading(doc, text, { size = 13, gap = 6 } = {}) {
  ensureSpace(doc, size + gap + 24);
  doc.font('Helvetica-Bold').fontSize(size).fillColor(C.navy).text(text, PAGE.left, doc.y, { width: CONTENT_W });
  const y = doc.y + 2;
  doc.moveTo(PAGE.left, y).lineTo(PAGE.left + CONTENT_W, y).lineWidth(0.75).strokeColor(C.line).stroke();
  doc.y = y + gap;
  doc.x = PAGE.left;
}

function chip(doc, text, x, y, color, size = 7.5) {
  doc.font('Helvetica-Bold').fontSize(size);
  const w = doc.widthOfString(text) + 12;
  const h = size + 6;
  doc.save().roundedRect(x, y, w, h, h / 2).fillOpacity(0.12).fill(color).restore();
  doc.save().roundedRect(x, y, w, h, h / 2).lineWidth(0.8).strokeColor(color).stroke().restore();
  doc.fillColor(color).text(text, x + 6, y + 3.2, { lineBreak: false });
  return w;
}

function tile(doc, x, y, w, h, label, value, sub, color = C.navy) {
  doc.save().roundedRect(x, y, w, h, 6).fill(C.soft).restore();
  doc.save().roundedRect(x, y, w, h, 6).lineWidth(0.75).strokeColor(C.line).stroke().restore();
  doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(label.toUpperCase(), x + 10, y + 8, { width: w - 20, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(17).fillColor(color).text(value, x + 10, y + 21, { width: w - 20, lineBreak: false });
  if (sub) {
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(sub, x + 10, y + h - 15, { width: w - 20, lineBreak: false });
  }
}

/** Generic table with a repeating header row, zebra striping and single-line ellipsised cells. */
function table(doc, columns, rows, { rowH = 21, fontSize = 8.5 } = {}) {
  const drawHeader = () => {
    const y = doc.y;
    doc.save().rect(PAGE.left, y, CONTENT_W, 20).fill(C.navy).restore();
    let x = PAGE.left;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    for (const col of columns) {
      doc.text(col.label, x + 5, y + 6, { width: col.w - 10, align: col.align || 'left', lineBreak: false });
      x += col.w;
    }
    doc.y = y + 20;
  };

  ensureSpace(doc, 20 + rowH * 2);
  drawHeader();
  rows.forEach((row, i) => {
    if (doc.y + rowH > maxY(doc)) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    if (i % 2 === 1) doc.save().rect(PAGE.left, y, CONTENT_W, rowH).fill(C.soft).restore();
    let x = PAGE.left;
    columns.forEach((col, ci) => {
      const cell = row[ci];
      const text = typeof cell === 'object' && cell !== null ? cell.text : cell;
      const color = typeof cell === 'object' && cell !== null && cell.color ? cell.color : C.ink;
      const bold = typeof cell === 'object' && cell !== null && cell.bold;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(color);
      doc.text(String(text ?? '-'), x + 5, y + (rowH - fontSize) / 2 - 0.5, {
        width: col.w - 10,
        height: fontSize + 2,
        ellipsis: true,
        align: col.align || 'left',
      });
      x += col.w;
    });
    doc.y = y + rowH;
  });
  doc.moveTo(PAGE.left, doc.y).lineTo(PAGE.left + CONTENT_W, doc.y).lineWidth(0.75).strokeColor(C.line).stroke();
  doc.y += 8;
  doc.x = PAGE.left;
}

/** A framed image slot with a caption underneath. */
function photoCell(doc, buf, x, y, w, h, caption, captionColor = C.muted) {
  doc.save().rect(x, y, w, h).fill(C.soft).restore();
  if (buf) {
    try {
      doc.image(buf, x, y, { fit: [w, h], align: 'center', valign: 'center' });
    } catch (err) {
      console.warn('[pdf-export] Could not embed image:', err.message);
    }
  } else {
    doc.font('Helvetica').fontSize(8).fillColor(C.muted).text('Image unavailable', x, y + h / 2 - 4, { width: w, align: 'center', lineBreak: false });
  }
  doc.save().rect(x, y, w, h).lineWidth(0.75).strokeColor(C.line).stroke().restore();
  if (caption) {
    doc.font('Helvetica').fontSize(7.5).fillColor(captionColor).text(caption, x, y + h + 3, { width: w, align: 'center', lineBreak: false });
  }
}

async function photoGrid(doc, items, { cols = 3, cellH = 105, gap = 10 } = {}) {
  const cellW = (CONTENT_W - gap * (cols - 1)) / cols;
  for (let i = 0; i < items.length; i += cols) {
    ensureSpace(doc, cellH + 20);
    const y = doc.y;
    const row = items.slice(i, i + cols);
    row.forEach((item, ci) => {
      photoCell(doc, item.buf, PAGE.left + ci * (cellW + gap), y, cellW, cellH, item.caption);
    });
    doc.y = y + cellH + 20;
  }
  doc.x = PAGE.left;
}

// ---------------------------------------------------------------- sections -
function drawCover(doc, ctx) {
  const { survey, company, project, surveyName, preparedBy, summary, options } = ctx;

  doc.save().rect(0, 0, doc.page.width, 128).fill(C.navy).restore();
  if (doc._iconFontReady) {
    const W = doc.page.width;
    drawIcon(doc, ICON.wheel, W - 165, -22, 175, 14, '#ffffff', 0.08);
    drawIcon(doc, ICON.compass, W - 325, 34, 95, -10, '#ffffff', 0.06);
    drawIcon(doc, ICON.waves, W - 235, 84, 30, 0, '#ffffff', 0.09);
  }
  doc.font('Helvetica').fontSize(9).fillColor('#94a3b8').text('CORROSION CONDITION REPORT', PAGE.left, 34, { characterSpacing: 1.5 });
  doc.font('Helvetica-Bold').fontSize(25).fillColor('#ffffff').text(project, PAGE.left, 52, { width: CONTENT_W });
  doc.font('Helvetica').fontSize(11).fillColor('#cbd5e1').text(surveyName, PAGE.left, 88, { width: CONTENT_W });

  const metaY = 148;
  const meta = [
    ['Company', company],
    ['Vessel (project)', project],
    ['Survey', surveyName],
    ['Survey period', summary.periodLabel],
    ['Generated', fmtDateTime(new Date())],
    ['Prepared by', preparedBy],
  ];
  const colW = CONTENT_W / 2;
  meta.forEach(([label, value], i) => {
    const x = PAGE.left + (i % 2) * colW;
    const y = metaY + Math.floor(i / 2) * 30;
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(label.toUpperCase(), x, y, { width: colW - 10, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(String(value || '-'), x, y + 11, { width: colW - 12, height: 12, ellipsis: true });
  });

  // KPI tiles
  const ty = metaY + 3 * 30 + 12;
  const gap = 8;
  const tw = (CONTENT_W - gap * 3) / 4;
  const th = 62;
  tile(doc, PAGE.left, ty, tw, th, 'Overall corrosion', pct(survey.overallMeanCorrosionPercent), sevLabel(summary.overallBand) + ' severity', sevColor(summary.overallBand));
  tile(doc, PAGE.left + (tw + gap), ty, tw, th, 'Areas inspected', String(survey.partCount), `${survey.completedPartCount} completed`);
  tile(doc, PAGE.left + (tw + gap) * 2, ty, tw, th, 'Open issues', String(summary.openIssues), summary.overdueIssues ? `${summary.overdueIssues} overdue` : 'none overdue', summary.overdueIssues ? C.bad : C.navy);
  tile(doc, PAGE.left + (tw + gap) * 3, ty, tw, th, 'Resurveyed areas', String(summary.resurveyedAreas), summary.awaitingResurvey ? `${summary.awaitingResurvey} repair(s) unconfirmed` : 'vs earlier survey', summary.awaitingResurvey ? C.warn : C.navy);

  doc.y = ty + th + 18;
  doc.x = PAGE.left;

  // Severity distribution
  heading(doc, 'Severity distribution');
  const bands = ['low', 'medium', 'high', 'critical'];
  const total = bands.reduce((s, b) => s + summary.bandCounts[b], 0);
  const barY = doc.y;
  if (total > 0) {
    let x = PAGE.left;
    bands.forEach((b) => {
      const w = (summary.bandCounts[b] / total) * CONTENT_W;
      if (w > 0) doc.save().rect(x, barY, w, 14).fill(sevColor(b)).restore();
      x += w;
    });
  } else {
    doc.save().rect(PAGE.left, barY, CONTENT_W, 14).fill(C.line).restore();
  }
  let lx = PAGE.left;
  bands.forEach((b) => {
    doc.save().rect(lx, barY + 22, 8, 8).fill(sevColor(b)).restore();
    const label = `${cap(b)} (${summary.bandCounts[b]})`;
    doc.font('Helvetica').fontSize(8.5).fillColor(C.ink).text(label, lx + 12, barY + 21, { lineBreak: false });
    lx += 12 + doc.widthOfString(label) + 22;
  });
  doc.y = barY + 44;
  doc.x = PAGE.left;

  // Key findings
  heading(doc, 'Key findings');
  doc.font('Helvetica').fontSize(9.5).fillColor(C.ink);
  for (const finding of summary.findings) {
    ensureSpace(doc, 20);
    const y = doc.y;
    doc.save().circle(PAGE.left + 4, y + 5, 2).fill(C.accent).restore();
    doc.font('Helvetica').fontSize(9.5).fillColor(C.ink).text(finding, PAGE.left + 14, y, { width: CONTENT_W - 14 });
    doc.y += 3;
  }
  doc.x = PAGE.left;
  doc.moveDown(0.6);

  // Areas at a glance
  heading(doc, 'Areas at a glance');
  const columns = [
    { label: 'ID', w: 58 },
    { label: 'Area', w: 118 },
    { label: 'Corrosion', w: 58, align: 'right' },
    { label: 'Severity', w: 58 },
    { label: 'Change', w: 96 },
    { label: 'Photos', w: 40, align: 'right' },
    { label: 'Issues', w: CONTENT_W - 58 - 118 - 58 - 58 - 96 - 40 },
  ];
  const rows = ctx.partsSorted.map((entry) => {
    const { part } = entry;
    const openCount = entry.issues.filter((a) => !actionStatus(a).resolved).length;
    const resolvedCount = entry.issues.length - openCount;
    const issuesText = entry.issues.length
      ? [openCount ? `${openCount} open` : null, resolvedCount ? `${resolvedCount} resolved` : null].filter(Boolean).join(', ')
      : '-';
    return [
      { text: part.observationId || '-', color: C.muted },
      { text: partLabel(part), bold: true },
      pct(part.meanCorrosionPercent),
      { text: sevLabel(effSeverity(part)), color: sevColor(effSeverity(part)), bold: true },
      entry.change
        ? { text: `${signedPct(entry.change.delta)} ${entry.change.kind === 'baseline' ? '(resurvey)' : '(prev.)'}`, color: changeColor(entry.change.delta), bold: true }
        : { text: '-', color: C.muted },
      String(part.imageCount || 0),
      { text: issuesText, color: openCount ? C.accent : C.ink },
    ];
  });
  table(doc, columns, rows);

  doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(
    'Severity is the inspector\'s confirmed rating where one exists, otherwise the AI\'s band by corrosion %: Low below 5%  |  Medium 5-15%  |  High 15-30%  |  Critical 30% and above. ' +
      'Change compares with the explicit resurvey baseline when one exists, otherwise the most recent earlier survey of the same area.',
    PAGE.left,
    doc.y,
    { width: CONTENT_W }
  );
  doc.x = PAGE.left;
  if (!options.photos && !options.comparison) {
    doc.moveDown(0.4);
    doc.text('Photos were excluded from this export.', PAGE.left, doc.y, { width: CONTENT_W });
  }
}

async function drawIssue(doc, action, who, options) {
  const status = actionStatus(action);
  ensureSpace(doc, 90);
  const startY = doc.y;
  const x = PAGE.left + 10;
  const w = CONTENT_W - 10;

  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.navy).text(action.title, x, startY, { width: w });
  let cy = doc.y + 3;
  let cx = x;
  cx += chip(doc, cap(action.severity) + ' severity', cx, cy, sevColor(action.severity)) + 5;
  cx += chip(doc, status.label, cx, cy, status.color) + 5;
  if (action.decision) chip(doc, DECISION_LABELS[action.decision] || action.decision, cx, cy, C.accent);
  doc.y = cy + 17;

  const meta = [
    `Raised ${fmtDate(action.createdAt)} by ${who(action.createdBy)}`,
    action.surveyName ? `in "${action.surveyName}"` : null,
    action.dueDate ? `due ${fmtDate(action.dueDate)}` : null,
    action.assignedTo ? `assigned to ${who(action.assignedTo)}` : null,
  ].filter(Boolean).join('  |  ');
  doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(meta, x, doc.y, { width: w });
  doc.y += 3;

  const field = (label, value) => {
    if (!value) return;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink).text(`${label}: `, x, doc.y, { continued: true, width: w });
    doc.font('Helvetica').fillColor(C.ink).text(String(value), { width: w });
    doc.y += 2;
  };
  if (action.damageTags && action.damageTags.length) {
    field('Damage observed', action.damageTags.map((t) => DAMAGE_LABELS[t] || t).join(', '));
  }
  field('Description', action.description);
  field('Engineering recommendation', action.engineeringRecommendation);
  if (status.resolved) {
    field('Action taken', action.repairActionTaken || 'No details recorded.');
    field('Resolved', `${fmtDate(action.completedAt)} by ${who(action.approvedBy)}`);
    if (action.needsResurvey) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.warn).text('A confirming resurvey of this area is still pending.', x, doc.y, { width: w });
      doc.y += 2;
    }
  }
  field('Notes', action.reviewerNotes);

  if (options.photos && action.afterPhotos && action.afterPhotos.length) {
    const items = [];
    for (const filename of action.afterPhotos.slice(0, 3)) {
      const buf = await actionPhotoBuffer(action.actionId, filename);
      if (buf) items.push({ buf, caption: 'After repair' });
    }
    if (items.length) {
      ensureSpace(doc, 96);
      const y = doc.y + 2;
      items.forEach((item, i) => photoCell(doc, item.buf, x + i * 128, y, 118, 74, item.caption));
      doc.y = y + 92;
    }
  }

  const endY = doc.y;
  doc.save().rect(PAGE.left, startY, 3, Math.max(8, endY - startY - 2)).fill(status.color).restore();
  doc.y = endY + 6;
  doc.x = PAGE.left;
}

async function drawAreaPage(doc, entry, ctx) {
  const { part, job, comparison, baselineJob, change, issues } = entry;
  const { options, who } = ctx;

  doc.addPage();

  // Title row
  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(C.navy).text(partLabel(part), PAGE.left, top, { width: CONTENT_W - 130 });
  const band = effSeverity(part);
  if (band) {
    doc.font('Helvetica-Bold').fontSize(9);
    const label = `${sevLabel(band).toUpperCase()} SEVERITY`;
    const w = doc.widthOfString(label) + 20;
    doc.save().roundedRect(PAGE.left + CONTENT_W - w, top + 2, w, 20, 10).fill(sevColor(band)).restore();
    doc.fillColor('#ffffff').text(label, PAGE.left + CONTENT_W - w + 10, top + 8, { lineBreak: false });
  }
  doc.y = Math.max(doc.y, top + 24);
  const inspected = part.latestCompleted ? fmtDate(part.latestCompleted.completedAt || part.latestCompleted.createdAt) : null;
  const subtitle = [
    part.observationId ? `Observation ${part.observationId}` : null,
    inspected ? `Inspected ${inspected}` : 'No completed inspection yet',
    part.inspectorName ? `by ${part.inspectorName}` : null,
    `Survey: ${ctx.surveyName}`,
  ].filter(Boolean).join('  |  ');
  doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(subtitle, PAGE.left, doc.y + 2, { width: CONTENT_W });
  doc.y += 12;
  if (part.notes) {
    const noteH = doc.heightOfString(part.notes, { width: CONTENT_W - 20 }) + 12;
    ensureSpace(doc, noteH + 8);
    const ny = doc.y;
    doc.save().roundedRect(PAGE.left, ny, CONTENT_W, noteH, 4).fill('#fefce8').restore();
    doc.save().rect(PAGE.left, ny, 3, noteH).fill(C.warn).restore();
    doc.font('Helvetica').fontSize(9).fillColor(C.ink).text(part.notes, PAGE.left + 12, ny + 6, { width: CONTENT_W - 20 });
    doc.y = ny + noteH + 8;
    doc.x = PAGE.left;
  }

  // Metric tiles
  const ty = doc.y;
  const gap = 8;
  const tw = (CONTENT_W - gap * 2) / 3;
  const th = 58;
  tile(doc, PAGE.left, ty, tw, th, 'Corrosion', pct(part.meanCorrosionPercent), sevLabel(band) + ' severity', sevColor(band));
  tile(doc, PAGE.left + tw + gap, ty, tw, th, 'Photos analysed', String(part.imageCount || 0), part.visitCount > 1 ? `${part.visitCount} visits in this survey` : 'latest visit');
  if (change) {
    const rawSub = `${changeWord(change.delta)} vs ${change.kind === 'baseline' ? 'resurvey baseline' : 'previous survey'}`;
    tile(doc, PAGE.left + (tw + gap) * 2, ty, tw, th, 'Change', signedPct(change.delta), rawSub, changeColor(change.delta));
  } else {
    tile(doc, PAGE.left + (tw + gap) * 2, ty, tw, th, 'Change', '-', 'No earlier survey to compare', C.muted);
  }
  doc.y = ty + th + 12;
  doc.x = PAGE.left;

  // Inspector assessment
  {
    const a = part.assessment;
    const lines = [];
    if (a && (a.severity || (a.damageTags && a.damageTags.length))) {
      if (a.severity) {
        lines.push(
          `Confirmed severity: ${sevLabel(a.severity).toUpperCase()}` +
            (differsFromAi(part) ? `   (the AI suggested ${sevLabel(part.severityBand)})` : '   (matches the AI suggestion)')
        );
      }
      if (a.damageTags && a.damageTags.length) {
        lines.push(`Damage observed: ${a.damageTags.map((t) => DAMAGE_LABELS[t] || t).join(', ')}`);
      }
      lines.push(`Confirmed by ${a.assessedBy || 'the inspector'}${a.assessedAt ? ` on ${fmtDate(a.assessedAt)}` : ''}`);
    } else {
      lines.push('Not yet confirmed by an inspector - severity shown is the AI suggestion.');
    }
    const confirmed = !!(a && (a.severity || (a.damageTags && a.damageTags.length)));
    const boxColor = confirmed ? (differsFromAi(part) ? C.warn : C.good) : C.muted;
    const text = lines.join('\n');
    doc.font('Helvetica').fontSize(9);
    const h = doc.heightOfString(text, { width: CONTENT_W - 24 }) + 14;
    ensureSpace(doc, h + 8);
    const y = doc.y;
    doc.save().roundedRect(PAGE.left, y, CONTENT_W, h, 4).fillOpacity(0.07).fill(boxColor).restore();
    doc.save().rect(PAGE.left, y, 3, h).fill(boxColor).restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(boxColor).text('INSPECTOR ASSESSMENT', PAGE.left + 12, y + 5, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(C.ink).text(text, PAGE.left + 12, y + 16, { width: CONTENT_W - 24 });
    doc.y = y + h + 10 + 8;
    doc.x = PAGE.left;
  }

  // Reviewer verdict
  if (job && job.review && job.review.verdict) {
    const rv = job.review;
    const rvColor = rv.verdict === 'worse' ? C.bad : rv.verdict === 'better' ? C.good : C.muted;
    const rvTitle =
      rv.verdict === 'worse' ? 'CONFIRMED DETERIORATION' : rv.verdict === 'better' ? 'REVIEWED - IMPROVED' : 'REVIEWED - NO CHANGE';
    const rvText = `${rv.note ? rv.note + '\n' : ''}Reviewed by ${rv.reviewedBy || 'the reviewer'}${rv.reviewedAt ? ` on ${fmtDate(rv.reviewedAt)}` : ''}`;
    doc.font('Helvetica').fontSize(9);
    const rvH = doc.heightOfString(rvText, { width: CONTENT_W - 24 }) + 22;
    ensureSpace(doc, rvH + 8);
    const rvY = doc.y;
    doc.save().roundedRect(PAGE.left, rvY, CONTENT_W, rvH, 4).fillOpacity(0.07).fill(rvColor).restore();
    doc.save().rect(PAGE.left, rvY, 3, rvH).fill(rvColor).restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(rvColor).text(`REVIEWER: ${rvTitle}`, PAGE.left + 12, rvY + 5, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(C.ink).text(rvText, PAGE.left + 12, rvY + 16, { width: CONTENT_W - 24 });
    doc.y = rvY + rvH + 8;
    doc.x = PAGE.left;
  }

  // Class breakdown
  const classes = (part.byClass || []).filter((r) => (r.meanPercent ?? r.percent) != null);
  if (classes.length) {
    heading(doc, 'Corrosion breakdown by class', { size: 11 });
    const maxPct = Math.max(...classes.map((r) => r.meanPercent ?? r.percent ?? 0), 0.0001);
    for (const row of classes) {
      ensureSpace(doc, 16);
      const y = doc.y;
      const value = row.meanPercent ?? row.percent ?? 0;
      const color = CLASS_COLORS[(Number.isFinite(row.classId) ? row.classId : 0) % CLASS_COLORS.length];
      doc.save().roundedRect(PAGE.left, y + 1, 8, 8, 2).fill(color).restore();
      doc.font('Helvetica').fontSize(8.5).fillColor(C.ink).text(String(row.class || 'class'), PAGE.left + 14, y, { width: 96, lineBreak: false });
      doc.save().roundedRect(PAGE.left + 116, y + 1, 250, 8, 3).fill(C.line).restore();
      const bw = Math.max(2, (value / maxPct) * 250);
      doc.save().roundedRect(PAGE.left + 116, y + 1, bw, 8, 3).fill(color).restore();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink).text(pct(value), PAGE.left + 374, y, { width: 50, lineBreak: false });
      doc.font('Helvetica').fillColor(C.muted).text(`${row.count || 0} instance(s)`, PAGE.left + 428, y, { width: 87, lineBreak: false });
      doc.y = y + 15;
    }
    doc.y += 4;
    doc.x = PAGE.left;
  }

  // Issues
  heading(doc, `Issues & repair follow-up (${issues.length})`, { size: 11 });
  if (!issues.length) {
    doc.font('Helvetica').fontSize(9).fillColor(C.muted).text('No issues raised for this area.', PAGE.left, doc.y, { width: CONTENT_W });
    doc.y += 10;
  } else {
    for (const action of issues) await drawIssue(doc, action, who, options);
  }
  doc.x = PAGE.left;

  // Photos
  if (!job) return;
  if (comparison && options.comparison) {
    heading(doc, comparison.pairing === 'matched' ? 'Before / after (guided resurvey)' : 'Before / after (vs previous inspection)', { size: 11 });
    if (comparison.pairing !== 'matched') {
      doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(
        'This visit was not a guided resurvey, so photos are paired by the order they were taken and may not show exactly the same spot.',
        PAGE.left,
        doc.y,
        { width: CONTENT_W }
      );
      doc.y += 6;
    }
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(
      `Baseline: "${comparison.baseline.surveyName}" (${fmtDate(comparison.baseline.createdAt)}, ${pct(comparison.baseline.meanCorrosionPercent)})   ` +
        `Now: "${comparison.current.surveyName}" (${fmtDate(comparison.current.createdAt)}, ${pct(comparison.current.meanCorrosionPercent)})`,
      PAGE.left,
      doc.y,
      { width: CONTENT_W }
    );
    doc.y += 6;

    const pairW = (CONTENT_W - 12) / 2;
    if (comparison.pairs.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(C.muted).text('No photos were matched to the baseline photos.', PAGE.left, doc.y, { width: CONTENT_W });
      doc.y += 10;
    }
    for (const pair of comparison.pairs.slice(0, MAX_PAIRS)) {
      ensureSpace(doc, 150);
      const y = doc.y;
      const [before, after] = await Promise.all([
        options.photos ? imageBuffer(baselineJob, pair.baselineFilename) : null,
        options.photos ? imageBuffer(job, pair.currentFilename) : null,
      ]);
      photoCell(doc, before, PAGE.left, y, pairW, 118, `BEFORE  |  ${pct(pair.baselinePercent)}`);
      photoCell(doc, after, PAGE.left + pairW + 12, y, pairW, 118, `AFTER  |  ${pct(pair.currentPercent)}`);
      if (typeof pair.delta === 'number') {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(changeColor(pair.delta)).text(
          `${changeWord(pair.delta)} ${signedPct(pair.delta)}`,
          PAGE.left,
          y + 132,
          { width: CONTENT_W, align: 'center', lineBreak: false }
        );
      }
      doc.y = y + 150;
    }
    if (comparison.pairs.length > MAX_PAIRS) {
      doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(`${comparison.pairs.length - MAX_PAIRS} more matched pair(s) are available in the dashboard.`, PAGE.left, doc.y, { width: CONTENT_W });
      doc.y += 8;
    }
    const notes = [];
    if (comparison.extraCurrent.length) notes.push(`${comparison.extraCurrent.length} new photo(s) added this cycle`);
    if (comparison.unmatchedBaseline.length) notes.push(`${comparison.unmatchedBaseline.length} baseline photo(s) not re-photographed`);
    if (notes.length) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.ink).text(notes.join('  |  '), PAGE.left, doc.y, { width: CONTENT_W });
      doc.y += 8;
    }
    if (options.photos && comparison.extraCurrent.length) {
      const items = [];
      for (const img of comparison.extraCurrent.slice(0, MAX_EXTRA_PHOTOS)) {
        items.push({ buf: await imageBuffer(job, img.filename), caption: `NEW  |  ${pct(img.percent)}` });
      }
      await photoGrid(doc, items, { cols: 3, cellH: 90 });
    }
  } else if (options.photos) {
    const images = jobImages(job).slice(0, MAX_LATEST_PHOTOS);
    if (images.length) {
      heading(doc, `Latest photos (${images.length} of ${part.imageCount || images.length})`, { size: 11 });
      const items = [];
      for (const img of images) {
        items.push({ buf: await imageBuffer(job, img.filename), caption: pct(img.percent) });
      }
      await photoGrid(doc, items, { cols: 3, cellH: 105 });
    }
  }
}

function drawIssueRegister(doc, allIssues, who) {
  doc.addPage();
  heading(doc, 'Issue register', { size: 15, gap: 10 });
  if (!allIssues.length) {
    doc.font('Helvetica').fontSize(10).fillColor(C.muted).text('No issues have been raised for the areas in this survey.', PAGE.left, doc.y, { width: CONTENT_W });
    return;
  }
  const columns = [
    { label: 'Area / spot', w: 80 },
    { label: 'Issue', w: 132 },
    { label: 'Severity', w: 54 },
    { label: 'Status', w: 104 },
    { label: 'Due', w: 68 },
    { label: 'Owner', w: CONTENT_W - 80 - 132 - 54 - 104 - 68 },
  ];
  const rows = allIssues.map((a) => {
    const status = actionStatus(a);
    const person = status.resolved ? who(a.approvedBy) : a.assignedTo ? who(a.assignedTo) : '-';
    return [
      { text: a.componentName ? `${a.regionName} > ${a.componentName}` : a.regionName, bold: true },
      a.title,
      { text: cap(a.severity), color: sevColor(a.severity), bold: true },
      { text: status.label, color: status.color, bold: true },
      a.isOverdue ? { text: fmtDate(a.dueDate), color: C.bad, bold: true } : fmtDate(a.dueDate),
      person,
    ];
  });
  table(doc, columns, rows);
}

function drawAuditTrail(doc, logs, who) {
  doc.addPage();
  heading(doc, 'Audit trail', { size: 15, gap: 6 });
  doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text('Most recent recorded changes to issues raised for this vessel.', PAGE.left, doc.y, { width: CONTENT_W });
  doc.y += 8;
  if (!logs.length) {
    doc.font('Helvetica').fontSize(10).fillColor(C.muted).text('No audit entries recorded yet.', PAGE.left, doc.y, { width: CONTENT_W });
    return;
  }
  const columns = [
    { label: 'When', w: 100 },
    { label: 'User', w: 150 },
    { label: 'Action', w: 60 },
    { label: 'Detail', w: CONTENT_W - 100 - 150 - 60 },
  ];
  const rows = logs.map((log) => {
    const d = log.details || {};
    let detail = '';
    if (d.changedFields && d.changedFields.status) {
      const STATUS_TEXT = { completed: 'Resolved', rejected: 'Dismissed', approved: 'Approved (legacy step)', open: 'Reopened', in_review: 'In review' };
      const others = Object.keys(d.changedFields).filter((k) => k !== 'status');
      detail = `Status set to ${STATUS_TEXT[d.changedFields.status] || d.changedFields.status}${others.length ? `; also ${others.join(', ')}` : ''}`;
    } else if (d.changedFields) detail = `Updated ${Object.keys(d.changedFields).join(', ')}`;
    else if (d.addedAfterPhoto) detail = 'Added after-repair photo';
    else if (d.exportType) detail = `Exported ${String(d.exportType).toUpperCase()} report`;
    else if (d.regionName) detail = `${d.regionName}${d.severity ? ` (${d.severity})` : ''}`;
    return [fmtDateTime(log.timestamp), who(log.userId), cap(log.action), detail || '-'];
  });
  table(doc, columns, rows, { rowH: 19, fontSize: 8 });
}

function drawSignOff(doc, preparedBy) {
  ensureSpace(doc, 130);
  doc.y += 18;
  heading(doc, 'Sign-off', { size: 13 });
  const boxW = (CONTENT_W - 16) / 2;
  const y = doc.y + 4;
  const block = (x, title, name) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.navy).text(title, x, y, { width: boxW });
    if (name) doc.font('Helvetica').fontSize(9).fillColor(C.ink).text(name, x, y + 14, { width: boxW });
    [['Signature', 52], ['Date', 78]].forEach(([label, off]) => {
      doc.moveTo(x, y + 40 + off - 30).lineTo(x + boxW, y + 40 + off - 30).lineWidth(0.75).strokeColor(C.muted).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(label, x, y + 43 + off - 30, { lineBreak: false });
    });
  };
  block(PAGE.left, 'Prepared by', preparedBy);
  block(PAGE.left + boxW + 16, 'Reviewed / technically approved by', '');
  doc.y = y + 100;
  doc.x = PAGE.left;
}

/** Header/footer pass over every buffered page (needs the final page count). */
function decoratePages(doc, { project, surveyName }) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const savedBottom = doc.page.margins.bottom;
    const savedTop = doc.page.margins.top;
    doc.page.margins.bottom = 0;
    doc.page.margins.top = 0;

    if (i > 0) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.navy).text('Corrosion Condition Report', PAGE.left, 26, { lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(`${project}  |  ${surveyName}`, PAGE.left, 26, { width: CONTENT_W, align: 'right', lineBreak: false });
      doc.moveTo(PAGE.left, 40).lineTo(PAGE.left + CONTENT_W, 40).lineWidth(0.75).strokeColor(C.line).stroke();
    }

    const fy = doc.page.height - 34;
    doc.moveTo(PAGE.left, fy - 6).lineTo(PAGE.left + CONTENT_W, fy - 6).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(`Generated ${fmtDateTime(new Date())}`, PAGE.left, fy, { lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.left, fy, { width: CONTENT_W, align: 'right', lineBreak: false });

    doc.page.margins.bottom = savedBottom;
    doc.page.margins.top = savedTop;
  }
}

// ---------------------------------------------------------------- summary --
function buildSummary({ survey, partsSorted, allIssues }) {
  const bandCounts = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const { part } of partsSorted) if (effSeverity(part)) bandCounts[effSeverity(part)] += 1;

  const openIssues = allIssues.filter((a) => !actionStatus(a).resolved);
  const overdueIssues = openIssues.filter((a) => a.isOverdue);
  const awaiting = allIssues.filter((a) => a.status === 'completed' && a.needsResurvey);
  const resurveyedAreas = partsSorted.filter((e) => e.job && e.job.baselineInferenceId).length;

  const findings = [];
  const withPct = partsSorted.filter((e) => typeof e.part.meanCorrosionPercent === 'number');
  if (withPct.length) {
    const top = withPct[0].part;
    if (top.meanCorrosionPercent < 0.005) {
      findings.push('No corrosion was detected in the inspected photos of any area.');
    } else {
      findings.push(`${partLabel(top)} has the highest corrosion at ${pct(top.meanCorrosionPercent)} (${sevLabel(top.severityBand)} severity).`);
    }
    const hiCrit = withPct.filter((e) => ['high', 'critical'].includes(effSeverity(e.part)));
    if (hiCrit.length) findings.push(`${hiCrit.length} of ${withPct.length} areas are rated High or Critical: ${hiCrit.map((e) => partLabel(e.part)).join(', ')}.`);
    else findings.push('No area is rated High or Critical.');
  } else {
    findings.push('No completed inspections are available for this survey yet.');
  }
  const assessed = partsSorted.filter((e) => e.part.assessment && e.part.assessment.severity);
  if (partsSorted.length) {
    findings.push(`${assessed.length} of ${partsSorted.length} area(s) have a severity confirmed by an inspector.`);
  }
  const overridden = partsSorted.filter((e) => differsFromAi(e.part));
  if (overridden.length) {
    findings.push(`The inspector rated ${overridden.map((e) => `${partLabel(e.part)} ${sevLabel(effSeverity(e.part))}`).join(', ')} differently from the AI suggestion.`);
  }
  const confirmedWorse = partsSorted.filter((e) => e.job && e.job.review && e.job.review.verdict === 'worse');
  if (confirmedWorse.length) {
    findings.push(`Reviewer-confirmed deterioration: ${confirmedWorse.map((e) => partLabel(e.part)).join(', ')}.`);
  }
  const worse = partsSorted.filter((e) => e.change && e.change.delta > CHANGE_EPSILON);
  const better = partsSorted.filter((e) => e.change && e.change.delta < -CHANGE_EPSILON);
  if (worse.length) findings.push(`Worsened since the comparison point: ${worse.slice(0, 4).map((e) => `${partLabel(e.part)} (${signedPct(e.change.delta)})`).join(', ')}.`);
  if (better.length) findings.push(`Improved since the comparison point: ${better.slice(0, 4).map((e) => `${partLabel(e.part)} (${signedPct(e.change.delta)})`).join(', ')}.`);
  if (openIssues.length) findings.push(`${openIssues.length} open issue(s)${overdueIssues.length ? `, ${overdueIssues.length} overdue` : ''} - see the issue register.`);
  else findings.push('No open issues for the areas in this survey.');
  if (awaiting.length) findings.push(`${awaiting.length} resolved repair(s) still need a confirming resurvey: ${[...new Set(awaiting.map((a) => a.regionName))].join(', ')}.`);
  if (resurveyedAreas) findings.push(`${resurveyedAreas} of ${survey.partCount} area(s) in this survey are resurveys with a before/after comparison.`);

  const created = survey.createdAt ? fmtDate(survey.createdAt) : null;
  const updated = survey.updatedAt ? fmtDate(survey.updatedAt) : null;
  const periodLabel = created && updated ? (created === updated ? created : `${created} to ${updated}`) : created || updated || '-';

  return {
    bandCounts,
    overallBand: deriveSeverityFromPercent(survey.overallMeanCorrosionPercent),
    openIssues: openIssues.length,
    overdueIssues: overdueIssues.length,
    awaitingResurvey: awaiting.length,
    resurveyedAreas,
    findings,
    periodLabel,
  };
}

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * GET /api/mobile-inspect/survey/pdf?company=&project=&surveyName=
 *   &photos=true|false      include photos (default true)
 *   &comparison=true|false  include before/after resurvey comparison (default true)
 *   &audit=true|false       append the audit trail (default false)
 *
 * Streams a formatted condition report: executive summary, per-area pages
 * (corrosion, change vs baseline/previous survey, issues with repair
 * follow-up, photos or before/after pairs), issue register and sign-off.
 */
const exportSurveyPdf = async (req, res) => {
  try {
    const company = String(req.query.company || req.user?.company || '').trim();
    const project = String(req.query.project || '').trim();
    const surveyName = String(req.query.surveyName || '').trim();
    const options = {
      photos: flag(req.query.photos, true),
      comparison: flag(req.query.comparison, true),
      audit: flag(req.query.audit, false),
    };

    if (!company || !project || !surveyName) {
      return res.status(400).json({
        error: 'Missing required query parameters',
        required: ['company', 'project', 'surveyName'],
      });
    }

    if (!canAccessAllWorkspaces(req.user)) {
      const access = validateWorkspaceAccess(req.user, company);
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Permission denied',
          message: access.error || 'You do not have access to this workspace',
        });
      }
    }

    const jobs = await InferenceJob.find(inspectFilter(company, project, { surveyName }))
      .sort({ createdAt: -1 })
      .lean();

    if (!jobs.length) {
      return res.status(404).json({ error: 'Survey not found', company, project, surveyName });
    }

    const jobsById = new Map(jobs.map((j) => [j.inferenceId, j]));
    const classNames = await resolveClassNamesForJobs(jobs);
    const survey = buildSurveyFromJobs(surveyName, jobs, classNames);
    const regionSet = new Set(survey.parts.map((p) => p.regionName));
    const observationSet = new Set(survey.parts.map((p) => p.observationId).filter(Boolean));

    // Issues for this vessel's areas in this survey (any survey they were raised in), dismissed ones excluded.
    const rawActions = await ActionItem.find({ company, project }).sort({ createdAt: -1 }).lean();
    const now = Date.now();
    const relevant = rawActions
      .filter(
        (a) =>
          a.status !== 'rejected' &&
          (a.observationId ? observationSet.has(a.observationId) : a.regionName && regionSet.has(a.regionName))
      )
      .map((a) => ({
        ...a,
        isOverdue: !!(a.dueDate && new Date(a.dueDate).getTime() < now && a.status !== 'completed'),
      }));
    const allIssues = await attachResurveyFlags(relevant);

    let auditLogs = [];
    if (options.audit) {
      try {
        const result = await auditService.getAuditLogs({ company, project, resourceType: 'action_item', limit: 40 });
        auditLogs = result.logs || [];
      } catch (err) {
        console.warn('[pdf-export] audit trail unavailable:', err.message);
      }
    }

    const who = await resolveUserLabels([
      ...allIssues.flatMap((a) => [a.createdBy, a.approvedBy, a.assignedTo]),
      ...auditLogs.map((l) => l.userId),
    ]);

    // Per-area context: latest job, baseline comparison (or previous survey), issues.
    const partsSorted = await Promise.all(
      survey.parts.map(async (part) => {
        const job = part.latestCompleted ? jobsById.get(part.latestCompleted.inferenceId) : null;
        let comparison = null;
        let baselineJob = null;
        let change = null;

        if (job && job.baselineInferenceId) {
          baselineJob = await InferenceJob.findOne({ inferenceId: job.baselineInferenceId }).lean();
          if (baselineJob) {
            comparison = buildComparison(job, baselineJob);
            change = {
              kind: 'baseline',
              delta: comparison.overallDelta,
              fromSurvey: baselineJob.surveyName,
              fromDate: baselineJob.createdAt,
            };
          }
        }
        if (job && !comparison && job.previousInferenceId) {
          baselineJob = await InferenceJob.findOne({ inferenceId: job.previousInferenceId }).lean();
          if (baselineJob) {
            comparison = buildComparison(job, baselineJob);
            change = {
              kind: 'previous',
              delta: comparison.overallDelta,
              fromSurvey: baselineJob.surveyName,
              fromDate: baselineJob.createdAt,
            };
          }
        }
        if (job && !change) {
          const previous = await InferenceJob.findOne(
            inspectFilter(company, project, {
              ...(part.observationId ? { observationId: part.observationId } : { regionName: part.regionName }),
              status: 'completed',
              surveyName: { $nin: [null, '', surveyName] },
              createdAt: { $lt: job.createdAt },
            })
          )
            .sort({ createdAt: -1 })
            .lean();
          const previousPct = previous ? readCorrosionFromJob(previous)?.meanCorrosionPercent : null;
          if (previous && typeof previousPct === 'number' && typeof part.meanCorrosionPercent === 'number') {
            change = {
              kind: 'previous',
              delta: Math.round((part.meanCorrosionPercent - previousPct) * 10000) / 10000,
              fromSurvey: previous.surveyName,
              fromDate: previous.createdAt,
            };
          }
        }

        const issues = allIssues
          .filter((a) => (a.observationId && part.observationId ? a.observationId === part.observationId : a.regionName === part.regionName))
          .sort((a, b) => Number(actionStatus(a).resolved) - Number(actionStatus(b).resolved));
        return { part, job, baselineJob, comparison, change, issues };
      })
    );
    partsSorted.sort((a, b) => {
      const pa = typeof a.part.meanCorrosionPercent === 'number' ? a.part.meanCorrosionPercent : -1;
      const pb = typeof b.part.meanCorrosionPercent === 'number' ? b.part.meanCorrosionPercent : -1;
      if (pb !== pa) return pb - pa;
      return (SEVERITY_RANK[b.part.severityBand] || 0) - (SEVERITY_RANK[a.part.severityBand] || 0);
    });

    const summary = buildSummary({ survey, partsSorted, allIssues });
    const preparedBy = req.user?.email || who(req.user?.id) || 'unknown';

    const safeName = surveyName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'survey';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_report.pdf"`);

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.left, right: PAGE.right },
      bufferPages: true,
      info: {
        Title: `Corrosion Condition Report - ${project} - ${surveyName}`,
        Author: preparedBy,
        Subject: 'Corrosion survey condition report',
        Creator: 'Vision corrosion dashboard',
      },
    });
    doc.pipe(res);

    try {
      if (fs.existsSync(ICON_FONT_PATH)) {
        doc.registerFont('mci', ICON_FONT_PATH);
        doc._iconFontReady = true;
      }
    } catch (fontErr) {
      console.warn('[pdf-export] Icon font unavailable, skipping watermark:', fontErr.message);
    }
    drawWatermark(doc, true);
    doc.on('pageAdded', () => drawWatermark(doc, false));

    const ctx = { survey, company, project, surveyName, preparedBy, summary, options, partsSorted, who };

    drawCover(doc, ctx);
    for (const entry of partsSorted) {
      await drawAreaPage(doc, entry, ctx);
    }
    drawIssueRegister(doc, allIssues, who);
    if (options.audit) drawAuditTrail(doc, auditLogs, who);
    drawSignOff(doc, preparedBy);
    decoratePages(doc, { project, surveyName });

    doc.end();

    auditService.logAction({
      action: 'view',
      resourceType: 'action_item',
      resourceId: surveyName,
      details: { company, project, exportType: 'pdf', options },
      req,
    });
  } catch (error) {
    console.error('Error exporting survey PDF:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
    res.end();
  }
};

module.exports = { exportSurveyPdf };
