/**
 * One-off: delete every login that belongs to no company (profile.company_id is null),
 * plus auth logins that have no profile row at all.
 *
 *   node scripts/delete-companyless-users-2026-10-09.js            -> DRY RUN
 *   node scripts/delete-companyless-users-2026-10-09.js --execute  -> backup, then delete
 *
 * Backup: C:\Gsn Soln\VisionBackend_company_cleanup_backup_2026-10-09\db\supabase\companyless_users\
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const EXECUTE = process.argv.includes('--execute');
const BACKUP = path.join(__dirname, '..', '..', 'VisionBackend_company_cleanup_backup_2026-10-09', 'db', 'supabase', 'companyless_users');
const TABLES = ['companies', 'projects', 'company_invites', 'workspace_join_requests', 'email_verification_tokens', 'datasets', 'dataset_files'];
const USER_COLS = ['id', 'user_id', 'created_by', 'invited_by', 'requested_by', 'approved_by'];
const fail = (m) => { console.error(`\n❌ ABORTED: ${m}\nNothing was deleted.`); process.exit(1); };

(async () => {
  console.log(EXECUTE ? '=== EXECUTE MODE ===' : '=== DRY RUN (nothing will be changed) ===');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: profiles, error: pErr } = await sb.from('profiles').select('*');
  if (pErr) throw pErr;
  const { data: list, error: lErr } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (lErr) throw lErr;
  const profileIds = new Set(profiles.map((p) => p.id));

  const targets = [
    ...profiles.filter((p) => !p.company_id).map((p) => ({ id: p.id, email: p.email, profile: p })),
    ...list.users.filter((u) => !profileIds.has(u.id)).map((u) => ({ id: u.id, email: u.email, profile: null })),
  ];
  const ids = new Set(targets.map((t) => t.id));

  // Safety: no platform admin, and nothing that cascades from these users may exist
  for (const t of targets) if (t.profile?.role === 'platform_admin') fail(`${t.email} is a platform_admin`);
  const dependents = {};
  for (const tbl of TABLES) {
    const { data, error } = await sb.from(tbl).select('*');
    if (error) continue;
    const rows = data.filter((r) => USER_COLS.some((c) => c !== 'id' && ids.has(r[c])));
    if (rows.length) dependents[tbl] = rows;
  }

  console.log(`\nLogins to delete (${targets.length}):`);
  targets.forEach((t) => console.log(`  - ${t.email}${t.profile ? '' : '  (login with no profile)'}`));
  console.log('\nRows that would be cascade-deleted with them:', Object.keys(dependents).length ? '' : 'none');
  for (const [tbl, rows] of Object.entries(dependents)) console.log(`  ${tbl}: ${rows.length}`, JSON.stringify(rows.map((r) => r.name || r.email || r.id)));
  if (Object.keys(dependents).length) fail('these users own other rows; review before deleting');

  if (!EXECUTE) { console.log('\nDry run complete. Re-run with --execute to back up and delete.'); return; }

  // Backup first
  fs.mkdirSync(BACKUP, { recursive: true });
  const auth = list.users.filter((u) => ids.has(u.id));
  fs.writeFileSync(path.join(BACKUP, 'auth_users.json'), JSON.stringify(auth, null, 1));
  fs.writeFileSync(path.join(BACKUP, 'profiles.json'), JSON.stringify(targets.map((t) => t.profile).filter(Boolean), null, 1));
  console.log(`\nBacked up ${auth.length} logins + ${targets.filter((t) => t.profile).length} profiles to ${BACKUP}`);

  // Delete (auth delete cascades the profile row)
  for (const t of targets) {
    const { error } = await sb.auth.admin.deleteUser(t.id);
    console.log(error ? `  ⚠️ ${t.email}: ${error.message}` : `  deleted ${t.email}`);
  }
  await sb.from('profiles').delete().in('id', [...ids]);

  const { data: after } = await sb.from('profiles').select('email, company_id');
  const { data: afterAuth } = await sb.auth.admin.listUsers({ perPage: 1000 });
  console.log(`\n✅ Done. Remaining logins: ${afterAuth.users.length} -> ${afterAuth.users.map((u) => u.email).join(', ')}`);
  console.log(`   Remaining profiles without company: ${after.filter((p) => !p.company_id).length}`);
})().catch((e) => { console.error('\n❌ ERROR:', e); process.exit(1); });
