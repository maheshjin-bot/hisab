-- Fix: the Balance Sheet could fail to tally.
--
-- get_balance_sheet chose each line's side from its group's nature and then
-- reported abs(signed_balance):
--
--   case when g.nature in ('current_liability','capital')
--        then 'liability' else 'asset' end,
--   abs(bal.signed_balance)
--
-- So a ledger whose balance sits on the opposite side to its nature was put
-- on the wrong side of the statement at its magnitude — and the two sides
-- stopped agreeing. The everyday cases are ordinary, not exotic:
--
--   * an overdrawn bank account (asset nature, credit balance) was reported
--     as a positive asset instead of an overdraft liability
--   * a supplier who has been overpaid (liability nature, debit balance) was
--     reported as a positive liability instead of an advance
--   * a customer in credit, likewise
--
-- Found by an end-to-end run: Trial Balance tallied at 600/600 while the
-- Balance Sheet reported assets 500 against liabilities 300, off by exactly
-- twice the overdrawn bank balance.
--
-- The side now follows the sign of the balance, which is both the correct
-- treatment and what makes the statement tally by construction: assets minus
-- liabilities is the sum of every balance-sheet ledger's signed balance,
-- which double entry makes equal and opposite to the period result already
-- added as the Net Profit/Loss line.
--
-- Nothing else changes: the profit/loss line, the nature filter, the
-- book-beginning window and security invoker are all as they were.
create or replace function public.get_balance_sheet(
  p_company_id uuid, p_as_of_date date
) returns table (
  side text, -- 'liability' | 'asset'
  ledger_id uuid, -- null for the synthetic Net Profit/Loss line
  ledger_name text,
  group_name text,
  nature text,
  amount numeric
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  v_book_beginning_date date;
  v_net_profit numeric(18,2);
begin
  select book_beginning_date into v_book_beginning_date from public.companies where id = p_company_id;

  -- Net profit = total income - total expense. Per entry, income contributes
  -- +(credit-debit); expense contributes -(debit-credit), which is the same
  -- expression, +(credit-debit) — the subtraction and the sign flip cancel.
  select coalesce(sum(ve.credit_amount - ve.debit_amount), 0)
  into v_net_profit
  from public.voucher_entries ve
  join public.vouchers v on v.id = ve.voucher_id
  join public.ledgers l on l.id = ve.ledger_id
  join public.account_groups g on g.id = l.group_id
  where v.company_id = p_company_id and v.is_deleted = false
    and v.voucher_date between v_book_beginning_date and p_as_of_date
    and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense');

  return query
  select
    -- A debit balance is an asset, a credit balance is a claim on the
    -- business, whatever the group is nominally classified as.
    case when bal.signed_balance > 0 then 'asset' else 'liability' end as side,
    l.id, l.name, g.name, g.nature,
    abs(bal.signed_balance) as amount
  from public.ledgers l
  join public.account_groups g on g.id = l.group_id
  cross join lateral (
    select
      coalesce(l.opening_balance_amount, 0) * case when l.opening_balance_type = 'debit' then 1 else -1 end
      + coalesce((
          select sum(ve.debit_amount - ve.credit_amount)
          from public.voucher_entries ve
          join public.vouchers v on v.id = ve.voucher_id
          where ve.ledger_id = l.id and v.company_id = p_company_id
            and v.is_deleted = false and v.voucher_date <= p_as_of_date
        ), 0) as signed_balance
  ) bal
  where l.company_id = p_company_id and l.is_active = true
    and g.nature in ('current_asset','current_liability','fixed_asset','capital')
    and bal.signed_balance <> 0

  union all

  select 'liability', null::uuid, 'Net Profit (Current Period)', 'Capital Account', 'capital', v_net_profit
  where v_net_profit >= 0

  union all

  select 'asset', null::uuid, 'Net Loss (Current Period)', 'Capital Account', 'capital', abs(v_net_profit)
  where v_net_profit < 0;
end;
$$;
