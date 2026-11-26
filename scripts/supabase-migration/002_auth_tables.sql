-- Our own login tables (replacing Supabase Auth). Safe to run more than once.
-- auth.users / auth.identities already exist (copied from Supabase by load_into_postgres.sh).

create table if not exists auth.refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  family_id   uuid not null,                 -- all tokens from one sign-in share a family
  token_hash  text not null unique,          -- sha256 of the token; the token itself is never stored
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  replaced_by uuid,
  user_agent  text,
  ip          text
);
create index if not exists refresh_tokens_user_idx on auth.refresh_tokens(user_id);
create index if not exists refresh_tokens_family_idx on auth.refresh_tokens(family_id);

create table if not exists auth.one_time_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  email       text not null,
  purpose     text not null check (purpose in ('verify_email', 'reset_password', 'magic_login')),
  token_hash  text not null unique,
  redirect_to text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists one_time_tokens_email_idx on auth.one_time_tokens(lower(email), purpose);

create table if not exists auth.email_suppressions (
  email      text primary key,               -- stored lower-case
  reason     text not null,                  -- bounce | complaint
  details    jsonb,
  created_at timestamptz not null default now()
);

-- Case-insensitive email lookups on auth.users (Supabase allowed one account per email)
create index if not exists users_email_lower_idx on auth.users(lower(email));

-- Keys Supabase had on auth.identities (pg_restore -t does not bring constraints along)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'identities_user_id_fkey') then
    alter table auth.identities add constraint identities_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'identities_provider_id_provider_unique') then
    alter table auth.identities add constraint identities_provider_id_provider_unique unique (provider_id, provider);
  end if;
end $$;
create index if not exists identities_user_id_idx on auth.identities(user_id);

-- Only the backend's system role touches these tables
revoke all on auth.refresh_tokens, auth.one_time_tokens, auth.email_suppressions from anon, authenticated;
grant all on auth.refresh_tokens, auth.one_time_tokens, auth.email_suppressions to service_role;
