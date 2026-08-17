-- Invoice lines: the detail behind a sales or purchase voucher.
--
-- Until now a sales "invoice" was Dr Debtor / Cr Sales and an amount. The
-- voucher form differed from a journal only in having a fixed party combobox
-- and harder role filtering; the data underneath was identical, and there was
-- no description, quantity, rate or unit anywhere in the schema. Nothing could
-- be printed and handed to a customer.
--
-- THE ARCHITECTURE, which is the part that must not be got wrong:
--
--   invoice_lines is the source. voucher_entries stays derived.
--
-- A generator turns the lines into balanced entries — one debit on the party
-- for the whole invoice, one credit per distinct revenue ledger for its
-- grouped subtotal, and the mirror image for a purchase. Underneath, it is
-- still ordinary double entry, so the deferred balance trigger, all five
-- reporting functions, the daybook, the audit trail and backup/restore keep
-- working completely untouched. Not one of them learns that invoices exist.
--
-- The corollary is a rule: no report may ever read invoice_lines. If a
-- statement, a tile or a total is ever tempted to, the design has gone wrong —
-- it means the entries stopped being a faithful summary of the lines, and the
-- fix is to the generator, not to the report.
--
-- What is deliberately NOT here: tax, GST, HSN, e-invoicing, Rule 46
-- compliance, an items master, inventory. Not even columns "ready for" them.
-- That is a different product; hooks left here for it are how the two get
-- entangled.
--
-- Backward compatibility is absolute. There are 57 sales and purchase vouchers
-- in the books with no invoice lines. A voucher with no invoice lines is a
-- valid voucher, permanently — this is not a migration that upgrades them, and
-- nothing below makes an invoice mandatory for anything.

-- --------------------------------------------- 1. who the invoice is from

-- companies carried a name and nothing else you could print on a document.
-- Nullable, because the 23 companies already in the books have none of this
-- and must keep saving without it. Nothing more: no GSTIN, no PAN — those
-- belong to the tax work that is explicitly out of scope.
alter table public.companies
  add column if not exists address text,
  add column if not exists phone text,
  add column if not exists email text;

-- Same shape as the check on ledgers.email, so an address book and a company
-- header agree about what an email address looks like.
alter table public.companies
  add constraint companies_email_check
  check (email is null or email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');

-- ------------------------------------------------------------ 2. the table

-- Tenancy follows the pattern every table here uses: a redundant company_id
-- and composite foreign keys into (id, company_id). That is what makes a
-- cross-company reference *unrepresentable* rather than merely blocked by a
-- policy — an invoice line crediting another company's income ledger cannot be
-- written down at all, by anyone, including a security-definer function.
--
-- On the numeric precisions, which are not all numeric(18,2):
--
--   * quantity numeric(18,3). A quantity is not money. Goods are sold by the
--     gram, the millilitre and the metre, and 2dp cannot hold 1.125 kg. Three
--     places also covers time billed to the minute closely enough for an
--     invoice line.
--   * rate numeric(18,4). A rate is a unit price, not an amount. Sub-paisa
--     unit prices are ordinary — 0.0850 per unit on a run of ten thousand is
--     a real quotation, and rounding it to 0.09 at data-entry time would
--     misprice the line by 6%. Four places is what most price lists carry.
--   * discount_amount and line_amount numeric(18,2), because both are money.
--
--   * line_amount is GENERATED ALWAYS ... STORED, and this is the load-bearing
--     decision of the whole migration. The paise are settled exactly once, per
--     line, and never recomputed: round(quantity * rate, 2) - discount_amount.
--     Everything downstream — the grouped credit, the party debit, the voucher
--     total, the Trial Balance — is a sum of these already-2dp values, so all
--     of them agree to the paise by construction rather than by arithmetic
--     luck. Three lines at 33.333 store 33.33 each and post 99.99; a generator
--     that grouped the raw quantity x rate would credit round(99.999) = 100.00
--     against a party debited 99.99 and leave the books a paisa out on every
--     invoice with an odd rate.
--
--     Generated rather than supplied-and-checked because the alternative fails
--     the wrong way round: the client computes line totals in JavaScript
--     floating point, and a supplied value would turn a half-paisa
--     disagreement into a rejected save the user cannot act on. The database
--     is the authority on what a line is worth, and the form re-reads it.
create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null,
  company_id uuid not null,
  -- The income ledger a sales line credits, or the expense ledger a purchase
  -- line debits. Per line, not per voucher: one invoice may carry goods and
  -- freight and a service charge, each belonging in a different ledger.
  revenue_ledger_id uuid not null,
  line_order smallint not null default 0,
  description text not null check (length(trim(description)) > 0),
  quantity numeric(18,3) not null default 1 check (quantity > 0),
  -- Nullable: services have no unit, and "1 nos" of consulting is noise on a
  -- printed invoice.
  unit text check (unit is null or length(trim(unit)) > 0),
  rate numeric(18,4) not null default 0 check (rate >= 0),
  discount_amount numeric(18,2) not null default 0 check (discount_amount >= 0),
  line_amount numeric(18,2) generated always as (round(quantity * rate, 2) - discount_amount) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A discount larger than the line it discounts is not a discount, and a
  -- negative line would post backwards.
  check (line_amount >= 0),
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id) on delete cascade,
  foreign key (revenue_ledger_id, company_id) references public.ledgers (id, company_id)
);

-- Both indexes back a composite foreign key, which is what 0008 added the
-- equivalents on voucher_entries for: without them, deleting a ledger or a
-- voucher sequentially scans this table.
create index invoice_lines_voucher_company_idx on public.invoice_lines(voucher_id, company_id);
create index invoice_lines_ledger_company_idx on public.invoice_lines(revenue_ledger_id, company_id);

create trigger set_updated_at
  before update on public.invoice_lines
  for each row execute function app_private.set_updated_at();

comment on table public.invoice_lines is
  'The itemised detail behind a sales or purchase voucher. The source; voucher_entries is derived from it by app_private.generate_invoice_entries(). No report reads this table.';

