-- The Ledger Statement's Narration column is free text someone typed by
-- hand — inconsistent, and it does not reliably say which ledger was on the
-- other side of the double entry. This adds "Particulars": the counterparty
-- ledger(s) for each voucher line, derived from the postings themselves.
--
-- Same aggregation precedent as get_daybook's dr_ledgers/cr_ledgers
-- (string_agg(distinct ..., ', ')), but scoped to the *other* lines of the
-- voucher only — not every debit-side or credit-side ledger including the
-- statement's own ledger. For the ordinary two-line voucher (payment,
-- receipt, sale, purchase — the vast majority) this is exactly one name. A
-- journal or contra with more lines yields every other ledger, comma-joined.
--
-- counterparty_ledger_id is only ever populated when there is exactly one
-- counterparty; a multi-party row has nothing single to link to, so the
-- client renders it as plain comma-joined text (see
-- lib/reports/ledger-statement-links.ts for that decision, pulled out as a
-- pure function the way balance-sheet-links.ts already does for its own
-- report).
--
-- Unlike get_daybook's aggregation, this one takes `order by l2.name` inside
-- string_agg: a multi-party cell's comma-joined text is read by an
-- accountant, and its order should not depend on unspecified aggregate
-- iteration order.
-- create or replace cannot add columns to an existing `returns table`
-- signature (Postgres: "cannot change return type of existing function" —
-- the row type is defined by the OUT parameters), so the old signature has
-- to be dropped first.
drop function if exists public.get_ledger_statement(uuid, uuid, date, date);

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
  running_balance numeric,
  counterparty text,
  counterparty_ledger_id uuid
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
         ordered.narration, ordered.debit_amount, ordered.credit_amount, ordered.running_balance,
         ordered.counterparty, ordered.counterparty_ledger_id
  from (
    select
      null::date as entry_date, null::uuid as voucher_id, null::text as voucher_type, null::text as voucher_number,
      'Opening Balance'::text as narration, null::numeric as debit_amount, null::numeric as credit_amount,
      v_opening_signed as running_balance,
      null::text as counterparty, null::uuid as counterparty_ledger_id,
      0::bigint as rn
    union all
    select
      m.entry_date, m.voucher_id, m.voucher_type, m.voucher_number, m.narration, m.debit_amount, m.credit_amount,
      v_opening_signed + sum(m.debit_amount - m.credit_amount) over (order by m.rn rows between unbounded preceding and current row) as running_balance,
      m.counterparty, m.counterparty_ledger_id,
      m.rn
    from (
      select
        v.voucher_date as entry_date, v.id as voucher_id, v.voucher_type, v.voucher_number,
        coalesce(ve.narration, v.narration) as narration, ve.debit_amount, ve.credit_amount,
        cp.counterparty, cp.counterparty_ledger_id,
        row_number() over (order by v.voucher_date, v.sequence_number, ve.line_order) as rn
      from public.voucher_entries ve
      join public.vouchers v on v.id = ve.voucher_id
      cross join lateral (
        select
          string_agg(distinct l2.name, ', ' order by l2.name) as counterparty,
          -- min()/max() have no uuid implementation, and when there is
          -- exactly one distinct id every row of the array is that same
          -- value anyway, so a plain (non-distinct) array_agg is enough.
          case when count(distinct l2.id) = 1 then (array_agg(l2.id))[1] end as counterparty_ledger_id
        from public.voucher_entries ve2
        join public.ledgers l2 on l2.id = ve2.ledger_id
        where ve2.voucher_id = ve.voucher_id and ve2.id <> ve.id
      ) cp
      where ve.ledger_id = p_ledger_id and v.company_id = p_company_id
        and v.is_deleted = false
        and v.voucher_date between p_from_date and p_to_date
    ) m
  ) ordered
  order by ordered.rn;
end;
$$;
