-- Bulk voucher creation for the CSV importer.
--
-- The importer previously looped one create_voucher RPC per voucher group, so
-- a 2,000-voucher file was 2,000 sequential round trips. This loops
-- server-side instead, and returns one row per group so the modal can report
-- partial failures exactly as the client-side loop did.
--
-- security invoker, like create_voucher itself: RLS must still gate the role
-- and lock-date checks as the calling user. Importing is not a way to write
-- rows you couldn't write one at a time.
create or replace function public.create_vouchers_bulk(
  p_company_id uuid,
  -- [{"group_key":"...","voucher_type":"payment","voucher_date":"2026-04-01",
  --   "narration":"...","reference_number":null,"reference_date":null,
  --   "lines":[{"ledger_id":"...","debit_amount":100,"credit_amount":0,
  --             "narration":"...","line_order":0}]}]
  p_groups jsonb
) returns table (
  group_key text,
  voucher_id uuid,
  error_message text
)
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_group jsonb;
  v_voucher_id uuid;
begin
  for v_group in select * from jsonb_array_elements(p_groups) loop
    group_key := v_group->>'group_key';
    voucher_id := null;
    error_message := null;

    begin
      v_voucher_id := public.create_voucher(
        p_company_id,
        v_group->>'voucher_type',
        (v_group->>'voucher_date')::date,
        v_group->>'narration',
        v_group->>'reference_number',
        nullif(v_group->>'reference_date', '')::date,
        v_group->'lines'
      );

      -- The balance and minimum-line-count triggers are `deferrable initially
      -- deferred`, so left alone they fire at COMMIT — one unbalanced group
      -- would abort the entire import instead of being reported as one bad
      -- group. Forcing them now checks only the events queued since the last
      -- check, inside this block's subtransaction, so a failure rolls back
      -- just this voucher and lands in the exception handler below.
      set constraints all immediate;
      set constraints all deferred;

      voucher_id := v_voucher_id;
    exception when others then
      -- Rolls back this group only; the loop continues with the next.
      error_message := sqlerrm;
    end;

    return next;
  end loop;
end;
$$;

revoke execute on function public.create_vouchers_bulk(uuid, jsonb) from public;
grant execute on function public.create_vouchers_bulk(uuid, jsonb) to authenticated;