comment on column public.invoice_lines.line_amount is
  'round(quantity * rate, 2) - discount_amount, settled once per line so every total downstream agrees to the paise. Generated: never written by a client.';

-- ------------------------------- 3. the lines and the postings cannot drift

-- invoice_lines is client-writable (see the policies below), exactly as
-- voucher_entries is, so it needs the same kind of backstop the double-entry
-- trigger gives the entries. The invariant: if a voucher has invoice lines at
-- all, they total what the voucher was posted for.
--
-- Compared against the sum of the entries rather than against
-- vouchers.total_amount, because total_amount is itself written by the
-- deferred balance trigger and the two triggers' firing order at COMMIT is not
-- something to depend on. Comparing against the postings is both earlier and
-- exact; total_amount then agrees transitively, since the balance trigger sets
-- it to that same sum.
--
-- A voucher with no invoice lines returns immediately and always will. That is
-- the backward-compatibility guarantee expressed as code.
create or replace function app_private.check_invoice_lines_match(p_voucher_id uuid)
returns void language plpgsql
security definer set search_path = ''
as $$
declare
  v_count integer;
  v_lines numeric(18,2);
  v_posted numeric(18,2);
begin
  if not exists (select 1 from public.vouchers where id = p_voucher_id) then
    return; -- header deleted in this same transaction — nothing to validate
  end if;

  select count(*), coalesce(sum(line_amount), 0)
    into v_count, v_lines
    from public.invoice_lines where voucher_id = p_voucher_id;

  if v_count = 0 then
    return; -- a voucher with no invoice lines is a valid voucher, permanently
  end if;

  select coalesce(sum(debit_amount), 0)
    into v_posted
    from public.voucher_entries where voucher_id = p_voucher_id;

  if v_lines <> v_posted then
    raise exception 'Voucher %: its invoice lines total % but it is posted for %', p_voucher_id, v_lines, v_posted;
  end if;
end;
$$;

create or replace function app_private.trg_invoice_lines_match() returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if TG_OP = 'DELETE' then
    perform app_private.check_invoice_lines_match(old.voucher_id);
    return old;
  else
    perform app_private.check_invoice_lines_match(new.voucher_id);
    if TG_OP = 'UPDATE' and old.voucher_id is distinct from new.voucher_id then
      perform app_private.check_invoice_lines_match(old.voucher_id);
    end if;
    return new;
  end if;
end;
$$;

create constraint trigger trg_invoice_lines_match
after insert or update or delete on public.invoice_lines
deferrable initially deferred
for each row execute function app_private.trg_invoice_lines_match();

-- Also on the entries, so the invariant holds from both directions: rewriting
-- a posting behind an invoice that still says something else is the same
-- corruption seen from the other side.
create constraint trigger trg_voucher_entries_invoice_match
after insert or update or delete on public.voucher_entries
deferrable initially deferred
for each row execute function app_private.trg_invoice_lines_match();

-- --------------------------------------------------------------- 4. the RLS

-- Byte-for-byte the voucher_entries policies from 0005 with the table name
-- changed, including the lock-date rule in insert/update/delete. An accountant
-- who cannot touch a closed period's postings must not be able to rewrite what
-- the invoice behind them says either — that document is what a tax auditor
-- reads. DELETE is allowed for the same reason it is on voucher_entries:
-- update_voucher()'s atomic replace-all flow needs it.
alter table public.invoice_lines enable row level security;

create policy invoice_lines_select on public.invoice_lines for select
  using ((select app_private.is_company_member(company_id)));

create policy invoice_lines_insert on public.invoice_lines for insert
  with check (
    (select app_private.can_write_company(company_id))
    and exists (
      select 1 from public.vouchers v
      where v.id = invoice_lines.voucher_id and v.company_id = invoice_lines.company_id
        and (
          (select app_private.is_company_admin(v.company_id))
          or v.voucher_date > coalesce((select lock_date from public.companies where id = v.company_id), '1900-01-01')
        )
    )
  );

create policy invoice_lines_update on public.invoice_lines for update
  using (
    (select app_private.can_write_company(company_id))
    and exists (
      select 1 from public.vouchers v
      where v.id = invoice_lines.voucher_id and v.company_id = invoice_lines.company_id
        and (
          (select app_private.is_company_admin(v.company_id))
          or v.voucher_date > coalesce((select lock_date from public.companies where id = v.company_id), '1900-01-01')
        )
    )
  );

create policy invoice_lines_delete on public.invoice_lines for delete
  using (
    (select app_private.can_write_company(company_id))
    and exists (
      select 1 from public.vouchers v
      where v.id = invoice_lines.voucher_id and v.company_id = invoice_lines.company_id
        and (
          (select app_private.is_company_admin(v.company_id))
          or v.voucher_date > coalesce((select lock_date from public.companies where id = v.company_id), '1900-01-01')
        )
    )
  );

-- --------------------------------------------------------- 5. the generator

-- Turns a voucher's invoice lines into balanced double entry.
--
--   sales:    Dr the party for the total
--             Cr each distinct revenue ledger for its grouped subtotal
--   purchase: the mirror image
--
-- Grouping is the point: three lines against one sales ledger produce one
-- credit, not three. A ledger statement should show what was invoiced to that
-- account, not a transcription of the customer's order form.
--
-- Every figure here is a sum of line_amount values, which are already settled
-- to 2dp by the generated column. Nothing is rounded a second time, so the
-- party debit and the grouped credits are the same number reached two ways and
-- balance exactly — including at 33.333 x 3 = 99.99.
--
-- security invoker, like create_voucher itself: the RLS on voucher_entries
-- must still gate the role and lock-date checks as the calling user. An
-- invoice is not a way to post entries you could not post by hand.
create or replace function app_private.generate_invoice_entries(
  p_voucher_id uuid,
  p_party_ledger_id uuid
) returns void
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_company_id uuid;
  v_type text;
  v_total numeric(18,2);
  v_order smallint := 0;
  v_group record;
