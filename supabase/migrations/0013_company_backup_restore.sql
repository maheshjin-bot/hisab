-- Per-company backup and restore.
--
-- Both functions are SECURITY DEFINER with an explicit permission check at the
-- top, rather than security invoker. That is deliberate and needs justifying,
-- since every reporting function in 0006 is invoker:
--
--   * export has to read voucher_number_sequences, which has no RLS policies
--     at all (0005 denies client access outright), or a restored company would
--     start renumbering from 1 and collide with its own history.
--   * restore has to DELETE vouchers, and there is no delete policy on
--     vouchers by design — "delete" in the app is is_deleted = true.
--
-- So the privilege is real, and the guard is the explicit membership/admin
-- check each function performs before touching anything.

-- ---------------------------------------------------------------- export

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
    'voucher_number_sequences', coalesce((
      select jsonb_agg(to_jsonb(s))
      from public.voucher_number_sequences s where s.company_id = p_company_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.export_company_backup(uuid) from public;
grant execute on function public.export_company_backup(uuid) to authenticated;

-- ---------------------------------------------------------------- restore

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
    if not app_private.is_company_admin(p_target_company_id) then
      raise exception 'Only an admin can replace a company from a backup';
    end if;
    v_company := p_target_company_id;

    -- Children first: entries reference vouchers and ledgers, ledgers
    -- reference groups. System groups stay — the trigger forbids deleting
    -- them, and they are matched by nature below rather than recreated.
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
      lock_date = nullif(p_payload->'company'->>'lock_date', '')::date
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
      set lock_date = nullif(p_payload->'company'->>'lock_date', '')::date
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
  -- statement. Forcing them here means an unbalanced voucher fails the
  -- restore, with its own message, and the whole thing rolls back.
  set constraints all immediate;

  return v_company;
end;
$$;

revoke execute on function public.restore_company_backup(jsonb, text, uuid) from public;
grant execute on function public.restore_company_backup(jsonb, text, uuid) to authenticated;
