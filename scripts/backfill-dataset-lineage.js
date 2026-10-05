/**
 * One-off backfill: populate Dataset.parentDatasetId / Dataset.rootDatasetId for
 * datasets created before lineage tracking existed, so the Versions panel can group
 * a dataset with its augmentations and duplicates.
 *
 * Strategy: union-find over all datasets, per (company, project):
 *  1. Union a doc with its backupDatasetId's doc — real, reliable augmentation lineage.
 *  2. Union docs that have no backupDatasetId (originals + old-style duplicates, which
 *     never recorded lineage) but share a base name once trailing _aug/_dup suffixes
 *     are stripped — best-effort for legacy duplicates.
 *  Using union-find (rather than resolving chain-links and name-matches in separate,
 *  ordered passes) means a duplicate-of-an-augmented-dataset still merges into the
 *  right family: e.g. augmenting "bike_rust" gives "bike_rust_aug" (real link), and
 *  separately duplicating "bike_rust_aug" gives "bike_rust_dup" with NO real link —
 *  but "bike_rust_dup" and "bike_rust" share the base name "bike_rust", so they union
 *  together, merging both chains into one family instead of splitting into two.
 *  3. The earliest-created doc in each resulting connected component becomes the root.
 *
 * The name heuristic is best-effort and legacy-data-only — going forward, lineage is
 * set explicitly at creation time (augmentationWorker.js, duplicateDataset), so this
 * script never needs to run again after a one-time pass post-deploy.
 *
 * Usage: node scripts/backfill-dataset-lineage.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Dataset = require('../models/Dataset');

function stripLineageSuffix(version) {
  // Repeatedly strip trailing _aug / _dup, optionally followed by a numeric/version
  // suffix like _aug_v1, _dup2, _aug3, until nothing more matches.
  let base = String(version || '');
  let changed = true;
  while (changed) {
    changed = false;
    const next = base.replace(/_(dup|aug)(_?v?\d+)?$/i, '');
    if (next !== base && next.length > 0) {
      base = next;
      changed = true;
    }
  }
  return base;
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGO_URI missing in .env');
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  // Include soft-deleted docs so a deleted member doesn't break its still-live
  // siblings' chain resolution; we still write rootDatasetId onto deleted docs too
  // (harmless — listDatasets already filters them out) so the chain stays intact.
  const allDatasets = await Dataset.find({}).select(
    '_id company project version createdAt backupDatasetId parentDatasetId rootDatasetId deletedAt'
  );

  const byId = new Map(allDatasets.map((d) => [d._id.toString(), d]));
  const dsu = new UnionFind();
  for (const d of allDatasets) dsu.find(d._id.toString());

  // 1. Union via real backupDatasetId links.
  for (const d of allDatasets) {
    if (d.backupDatasetId && byId.has(d.backupDatasetId.toString())) {
      dsu.union(d._id.toString(), d.backupDatasetId.toString());
    }
  }

  // 2. Union via name heuristic, only among docs with no backupDatasetId of their own,
  //    scoped to the same (company, project) so unrelated projects never merge.
  const byGroupKey = new Map();
  for (const d of allDatasets) {
    if (d.backupDatasetId) continue; // reliable lineage already established for this doc
    const key = `${d.company}||${d.project}`;
    if (!byGroupKey.has(key)) byGroupKey.set(key, []);
    byGroupKey.get(key).push(d);
  }
  for (const docs of byGroupKey.values()) {
    const byBaseName = new Map();
    for (const d of docs) {
      const base = stripLineageSuffix(d.version);
      if (!byBaseName.has(base)) byBaseName.set(base, []);
      byBaseName.get(base).push(d);
    }
    for (const members of byBaseName.values()) {
      for (let i = 1; i < members.length; i++) {
        dsu.union(members[0]._id.toString(), members[i]._id.toString());
      }
    }
  }

  // 3. Group by final component, pick earliest-created member as root.
  const components = new Map(); // rootId -> docs[]
  for (const d of allDatasets) {
    const r = dsu.find(d._id.toString());
    if (!components.has(r)) components.set(r, []);
    components.get(r).push(d);
  }

  const ops = [];
  let chainResolved = 0;
  let heuristicResolved = 0;
  let singletons = 0;
  let ties = 0;

  for (const members of components.values()) {
    members.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (members.length > 1) {
      const earliestTime = new Date(members[0].createdAt).getTime();
      const tiedEarliest = members.filter((m) => new Date(m.createdAt).getTime() === earliestTime);
      if (tiedEarliest.length > 1) {
        ties++;
        console.warn(
          `[TIE] ${members[0].company}/${members[0].project}: multiple docs share the earliest createdAt, picking first by _id order`,
          tiedEarliest.map((m) => m._id.toString())
        );
      }
    }
    const root = members[0];
    for (const d of members) {
      const isRoot = d._id.equals(root._id);
      const parentId = d.backupDatasetId ? d.backupDatasetId : isRoot ? null : root._id;
      ops.push({
        updateOne: {
          filter: { _id: d._id },
          update: { $set: { parentDatasetId: parentId, rootDatasetId: root._id } },
        },
      });
      if (members.length === 1) singletons++;
      else if (d.backupDatasetId) chainResolved++;
      else heuristicResolved++;
    }
  }

  console.log(
    `Resolved lineage for ${ops.length} datasets (chain: ${chainResolved}, heuristic: ${heuristicResolved}, singleton: ${singletons}, name ties: ${ties})`
  );

  const BATCH_SIZE = 500;
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = ops.slice(i, i + BATCH_SIZE);
    const result = await Dataset.bulkWrite(batch);
    console.log(`Batch ${i / BATCH_SIZE + 1}: modified ${result.modifiedCount}`);
  }

  console.log('Done.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
