-- BILL CAPTURE — more than one photographed page per bill.
--
-- A genuinely multi-page bill (line items spilling onto a second sheet, a
-- long itemised delivery note) was a stated limitation of the first version:
-- "one extraction per document, read from page 1 only." This moves
-- bill_capture_drafts.storage_path out into its own child table so a draft
-- can hold any number of pages, in order.
--
-- Production already has real rows from the first version's own testing —
-- this backfills every existing draft's single photo as its page 1 before
-- dropping the column, so nothing already captured is lost.
create table public.bill_capture_pages (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null,
  company_id uuid not null,
  page_no smallint not null check (page_no >= 1),
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  unique (draft_id, page_no),
  foreign key (draft_id, company_id) references public.bill_capture_drafts (id, company_id) on delete cascade
);

create index bill_capture_pages_draft_idx on public.bill_capture_pages(draft_id, page_no);

-- Backfill before the column is dropped: every draft's one existing photo
-- becomes page 1 of that same draft.
insert into public.bill_capture_pages (draft_id, company_id, page_no, storage_path)
select id, company_id, 1, storage_path from public.bill_capture_drafts;

alter table public.bill_capture_drafts drop column storage_path;

alter table public.bill_capture_pages enable row level security;

create policy bill_capture_pages_select on public.bill_capture_pages for select
  using ((select app_private.is_company_member(company_id)));

-- Adding or removing a page only makes sense before a draft is settled —
-- both policies re-check the parent's own status rather than trusting the
-- terminal-state rule was already enforced somewhere upstream, the same
-- defensive-recheck discipline app_private.enforce_bill_capture_draft_status()
-- already applies to the draft row itself. There is no trigger on this table
-- to fall back on if a policy were ever loosened, so the check lives here.
create policy bill_capture_pages_insert on public.bill_capture_pages for insert
  with check (
    (select app_private.can_write_company(company_id))
    and exists (
      select 1 from public.bill_capture_drafts d
      where d.id = bill_capture_pages.draft_id and d.company_id = bill_capture_pages.company_id
        and d.status = 'pending_review'
    )
  );

-- No update policy: a page's photo is immutable once uploaded — remove and
-- re-add to replace one rather than overwrite it in place.
create policy bill_capture_pages_delete on public.bill_capture_pages for delete
  using (
    (select app_private.can_write_company(company_id))
    and exists (
      select 1 from public.bill_capture_drafts d
      where d.id = bill_capture_pages.draft_id and d.company_id = bill_capture_pages.company_id
        and d.status = 'pending_review'
    )
  );
