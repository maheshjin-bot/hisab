-- Fix: undoing voucher creations left a permanent hole in the numbering.
--
-- revert_company_changes_since() (0014) rewinds four tables and only those
-- four:
--
--   and table_name in ('vouchers','voucher_entries','ledgers','account_groups')
--
-- voucher_number_sequences is not in that list, and it could not be: it
-- carries no audit trigger, so there are no audit rows describing how it
-- moved. Every voucher creation had bumped next_number through
-- app_private.next_voucher_number(), and the undo deleted the vouchers while
-- leaving next_number exactly where those creations had pushed it.
--
-- So undoing ten sales invoices deleted SAL/2026-27/00001..00010 and left the
-- sequence pointing at 00011. The next invoice was numbered 00011, and the
-- book showed a series that skipped its first ten numbers — in a series whose
-- entire purpose is to be consecutive and gapless, and which a tax auditor is
-- entitled to read that way. Nothing in the UI can reissue a number, so this
-- was the one part of an undo that could not be repaired afterwards. Undo is
-- offered to the user as the safe, reversible option; it has to actually be
-- one.
--
-- The repair: after the rewind, reset each of the company's sequences to one
-- above the highest sequence_number that survived it, per
-- (company_id, voucher_type, financial_year_label). Where no voucher survived
-- for a key at all, reset to 1 — the series is empty again, so it starts
-- again.
--
-- This is only sound because undo is a tail and never a window. 0014 says so
-- in its own opening comment and enforces it by taking a single point in time
-- rather than a range: everything from p_since forward comes off, so no
-- voucher can exist above the removed range. If undo ever grew the ability to
-- revert a middle slice, max(sequence_number) + 1 would start handing out
-- numbers that a surviving later voucher already holds, and the unique index
-- on (company_id, voucher_type, financial_year_label, voucher_number) would
-- start rejecting perfectly ordinary saves. The tail property is the whole
-- justification; it is not a detail.
--
-- What is deliberately *not* changed:
--
--   * soft-deleted vouchers still count as survivors. is_deleted = true means
--     "cancelled in the book", not "never existed" — the row is still there,
--     it still holds its number, and the unique index still enforces it. A
--     reset that skipped them would immediately reissue a number that is
--     already on a cancelled voucher and fail on the index.
--   * only the reverted company's sequences are touched. Another company's
--     numbering has nothing to do with this undo.
--   * padding and prefix are untouched; only next_number moves.
--   * no sequence row is created or removed. A key with no surviving vouchers
--     is reset to 1 rather than deleted, which is the same state a fresh
--     company is in before its first voucher and avoids a needless insert on
--     the next save.
--   * security definer, set search_path = '' and the
--     (uuid, timestamptz) -> integer signature are preserved, and the return
--     value still counts audit entries reverted, not sequences reset —
--     lib/supabase/queries/undo.ts reads it as the "changes undone" figure.
--   * create or replace preserves the existing ACL, so 0014's
--     revoke-from-public / grant-to-authenticated on this function still
--     stands without being restated here.
--
-- One accepted side effect: the reset is computed for every one of the
-- company's sequence keys, not only the keys the undo touched. If a sequence
-- had drifted ahead of its series for some other reason — a create_voucher
-- whose transaction rolled back after next_voucher_number() had already
-- claimed a number, which is the ordinary way a gap appears — this pulls it
-- back too and the gap closes. That is a repair, not a regression: the number
-- it reissues belongs to no row, in this company or anywhere else.

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
      and table_name in ('vouchers','voucher_entries','ledgers','account_groups')
    order by changed_at desc, id desc
  loop
    if v_entry.action = 'INSERT' then
      -- It didn't exist before: remove it.
      case v_entry.table_name
        when 'voucher_entries' then delete from public.voucher_entries where id = v_entry.record_id;
        when 'vouchers'        then delete from public.vouchers        where id = v_entry.record_id;
        when 'ledgers'         then delete from public.ledgers         where id = v_entry.record_id;
        when 'account_groups'  then delete from public.account_groups  where id = v_entry.record_id;
      end case;

    elsif v_entry.action = 'DELETE' then
      -- It existed before: put it back, id and all, so anything referencing
      -- it still lines up.
      case v_entry.table_name
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
