-- Private schema for internal functions that must run with elevated
-- privileges (SECURITY DEFINER) but should never be directly callable by
-- clients via PostgREST. Only "public" is exposed to the API by default.
create schema if not exists app_private;

-- gen_random_uuid() ships built into Postgres 13+, so every ID default in
-- this schema can rely on it with no extension needed.

-- Generic updated_at maintenance, reused by every table via
-- `create trigger set_updated_at before update ... execute function app_private.set_updated_at()`.
create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
