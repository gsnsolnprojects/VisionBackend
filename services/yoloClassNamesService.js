const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { spawn } = require('child_process');
const storageAdapter = require('./storageAdapter');
const { resolveModelCheckpointPath } = require('./resolveModelCheckpoint');

/**
 * Resolve ordered YOLO class label strings for a trained model (same strings as inference `class` field).
 *
 * Priority:
 * 1. Ultralytics checkpoint (best.pt) — same artifact inference loads
 * 2. class-mapping.json or data.yaml next to model.storagePath
 * 3. class-mapping.json or data.yaml on the training dataset root (company/project/datasetVersion)
 *
 * @param {object} model - Lean Model doc (or subset with company, project, datasetVersion, storagePath, bestCheckpointPath)
 * @returns {Promise<string[]>}
 */
const ptNamesCache = new Map();

function getPythonBin() {
  return (
    process.env.YOLO_CLASS_NAMES_PYTHON ||
    process.env.AUG_PYTHON_BIN ||
    process.env.PYTHON ||
    'python'
  );
}

async function isUsableCheckpoint(filePath) {
  try {
    const st = await fsPromises.stat(filePath);
    if (!st.isFile() || st.size < 4096) return false;
    const fh = await fsPromises.open(filePath, 'r');
    const buf = Buffer.alloc(160);
    await fh.read(buf, 0, 160, 0);
    await fh.close();
    const head = buf.toString('utf8');
    if (head.includes('placeholder')) return false;
    return true;
  } catch {
    return false;
  }
}

function runExtractScript(modelPath) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, '..', 'inference-scripts', 'extract_yolo_class_names.py');
    const py = getPythonBin();
    const child = spawn(py, [scriptPath, '--model', modelPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, 120000);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        if (err.trim()) {
          console.warn('[yoloClassNames] extract script stderr:', err.trim().slice(0, 500));
        }
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(out.trim());
        resolve(Array.isArray(parsed) ? parsed.map((x) => String(x)) : null);
      } catch {
        resolve(null);
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      console.warn('[yoloClassNames] spawn error:', e.message);
      resolve(null);
    });
  });
}

async function classNamesFromCheckpoint(ptPath) {
  const resolved = path.resolve(ptPath);
  let mtime = 0;
  try {
    const st = await fsPromises.stat(resolved);
    mtime = st.mtimeMs;
  } catch {
    return null;
  }
  const cacheKey = `${resolved}:${mtime}`;
  for (const k of ptNamesCache.keys()) {
    if (k.startsWith(`${resolved}:`) && k !== cacheKey) {
      ptNamesCache.delete(k);
    }
  }
  if (ptNamesCache.has(cacheKey)) {
    return ptNamesCache.get(cacheKey);
  }
  const names = await runExtractScript(resolved);
  if (names && names.length > 0) {
    ptNamesCache.set(cacheKey, names);
  }
  return names && names.length > 0 ? names : null;
}

async function parseClassMappingJson(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    const obj = JSON.parse(raw);
    const keys = Object.keys(obj)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    const out = keys.map((k) => String(obj[k]));
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function parseNamesFromDataYaml(filePath) {
  try {
    const text = await fsPromises.readFile(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    const names = [];
    let inNames = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!inNames) {
        if (/^names:\s*$/.test(trimmed) || trimmed === 'names:') {
          inNames = true;
        }
        continue;
      }
      const listItem = line.match(/^\s*-\s+(.+?)\s*$/);
      if (listItem) {
        names.push(listItem[1].trim());
        continue;
      }
      if (trimmed && !trimmed.startsWith('#')) {
        if (names.length > 0) break;
      }
    }
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
}

async function getClassNamesForTrainedModel(model, options = {}) {
  if (!model || typeof model !== 'object') return [];
  const skipCheckpoint = options.skipCheckpoint === true;

  if (model.modelType === 'RF_DETR' && model.storagePath) {
    const modelRoot = path.resolve(model.storagePath);
    const mapped = await parseClassMappingJson(path.join(modelRoot, 'class-mapping.json'));
    if (mapped && mapped.length > 0) return mapped;
    const fromYaml = await parseNamesFromDataYaml(path.join(modelRoot, 'data.yaml'));
    if (fromYaml && fromYaml.length > 0) return fromYaml;
  }

  const best = resolveModelCheckpointPath(model);

  const usable = best && fs.existsSync(best) ? await isUsableCheckpoint(best) : false;
  if (
    !skipCheckpoint &&
    model.modelType !== 'RF_DETR' &&
    best &&
    fs.existsSync(best) &&
    usable
  ) {
    const fromPt = await classNamesFromCheckpoint(best);
    if (fromPt && fromPt.length > 0) {
      return fromPt;
    }
  }

  if (model.storagePath) {
    const modelRoot = path.resolve(model.storagePath);
    const cm = path.join(modelRoot, 'class-mapping.json');
    const mapped = await parseClassMappingJson(cm);
    if (mapped && mapped.length > 0) return mapped;
    const yamlPath = path.join(modelRoot, 'data.yaml');
    const fromYaml = await parseNamesFromDataYaml(yamlPath);
    if (fromYaml && fromYaml.length > 0) return fromYaml;
  }

  if (model.company && model.project && model.datasetVersion) {
    // The training dataset's stored folder (survives renames, and is GSN's folder for linked samples)
    const Dataset = require('../models/Dataset');
    const trainedOn = model.datasetId
      ? await Dataset.findById(model.datasetId).select('storagePath').lean().catch(() => null)
      : null;
    const dsRoot =
      trainedOn?.storagePath ||
      storageAdapter.buildDatasetPath(model.company, model.project, model.datasetVersion);
    const cm2 = path.join(dsRoot, 'class-mapping.json');
    const mapped2 = await parseClassMappingJson(cm2);
    if (mapped2 && mapped2.length > 0) return mapped2;
    const yaml2 = path.join(dsRoot, 'data.yaml');
    const fromYaml2 = await parseNamesFromDataYaml(yaml2);
    if (fromYaml2 && fromYaml2.length > 0) return fromYaml2;
  }

  return [];
}

module.exports = {
  getClassNamesForTrainedModel,
  classNamesFromCheckpoint,
  parseClassMappingJson,
  parseNamesFromDataYaml,
};
