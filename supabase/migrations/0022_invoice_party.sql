-- The party an invoice is made out to.
--
-- 0021 gave a sales or purchase voucher itemised lines and a printable
-- document, but it stored the one thing the document is addressed to —
-- the customer on a sale, the supplier on a bill — nowhere at all. The party
-- was recoverable only by a convention: generate_invoice_entries() writes the
-- party leg first, at voucher_entries.line_order = 0, and both the edit form
-- and the printed invoice read it back from there.
--
-- Nothing in the schema held that convention up. line_order is an ordinary
-- smallint with no meaning to any constraint; a hand-written voucher_entries
-- row that reordered the legs, an import that wrote them the other way round,
-- or any future change to the generator's ordering would have made an invoice
-- print one customer's name over another customer's goods, with the voucher
-- still balanced, the invoice lines still matching the postings, the Trial
-- Balance still tallying and every guarantee in supabase/tests/guarantees.sql
-- still passing. A document a customer is sent and a tax auditor reads should
-- not rest on the order rows happen to be in.
--
-- So the party becomes a column, and voucher_entries stays derived from it in
-- exactly the way invoice_lines already is: the generator reads the column's
-- source, not the other way round. No report learns about any of this — the
-- corollary rule from 0021 stands, and party_ledger_id is read by the invoice
-- form and the printed document only.
--
-- invoice_lines has zero rows in production, so there is no data to migrate
-- today. There would be the moment a real invoice exists, which is why this
-- follows 0021 immediately rather than waiting for the duplicate-bill work
-- that also needs the column.

-- ------------------------------------------------------------ 1. the column

-- Composite, like every other cross-table reference in this schema:
-- (party_ledger_id, company_id) references (id, company_id) rather than
-- party_ledger_id alone. The redundant company_id is what makes an invoice
-- addressed to another company's customer *unrepresentable* rather than
-- merely blocked by a policy — it cannot be written down at all, by anyone,
-- including a security-definer function or a restore.
--
-- Nullable, and permanently so. A journal and a contra have no counterparty,
-- and the 57 sales and purchase vouchers already in the books have no invoice
-- lines and no party either. They are not a backlog waiting to be upgraded;
-- a voucher with no invoice lines is a valid voucher, and it must keep saving
-- and editing with this column null. The rule that makes the party mandatory
-- is conditional and lives in the trigger below, not in a NOT NULL.
alter table public.vouchers
  add column if not exists party_ledger_id uuid;

alter table public.vouchers
  add constraint vouchers_party_ledger_id_company_id_fkey
  foreign key (party_ledger_id, company_id) references public.ledgers (id, company_id);

-- Two queries want this, and neither can have it otherwise.
--
-- "every invoice for this customer" is the obvious one: without the column it
-- is a join through voucher_entries into account_groups to work out which leg
-- was the party's, per voucher.
--
-- The other is the duplicate-bill guard of a later batch — the same supplier's
-- bill number arriving twice in one financial year — which needs
-- (company_id, party_ledger_id, reference_number, financial_year_label) and
-- cannot be expressed at all while the party lives in a child table. The index
-- here is the leading half of it; the guard adds its own unique index on top
-- when it lands, rather than this file guessing at its shape now.
create index vouchers_company_party_idx
  on public.vouchers(company_id, party_ledger_id)
  where party_ledger_id is not null;

comment on column public.vouchers.party_ledger_id is
  'Who a sales or purchase invoice is made out to: the customer debited, or the supplier credited. The record; the party leg in voucher_entries is generated from it. Null for journals, contras and every voucher with no invoice lines.';

-- ---------------------------------------------------------- 2. enforcement

