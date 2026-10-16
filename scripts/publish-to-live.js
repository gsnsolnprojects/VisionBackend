#!/usr/bin/env node
/**
 * Publish the superadmin's "Publish to live" selection to the live AWS setup.
 *
 *   node scripts/publish-to-live.js            dry run: show what would be copied
 *   node scripts/publish-to-live.js --apply    copy records and files
 *
 * Reads the selection from the local database (MONGO_URI in .env):
 *   - datasets with publishToLive = true (not deleted, not linked samples)
 *   - the models trained on them, their training jobs, their images / annotations /
 *     categories, and their sample-library entries
 * and copies them into the live database (same cluster, database LIVE_DB_NAME, default
 * visiondb_prod), keeping the same _ids so re-running updates instead of duplicating.
 * File locations are rewritten from this computer's folder to the server's /data.
 *
 * Files (dataset folders, model folders without training leftovers) go through a private
 * S3 bucket: uploaded with `aws s3 sync` (only new / changed files), pulled onto the
 * server with an SSM command, then removed from the bucket.
 *
 * Settings (environment):
 *   LIVE_DB_NAME        live database name (default visiondb_prod)
 *   PUBLISH_BUCKET      staging bucket (default vision-publish-191926569224)
 *   LIVE_INSTANCE_ID    API server (default i-06dc5fb3c2616ac00)
 *   AWS_REGION          default ap-south-1
 *   AWS_CLI             path to the aws executable (default "aws")
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const LIVE_DB_NAME = process.env.LIVE_DB_NAME || 'visiondb_prod';
const BUCKET = process.env.PUBLISH_BUCKET || 'vision-publish-191926569224';
const INSTANCE_ID = process.env.LIVE_INSTANCE_ID || 'i-06dc5fb3c2616ac00';
const REGION = process.env.AWS_REGION || 'ap-south-1';
const AWS = process.env.AWS_CLI || 'aws';
const SERVER_DATA = '/data'; // as the app inside the container sees it
const SERVER_HOST_DATA = '/srv/vision/data'; // the same folder on the EC2 host

/** Training leftovers the app never reads: resume snapshots, last-epoch and RF-DETR checkpoint copies */
const EXCLUDES = ['*.ckpt', '*/last.pt', 'last.pt', 'rfdetr-output/checkpoint*.pth', '*/rfdetr-output/checkpoint*.pth'];
const isLeftOut = (rel) => {
  const name = path.basename(rel);
  return name.endsWith('.ckpt') || name === 'last.pt' || (/[\\/]?rfdetr-output[\\/]/.test(rel) && /^checkpoint.*\.pth$/.test(name));
};

// ---------- paths ----------

const localRoot = ROOT.replace(/[\\/]+$/, '');
const localRootLower = localRoot.toLowerCase().replace(/\//g, '\\');

/** "C:\Gsn Soln\VisionBackend\datasets\gsn\x" -> "datasets/gsn/x"; null if outside this folder */
function relativeToRoot(p) {
  if (typeof p !== 'string') return null;
  const normalized = p.replace(/\//g, '\\');
  if (!normalized.toLowerCase().startsWith(localRootLower + '\\')) return null;
  return normalized.slice(localRootLower.length + 1).replace(/\\/g, '/');
}

/**
 * Rewrite every value that is a path inside this computer's folder to the server's /data
 * path. Text that merely mentions a path (training log lines) is history and stays as is.
 */
function rewritePaths(value) {
  if (typeof value === 'string') {
    const rel = relativeToRoot(value);
    return rel === null ? value : `${SERVER_DATA}/${rel}`;
  }
  if (Array.isArray(value)) return value.map(rewritePaths);
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId) && !Buffer.isBuffer(value) && value._bsontype === undefined) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewritePaths(v);
    return out;
  }
  return value;
}

function folderSize(dir) {
  let bytes = 0, files = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (!isLeftOut(r)) { bytes += fs.statSync(full).size; files++; }
    }
  };
  walk(dir, '');
  return { bytes, files };
}

const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;

