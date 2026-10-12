/**
 * One-off: delete every company except "gsn" (Supabase + MongoDB + local disk).
 *
 *   node scripts/delete-non-gsn-companies-2026-10-09.js            -> DRY RUN (counts + safety checks only)
 *   node scripts/delete-non-gsn-companies-2026-10-09.js --execute  -> backup, then delete
 *
 * Backup (written BEFORE anything is deleted):
 *   C:\Gsn Soln\VisionBackend_company_cleanup_backup_2026-10-09\
 *     db\mongo\<collection>.json     every MongoDB document that gets deleted (Extended JSON)
 *     db\supabase\<table>.json       every Supabase row that gets deleted + the auth user records
 *     datasets\ models\ results\     the company folders, moved (not deleted)
 *
 * Stop the backend (nodemon watches models/) before --execute.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');

const KEEP_COMPANY = 'gsn';
const EXECUTE = process.argv.includes('--execute');
const ROOT = path.join(__dirname, '..');
const BACKUP = path.join(ROOT, '..', 'VisionBackend_company_cleanup_backup_2026-10-09');
const SB_TABLES = ['project_users', 'dataset_files', 'datasets', 'company_invites', 'workspace_join_requests', 'email_verification_tokens', 'projects'];
const USER_COLS = ['user_id', 'created_by', 'invited_by', 'requested_by', 'approved_by'];

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`\n❌ ABORTED: ${msg}\nNothing was deleted.`); process.exit(1); };
const writeJson = (rel, data) => {
  const file = path.join(BACKUP, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  return file;
};

(async () => {
  log(EXECUTE ? '=== EXECUTE MODE ===' : '=== DRY RUN (nothing will be changed) ===');

  // ------------------------------------------------------------ Supabase: plan
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

  const companies = await must(sb.from('companies').select('*'));
  const keep = companies.filter((c) => c.name === KEEP_COMPANY);
  if (keep.length !== 1) fail(`expected exactly one company named "${KEEP_COMPANY}", found ${keep.length}`);
  const keepId = keep[0].id;
  const delCompanies = companies.filter((c) => c.id !== keepId);
  const delCompanyIds = new Set(delCompanies.map((c) => c.id));

  const profiles = await must(sb.from('profiles').select('*'));
  const delProfiles = profiles.filter((p) => delCompanyIds.has(p.company_id));
  const delUserIds = new Set(delProfiles.map((p) => p.id));
  const keepUserIds = new Set(profiles.filter((p) => p.company_id === keepId).map((p) => p.id));

  const projects = await must(sb.from('projects').select('*'));
  const keepProjectIds = new Set(projects.filter((p) => p.company_id === keepId).map((p) => p.id));
  const delProjectIds = new Set(projects.filter((p) => delCompanyIds.has(p.company_id)).map((p) => p.id));

  // Safety: deleting a user cascades to rows they created. None of gsn's rows may depend on a user being deleted.
  if (delUserIds.has(keep[0].created_by)) fail('the gsn company was created by a user who would be deleted');
  for (const u of keepUserIds) if (delUserIds.has(u)) fail('a gsn user is in the delete list');
  for (const p of profiles) if (p.role === 'platform_admin' && delUserIds.has(p.id)) fail(`platform_admin ${p.email} would be deleted`);

  const sbPlan = {};
  for (const t of SB_TABLES) {
    const { data, error } = await sb.from(t).select('*');
    if (error) { log(`  (supabase table ${t} not available: ${error.code}) - skipped`); continue; }
    const belongsToGsn = (r) => r.company_id === keepId || keepProjectIds.has(r.project_id);
    const hitsDeleted = (r) => delCompanyIds.has(r.company_id) || delProjectIds.has(r.project_id) || USER_COLS.some((c) => delUserIds.has(r[c]));
    const rows = data.filter(hitsDeleted);
    const unsafe = rows.filter(belongsToGsn);
    if (unsafe.length) fail(`${unsafe.length} gsn row(s) in "${t}" reference a user being deleted (would cascade-delete gsn data)`);
    sbPlan[t] = rows;
  }

  log('\nSupabase:');
  log(`  keep company: ${keep[0].name} (${keepUserIds.size} users, ${keepProjectIds.size} projects)`);
  log(`  delete companies (${delCompanies.length}): ${delCompanies.map((c) => c.name).join(', ')}`);
  log(`  delete user accounts (${delProfiles.length}): ${delProfiles.map((p) => p.email).join(', ')}`);
  for (const [t, rows] of Object.entries(sbPlan)) log(`  delete ${t}: ${rows.length}`);

  // ------------------------------------------------------------ MongoDB: plan
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
  const nonGsn = { company: { $exists: true, $nin: [KEEP_COMPANY, null] } };

  const delDatasets = await db.collection('datasets').find(nonGsn).project({ _id: 1 }).toArray();
  const dsIds = delDatasets.map((d) => d._id);
  const dsFilter = { datasetId: { $in: [...dsIds, ...dsIds.map(String)] } };

  const mongoPlan = {};
  for (const col of cols) {
    const hasCompany = await db.collection(col).countDocuments({ company: { $exists: true } });
    let filter = null;
    if (hasCompany) filter = nonGsn;
    else if (['images', 'annotations', 'categories'].includes(col)) filter = dsFilter;
    if (!filter) continue;
    const n = await db.collection(col).countDocuments(filter);
    if (n) mongoPlan[col] = filter;
    if (n) log(`${Object.keys(mongoPlan).length === 1 ? '\nMongoDB:\n' : ''}  delete ${col}: ${n}`);
  }
  // Safety: gsn datasets must not lose images/annotations
  const gsnDs = await db.collection('datasets').find({ company: KEEP_COMPANY }).project({ _id: 1 }).toArray();
  const gsnDsSet = new Set(gsnDs.map((d) => String(d._id)));
  if (dsIds.some((id) => gsnDsSet.has(String(id)))) fail('dataset id overlap with gsn');

  // ------------------------------------------------------------ Disk: plan
  const diskPlan = [];
  for (const top of ['datasets', 'models', 'results']) {
    for (const d of fs.readdirSync(path.join(ROOT, top), { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== KEEP_COMPANY && d.name !== 'base') diskPlan.push(`${top}/${d.name}`);
    }
  }
  log(`\nDisk: move to backup: ${diskPlan.join(' | ') || '(none)'}`);

  if (!EXECUTE) { log('\nDry run complete. Re-run with --execute to back up and delete.'); await mongoose.disconnect(); return; }

  // ============================================================ EXECUTE
  if (fs.existsSync(path.join(BACKUP, 'db'))) fail(`backup folder already has a db/ export: ${BACKUP}`);

  // 1) BACKUP everything first
  log('\n[1/4] Backing up…');
  const { EJSON } = require('bson');
  for (const [col, filter] of Object.entries(mongoPlan)) {
    const docs = await db.collection(col).find(filter).toArray();
    writeJson(`db/mongo/${col}.json`, EJSON.stringify(docs, null, 1, { relaxed: false }));
    const check = EJSON.parse(fs.readFileSync(path.join(BACKUP, `db/mongo/${col}.json`), 'utf8'));
    if (check.length !== docs.length) fail(`backup verification failed for ${col}`);
    log(`  mongo ${col}: ${docs.length} docs saved`);
  }
  for (const [t, rows] of Object.entries(sbPlan)) writeJson(`db/supabase/${t}.json`, rows);
  writeJson('db/supabase/companies.json', delCompanies);
  writeJson('db/supabase/profiles.json', delProfiles);
  const authUsers = [];
  for (const id of delUserIds) {
    const { data, error } = await sb.auth.admin.getUserById(id);
    authUsers.push(error ? { id, error: error.message } : data.user);
  }
  writeJson('db/supabase/auth_users.json', authUsers);
  log(`  supabase: ${delCompanies.length} companies, ${delProfiles.length} profiles/auth users, ${Object.values(sbPlan).reduce((a, r) => a + r.length, 0)} related rows saved`);

  // 2) MongoDB
  log('[2/4] Deleting MongoDB records…');
  for (const [col, filter] of Object.entries(mongoPlan)) {
    const r = await db.collection(col).deleteMany(filter);
    log(`  ${col}: ${r.deletedCount} deleted`);
  }

  // 3) Supabase: child rows -> auth users (cascades profiles) -> companies
  log('[3/4] Deleting Supabase records…');
  for (const t of SB_TABLES) {
    const rows = sbPlan[t];
    if (!rows || !rows.length) continue;
    const ids = rows.map((r) => r.id).filter(Boolean);
    if (ids.length) { await must(sb.from(t).delete().in('id', ids)); log(`  ${t}: ${ids.length} deleted`); }
  }
  for (const id of delUserIds) {
    const { error } = await sb.auth.admin.deleteUser(id);
    if (error) log(`  ⚠️ auth user ${id}: ${error.message}`);
  }
  await must(sb.from('profiles').delete().in('id', [...delUserIds]));
  log(`  user accounts: ${delUserIds.size} deleted`);
  await must(sb.from('companies').delete().in('id', [...delCompanyIds]));
  log(`  companies: ${delCompanyIds.size} deleted`);

  // 4) Disk (move, not delete)
  log('[4/4] Moving company folders to backup…');
  for (const rel of diskPlan) {
    const dest = path.join(BACKUP, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(path.join(ROOT, rel), dest);
    log(`  moved ${rel}`);
  }

  // Verify gsn untouched
  const left = await must(sb.from('companies').select('name'));
  log(`\n✅ Done. Companies left in Supabase: ${left.map((c) => c.name).join(', ')}`);
  log(`   gsn datasets in MongoDB: ${await db.collection('datasets').countDocuments({ company: KEEP_COMPANY })}, models: ${await db.collection('models').countDocuments({ company: KEEP_COMPANY })}`);
  log(`   Backup: ${BACKUP}`);
  await mongoose.disconnect();
})().catch((e) => { console.error('\n❌ ERROR:', e); process.exit(1); });
