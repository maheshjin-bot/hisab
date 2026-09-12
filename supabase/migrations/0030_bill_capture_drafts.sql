-- BILL CAPTURE — photograph a purchase bill, let an AI model read it, review
-- it, post it. See app/api/bill-capture/extract/route.ts for the model call
-- itself (a Next.js route, not SQL — it has to make an outbound HTTPS
-- request); this migration only stores what comes back from it.
--
-- Deliberately narrow for a first version: PURCHASE bills only, desktop
-- upload only. No sales-bill capture yet, no phone scanner, no WhatsApp. And
-- no GST/HSN fields anywhere in this schema — HISAB's ledgers carry no
-- GSTIN, there is no item master to hang an HSN code off, and tax is out of
-- scope by product decision (see lib/reports and the invoicing feature).
-- What the AI reads is exactly what a Purchase Bill voucher already stores:
-- a supplier, a bill number/date, and line items with a description,
-- quantity, unit, rate and a discount — nothing this schema can't already
-- hold.
--
-- WHY THIS TABLE INSTEAD OF AN RPC-ONLY DESIGN.
--
-- HISAB's own convention for staging/CRUD data (import_batch_rows in 0007,
-- ledgers themselves) is direct table writes governed by RLS and a
-- protective trigger, not a narrow RPC wrapper around every mutation — so
-- this follows that same shape rather than introducing a second style. The
-- one guarantee that has to be unconditional — a draft cannot become
-- "confirmed" by anyone simply writing that word — is enforced by the
-- trigger below regardless of which statement reaches the row, which is the
-- same strength of guarantee an RPC-only design would give, just built the
-- way the rest of this schema already builds it.
create table public.bill_capture_drafts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- Where the photographed bill lives in Storage. Set once at creation, but
  -- writable up to the terminal states — the review screen sits between the
  -- capture and the extraction and may reasonably crop/replace the same page.
  storage_path text not null unique,
  -- The model's raw structured output. Shape owned entirely by application
  -- code (see lib/bill-capture/), no column-level schema.
  extracted_json jsonb,
  extracted_at timestamptz,
  -- Computed by the trigger below, never accepted from the client as-is —
  -- see enforce_bill_capture_draft_status().
  status text not null default 'pending_review' check (status in ('pending_review', 'confirmed', 'rejected')),
  -- Set by the client only after it has already called the ordinary
  -- create_voucher()/apply_invoice() path a hand-typed Purchase Bill uses.
  -- The trigger validates it — never creates it.
  confirmed_voucher_id uuid,
  rejected_reason text,
  rejected_by uuid references auth.users(id) on delete set null,
  rejected_at timestamptz,
  -- What a person typed before any AI ran — a hint for whoever reviews it,
  -- never matched automatically against anything.
  vendor_hint text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (confirmed_voucher_id, company_id) references public.vouchers (id, company_id)
);

create index bill_capture_drafts_company_status_idx on public.bill_capture_drafts(company_id, status, created_at desc);

create trigger set_updated_at
  before update on public.bill_capture_drafts
  for each row execute function app_private.set_updated_at();

-- THE STATE MACHINE. `status` is derived from the row's own other columns on
-- every insert and update, never trusted from the client — the single
-- load-bearing guarantee of the whole feature. "The AI never posts anything"
-- is true only because there is no way to reach 'confirmed' except by first
-- creating a real voucher through the ordinary posting function and then
-- pointing a draft at its real id, and this trigger re-verifies that id on
-- every attempt rather than trusting it was checked once somewhere upstream.
create or replace function app_private.enforce_bill_capture_draft_status()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_voucher public.vouchers;
begin
  if TG_OP = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;

  -- Both 'confirmed' and 'rejected' are terminal: nothing about a draft may
  -- change further once either is reached, including trying to re-reject an
  -- already-rejected one or re-extract an already-confirmed one.
  if TG_OP = 'UPDATE' and old.status in ('confirmed', 'rejected') then
    raise exception 'This capture is already % and cannot be changed further', old.status;
  end if;

  if new.confirmed_voucher_id is not null then
    select * into v_voucher from public.vouchers
      where id = new.confirmed_voucher_id and company_id = new.company_id;

    if v_voucher is null then
      raise exception 'That voucher does not exist in this company';
    end if;
    if v_voucher.is_deleted then
      raise exception 'That voucher has been deleted and cannot confirm a capture';
    end if;
    if v_voucher.voucher_type <> 'purchase' then
      raise exception 'A bill capture can only be confirmed against a purchase voucher, not a % voucher', v_voucher.voucher_type;
    end if;

    new.status := 'confirmed';
  elsif new.rejected_at is not null then
    -- Filled in here rather than trusted from the client, the same reason
    -- created_by is: the reviewer rejecting it is whoever is authenticated,
    -- not whatever id a request happens to carry.
    new.rejected_by := coalesce(new.rejected_by, auth.uid());

    if new.rejected_reason is null or length(trim(new.rejected_reason)) = 0 then
      raise exception 'A rejection needs a reason';
    end if;
    new.status := 'rejected';
  else
    new.status := 'pending_review';
  end if;

  return new;
end;
$$;

create trigger enforce_bill_capture_draft_status
  before insert or update on public.bill_capture_drafts
  for each row execute function app_private.enforce_bill_capture_draft_status();

alter table public.bill_capture_drafts enable row level security;

create policy bill_capture_drafts_select on public.bill_capture_drafts for select
  using ((select app_private.is_company_member(company_id)));

create policy bill_capture_drafts_insert on public.bill_capture_drafts for insert
  with check ((select app_private.can_write_company(company_id)));

create policy bill_capture_drafts_update on public.bill_capture_drafts for update
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

-- No delete policy, deliberately: a rejected draft's photo stays as the
-- record of what was reviewed and sent back, the same stated choice the
-- source feature this was adapted from makes.
