-- BILL CAPTURE — Storage bucket and access policies.
--
-- This is NOT one of the numbered files in supabase/migrations/. The local
-- test harness (supabase/tests/local-harness.sql) only stubs the `auth`
-- schema Supabase provides, not `storage` — Supabase Storage is a separate
-- service with its own schema that only really exists on an actual Supabase
-- project. Putting this in supabase/migrations/ would break `npm run
-- db:test` for every migration after it, permanently, since that script
-- applies every file in the directory in order. So this is delivered and run
-- on its own, once, directly on the real project — same as
-- supabase/migrations/0030_bill_capture_drafts.sql, just filed separately
-- because it configures the platform rather than the application schema.
--
-- Run this once, any time relative to 0030 (the two don't depend on each
-- other at apply time — only at the moment someone actually uploads a bill).

insert into storage.buckets (id, name, public)
values ('bill-captures', 'bill-captures', false)
on conflict (id) do nothing;

-- Path convention: {company_id}/{draft_id}/original.{ext} — storage.foldername
-- splits a path by "/" and returns every segment except the filename, so
-- (storage.foldername(name))[1] is always the company id (Postgres arrays
-- are 1-indexed). Keyed directly off that segment means a page can never be
-- written into, or read out of, another tenant's folder, independent of
-- anything the application code does or forgets to check.
create policy bill_captures_insert on storage.objects for insert
  with check (
    bucket_id = 'bill-captures'
    and (select app_private.can_write_company(((storage.foldername(name))[1])::uuid))
  );

create policy bill_captures_select on storage.objects for select
  using (
    bucket_id = 'bill-captures'
    and (select app_private.is_company_member(((storage.foldername(name))[1])::uuid))
  );

-- Needed for upsert: the client uploads with upsert:true so a dropped
-- response can be retried by re-sending the same deterministic path rather
-- than leaving an orphaned duplicate, and Supabase Storage's upsert can
-- resolve to an UPDATE when the object already exists.
create policy bill_captures_update on storage.objects for update
  using (
    bucket_id = 'bill-captures'
    and (select app_private.can_write_company(((storage.foldername(name))[1])::uuid))
  );

-- No delete policy: a capture's photo is kept even once its draft is
-- rejected, as the record of what was reviewed and sent back — the same
-- stated choice the feature this was adapted from makes.
