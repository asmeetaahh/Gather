-- =============================================================================
-- Minimal emulation of the parts of a Supabase project that the GATHER migrations depend on.
--
-- WHY THIS EXISTS: the migrations are tested against PGlite (a real PostgreSQL engine running
-- in-process), because Docker / the Supabase CLI are not available in every environment. A
-- plain Postgres has none of Supabase's platform objects, so this file recreates just enough of
-- them. It is TEST-ONLY and is never applied to a real Supabase project.
--
-- It mirrors (from Supabase's public behaviour):
--   * roles anon / authenticated / service_role (service_role has BYPASSRLS)
--   * auth.users, auth.uid(), auth.role(), auth.jwt()  (claims read from request.jwt.claims)
--   * storage.buckets, storage.objects (RLS enabled), storage.foldername()
--   * the DEFAULT PRIVILEGES Supabase gives its API roles on new public tables — the GATHER
--     migrations must (and do) revoke these, so emulating them keeps the test honest.
--
-- LIMITATION: it is an approximation. Re-run the migrations on a real local Supabase stack
-- (`supabase db reset`, needs Docker) before relying on them in production.
-- =============================================================================

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- ---- auth ------------------------------------------------------------------------------------
create schema auth;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Same claim-reading behaviour as Supabase: PostgREST sets request.jwt.claims per request.
create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- ---- storage ---------------------------------------------------------------------------------
create schema storage;

create table storage.buckets (
  id                 text primary key,
  name               text not null unique,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now()
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

-- Real definition: returns the folder segments of an object path (everything but the file).
create function storage.foldername(name text) returns text[]
language plpgsql as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;

grant usage on schema storage to anon, authenticated, service_role;
-- Supabase lets its API roles attempt everything on storage tables; RLS is the gate.
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
grant execute on all functions in schema storage to anon, authenticated, service_role;

-- ---- public schema defaults ------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

-- What a fresh Supabase project does for the `postgres` role. The GATHER migrations revoke
-- these for anon/authenticated (see 20260921100000_types_and_helpers.sql).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
