#!/bin/sh
# Load a Supabase backup into our own Postgres (see docs/SUPABASE_MIGRATION_PLAN.md, section 4.3).
#
# Runs inside a postgres:17 container on the same Docker network as the target database:
#   /work   = extracted Supabase backup folder (full_all_schemas.dump, public_schema_and_data.sql, row_counts.txt)
#   env     = POSTGRES_PASSWORD (superuser), APP_PASSWORD (login role vision_app), PGHOST
#
# Refuses to run if the public schema already has tables, so it can never overwrite data.
set -eu
export PGUSER=postgres PGDATABASE=vision PGPASSWORD="$POSTGRES_PASSWORD"
cd /work

n=$(psql -Atc "select count(*) from information_schema.tables where table_schema='public'")
if [ "$n" != "0" ]; then echo "STOP: public schema already has $n tables"; exit 1; fi

echo "== 1. roles, extensions, auth helpers"
psql -q -v ON_ERROR_STOP=1 -v app_pw="$APP_PASSWORD" <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
select format('create role vision_app login noinherit password %L', :'app_pw')
 where not exists (select 1 from pg_roles where rolname='vision_app') \gexec
grant anon, authenticated, service_role to vision_app;
grant connect on database vision to vision_app;
revoke create on schema public from public;

create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
create extension if not exists "uuid-ossp" schema extensions;

create schema if not exists auth;
-- Same behaviour as Supabase: read the caller from the request.jwt.claims setting.
-- The setting is '' (not NULL) on a pooled connection after an earlier transaction used it,
-- so empty must mean "no caller" rather than fail to parse as JSON.
create or replace function auth.uid() returns uuid language sql stable as
  $f$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid $f$;
create or replace function auth.role() returns text language sql stable as
  $f$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'role', '') $f$;
create or replace function auth.email() returns text language sql stable as
  $f$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'email', '') $f$;
create or replace function auth.jwt() returns jsonb language sql stable as
  $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
SQL

echo "== 2. auth.users + auth.identities (structure and rows from the full dump)"
pg_restore --no-owner --no-privileges -s -n auth -t users -t identities -f - full_all_schemas.dump | psql -q -v ON_ERROR_STOP=1
pg_restore -a -n auth -t users -t identities -d vision full_all_schemas.dump
psql -q -v ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='auth.users'::regclass and contype='p') then
    alter table auth.users add primary key (id); end if;
  if not exists (select 1 from pg_constraint where conrelid='auth.identities'::regclass and contype='p') then
    alter table auth.identities add primary key (id); end if;
end $$;
SQL

echo "== 3. public schema + data"
psql -q -f public_schema_and_data.sql > /tmp/load.log 2>&1 || true
errs=$(grep -c ERROR /tmp/load.log || true)
echo "errors: $errs (expected 1: schema public already exists)"
grep ERROR /tmp/load.log | sort | uniq -c
if grep ERROR /tmp/load.log | grep -vq 'schema "public" already exists'; then echo "STOP: unexpected errors"; exit 1; fi

echo "== 4. trigger on auth.users (not part of the public dump)"
psql -q -v ON_ERROR_STOP=1 -c "create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user()"

echo "== 5. permissions (same as Supabase defaults; RLS still decides which rows)"
psql -q -v ON_ERROR_STOP=1 <<'SQL'
grant usage on schema public, extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant all on auth.users, auth.identities to service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
SQL
echo "load finished"
