-- The dashboard's six cash-position figures in one round trip.
--
-- It previously composed them client-side from two full trial balances plus
-- one get_ledger_statement call *per cash and bank ledger*: three ledgers was
-- five requests, thirty bank accounts was thirty-two, on every dashboard load.
--
-- security invoker, matching the five reporting functions in 0006 — the
-- caller's RLS decides which company's rows are visible, and this function
-- adds no privilege of its own.
create or replace function public.get_dashboard_summary(
  p_company_id uuid, p_as_of_date date
) returns table (
  cash_in_hand numeric,
  cash_in_hand_change numeric,
  bank_balance numeric,
  bank_balance_change numeric,
  month_inflow numeric,
  month_outflow numeric
)
language sql
security invoker
set search_path = ''
stable
as $$
  with bounds as (
    select
      date_trunc('month', p_as_of_date::timestamp)::date as month_start,
      (date_trunc('month', p_as_of_date::timestamp)::date - 1) as prev_month_end
  ),
  -- Cash and bank ledgers are found via account_groups.ledger_role rather
  -- than by group name, so a company that renames its seeded "Cash-in-Hand"
  -- or "Bank Accounts" group keeps working. The cash/bank split is then a
  -- name test, which is what the client did too.
  cash_bank_ledgers as (
    select
      l.id,
      l.opening_balance_amount,
      l.opening_balance_type,
      (g.name ilike '%cash%') as is_cash
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    where l.company_id = p_company_id
      and l.is_active = true
      and g.ledger_role = 'cash_bank'
  ),
  -- Signed balance per ledger at both dates, in one pass over the entries
  -- rather than two full trial balances.
  balances as (
    select
      cbl.is_cash,
      coalesce(cbl.opening_balance_amount, 0)
        * case when cbl.opening_balance_type = 'debit' then 1 else -1 end
        + coalesce(sum(ve.debit_amount - ve.credit_amount)
            filter (where v.voucher_date <= p_as_of_date), 0) as balance_now,
      coalesce(cbl.opening_balance_amount, 0)
        * case when cbl.opening_balance_type = 'debit' then 1 else -1 end
        + coalesce(sum(ve.debit_amount - ve.credit_amount)
            filter (where v.voucher_date <= (select prev_month_end from bounds)), 0) as balance_prev
    from cash_bank_ledgers cbl
    left join public.voucher_entries ve on ve.ledger_id = cbl.id
    left join public.vouchers v
      on v.id = ve.voucher_id
     and v.company_id = p_company_id
     and v.is_deleted = false
    group by cbl.id, cbl.is_cash, cbl.opening_balance_amount, cbl.opening_balance_type
  ),
  -- Gross movement for the month to date: every debit and every credit, not
  -- the net change, so money that went out and came back counts on both
  -- sides — which is how a cash-flow tile should read.
  movement as (
    select
      coalesce(sum(ve.debit_amount), 0) as inflow,
      coalesce(sum(ve.credit_amount), 0) as outflow
    from cash_bank_ledgers cbl
    join public.voucher_entries ve on ve.ledger_id = cbl.id
    join public.vouchers v on v.id = ve.voucher_id
    where v.company_id = p_company_id
      and v.is_deleted = false
      and v.voucher_date between (select month_start from bounds) and p_as_of_date
  )
  select
    coalesce(sum(balance_now) filter (where is_cash), 0),
    coalesce(sum(balance_now - balance_prev) filter (where is_cash), 0),
    coalesce(sum(balance_now) filter (where not is_cash), 0),
    coalesce(sum(balance_now - balance_prev) filter (where not is_cash), 0),
    (select inflow from movement),
    (select outflow from movement)
  from balances;
$$;

revoke execute on function public.get_dashboard_summary(uuid, date) from public;
grant execute on function public.get_dashboard_summary(uuid, date) to authenticated;