-- Extended, not replaced, and deliberately not given a trigger of its own.
--
-- check_invoice_lines_match() already fires on both invoice_lines and
-- voucher_entries, deferred to COMMIT, and already returns immediately when a
-- voucher has no invoice lines. That early return is the backward-
-- compatibility guarantee expressed as code, so a condition placed after it
-- inherits the guarantee for free: the new rule cannot reach a voucher with no
-- invoice lines, by construction rather than by remembering to re-state the
-- exemption.
--
-- Checked before the totals rather than after, because "this invoice is
-- addressed to nobody" is the more fundamental complaint of the two and the
-- clearer thing to be told first.
create or replace function app_private.check_invoice_lines_match(p_voucher_id uuid)
returns void language plpgsql
security definer set search_path = ''
as $$
declare
  v_count integer;
  v_lines numeric(18,2);
  v_posted numeric(18,2);
  v_party uuid;
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

  -- Past this point the voucher is an invoice, and an invoice is a document
  -- addressed to somebody. Without this, the party would be whatever the
  -- postings happened to be ordered as, which is the fragility this whole
  -- migration exists to remove.
  select party_ledger_id into v_party
    from public.vouchers where id = p_voucher_id;

  if v_party is null then
    raise exception 'Voucher %: it has invoice lines but no party ledger — an invoice has to say who it is made out to', p_voucher_id;
  end if;

  select coalesce(sum(debit_amount), 0)
    into v_posted
    from public.voucher_entries where voucher_id = p_voucher_id;

  if v_lines <> v_posted then
    raise exception 'Voucher %: its invoice lines total % but it is posted for %', p_voucher_id, v_lines, v_posted;
  end if;
end;
$$;

-- ------------------------------------------ 2b. the same rule, other side

-- The trigger above is registered on invoice_lines and voucher_entries — the
-- two tables holding the things it compares. That covers every path that
-- writes postings, which is every path the application offers. It does not
-- cover the header being edited on its own:
--
--   update public.vouchers set party_ledger_id = null where id = ...;
--
-- touches neither watched table, so nothing fires. vouchers_update (0005)
-- admits that statement from any member can_write_company() lets through, and
-- the lock date only narrows it to unlocked periods. The invoice is caught the
-- next time its postings are written — but "the next time" may be never, and
-- until then the books hold a document addressed to nobody with every total
-- still tallying, every guarantee still passing and nothing anywhere to say
-- so. A rule enforced only when somebody happens to touch a different table is
-- not enforced.
--
-- So this is a second trigger rather than more work inside the first. The
-- earlier note in this file is about the *backward-compatibility logic*, which
-- must stay in one place so the "no invoice lines, no rule" exemption cannot
-- drift between two copies; it is not an argument against watching a second
-- table. These two are complementary — the lines side and the header side of
-- one invariant — and neither subsumes the other.

-- ON THE EVENT SET: update of party_ledger_id, and nothing else.
--
-- The forbidden state is (this voucher has invoice lines) and (its party is
-- null). Consider each way an operation on public.vouchers could enter it.
--
--   * INSERT cannot. invoice_lines has a *non-deferrable* composite foreign
--     key into vouchers (id, company_id), so a line cannot exist for a voucher
--     row that does not. A voucher being inserted therefore has no lines at
--     that instant, and any it acquires later in the transaction arrive as
--     inserts into invoice_lines — each of which fires trg_invoice_lines_match,
--     deferred to the same COMMIT, running this same check. Firing on INSERT
--     here would re-check, at COMMIT, precisely the vouchers the lines trigger
--     has already queued. Not a hole; a duplicate.
--
--   * UPDATE of any other column cannot. To gain lines, a voucher would have
--     to change the (id, company_id) the lines point at, and that same foreign
--     key has no ON UPDATE action, so it refuses. To lose its party it has to
--     name party_ledger_id, and naming it is what arms this trigger. The
--     precedent is 0017's `before update of is_active` and 0020's `after
--     update of status`: a column-scoped event cannot be dodged, because the
--     only way to change the column is to mention it.
--
--   * DELETE cannot leave anything behind: the foreign key is ON DELETE
--     CASCADE, so the lines go with the header.
--
-- Scoping to the column is not only tidiness. The deferred balance trigger
-- writes vouchers.total_amount on every single voucher save, so a bare `after
-- update` would run this query once per voucher written, forever, to catch a
-- state that update cannot produce.