function aws(args, opts = {}) {
  return execFileSync(AWS, [...args, '--region', REGION], { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
}

// ---------- main ----------

(async () => {
  const localUri = process.env.MONGO_URI;
  if (!localUri) throw new Error('MONGO_URI is not set in .env');
  const local = await mongoose.createConnection(localUri).asPromise();
  const live = local.useDb(LIVE_DB_NAME, { useCache: false });
  if (local.db.databaseName === LIVE_DB_NAME) throw new Error('Local and live database names are the same');
  console.log(`Local database: ${local.db.databaseName}  ->  live database: ${LIVE_DB_NAME}`);
  console.log(APPLY ? 'MODE: APPLY (copying)\n' : 'MODE: DRY RUN (nothing is changed; add --apply to copy)\n');

  const L = (name) => local.db.collection(name);
  const datasets = await L('datasets').find({ publishToLive: true, deletedAt: null, linkedFrom: null }).toArray();
  if (datasets.length === 0) {
    console.log('Nothing ticked in Superadmin -> Publish to live.');
    await local.close();
    return;
  }
  const datasetIds = datasets.map((d) => d._id);
  const models = await L('models').find({ linkedFrom: null, datasetId: { $in: datasetIds } }).toArray();
  const jobIds = models.map((m) => m.jobId).filter(Boolean);
  const records = {
    datasets,
    models,
    trainingjobs: await L('trainingjobs').find({ _id: { $in: jobIds } }).toArray(),
    images: await L('images').find({ datasetId: { $in: datasetIds } }).toArray(),
    annotations: await L('annotations').find({ datasetId: { $in: datasetIds } }).toArray(),
    categories: await L('categories').find({ datasetId: { $in: datasetIds } }).toArray(),
    samplelibraryitems: await L('samplelibraryitems').find({ datasetId: { $in: datasetIds } }).toArray(),
  };

  // Folders to send, checked to exist on this computer
  const folders = new Map(); // rel -> { label, bytes, files }
  const problems = [];
  for (const d of datasets) {
    const rel = relativeToRoot(d.storagePath);
    if (!rel || !fs.existsSync(d.storagePath)) { problems.push(`dataset ${d.project}/${d.version}: files not on this computer (${d.storagePath})`); continue; }
    folders.set(rel, { label: `dataset ${String(d.project).trim()} / ${d.version}`, ...folderSize(d.storagePath) });
  }
  for (const m of models) {
    const rel = relativeToRoot(m.storagePath);
    if (!rel || !fs.existsSync(m.storagePath)) { problems.push(`model ${m.modelId}: files not on this computer (${m.storagePath})`); continue; }
    if (!folders.has(rel)) folders.set(rel, { label: `model ${String(m.project).trim()} / ${m.modelType} ${m.modelVersion}`, ...folderSize(m.storagePath) });
  }
  if (problems.length) {
    console.log('Cannot publish:\n  ' + problems.join('\n  '));
    await local.close();
    process.exit(1);
  }

  console.log('Records to copy:');
  for (const [name, docs] of Object.entries(records)) console.log(`  ${name.padEnd(20)} ${docs.length}`);
  console.log('\nFolders to upload (without training leftovers):');
  let total = 0;
  for (const [rel, f] of folders) { total += f.bytes; console.log(`  ${f.label.padEnd(55)} ${String(f.files).padStart(5)} files  ${mb(f.bytes).padStart(10)}   -> ${SERVER_DATA}/${rel}`); }
  console.log(`  ${'TOTAL'.padEnd(55)} ${''.padStart(11)} ${mb(total).padStart(10)}`);

  const sample = rewritePaths(models[0] || datasets[0]);
  console.log(`\nPath example: ${(models[0] || datasets[0]).storagePath}  ->  ${sample.storagePath}`);

  if (!APPLY) {
    await local.close();
    return;
  }

  // 1) Files: this computer -> S3
  console.log('\n[1/4] Uploading files to the staging bucket...');
  const excludeArgs = EXCLUDES.flatMap((p) => ['--exclude', p]);
  for (const [rel, f] of folders) {
    console.log(`  ${f.label}`);
    aws(['s3', 'sync', path.join(localRoot, ...rel.split('/')), `s3://${BUCKET}/publish/${rel}`, '--only-show-errors', ...excludeArgs], { inherit: true });
  }

  // 2) Files: S3 -> server
  console.log('[2/4] Pulling files onto the server...');
  const syncCmd = `aws s3 sync s3://${BUCKET}/publish/ ${SERVER_HOST_DATA}/ --region ${REGION} --only-show-errors && du -sh ${SERVER_HOST_DATA}`;
  const commandId = aws(['ssm', 'send-command', '--instance-ids', INSTANCE_ID, '--document-name', 'AWS-RunShellScript',
    '--comment', 'publish to live', '--parameters', JSON.stringify({ commands: [syncCmd], executionTimeout: ['3600'] }),
    '--query', 'Command.CommandId', '--output', 'text']).trim();
  let status = 'Pending', out = '';
  for (let i = 0; i < 360 && ['Pending', 'InProgress', 'Delayed'].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      [status, out] = JSON.parse(aws(['ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', INSTANCE_ID,
        '--query', '[Status,StandardOutputContent,StandardErrorContent]', '--output', 'json']).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ''));
    } catch { status = 'Pending'; }
  }
  if (status !== 'Success') throw new Error(`Server could not pull the files (${status}): ${out}`);
  console.log(`  server data folder now: ${out.trim()}`);

  // 3) Records: local -> live database (same _ids; replace = update when re-published)
  console.log('[3/4] Copying records to the live database...');
  for (const [name, docs] of Object.entries(records)) {
    if (docs.length === 0) continue;
    const ops = docs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: rewritePaths(doc), upsert: true } }));
    const result = await live.collection(name).bulkWrite(ops, { ordered: false });
    console.log(`  ${name.padEnd(20)} ${result.upsertedCount} new, ${result.modifiedCount} updated`);
  }

  // 4) Empty the staging bucket
  console.log('[4/4] Emptying the staging bucket...');
  aws(['s3', 'rm', `s3://${BUCKET}/publish/`, '--recursive', '--only-show-errors'], { inherit: true });

  console.log('\nPublished.');
  await local.close();
})().catch(async (error) => {
  console.error('\nPUBLISH FAILED:', error.message);
  process.exit(1);
});
