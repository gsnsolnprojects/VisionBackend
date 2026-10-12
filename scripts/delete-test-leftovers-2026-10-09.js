/**
 * One-off: delete leftover test records that belong to no company:
 *   - localedgeevents with no company (edge-app restart logs, Feb 2026)
 *   - all demoextinguisherreads (temporary extinguisher OCR demo, Apr 2026)
 *
 *   node scripts/delete-test-leftovers-2026-10-09.js            -> DRY RUN
 *   node scripts/delete-test-leftovers-2026-10-09.js --execute  -> backup, then delete
 *
 * Backup: C:\Gsn Soln\VisionBackend_company_cleanup_backup_2026-10-09\db\mongo\leftovers\
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { EJSON } = require('bson');

const EXECUTE = process.argv.includes('--execute');
const BACKUP = path.join(__dirname, '..', '..', 'VisionBackend_company_cleanup_backup_2026-10-09', 'db', 'mongo', 'leftovers');
const PLAN = {
  localedgeevents: { $or: [{ company: null }, { company: { $exists: false } }] },
  demoextinguisherreads: {},
};

(async () => {
  console.log(EXECUTE ? '=== EXECUTE MODE ===' : '=== DRY RUN (nothing will be changed) ===');
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  for (const [col, filter] of Object.entries(PLAN)) {
    const docs = await db.collection(col).find(filter).toArray();
    console.log(`${col}: ${docs.length} to delete`);
    if (!EXECUTE || !docs.length) continue;

    fs.mkdirSync(BACKUP, { recursive: true });
    const file = path.join(BACKUP, `${col}.json`);
    fs.writeFileSync(file, EJSON.stringify(docs, null, 1, { relaxed: false }));
    if (EJSON.parse(fs.readFileSync(file, 'utf8')).length !== docs.length) throw new Error(`backup check failed for ${col}`);

    const r = await db.collection(col).deleteMany({ _id: { $in: docs.map((d) => d._id) } });
    console.log(`  backed up -> ${file}\n  deleted ${r.deletedCount}`);
  }

  if (EXECUTE) {
    for (const col of Object.keys(PLAN)) console.log(`remaining in ${col}: ${await db.collection(col).countDocuments()}`);
  } else {
    console.log('\nDry run complete. Re-run with --execute to back up and delete.');
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('\n❌ ERROR:', e); process.exit(1); });
