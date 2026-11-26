#!/bin/sh
# Check a loaded database against the Supabase backup: counts, triggers, keys, rules, orphans, RLS.
# Same environment as load_into_postgres.sh. Prints PASS/FAIL per check; exits 1 on any FAIL.
set -eu
export PGUSER=postgres PGDATABASE=vision PGPASSWORD="$POSTGRES_PASSWORD"
cd /work
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: got '$2', expected '$3'"; fail=1; fi; }

psql -At -c "select string_agg(format('select %L as t, count(*) from %I.%I', table_schema||'.'||table_name, table_schema, table_name), ' union all ') from information_schema.tables where table_schema='public' and table_type='BASE TABLE'" > /tmp/q.sql
psql -At -F ' ' -f /tmp/q.sql | sort > /tmp/now.txt
psql -At -F ' ' -c "select 'auth.users', count(*) from auth.users union all select 'auth.identities', count(*) from auth.identities" >> /tmp/now.txt
if diff row_counts.txt /tmp/now.txt >/dev/null; then echo "PASS  row counts match the Supabase backup ($(wc -l < /tmp/now.txt) tables)"; else echo "FAIL  row counts differ:"; diff row_counts.txt /tmp/now.txt || true; fail=1; fi

check "triggers" "$(psql -Atc "select count(*) from pg_trigger where not tgisinternal")" 8
check "foreign keys" "$(psql -Atc "select count(*) from pg_constraint where contype='f' and connamespace in ('public'::regnamespace,'auth'::regnamespace)")" 15
check "RLS policies" "$(psql -Atc "select count(*) from pg_policies")" 27
check "public functions" "$(psql -Atc "select count(*) from pg_proc where pronamespace='public'::regnamespace")" 19

orphans=$(psql -At -c "
select (select count(*) from public.profiles p where not exists (select 1 from auth.users u where u.id=p.id))
     + (select count(*) from auth.users u where not exists (select 1 from public.profiles p where p.id=u.id))
     + (select count(*) from public.company_subscriptions s where not exists (select 1 from public.companies c where c.id=s.company_id))
     + (select count(*) from public.projects p where p.company_id is not null and not exists (select 1 from public.companies c where c.id=p.company_id))")
check "orphan rows" "$orphans" 0

# Run SQL as a signed-in user (the same way the backend will), in a transaction that is always rolled back.
# Prints only the last result line.
as_user() {
  psql -At -q 2>/dev/null <<EOF | tail -n 1
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, true) \g /dev/null
$2
rollback;
EOF
}

# An ordinary member (not platform_admin / workspace_admin) who belongs to an organisation
uid=$(psql -At -c "select id from public.profiles where company_id is not null and coalesce(role,'') not in ('platform_admin','workspace_admin') order by created_at limit 1")
echo "test user: an ordinary member with role '$(psql -At -c "select coalesce(role,'(none)') from public.profiles where id='$uid'")'"
own=$(psql -At -c "select count(*) from public.projects where company_id=(select company_id from public.profiles where id='$uid')")
total=$(psql -At -c "select count(*) from public.projects")
check "RLS: member sees only own organisation's projects ($total exist in total)" "$(as_user "$uid" "select count(*) from public.projects;")" "$own"
check "RLS: unknown user sees no profiles" "$(as_user 00000000-0000-0000-0000-000000000001 "select count(*) from public.profiles;")" 0

# An ordinary member can't make themselves superadmin or move to another organisation (the
# protect_profile_privileged_fields trigger must refuse), but can still edit their own name.
refused() {
  psql -At -q 2>&1 <<EOF | grep -c "Not allowed to change role, company"
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, true) \g /dev/null
$2
rollback;
EOF
}
co_before=$(psql -At -c "select company_id from public.profiles where id='$uid'")
other_co=$(psql -At -c "select id from public.companies where id <> '$co_before' limit 1")
check "member cannot promote self to platform_admin (refused)" "$(refused "$uid" "update public.profiles set role='platform_admin' where id='$uid';")" 1
check "member cannot move self to another organisation (refused)" "$(refused "$uid" "update public.profiles set company_id='$other_co' where id='$uid';")" 1
check "member can still edit own name" "$(as_user "$uid" "update public.profiles set name='Test Name' where id='$uid'; select name from public.profiles where id='$uid';")" "Test Name"

[ "$fail" = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
