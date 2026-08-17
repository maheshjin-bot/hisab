-- Supabase compatibility shim for running the database test suite on a bare
-- PostgreSQL install.
--
-- THIS IS NOT PART OF THE SCHEMA. Nothing here is applied to any Supabase
-- project, and nothing here should ever be treated as a migration. It exists
-- for exactly one reason: `supabase/migrations/*.sql` and
-- `supabase/tests/guarantees.sql` are written against a Supabase database, and
-- a stock PostgreSQL has none of the pieces Supabase's platform supplies —
-- the `auth` schema, `auth.users`, `auth.uid()`, `auth.jwt()`, and the
-- `anon` / `authenticated` / `service_role` roles that GoTrue and PostgREST
-- create before any project migration runs. Without them migration 0002 fails
-- on its first foreign key and the whole chain stops.
--
-- What this file provides is deliberately the minimum the migrations and the
-- tests actually reference, discovered by reading them rather than by copying
-- Supabase's own auth schema:
--
--   * schema `auth`
--   * `auth.users`, with every column `pg_temp.make_user()` in guarantees.sql
--     names, and nothing else required to be non-null
--   * `auth.uid()`, `auth.jwt()`, `auth.role()`, `auth.email()`
--   * roles `anon`, `authenticated`, `service_role`
--
-- `auth.uid()` reproduces Supabase's own claim resolution exactly, because
-- guarantees.sql switches identity by setting those GUCs and every permission
-- assertion in sections 9-11 depends on it behaving identically: the
-- `request.jwt.claim.sub` GUC first, falling back to the `sub` key of the
-- `request.jwt.claims` JSON blob.
--
-- Idempotent and self-contained, so re-running the whole verification is one
-- command. See supabase/tests/README.md.

-- ------------------------------------------------------------------- roles
--
-- PostgREST and GoTrue own these on a real project. Only their existence
-- matters here: the migrations `grant execute ... to authenticated` and
-- attach `create policy ... to authenticated`, both of which need the role to
-- resolve. NOLOGIN because nothing should ever connect as one of them.
do $harness$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$harness$;

grant usage on schema public to anon, authenticated, service_role;

-- ------------------------------------------------------------ auth schema

create schema if not exists auth;

grant usage on schema auth to anon, authenticated, service_role;

-- A cut-down auth.users. The column list and the nullability are what matter:
-- `pg_temp.make_user()` in guarantees.sql inserts id, instance_id, aud, role,
-- email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
-- created_at and updated_at by name, and nothing outside that list may be
-- NOT NULL without a default or the fixture cannot build a user. The types
-- match Supabase's (varchar(255) for aud/role/email, jsonb for the metadata)
-- so that anything the migrations do with them — lower(email), a foreign key
-- on id, raw_user_meta_data ->> 'full_name' in app_private.handle_new_user()
-- — behaves the same way here.
create table if not exists auth.users (
  instance_id uuid,
  id uuid not null primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  confirmation_sent_at timestamptz,
  recovery_token varchar(255),
  recovery_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz,
  updated_at timestamptz,
  phone text default null,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);

-- Supabase enforces this; migration 0020's revoke trigger matches an invite
-- against a member's address with lower(), and 0002's accept_company_invite()
-- does the same, so a duplicate address would make both ambiguous.
create unique index if not exists users_email_partial_key
  on auth.users (email) where is_anonymous = false;

-- ---------------------------------------------------------- auth functions

-- Supabase's auth.uid(): the request's JWT `sub` claim. PostgREST sets
-- `request.jwt.claims` to the whole decoded token; older versions set the
-- flattened `request.jwt.claim.sub`. Both are read, flattened first, exactly
-- as the platform's own definition does — guarantees.sql's pg_temp.act_as()
-- sets `request.jwt.claims`, and sections 9-11 assert on what the migrations'
-- permission checks make of it.
--
-- The `true` second argument to current_setting() is what makes an unset GUC
-- return NULL instead of raising, which is how "nobody is signed in" reaches
-- the `auth.uid() is null` guards in create_company(),
-- accept_company_invite() and revert_company_changes_since().
create or replace function auth.uid()
returns uuid
language sql
stable
as $harness$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$harness$;

-- The whole claim set. 0005 and 0008 read `auth.jwt() ->> 'email'` to match a
-- pending invite against the caller without granting SELECT on auth.users.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $harness$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$harness$;

create or replace function auth.role()
returns text
language sql
stable
as $harness$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$harness$;

create or replace function auth.email()
returns text
language sql
stable
as $harness$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$harness$;

grant execute on function auth.uid(), auth.jwt(), auth.role(), auth.email()
  to anon, authenticated, service_role;

-- 0002 hangs an AFTER INSERT trigger on auth.users to mirror new signups into
-- public.profiles. The trigger function is security definer, so it runs as the
-- owner; the insert itself here is done by the test as the owner anyway.
grant select, insert, update, delete on auth.users to service_role;
grant select on auth.users to authenticated;