-- ON THE DEFERRAL: `deferrable initially deferred`, like every other invariant
-- in this schema, and here it is load-bearing rather than stylistic.
--
-- The rule is a statement about the books at COMMIT, not about the order the
-- statements composing a save happen to run in. Two live paths depend on that
-- reading:
--
--   * update_voucher() re-addressing an invoice deletes its lines and entries
--     and has apply_invoice() write them again, with the party update landing
--     in the middle. Every intermediate state there is legal only because
--     nothing looks until the end.
--
--   * revert_company_changes_since() is the sharper case. Every audit row
--     written by one transaction carries the same changed_at — it defaults to
--     now(), which is the transaction timestamp — so the undo's
--     `order by changed_at desc, id desc` falls through to id, and audit_log.id
--     is a gen_random_uuid(). Within a single undone transaction the replay
--     order is therefore *arbitrary*, and an immediate check would refuse an
--     undo depending on which uuids came out of the generator. The two
--     functions that must not defer past their own return already say so, with
--     `set constraints all immediate` before they finish; this trigger is
--     forced along with the rest by those, so a restore or an undo that would
--     leave an invoice party-less still fails inside the call that caused it.
create or replace function app_private.check_voucher_party()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_party uuid;
  v_number text;
  v_count integer;
begin
  -- NEW is the row as it stood when the UPDATE ran, and this fires at COMMIT,
  -- so both halves are re-read rather than trusted. The same three guards as
  -- check_invoice_lines_match(), in the same order and for the same reasons.
  select party_ledger_id, voucher_number
    into v_party, v_number
    from public.vouchers where id = new.id;

  if not found then
    return new; -- header deleted later in this same transaction
  end if;

  select count(*) into v_count
    from public.invoice_lines where voucher_id = new.id;

  if v_count = 0 then
    return new; -- a voucher with no invoice lines is a valid voucher, permanently
  end if;

  if v_party is null then
    raise exception
      'Cannot remove the party from voucher %: it has % invoice line(s), and an invoice has to say who it is made out to. Put the customer or supplier back on it, or delete the voucher and re-enter it as a plain voucher.',
      v_number, v_count;
  end if;

  return new;
end;
$$;

create constraint trigger trg_voucher_party_required
after update of party_ledger_id on public.vouchers
deferrable initially deferred
for each row execute function app_private.check_voucher_party();

-- ----------------------------------------------------------- 3. populating it

-- apply_invoice() already receives the party and already validates it; up to
-- now it used it only to decide which leg generate_invoice_entries() should
-- write. It records it as well, and does so *before* generating the entries,
-- so the two can never be written in an order where the postings exist and the
-- column does not — and so a cross-company party is refused by the vouchers
-- foreign key, naming party_ledger_id, rather than surfacing later as a
-- confusing complaint about a voucher_entries row.
--
-- Everything else is 0021's, unchanged. This is the single place both
-- create_voucher and update_voucher route an invoice through, so setting it
-- here covers creating and editing at once.
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

  -- The record of who this invoice is to, written before anything is posted
  -- from it.
  update public.vouchers
    set party_ledger_id = v_party
    where id = p_voucher_id;

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

-- -------------------------------------------------- 4. a symmetric guard

-- 0021's update_voucher, with one guard added and everything else — the
-- financial-year check from 0018, the invoice-to-plain refusal, the atomic
-- replace of entries and lines — preserved verbatim.
--
-- The asymmetry being closed: 0021 refused a plain-lines save of a voucher
-- that *has* invoice lines, but accepted an invoice payload for a voucher that
-- has *none*. That let any of the 57 legacy sales and purchase vouchers be
-- silently upgraded into an invoice, with descriptions, quantities and rates
-- invented at edit time and nothing anywhere recording that the document was
-- reconstructed rather than issued. The database permitted it; only a UI
-- choice prevented it, and a UI choice is not a guarantee.
--
-- Replaced in place, not dropped and recreated. 0021 had to drop it because it
-- was changing the signature, and said so; this changes only the body, and a
-- needless drop would discard any privilege granted on the function since —
-- `create or replace` keeps them.
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
  v_has_invoice boolean;
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

  v_has_invoice := exists (select 1 from public.invoice_lines where voucher_id = p_voucher_id);

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
  if (p_invoice is null or jsonb_typeof(p_invoice) = 'null') and v_has_invoice then
    raise exception
      'Voucher % is an invoice, so it has to be saved as one: sending plain voucher lines would discard its descriptions, quantities and rates. Edit it on the invoice form, or delete it and re-enter it.',
      v_stored_number;
  end if;

  -- And the mirror of it, which 0021 left open.
  --
  -- The reasoning is the one 0004 already gives for voucher_type being
  -- immutable after creation: a voucher should not change its nature under
  -- you. A voucher entered as a total against two ledgers records no
  -- descriptions, no quantities and no rates, because none were ever written
  -- down; accepting an invoice payload for it would not recover that detail,
  -- it would manufacture it, and the resulting document would look exactly
  -- like one that had been itemised all along. An invoice is something a
  -- voucher is entered as, not something it is later promoted to.
  if p_invoice is not null and jsonb_typeof(p_invoice) <> 'null' and not v_has_invoice then
    raise exception
      'Voucher % is not an invoice, so it cannot be saved as one: it was entered as a total against two ledgers and has no descriptions, quantities or rates to edit. Delete it and re-enter it as an invoice.',
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

