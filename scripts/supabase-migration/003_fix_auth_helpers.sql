-- Fix for databases loaded before 26 Nov 2026 13:30: auth.uid() / role() / email() failed with
-- "invalid input syntax for type json" when request.jwt.claims was '' (a pooled connection that
-- served an earlier user request). Empty now means "no caller", like in Supabase. Safe to rerun.
create or replace function auth.uid() returns uuid language sql stable as
  $f$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid $f$;
create or replace function auth.role() returns text language sql stable as
  $f$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'role', '') $f$;
create or replace function auth.email() returns text language sql stable as
  $f$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'email', '') $f$;
