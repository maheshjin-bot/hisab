-- Undo everything that changed since a point in time.
--
-- Three pieces: close the gaps in what the audit log records, mark the
-- entries an undo itself produces so a second undo doesn't unwind the first,
-- and the undo itself.
--
-- Deliberately "since a point", not "between two dates". Reverting a window
-- in the middle of a history produces nonsense — a voucher created inside the
-- window and edited after it would have its creation undone while the edit
-- survives, leaving an edit against a row that no longer exists. Undo is only
-- coherent as a tail: put the books back to how they stood at time T.

-- ---------------------------------------------------- 1. close audit gaps

-- account_groups and companies carried no audit trigger, so chart-of-accounts
-- edits and lock-date changes left no trace at all — invisible in History and
-- impossible to undo.
create trigger audit_account_groups
  after insert or update or delete on public.account_groups
  for each row execute function app_private.record_audit_log();

create trigger audit_companies
  after insert or update or delete on public.companies
  for each row execute function app_private.record_audit_log();

-- --------------------------------------------- 2. mark undo-made entries

alter table public.audit_log
  add column if not exists is_revert boolean not null default false;

comment on column public.audit_log.is_revert is
  'True when this row was written by an undo. Undo skips these, so undoing twice does not re-apply the first undo in reverse.';

-- companies has no company_id column — its own id is the company. Without
-- this the new trigger fails on every company write.
create or replace function app_private.record_audit_log()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  if TG_TABLE_NAME = 'companies' then
    v_company_id := case when TG_OP = 'DELETE' then old.id else new.id end;
  else
    v_company_id := case when TG_OP = 'DELETE' then old.company_id else new.company_id end;
  end if;

  insert into public.audit_log (
    company_id, table_name, record_id, action, old_data, new_data, changed_by, is_revert
  )
  values (
    v_company_id,
    TG_TABLE_NAME,
    case when TG_OP = 'DELETE' then old.id else new.id end,
    TG_OP,
    case when TG_OP in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when TG_OP in ('UPDATE','INSERT') then to_jsonb(new) else null end,
    auth.uid(),
    coalesce(current_setting('hisab.is_revert', true) = 'on', false)
  );

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------ 3. preview

-- What an undo would touch, so it can be shown before anything is changed.
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
    and a.table_name in ('vouchers','voucher_entries','ledgers','account_groups')
  group by a.table_name, a.action
  order by a.table_name, a.action;
$$;

revoke execute on function public.preview_revert_since(uuid, timestamptz) from public;
grant execute on function public.preview_revert_since(uuid, timestamptz) to authenticated;

-- ------------------------------------------------------------- 4. the undo

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

  -- The balance triggers are deferred, so without this an undo that left a
  -- voucher unbalanced would blow up on some unrelated statement later
  -- instead of failing here and rolling the whole undo back.
  set constraints all immediate;

  perform set_config('hisab.is_revert', 'off', true);
  return v_reverted;
end;
$$;

revoke execute on function public.revert_company_changes_since(uuid, timestamptz) from public;
grant execute on function public.revert_company_changes_since(uuid, timestamptz) to authenticated;