begin
  select company_id, voucher_type into v_company_id, v_type
    from public.vouchers where id = p_voucher_id;
  if v_company_id is null then
    raise exception 'Voucher not found';
  end if;
  if v_type not in ('sales', 'purchase') then
    raise exception 'Invoice lines are only for sales and purchase vouchers, not %', v_type;
  end if;
  if p_party_ledger_id is null then
    raise exception 'An invoice needs a party ledger: the customer to debit, or the supplier to credit';
  end if;

  select coalesce(sum(line_amount), 0) into v_total
    from public.invoice_lines where voucher_id = p_voucher_id;

  if v_total <= 0 then
    raise exception 'An invoice must come to more than nothing (this one totals %)', v_total;
  end if;

  -- The party leg, first, for the whole invoice.
  insert into public.voucher_entries
    (voucher_id, company_id, ledger_id, debit_amount, credit_amount, narration, line_order)
  values (
    p_voucher_id, v_company_id, p_party_ledger_id,
    case when v_type = 'sales' then v_total else 0 end,
    case when v_type = 'sales' then 0 else v_total end,
    null, 0
  );

  -- One entry per distinct revenue ledger, ordered by where that ledger first
  -- appears on the invoice so the voucher reads in the order it was written.
  --
  -- A group summing to zero is skipped rather than posted: voucher_entries
  -- refuses a row that is neither a debit nor a credit, and a free line ("1
  -- sample, no charge") is a perfectly ordinary thing to put on an invoice.
  -- Skipping it cannot unbalance anything, because the party leg is the sum of
  -- every line and the skipped groups contribute nothing to it.
  for v_group in
    select l.revenue_ledger_id, sum(l.line_amount) as amount
    from public.invoice_lines l
    where l.voucher_id = p_voucher_id
    group by l.revenue_ledger_id
    having sum(l.line_amount) <> 0
    order by min(l.line_order), min(l.created_at), l.revenue_ledger_id
  loop
    v_order := v_order + 1;
    insert into public.voucher_entries
      (voucher_id, company_id, ledger_id, debit_amount, credit_amount, narration, line_order)
    values (
      p_voucher_id, v_company_id, v_group.revenue_ledger_id,
      case when v_type = 'sales' then 0 else v_group.amount end,
      case when v_type = 'sales' then v_group.amount else 0 end,
      null, v_order
    );
  end loop;
end;
$$;

-- 0009 grants execute on app_private to authenticated and sets a default
-- privilege for future functions, but default privileges are recorded per
-- granting role, and both functions here are reached from security *invoker*
-- RPCs. That is exactly the shape of the bug 0009 was written to fix, so the
-- grants are restated rather than assumed — as 0018 restates its own.
grant execute on function app_private.generate_invoice_entries(uuid, uuid) to authenticated;

-- Validates the payload, writes the lines, then posts them. The one place
-- create_voucher and update_voucher share, so an invoice saved by either takes
-- exactly the same route into the books.
create or replace function app_private.apply_invoice(
  p_voucher_id uuid,
  p_company_id uuid,
  p_voucher_type text,
  p_lines jsonb,
  p_invoice jsonb
) returns void
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_party uuid;
  v_lines jsonb;
  v_line jsonb;
  v_description text;
begin
  if p_voucher_type not in ('sales', 'purchase') then
    raise exception 'Invoice lines are only for sales and purchase vouchers, not %', p_voucher_type;
  end if;

  -- One write path, not two. A caller that supplied both would be asking the
  -- database to decide which of the two the books should believe.
  if coalesce(jsonb_array_length(p_lines), 0) > 0 then
    raise exception 'A voucher cannot be saved with both hand-entered lines and invoice lines: send one or the other';
  end if;

  v_party := nullif(p_invoice->>'party_ledger_id', '')::uuid;
  if v_party is null then
    raise exception 'An invoice needs a party ledger: the customer to debit, or the supplier to credit';
  end if;

  v_lines := p_invoice->'lines';
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'An invoice needs at least one line';
  end if;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_description := nullif(trim(coalesce(v_line->>'description', '')), '');
    if v_description is null then
      raise exception 'Every invoice line needs a description';
    end if;
    if nullif(v_line->>'revenue_ledger_id', '') is null then
      raise exception 'Invoice line "%" needs a ledger to post to', v_description;
    end if;

    insert into public.invoice_lines (
      voucher_id, company_id, revenue_ledger_id, line_order,
      description, quantity, unit, rate, discount_amount
    ) values (
      p_voucher_id,
      p_company_id,
      (v_line->>'revenue_ledger_id')::uuid,
      coalesce((v_line->>'line_order')::int, 0),
      v_description,
      coalesce((v_line->>'quantity')::numeric, 1),
      nullif(trim(coalesce(v_line->>'unit', '')), ''),
      coalesce((v_line->>'rate')::numeric, 0),
      coalesce((v_line->>'discount_amount')::numeric, 0)
    );
  end loop;

  perform app_private.generate_invoice_entries(p_voucher_id, v_party);
end;
$$;

grant execute on function app_private.apply_invoice(uuid, uuid, text, jsonb, jsonb) to authenticated;

-- -------------------------------------------------------- 6. the write path

-- Both RPCs grow one optional trailing argument. They are dropped and
-- recreated rather than left alongside a new overload: two functions differing
-- only by a defaulted argument are ambiguous to PostgREST, which resolves an
-- RPC by the names of the keys posted to it and would have two candidates for
-- every existing call. Neither carries an explicit ACL (0004 created both with
-- the default), so dropping loses nothing that has to be restated.
--
-- When p_invoice is absent, both behave exactly as they did — the p_lines loop
-- below is 0004's, unchanged, and no invoice line is created, looked for, or
-- required. That is what keeps the 57 existing sales and purchase vouchers
-- working, reporting identically and editable.
drop function if exists public.create_voucher(uuid, text, date, text, text, date, jsonb);

create or replace function public.create_voucher(
  p_company_id uuid, p_voucher_type text, p_voucher_date date,
  p_narration text, p_reference_number text, p_reference_date date,
  p_lines jsonb, -- [{"ledger_id":"...","debit_amount":100.00,"credit_amount":0,"narration":"...","line_order":0}]
  -- Optional. When present, p_lines must be empty and the entries are
  -- generated from these instead:
  --   {"party_ledger_id":"...",
  --    "lines":[{"line_order":0,"description":"Widgets","quantity":10,
  --              "unit":"nos","rate":100.0000,"discount_amount":0,
  --              "revenue_ledger_id":"..."}]}
  p_invoice jsonb default null
) returns uuid
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_voucher_id uuid;
  v_display_number text;
  v_seq_number int;
  v_fy_label text;
  v_line jsonb;
begin
  select display_number, seq_number, fy_label
    into v_display_number, v_seq_number, v_fy_label
    from app_private.next_voucher_number(p_company_id, p_voucher_type, p_voucher_date);

  insert into public.vouchers (
    company_id, voucher_type, voucher_number, sequence_number, financial_year_label,
    voucher_date, narration, reference_number, reference_date, created_by
  )
  values (
    p_company_id, p_voucher_type, v_display_number, v_seq_number, v_fy_label,
    p_voucher_date, p_narration, p_reference_number, p_reference_date, auth.uid()
  )
  returning id into v_voucher_id;

  if p_invoice is null or jsonb_typeof(p_invoice) = 'null' then
    for v_line in select * from jsonb_array_elements(p_lines) loop
      insert into public.voucher_entries (voucher_id, company_id, ledger_id, debit_amount, credit_amount, narration, line_order)
      values (
        v_voucher_id, p_company_id, (v_line->>'ledger_id')::uuid,
        coalesce((v_line->>'debit_amount')::numeric, 0),
        coalesce((v_line->>'credit_amount')::numeric, 0),
        v_line->>'narration',
        coalesce((v_line->>'line_order')::int, 0)
      );
    end loop;
  else
    perform app_private.apply_invoice(v_voucher_id, p_company_id, p_voucher_type, p_lines, p_invoice);
  end if;

  return v_voucher_id;
end;
$$;

-- 0018's update_voucher, with the invoice payload added. The financial-year
-- guard stays exactly where it was, ahead of every write, so a refused edit
-- still leaves the header untouched, the entries unreplaced *and* the invoice
-- lines unreplaced — not an invoice stripped of its lines by an edit that then
-- changed its mind.
--
-- The invoice lines are replaced the same way the entries always have been:
-- deleted and rewritten inside the one transaction, never patched.
drop function if exists public.update_voucher(uuid, date, text, text, date, jsonb);

create or replace function public.update_voucher(
  p_voucher_id uuid,
  p_voucher_date date,
  p_narration text,
  p_reference_number text,
  p_reference_date date,
  p_lines jsonb,
  p_invoice jsonb default null
) returns uuid
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_company_id uuid;
  v_voucher_type text;
  v_stored_year text;
  v_stored_number text;
  v_new_year text;
  v_line jsonb;
begin
  select company_id, voucher_type, financial_year_label, voucher_number
    into v_company_id, v_voucher_type, v_stored_year, v_stored_number
    from public.vouchers where id = p_voucher_id;
  if v_company_id is null then
    raise exception 'Voucher not found';
  end if;

  -- The number this voucher already carries was minted from the year of the
  -- date it had at the time. If the new date lands in a different year, that
  -- number stops describing it, and the only honest repairs are renumbering
  -- (which breaks paper already issued) or refusing. Refuse.
  --
  -- NULL is left alone on purpose: the NOT NULL constraint on voucher_date is
  -- a clearer complaint than a year comparison against nothing.
  if p_voucher_date is not null then
    v_new_year := app_private.financial_year_label(v_company_id, p_voucher_date);

    if v_new_year is distinct from v_stored_year then
      raise exception
        'Cannot move voucher % from financial year % to %: its number was issued from the % series and may already have been printed or sent, so it cannot be renumbered. Delete this voucher and re-enter it in %.',
        v_stored_number, v_stored_year, v_new_year, v_stored_year, v_new_year;
    end if;
  end if;

  -- An invoice saved back without its invoice payload would have its lines
  -- deleted along with its entries and be rewritten as a plain voucher — the
  -- item detail, the quantities and the rates gone, silently, with the totals
  -- still tallying so nothing downstream would notice. That is not an edit a
  -- user ever means to make; it is what happens when a form that predates
  -- invoicing is pointed at one. Refuse, in the same spirit as the year guard
  -- above: loudly, before any write, saying what to do instead.
  --
  -- This can only fire on a voucher created by the invoice path. The 57
  -- vouchers already in the books have no invoice lines and never take this
  -- branch.
  if (p_invoice is null or jsonb_typeof(p_invoice) = 'null')
     and exists (select 1 from public.invoice_lines where voucher_id = p_voucher_id) then
    raise exception
      'Voucher % is an invoice, so it has to be saved as one: sending plain voucher lines would discard its descriptions, quantities and rates. Edit it on the invoice form, or delete it and re-enter it.',
      v_stored_number;
  end if;

  update public.vouchers
    set voucher_date = p_voucher_date,
        narration = p_narration,
        reference_number = p_reference_number,
        reference_date = p_reference_date,
        updated_by = auth.uid()
    where id = p_voucher_id;

  delete from public.voucher_entries where voucher_id = p_voucher_id;
  delete from public.invoice_lines where voucher_id = p_voucher_id;

  if p_invoice is null or jsonb_typeof(p_invoice) = 'null' then
    for v_line in select * from jsonb_array_elements(p_lines) loop
      insert into public.voucher_entries (voucher_id, company_id, ledger_id, debit_amount, credit_amount, narration, line_order)
      values (
        p_voucher_id, v_company_id, (v_line->>'ledger_id')::uuid,
        coalesce((v_line->>'debit_amount')::numeric, 0),
        coalesce((v_line->>'credit_amount')::numeric, 0),
        v_line->>'narration',
        coalesce((v_line->>'line_order')::int, 0)
      );
    end loop;
  else
    perform app_private.apply_invoice(p_voucher_id, v_company_id, v_voucher_type, p_lines, p_invoice);
  end if;

  return p_voucher_id;
end;
$$;

-- ------------------------------------------------------------- 7. the audit

-- Without this, editing an invoice leaves no trace in History and — worse —
-- there is nothing for the undo below to replay, so an undo would rewind the
-- postings and leave the invoice describing a version of itself the ledgers no
-- longer hold.
create trigger audit_invoice_lines
  after insert or update or delete on public.invoice_lines
  for each row execute function app_private.record_audit_log();

-- ------------------------------------------------- 8. backup and restore

-- 0013's export, with invoice_lines added. The format version stays at 1: an
-- older restore reading a newer file is not a situation that can arise (the
-- migration chain only moves forward), while bumping it would make
-- restore_company_backup refuse the very files this function now writes. Files
-- written before today simply have no invoice_lines key, which the restore
-- below coalesces away.
create or replace function public.export_company_backup(p_company_id uuid)
returns jsonb
language plpgsql
security definer set search_path = ''
stable
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to export a backup';
  end if;
  if not app_private.is_company_member(p_company_id) then
    raise exception 'You are not a member of this company';
  end if;

  select jsonb_build_object(
    'format', 'hisab.company-backup',
    'version', 1,
    'exported_at', now(),
    -- Deliberately absent: company_members and company_invites (they
    -- reference auth.users ids that mean nothing in another project, and a
    -- backup should not be a way to move accounts around), audit_log (it is
    -- the record of changes, not the data), and import_batches.
    'company', (
      select to_jsonb(c) from public.companies c where c.id = p_company_id
    ),
    'account_groups', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.sort_order, g.name)
      from public.account_groups g where g.company_id = p_company_id
    ), '[]'::jsonb),
    'ledgers', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.name)
      from public.ledgers l where l.company_id = p_company_id
    ), '[]'::jsonb),
    'vouchers', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.voucher_date, v.sequence_number)
      from public.vouchers v where v.company_id = p_company_id
    ), '[]'::jsonb),
    'voucher_entries', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.voucher_id, e.line_order)
      from public.voucher_entries e where e.company_id = p_company_id
    ), '[]'::jsonb),
    'invoice_lines', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.voucher_id, i.line_order)
      from public.invoice_lines i where i.company_id = p_company_id
    ), '[]'::jsonb),
    'voucher_number_sequences', coalesce((
      select jsonb_agg(to_jsonb(s))
      from public.voucher_number_sequences s where s.company_id = p_company_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- 0013's restore, with three changes: the company's new address/phone/email
-- are carried over in both modes, invoice_lines are wiped alongside everything
-- else when overwriting, and they are re-inserted after the entries with both
-- of their references remapped through the same id maps the rest of the
-- restore uses.
create or replace function public.restore_company_backup(
  p_payload jsonb,
  p_mode text default 'new',              -- 'new' | 'overwrite'
  p_target_company_id uuid default null   -- required when overwriting
) returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_row jsonb;
  v_new_id uuid;
  v_group_map jsonb := '{}'::jsonb;   -- backup id -> restored id
  v_ledger_map jsonb := '{}'::jsonb;
  v_voucher_map jsonb := '{}'::jsonb;
  v_pass int := 0;
  v_placed int;
  v_pending int;
begin
  if v_user is null then
    raise exception 'Must be authenticated to restore a backup';
  end if;

  if p_payload->>'format' is distinct from 'hisab.company-backup' then
    raise exception 'That file is not a HISAB company backup';
  end if;
  if coalesce((p_payload->>'version')::int, 0) > 1 then
    raise exception 'That backup was written by a newer version of HISAB (format version %)', p_payload->>'version';
  end if;

  -- ---- decide where the data is going ----------------------------------
  if p_mode = 'overwrite' then
    if p_target_company_id is null then
      raise exception 'Overwriting needs a company to overwrite';
    end if;
    -- `is not true`, not `not ...`: a NULL from the permission helper would
    -- make `not NULL` -> NULL, skip the raise, and let a non-member through.
    if app_private.is_company_admin(p_target_company_id) is not true then
      raise exception 'Only an admin can replace a company from a backup';
    end if;
    v_company := p_target_company_id;

    -- Children first: invoice lines and entries reference vouchers and
    -- ledgers, ledgers reference groups. System groups stay — the trigger
    -- forbids deleting them, and they are matched by nature below rather than
    -- recreated.
    delete from public.invoice_lines where company_id = v_company;
    delete from public.voucher_entries where company_id = v_company;
    delete from public.vouchers where company_id = v_company;
    delete from public.ledgers where company_id = v_company;
    delete from public.account_groups where company_id = v_company and is_system = false;
    delete from public.voucher_number_sequences where company_id = v_company;

    update public.companies set
      name = coalesce(p_payload->'company'->>'name', name),
      book_beginning_date = (p_payload->'company'->>'book_beginning_date')::date,
      financial_year_start_month = (p_payload->'company'->>'financial_year_start_month')::smallint,
      base_currency = p_payload->'company'->>'base_currency',
      lock_date = nullif(p_payload->'company'->>'lock_date', '')::date,
      address = p_payload->'company'->>'address',
      phone = p_payload->'company'->>'phone',
      email = p_payload->'company'->>'email'
    where id = v_company;

  elsif p_mode = 'new' then
    -- create_company seeds a fresh chart of accounts and makes the caller an
    -- admin. The seeded sub-groups are then dropped, because the backup
    -- carries its own — including any the user added or renamed. Nothing
    -- references them yet, so this is safe.
    v_company := public.create_company(
      coalesce(p_payload->'company'->>'name', 'Restored company'),
      (p_payload->'company'->>'book_beginning_date')::date,
      (p_payload->'company'->>'financial_year_start_month')::smallint,
      (p_payload->'company'->>'base_currency')::char(3)
    );

    delete from public.account_groups where company_id = v_company and is_system = false;

    update public.companies
      set lock_date = nullif(p_payload->'company'->>'lock_date', '')::date,
          address = p_payload->'company'->>'address',
          phone = p_payload->'company'->>'phone',
          email = p_payload->'company'->>'email'
      where id = v_company;
  else
    raise exception 'Unknown restore mode: %', p_mode;
  end if;

  -- ---- account groups ---------------------------------------------------
  -- The eight system groups can't be created or deleted, but there is exactly
  -- one per nature, so they are matched on that rather than on name — which
  -- keeps working even if the user renamed one.
  for v_row in select * from jsonb_array_elements(p_payload->'account_groups') loop
    if coalesce((v_row->>'is_system')::boolean, false) then
      select id into v_new_id
        from public.account_groups
        where company_id = v_company and is_system and nature = v_row->>'nature';

      if v_new_id is not null then
        update public.account_groups
          set name = v_row->>'name',
              ledger_role = v_row->>'ledger_role',
              sort_order = coalesce((v_row->>'sort_order')::smallint, 0)
          where id = v_new_id;
        v_group_map := v_group_map || jsonb_build_object(v_row->>'id', v_new_id);
      end if;
    end if;
  end loop;

  -- Sub-groups can nest arbitrarily deep, so place whichever ones have a
  -- mapped parent and repeat. A pass that places nothing while work remains
  -- means the backup references a parent it doesn't contain.
  loop
    v_pass := v_pass + 1;
    v_placed := 0;
    v_pending := 0;

    for v_row in select * from jsonb_array_elements(p_payload->'account_groups') loop
      if coalesce((v_row->>'is_system')::boolean, false) then continue; end if;
      if v_group_map ? (v_row->>'id') then continue; end if;

      if v_row->>'parent_group_id' is null then
        insert into public.account_groups
          (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
        values
          (v_company, null, v_row->>'name', v_row->>'nature', v_row->>'normal_balance',
           v_row->>'ledger_role', coalesce((v_row->>'sort_order')::smallint, 0))
        returning id into v_new_id;

        v_group_map := v_group_map || jsonb_build_object(v_row->>'id', v_new_id);
        v_placed := v_placed + 1;

      elsif v_group_map ? (v_row->>'parent_group_id') then
        insert into public.account_groups
          (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
        values
          (v_company, (v_group_map->>(v_row->>'parent_group_id'))::uuid, v_row->>'name',
           v_row->>'nature', v_row->>'normal_balance', v_row->>'ledger_role',
           coalesce((v_row->>'sort_order')::smallint, 0))
        returning id into v_new_id;

        v_group_map := v_group_map || jsonb_build_object(v_row->>'id', v_new_id);
        v_placed := v_placed + 1;
      else
        v_pending := v_pending + 1;
      end if;
    end loop;

    exit when v_pending = 0;
    if v_placed = 0 then
      raise exception 'Backup has % account group(s) whose parent group is missing from the file', v_pending;
    end if;
    if v_pass > 50 then
      raise exception 'Account groups in this backup are nested too deeply to restore';
    end if;
  end loop;

  -- ---- ledgers ----------------------------------------------------------
  for v_row in select * from jsonb_array_elements(p_payload->'ledgers') loop
    if not (v_group_map ? (v_row->>'group_id')) then
      raise exception 'Ledger "%" refers to an account group missing from the backup', v_row->>'name';
    end if;

    insert into public.ledgers (
      company_id, group_id, name, opening_balance_amount, opening_balance_type,
      contact_person, phone, email, address, notes, is_active, created_by
    ) values (
      v_company,
      (v_group_map->>(v_row->>'group_id'))::uuid,
      v_row->>'name',
      coalesce((v_row->>'opening_balance_amount')::numeric, 0),
      coalesce(v_row->>'opening_balance_type', 'debit'),
      v_row->>'contact_person',
      v_row->>'phone',
      v_row->>'email',
      v_row->>'address',
      v_row->>'notes',
      coalesce((v_row->>'is_active')::boolean, true),
      -- The original author's id belongs to whichever project made the
      -- backup, so authorship is re-stamped to whoever restored it.
      v_user
    ) returning id into v_new_id;

    v_ledger_map := v_ledger_map || jsonb_build_object(v_row->>'id', v_new_id);
  end loop;

  -- ---- vouchers ---------------------------------------------------------
  -- Numbers, dates and sequence positions are carried over verbatim: a
  -- restored book has to agree with whatever was printed or filed from the
  -- original.
  for v_row in select * from jsonb_array_elements(p_payload->'vouchers') loop
    insert into public.vouchers (
      company_id, voucher_type, voucher_number, sequence_number, financial_year_label,
      voucher_date, narration, reference_number, reference_date, is_deleted, created_by
    ) values (
      v_company,
      v_row->>'voucher_type',
      v_row->>'voucher_number',
      (v_row->>'sequence_number')::int,
      v_row->>'financial_year_label',
      (v_row->>'voucher_date')::date,
      v_row->>'narration',
      v_row->>'reference_number',
      nullif(v_row->>'reference_date', '')::date,
      coalesce((v_row->>'is_deleted')::boolean, false),
      v_user
    ) returning id into v_new_id;

    v_voucher_map := v_voucher_map || jsonb_build_object(v_row->>'id', v_new_id);
  end loop;

  -- ---- voucher entries --------------------------------------------------
  for v_row in select * from jsonb_array_elements(p_payload->'voucher_entries') loop
    if not (v_voucher_map ? (v_row->>'voucher_id')) then
      raise exception 'Backup has a voucher line whose voucher is missing from the file';
    end if;
    if not (v_ledger_map ? (v_row->>'ledger_id')) then
      raise exception 'Backup has a voucher line whose ledger is missing from the file';
    end if;

    insert into public.voucher_entries (
      voucher_id, company_id, ledger_id, debit_amount, credit_amount, narration, line_order
    ) values (
      (v_voucher_map->>(v_row->>'voucher_id'))::uuid,
      v_company,
      (v_ledger_map->>(v_row->>'ledger_id'))::uuid,
      coalesce((v_row->>'debit_amount')::numeric, 0),
      coalesce((v_row->>'credit_amount')::numeric, 0),
      v_row->>'narration',
      coalesce((v_row->>'line_order')::int, 0)
    );
  end loop;

  -- ---- invoice lines ----------------------------------------------------
  -- Restored, not regenerated: the entries above are already in the file, and
  -- re-running the generator would risk a restored book disagreeing with the
  -- invoice that was actually sent. line_amount is generated and so is
  -- recomputed from the quantity, rate and discount rather than carried.
  -- Absent from files written before invoicing existed, which is why the whole
  -- array is coalesced rather than assumed.
  for v_row in select * from jsonb_array_elements(coalesce(p_payload->'invoice_lines', '[]'::jsonb)) loop
    if not (v_voucher_map ? (v_row->>'voucher_id')) then
      raise exception 'Backup has an invoice line whose voucher is missing from the file';
    end if;
    if not (v_ledger_map ? (v_row->>'revenue_ledger_id')) then
      raise exception 'Backup has an invoice line whose ledger is missing from the file';
    end if;

    insert into public.invoice_lines (
      voucher_id, company_id, revenue_ledger_id, line_order,
      description, quantity, unit, rate, discount_amount
    ) values (
      (v_voucher_map->>(v_row->>'voucher_id'))::uuid,
      v_company,
      (v_ledger_map->>(v_row->>'revenue_ledger_id'))::uuid,
      coalesce((v_row->>'line_order')::int, 0),
      v_row->>'description',
      coalesce((v_row->>'quantity')::numeric, 1),
      v_row->>'unit',
      coalesce((v_row->>'rate')::numeric, 0),
      coalesce((v_row->>'discount_amount')::numeric, 0)
    );
  end loop;

  -- ---- numbering --------------------------------------------------------
  for v_row in select * from jsonb_array_elements(coalesce(p_payload->'voucher_number_sequences', '[]'::jsonb)) loop
    insert into public.voucher_number_sequences
      (company_id, voucher_type, financial_year_label, prefix, next_number, padding)
    values (
      v_company,
      v_row->>'voucher_type',
      v_row->>'financial_year_label',
      v_row->>'prefix',
      coalesce((v_row->>'next_number')::int, 1),
      coalesce((v_row->>'padding')::int, 5)
    )
    on conflict (company_id, voucher_type, financial_year_label) do update
      set prefix = excluded.prefix,
          next_number = excluded.next_number,
          padding = excluded.padding;
  end loop;

  -- The balance triggers are `deferrable initially deferred`, so left alone
  -- they fire at COMMIT — long after this function has returned, which would
  -- surface a corrupt backup as an unattributable error on some later
  -- statement. Forcing them here means an unbalanced voucher, or an invoice
  -- whose lines do not match its postings, fails the restore with its own
  -- message, and the whole thing rolls back.
  set constraints all immediate;

  return v_company;
end;
$$;

-- --------------------------------------------------------------- 9. the undo

-- Both the preview and the undo itself filter on a hard-coded list of tables.
-- invoice_lines has to join it in both, and for the same reason: an undo that
-- rewound a voucher's entries and left its invoice lines behind would leave
-- the document saying one thing and the ledgers another, which is precisely
-- the state the deferred invariant above exists to make impossible — so the
-- undo would not merely be wrong, it would abort at COMMIT and take the whole
-- rewind with it.
create or replace function public.preview_revert_since(
  p_company_id uuid,
  p_since timestamptz
) returns table (
  table_name text,
  action text,
  entries bigint,
  earliest timestamptz,
  latest timestamptz
)
language sql
security invoker
set search_path = ''
stable
as $$
  select a.table_name, a.action, count(*), min(a.changed_at), max(a.changed_at)
  from public.audit_log a
  where a.company_id = p_company_id
    and a.changed_at >= p_since
    and a.is_revert = false
    and a.table_name in ('vouchers','voucher_entries','invoice_lines','ledgers','account_groups')
  group by a.table_name, a.action
  order by a.table_name, a.action;
$$;

-- 0019's revert, with invoice_lines added to the filter and to the three
-- replay branches. Everything else is preserved verbatim, including the
-- numbering rewind at the end, the tail-not-window justification it rests on,
-- the security definer / search_path / signature, and the return value that
-- lib/supabase/queries/undo.ts reads as the "changes undone" figure.
create or replace function public.revert_company_changes_since(
  p_company_id uuid,
  p_since timestamptz
) returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_entry public.audit_log;
  v_reverted integer := 0;
  v_started timestamptz := clock_timestamp();
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to undo changes';
  end if;
  -- `is not true`, not `not ...`: a NULL from the permission helper would
  -- make `not NULL` -> NULL, skip the raise, and let a non-member through.
  if app_private.is_company_admin(p_company_id) is not true then
    raise exception 'Only an admin can undo changes for a company';
  end if;
  if p_since is null then
    raise exception 'Undo needs a point in time to go back to';
  end if;
  -- clock_timestamp(), not now(): now() is the transaction's start time, so a
  -- caller that took its mark a moment ago with the wall clock would be told
  -- its own timestamp is in the future.
  if p_since > clock_timestamp() then
    raise exception 'That point in time is in the future';
  end if;

  -- Tags every write below, so these rows are skipped by a later undo.
  perform set_config('hisab.is_revert', 'on', true);

  -- Newest first: a row's later changes have to come off before its earlier
  -- ones, or the older state is overwritten by the newer one on the way back.
  --
  -- Membership and company settings are excluded on purpose. Undo is for
  -- bookkeeping mistakes; silently reinstating a removed member or reopening
  -- a locked period is a different decision with different consequences.
  for v_entry in
    select *
    from public.audit_log
    where company_id = p_company_id
      and changed_at >= p_since
      and changed_at <= v_started
      and is_revert = false
      and table_name in ('vouchers','voucher_entries','invoice_lines','ledgers','account_groups')
    order by changed_at desc, id desc
  loop
    if v_entry.action = 'INSERT' then
      -- It didn't exist before: remove it.
      case v_entry.table_name
        when 'invoice_lines'   then delete from public.invoice_lines   where id = v_entry.record_id;
        when 'voucher_entries' then delete from public.voucher_entries where id = v_entry.record_id;
        when 'vouchers'        then delete from public.vouchers        where id = v_entry.record_id;
        when 'ledgers'         then delete from public.ledgers         where id = v_entry.record_id;
        when 'account_groups'  then delete from public.account_groups  where id = v_entry.record_id;
      end case;

    elsif v_entry.action = 'DELETE' then
      -- It existed before: put it back, id and all, so anything referencing
      -- it still lines up.
      case v_entry.table_name
        when 'invoice_lines' then
          -- `line_amount` is GENERATED ALWAYS, so it is never written back; it
          -- is recomputed from the quantity, rate and discount that are.
          insert into public.invoice_lines
            (id, voucher_id, company_id, revenue_ledger_id, line_order,
             description, quantity, unit, rate, discount_amount)
          select r.id, r.voucher_id, r.company_id, r.revenue_ledger_id, r.line_order,
                 r.description, r.quantity, r.unit, r.rate, r.discount_amount
          from jsonb_populate_record(null::public.invoice_lines, v_entry.old_data) r;

        when 'voucher_entries' then
          insert into public.voucher_entries
            (id, voucher_id, company_id, ledger_id, debit_amount, credit_amount, narration, line_order)
          select r.id, r.voucher_id, r.company_id, r.ledger_id, r.debit_amount, r.credit_amount, r.narration, r.line_order
          from jsonb_populate_record(null::public.voucher_entries, v_entry.old_data) r;

        when 'vouchers' then
          insert into public.vouchers
            (id, company_id, voucher_type, voucher_number, sequence_number, financial_year_label,
             voucher_date, narration, reference_number, reference_date, is_deleted, created_by)
          select r.id, r.company_id, r.voucher_type, r.voucher_number, r.sequence_number, r.financial_year_label,
                 r.voucher_date, r.narration, r.reference_number, r.reference_date, r.is_deleted, r.created_by
          from jsonb_populate_record(null::public.vouchers, v_entry.old_data) r;

        when 'ledgers' then
          insert into public.ledgers
            (id, company_id, group_id, name, opening_balance_amount, opening_balance_type,
             contact_person, phone, email, address, notes, is_active, created_by)
          select r.id, r.company_id, r.group_id, r.name, r.opening_balance_amount, r.opening_balance_type,
                 r.contact_person, r.phone, r.email, r.address, r.notes, r.is_active, r.created_by
          from jsonb_populate_record(null::public.ledgers, v_entry.old_data) r;

        when 'account_groups' then
          -- `statement` is GENERATED ALWAYS, so it is never written back.
          insert into public.account_groups
            (id, company_id, parent_group_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
          select r.id, r.company_id, r.parent_group_id, r.name, r.nature, r.normal_balance,
                 r.ledger_role, r.is_system, r.sort_order
          from jsonb_populate_record(null::public.account_groups, v_entry.old_data) r;
      end case;

    elsif v_entry.action = 'UPDATE' then
      -- Put the previous values back. Columns the database owns —
      -- created_at, updated_at, and the generated ones — are left alone.
      case v_entry.table_name
        when 'invoice_lines' then
          update public.invoice_lines t
          set revenue_ledger_id = r.revenue_ledger_id, line_order = r.line_order,
              description = r.description, quantity = r.quantity, unit = r.unit,
              rate = r.rate, discount_amount = r.discount_amount
          from jsonb_populate_record(null::public.invoice_lines, v_entry.old_data) r
          where t.id = r.id;

        when 'voucher_entries' then
          update public.voucher_entries t
          set ledger_id = r.ledger_id, debit_amount = r.debit_amount,
              credit_amount = r.credit_amount, narration = r.narration, line_order = r.line_order
          from jsonb_populate_record(null::public.voucher_entries, v_entry.old_data) r
          where t.id = r.id;

        when 'vouchers' then
          update public.vouchers t
          set voucher_date = r.voucher_date, narration = r.narration,
              reference_number = r.reference_number, reference_date = r.reference_date,
              is_deleted = r.is_deleted, total_amount = r.total_amount
          from jsonb_populate_record(null::public.vouchers, v_entry.old_data) r
          where t.id = r.id;

        when 'ledgers' then
          update public.ledgers t
          set group_id = r.group_id, name = r.name,
              opening_balance_amount = r.opening_balance_amount,
              opening_balance_type = r.opening_balance_type,
              contact_person = r.contact_person, phone = r.phone, email = r.email,
              address = r.address, notes = r.notes, is_active = r.is_active
          from jsonb_populate_record(null::public.ledgers, v_entry.old_data) r
          where t.id = r.id;

        when 'account_groups' then
          update public.account_groups t
          set parent_group_id = r.parent_group_id, name = r.name,
              ledger_role = r.ledger_role, sort_order = r.sort_order
          from jsonb_populate_record(null::public.account_groups, v_entry.old_data) r
          where t.id = r.id;
      end case;
    end if;

    v_reverted := v_reverted + 1;
  end loop;

  -- Rewind the numbering to match what survived.
  --
  -- The sequences carry no audit trail, so this is a recomputation rather
  -- than a replay: for each of this company's keys, one above the highest
  -- sequence_number still present under that key, or 1 if the key has no
  -- vouchers left. Soft-deleted vouchers count — they still hold their
  -- numbers.
  --
  -- Sound only because undo is a tail and never a window: everything from
  -- p_since forward has just come off, so no voucher can exist above the
  -- removed range and max(sequence_number) + 1 cannot collide with one.
  update public.voucher_number_sequences s
  set next_number = coalesce((
        select max(v.sequence_number) + 1
        from public.vouchers v
        where v.company_id = s.company_id
          and v.voucher_type = s.voucher_type
          and v.financial_year_label = s.financial_year_label
      ), 1)
  where s.company_id = p_company_id;

  -- The balance triggers are deferred, so without this an undo that left a
  -- voucher unbalanced would blow up on some unrelated statement later
  -- instead of failing here and rolling the whole undo back.
  set constraints all immediate;

  perform set_config('hisab.is_revert', 'off', true);
  return v_reverted;
end;
$$;