-- ------------------------------------------------- 5. backup and restore

-- export_company_backup is deliberately NOT restated here.
--
-- It builds each voucher with `to_jsonb(v)` over the whole row, exactly as it
-- builds the invoice lines with `to_jsonb(i)`, so party_ledger_id joins the
-- file the moment the column exists — no edit, and no possibility of the
-- export drifting behind a future column either. Restating the function
-- byte-for-byte to add a comment would be a redeploy that changes nothing and
-- a second copy to keep in step. Section 23 of supabase/tests/guarantees.sql
-- asserts the key is actually in the exported file rather than trusting that
-- reasoning.
--
-- The restore is a different matter, and it is the half that silently loses
-- data. A restore that carried the original uuid across would, in the lucky
-- case, be refused by the composite foreign key; in the unlucky one it would
-- land on a ledger of the *target* company that happened to share the id and
-- quietly re-address the invoice to somebody else's customer. It has to go
-- through the same v_ledger_map that invoice_lines.revenue_ledger_id goes
-- through — which is available by then, since ledgers are restored before
-- vouchers.
--
-- Everything else below is 0021's restore, unchanged.
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
    -- The party is a ledger id, so it is remapped, never carried. Files
    -- written before the column existed have no such key at all, so the
    -- lookup is guarded rather than assumed: absent means "this voucher had
    -- no party", which is exactly what those vouchers had. Present but
    -- unmapped means the file is internally inconsistent, and is worth the
    -- same complaint an entry with a missing ledger gets — restoring it as
    -- null would lose the customer silently.
    if v_row->>'party_ledger_id' is not null
       and not (v_ledger_map ? (v_row->>'party_ledger_id')) then
      raise exception 'Backup has a voucher whose party ledger is missing from the file';
    end if;

    insert into public.vouchers (
      company_id, voucher_type, voucher_number, sequence_number, financial_year_label,
      voucher_date, narration, reference_number, reference_date, party_ledger_id, is_deleted, created_by
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
      -- `->>` on an absent key is null, and `v_ledger_map->>null` is null too,
      -- so an old file lands here as null without a special case.
      (v_ledger_map->>coalesce(v_row->>'party_ledger_id', ''))::uuid,
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

-- --------------------------------------------------------------- 6. the undo

-- 0021's revert, with party_ledger_id added to two of the vouchers branches
-- and nothing else touched — the numbering rewind at the end, the
-- tail-not-window justification it rests on, the security definer /
-- search_path / signature, and the return value lib/supabase/queries/undo.ts
-- reads as the "changes undone" figure are all preserved verbatim.
--
-- Both branches matter, and for different failures:
--
--   * UPDATE names the columns it puts back one by one, so a column missing
--     from that list is simply not rewound. Undoing a mistaken edit would
--     report success, restore the lines, the entries and the totals, and
--     leave the invoice addressed to whoever the mistake had named — the one
--     part of the edit the user was most likely trying to undo.
--
--   * DELETE (the replay that puts a row back) names its columns too, so a
--     restored voucher would come back with a null party. The deferred
--     invariant would then refuse the whole undo the moment its invoice lines
--     came back with it, which is at least loud — but the fix is the same
--     one-word one, so it is made in both places rather than argued about.
--
-- preview_revert_since needs no change: it groups audit rows by table and
-- action and never looks at a column.
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
             voucher_date, narration, reference_number, reference_date, party_ledger_id, is_deleted, created_by)
          select r.id, r.company_id, r.voucher_type, r.voucher_number, r.sequence_number, r.financial_year_label,
                 r.voucher_date, r.narration, r.reference_number, r.reference_date, r.party_ledger_id,
                 r.is_deleted, r.created_by
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
              party_ledger_id = r.party_ledger_id,
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
