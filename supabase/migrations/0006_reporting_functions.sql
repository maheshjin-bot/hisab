-- All reporting functions are security invoker (the default, stated
-- explicitly) so RLS still applies as the calling user — even if a bad
-- p_company_id were passed, the underlying tables' RLS means zero rows come
-- back for a company the caller isn't a member of. No separate reporting
-- tables: everything is a live aggregation over voucher_entries.

create or replace function public.get_daybook(
  p_company_id uuid, p_from_date date, p_to_date date
) returns table (
  voucher_id uuid,
  voucher_date date,
  voucher_type text,
  voucher_number text,
  narration text,
  total_amount numeric,
  dr_ledgers text,
  cr_ledgers text
)
language sql
security invoker
set search_path = ''
stable
as $$
  select
    v.id, v.voucher_date, v.voucher_type, v.voucher_number, v.narration, v.total_amount,
    string_agg(distinct case when ve.debit_amount > 0 then l.name end, ', ') as dr_ledgers,
    string_agg(distinct case when ve.credit_amount > 0 then l.name end, ', ') as cr_ledgers
  from public.vouchers v
  join public.voucher_entries ve on ve.voucher_id = v.id
  join public.ledgers l on l.id = ve.ledger_id
  where v.company_id = p_company_id
    and v.is_deleted = false
    and v.voucher_date between p_from_date and p_to_date
  group by v.id, v.voucher_date, v.voucher_type, v.voucher_number, v.narration, v.total_amount
  order by v.voucher_date, v.sequence_number;
$$;

-- Running balance is computed server-side (window function) because it's
-- order-dependent and can't be correctly computed over a paginated client
-- slice. Convention: debit_amount - credit_amount, accumulated — positive
-- running_balance means a net-Dr position, negative means net-Cr. The first
-- row is always a synthetic "Opening Balance" entry (balance as of the day
-- before p_from_date), matching how a real ledger statement reads.
create or replace function public.get_ledger_statement(
  p_company_id uuid, p_ledger_id uuid, p_from_date date, p_to_date date
) returns table (
  entry_date date,
  voucher_id uuid,
  voucher_type text,
  voucher_number text,
  narration text,
  debit_amount numeric,
  credit_amount numeric,
  running_balance numeric
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  v_opening_signed numeric(18,2);
begin
  select
    coalesce(l.opening_balance_amount, 0) * case when l.opening_balance_type = 'debit' then 1 else -1 end
    + coalesce((
        select sum(ve.debit_amount - ve.credit_amount)
        from public.voucher_entries ve
        join public.vouchers v on v.id = ve.voucher_id
        where ve.ledger_id = p_ledger_id and v.company_id = p_company_id
          and v.is_deleted = false and v.voucher_date < p_from_date
      ), 0)
  into v_opening_signed
  from public.ledgers l
  where l.id = p_ledger_id and l.company_id = p_company_id;

  return query
  select ordered.entry_date, ordered.voucher_id, ordered.voucher_type, ordered.voucher_number,
         ordered.narration, ordered.debit_amount, ordered.credit_amount, ordered.running_balance
  from (
    select
      null::date as entry_date, null::uuid as voucher_id, null::text as voucher_type, null::text as voucher_number,
      'Opening Balance'::text as narration, null::numeric as debit_amount, null::numeric as credit_amount,
      v_opening_signed as running_balance,
      0::bigint as rn
    union all
    select
      m.entry_date, m.voucher_id, m.voucher_type, m.voucher_number, m.narration, m.debit_amount, m.credit_amount,
      v_opening_signed + sum(m.debit_amount - m.credit_amount) over (order by m.rn rows between unbounded preceding and current row) as running_balance,
      m.rn
    from (
      select
        v.voucher_date as entry_date, v.id as voucher_id, v.voucher_type, v.voucher_number,
        coalesce(ve.narration, v.narration) as narration, ve.debit_amount, ve.credit_amount,
        row_number() over (order by v.voucher_date, v.sequence_number, ve.line_order) as rn
      from public.voucher_entries ve
      join public.vouchers v on v.id = ve.voucher_id
      where ve.ledger_id = p_ledger_id and v.company_id = p_company_id
        and v.is_deleted = false
        and v.voucher_date between p_from_date and p_to_date
    ) m
  ) ordered
  order by ordered.rn;
end;
$$;

create or replace function public.get_trial_balance(
  p_company_id uuid, p_as_of_date date
) returns table (
  ledger_id uuid,
  ledger_name text,
  group_name text,
  nature text,
  debit_balance numeric,
  credit_balance numeric
)
language sql
security invoker
set search_path = ''
stable
as $$
  select
    l.id,
    l.name,
    g.name,
    g.nature,
    greatest(bal.signed_balance, 0) as debit_balance,
    greatest(-bal.signed_balance, 0) as credit_balance
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
  order by g.sort_order, g.name, l.name;
$$;

-- Period-scoped (from_date..to_date), unlike the balance sheet's life-to-date
-- profit figure. The app computes Gross Profit = sum(direct_income) -
-- sum(direct_expense), then Net Profit = Gross Profit + sum(indirect_income)
-- - sum(indirect_expense), grouping these rows by `statement`/`nature`.
create or replace function public.get_profit_and_loss(
  p_company_id uuid, p_from_date date, p_to_date date
) returns table (
  ledger_id uuid,
  ledger_name text,
  group_name text,
  nature text,
  statement text,
  amount numeric
)
language sql
security invoker
set search_path = ''
stable
as $$
  select
    l.id, l.name, g.name, g.nature, g.statement,
    abs(sum(
      case when g.normal_balance = 'credit' then ve.credit_amount - ve.debit_amount
           else ve.debit_amount - ve.credit_amount end
    )) as amount
  from public.voucher_entries ve
  join public.vouchers v on v.id = ve.voucher_id
  join public.ledgers l on l.id = ve.ledger_id
  join public.account_groups g on g.id = l.group_id
  where v.company_id = p_company_id and v.is_deleted = false
    and v.voucher_date between p_from_date and p_to_date
    and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense')
  group by l.id, g.id
  having sum(
      case when g.normal_balance = 'credit' then ve.credit_amount - ve.debit_amount
           else ve.debit_amount - ve.credit_amount end
    ) <> 0
  order by g.statement, g.sort_order, g.name, l.name;
$$;

-- Balance Sheet: real balance-sheet-nature ledgers plus one synthetic Net
-- Profit/Loss line, life-to-date (book_beginning_date -> as_of_date, not
-- FY-scoped) so prior years' profit doesn't disappear from the sheet. The
-- synthetic line's side (liability for a profit, asset for a loss) is
-- mathematically forced by the accounting equation, so both sides are
-- guaranteed to total identically as long as every voucher balances, which
-- the DB enforces.
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
  -- So one uniform (credit_amount - debit_amount) sum across every
  -- income/expense entry is correct with no per-nature branching needed.
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
    case when g.nature in ('current_liability','capital') then 'liability' else 'asset' end as side,
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
