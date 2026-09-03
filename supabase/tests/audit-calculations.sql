-- An audit of the arithmetic in HISAB's reporting layer.
--
-- guarantees.sql asserts the rules the *database* enforces. This file asserts
-- something narrower and, for a set of books, more important: that the numbers
-- the reports print are the numbers the underlying rows say they should be.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/audit-calculations.sql
--
-- It builds its own fixtures, touches nothing that already exists, and rolls
-- the whole transaction back.
--
-- ---------------------------------------------------------------- the method
--
-- Every expectation here is computed a SECOND, INDEPENDENT way, from
-- `voucher_entries` and `ledgers` directly. No assertion checks one report by
-- calling another — two reports built on the same mistaken expression agree
-- with each other perfectly. Where the independent computation could have been
-- copied from the function under test it is deliberately written differently
-- (a semi-join rather than a join, two sums rather than one, a CASE rather
-- than a multiplication by ±1), so a transcription error in one is unlikely to
-- be reproduced in the other.
--
-- A handful of figures are additionally pinned to hand-computed literals in
-- section 2. That is not belt-and-braces: it is the only thing standing
-- between this file and the failure mode where the helper and the function are
-- both wrong in the same direction and quietly agree.
--
-- ------------------------------------------- why this one does not abort early
--
-- guarantees.sql raises on the first failure, which is right for a gate. An
-- audit is a survey: stopping at the first discrepancy hides the other five and
-- makes the next run a bisection. So `pg_temp.chk` RECORDS a failure and
-- carries on, every finding is printed at the end with its expected and actual
-- figures in paise, and the script then raises so the exit code is still
-- non-zero. Running it twice — once against the migrations as they are, once
-- with a function deliberately mutated — gives two failure sets whose
-- difference is exactly what the mutation broke, which is how each assertion
-- below was shown to be capable of failing.
--
-- A NULL condition is a failure, not a pass, for the reason guarantees.sql
-- gives: most of these compare a figure a function is supposed to have
-- returned, and "no row came back" must not read as "the figures agree".

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------------ helpers

create temp table audit_findings (
  seq serial primary key,
  section text,
  what text,
  expected text,
  actual text
);

-- Money is compared in paise, printed in paise, and reported in paise. Rupee
-- formatting is the one place a real half-paisa discrepancy can be rounded out
-- of existence by the report that is meant to be showing it to you.
create or replace function pg_temp.paise(p numeric) returns text
language sql immutable as $$
  select case when p is null then '(null)' else round(p * 100)::bigint::text || 'p' end;
$$;

create or replace function pg_temp.chk(
  p_ok boolean, p_what text, p_expected text default null, p_actual text default null
) returns void language plpgsql as $$
begin
  if p_ok is true then
    raise notice '  ok    %', p_what;
  else
    insert into pg_temp.audit_findings (section, what, expected, actual)
    values (coalesce(current_setting('audit.section', true), '?'), p_what, p_expected, p_actual);
    raise warning '  FAIL  %  [expected %, actual %]',
      p_what, coalesce(p_expected, '-'), coalesce(p_actual, '-');
  end if;
end;
$$;

create or replace function pg_temp.chk_eq(
  p_actual numeric, p_expected numeric, p_what text
) returns void language plpgsql as $$
begin
  perform pg_temp.chk(
    p_actual is not distinct from p_expected,
    p_what,
    pg_temp.paise(p_expected),
    pg_temp.paise(p_actual)
  );
end;
$$;

-- THE INDEPENDENT BALANCE. Opening balance, signed by its type, plus every
-- posting on every non-deleted voucher of this company dated on or before the
-- as-of date.
--
-- Written to look as little as possible like the lateral in get_trial_balance:
-- the opening is a CASE returning the negated amount rather than a
-- multiplication by ±1, the movement is two separate sums subtracted rather
-- than one sum of a difference, and the voucher restriction is a semi-join
-- rather than an inner join. Same arithmetic, different expression — which is
-- the only way a second opinion is worth having.
create or replace function pg_temp.raw_balance(
  p_company uuid, p_ledger uuid, p_as_of date
) returns numeric language sql stable as $$
  select
    (select case when l.opening_balance_type = 'debit'
                 then coalesce(l.opening_balance_amount, 0)
                 else -coalesce(l.opening_balance_amount, 0) end
       from public.ledgers l
      where l.id = p_ledger and l.company_id = p_company)
    +
    (select coalesce(sum(e.debit_amount), 0) - coalesce(sum(e.credit_amount), 0)
       from public.voucher_entries e
      where e.ledger_id = p_ledger
        and exists (
          select 1 from public.vouchers v
           where v.id = e.voucher_id
             and v.company_id = p_company
             and v.is_deleted = false
             and v.voucher_date <= p_as_of
        ));
$$;

-- Life to date: the same figure with no date bound at all, which is what
-- get_outstanding_balances reports and what the 0017 deactivation guard
-- measures. '9999-12-31' rather than a second function body, so the two
-- cannot drift.
create or replace function pg_temp.raw_balance_ltd(p_company uuid, p_ledger uuid)
returns numeric language sql stable as $$
  select pg_temp.raw_balance(p_company, p_ledger, '9999-12-31'::date);
$$;

-- Net profit computed the long way round: income is what was credited less
-- what was debited to it, expense is what was debited less what was credited,
-- and profit is the first minus the second. get_balance_sheet collapses this
-- to one uniform sum(credit - debit) and argues the branches cancel. They do
-- — but the argument is exactly the kind of reasoning an audit should not
-- take on trust, so this spells it out per nature and lets the two meet.
create or replace function pg_temp.raw_net_profit(
  p_company uuid, p_from date, p_to date
) returns numeric language sql stable as $$
  select
    coalesce(sum(case when g.nature in ('direct_income', 'indirect_income')
                      then e.credit_amount - e.debit_amount end), 0)
  - coalesce(sum(case when g.nature in ('direct_expense', 'indirect_expense')
                      then e.debit_amount - e.credit_amount end), 0)
  from public.voucher_entries e
  join public.vouchers v on v.id = e.voucher_id
  join public.ledgers l on l.id = e.ledger_id
  join public.account_groups g on g.id = l.group_id
  where v.company_id = p_company
    and v.is_deleted = false
    and v.voucher_date between p_from and p_to;
$$;

create or replace function pg_temp.section(p_name text) returns void
language plpgsql as $$
begin
  perform set_config('audit.section', p_name, false);
end;
$$;


-- ============================================================== 1. FIXTURES

\echo ''
\echo '1. Building the fixtures'

-- COMPANY A — the general dataset. Everything awkward that can coexist without
-- contradicting anything else lives here: an overdrawn bank, a customer in
-- credit, a supplier holding our advance, a proprietor's drawings sitting on
-- the debit side of a capital-nature ledger, an inactive ledger still carrying
-- money, an inactive one at nil, a party whose whole balance is an opening
-- figure, a soft-deleted voucher, a forward-dated invoice, vouchers landing
-- exactly on and exactly either side of both period boundaries, and two
-- invoices whose paise do not divide.
--
-- Its opening balances are constructed to net to zero across the company
-- (192000 Dr against 192000 Cr). That is not tidiness: the Trial Balance can
-- only tally if they do, and a fixture whose openings were lopsided would
-- report a fixture defect as a function defect on every single date.

do $$
declare
  v_company uuid;
  v_g_cash uuid; v_g_bank uuid; v_g_debtor uuid; v_g_creditor uuid;
  v_g_capital uuid; v_g_dinc uuid; v_g_dexp uuid; v_g_iinc uuid;
  v_g_iexp uuid; v_g_plant uuid;
  v_cash uuid; v_bank_main uuid; v_bank_od uuid;
  v_alpha uuid; v_beta uuid; v_retired uuid; v_dormant uuid; v_opening_only uuid;
  v_gamma uuid; v_delta uuid;
  v_capital uuid; v_drawings uuid;
  v_sales uuid; v_purchases uuid; v_freight uuid; v_rent uuid; v_commission uuid;
  v_machine uuid;
  v_v3 uuid; v_v8 uuid; v_v9 uuid; v_v11 uuid; v_v14 uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('AUDIT A Main Co', '2025-04-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_g_cash     from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  select id into v_g_bank     from public.account_groups where company_id = v_company and name = 'Bank Accounts';
  select id into v_g_debtor   from public.account_groups where company_id = v_company and name = 'Sundry Debtors';
  select id into v_g_creditor from public.account_groups where company_id = v_company and name = 'Sundry Creditors';
  select id into v_g_capital  from public.account_groups where company_id = v_company and name = 'Capital Account';
  select id into v_g_dinc     from public.account_groups where company_id = v_company and name = 'Direct Incomes';
  select id into v_g_dexp     from public.account_groups where company_id = v_company and name = 'Direct Expenses';
  select id into v_g_iinc     from public.account_groups where company_id = v_company and name = 'Indirect Incomes';
  select id into v_g_iexp     from public.account_groups where company_id = v_company and name = 'Indirect Expenses';
  select id into v_g_plant    from public.account_groups where company_id = v_company and name = 'Plant & Machinery';

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_cash, 'A Cash', 100000.00, 'debit') returning id into v_cash;
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_bank, 'A Bank Main', 50000.00, 'debit') returning id into v_bank_main;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_g_bank, 'A Bank Overdraft') returning id into v_bank_od;

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_debtor, 'A Debtor Alpha', 30000.00, 'debit') returning id into v_alpha;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_g_debtor, 'A Debtor Beta') returning id into v_beta;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_g_debtor, 'A Debtor Retired') returning id into v_retired;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_g_debtor, 'A Debtor Dormant') returning id into v_dormant;
  -- Carried over from the old books and never posted to since: its whole
  -- balance is the opening figure, so its last transaction date is nothing.
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_debtor, 'A Debtor Opening Only', 12000.00, 'debit') returning id into v_opening_only;

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_creditor, 'A Creditor Gamma', 20000.00, 'credit') returning id into v_gamma;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_g_creditor, 'A Creditor Delta') returning id into v_delta;

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_capital, 'A Capital', 172000.00, 'credit') returning id into v_capital;
  -- A capital-nature ledger that will carry a DEBIT balance. 0012's rule says
  -- it belongs on the asset side of the sheet; its nature says otherwise.
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_g_capital, 'A Drawings') returning id into v_drawings;

  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_dinc,  'A Sales')             returning id into v_sales;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_dexp,  'A Purchases')         returning id into v_purchases;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_dexp,  'A Freight')           returning id into v_freight;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_iexp,  'A Rent')              returning id into v_rent;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_iinc,  'A Commission Earned') returning id into v_commission;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_plant, 'A Machine')           returning id into v_machine;

  -- Retired while empty, then posted to. The only route to "inactive and
  -- still holding money" that 0017's trigger permits, and the state 0017's
  -- reporting half exists to handle.
  update public.ledgers set is_active = false where id in (v_retired, v_dormant);

  -- V1 — the first day of the financial year, which is also book beginning.
  perform public.create_voucher(v_company, 'journal', '2025-04-01', 'A/V1 machine bought on credit', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_machine, 'debit_amount', 25000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_gamma,   'debit_amount', 0, 'credit_amount', 25000, 'line_order', 1)));

  -- V2 — the day BEFORE the report period starts.
  perform public.create_voucher(v_company, 'receipt', '2025-05-31', 'A/V2 day before the period', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 1000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_alpha, 'debit_amount', 0, 'credit_amount', 1000, 'line_order', 1)));

  -- V3 — EXACTLY the first day of the period, and the sum-of-rounded probe:
  -- three lines at 33.3333 store 33.33 each and must post 99.99, not the
  -- 100.00 a round-the-sum generator would produce.
  v_v3 := public.create_voucher(v_company, 'sales', '2025-06-01', 'A/V3 thirds', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_alpha, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Third 1', 'quantity', 1, 'rate', 33.3333, 'revenue_ledger_id', v_sales),
      jsonb_build_object('line_order', 1, 'description', 'Third 2', 'quantity', 1, 'rate', 33.3333, 'revenue_ledger_id', v_sales),
      jsonb_build_object('line_order', 2, 'description', 'Third 3', 'quantity', 1, 'rate', 33.3333, 'revenue_ledger_id', v_sales))));

  -- V4 — overdraws the second bank account. Asset nature, credit balance.
  perform public.create_voucher(v_company, 'payment', '2025-06-15', 'A/V4 stock bought on overdraft', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_purchases, 'debit_amount', 40000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_bank_od,   'debit_amount', 0, 'credit_amount', 40000, 'line_order', 1)));

  -- V5 — EXACTLY the last day of the period. Puts a customer into credit.
  perform public.create_voucher(v_company, 'receipt', '2025-06-30', 'A/V5 advance from a customer', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash, 'debit_amount', 5000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_beta, 'debit_amount', 0, 'credit_amount', 5000, 'line_order', 1)));

  -- V6 — the day AFTER the period ends.
  perform public.create_voucher(v_company, 'payment', '2025-07-01', 'A/V6 day after the period', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_rent, 'debit_amount', 2500, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_cash, 'debit_amount', 0, 'credit_amount', 2500, 'line_order', 1)));

  -- V7 — the LAST day of the financial year. Puts a supplier into debit.
  perform public.create_voucher(v_company, 'payment', '2026-03-31', 'A/V7 advance paid to a supplier', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_delta,     'debit_amount', 7000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_bank_main, 'debit_amount', 0, 'credit_amount', 7000, 'line_order', 1)));

  -- V8 — the rounding probe proper. Six lines, none of which divides evenly:
  --   0.001 x 1234.5678 -> round(1.2345678) = 1.23   (a four-decimal rate on a gram)
  --   7     x   10.0050 -> round(70.035)    = 70.04, less a 0.01 discount = 70.03
  --   2     x    0.0850 -> round(0.17)      = 0.17
  --   1     x    0.0050 -> round(0.005)     = 0.01, three times
  -- Sum of the rounded lines: 71.46. Rounding the raw sum instead
  -- (71.4445678) gives 71.44 — two paise adrift, which is what this fixture is
  -- for.
  v_v8 := public.create_voucher(v_company, 'purchase', '2025-06-10', 'A/V8 odd paise', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_gamma, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'One gram',   'quantity', 0.001, 'unit', 'kg', 'rate', 1234.5678, 'revenue_ledger_id', v_purchases),
      jsonb_build_object('line_order', 1, 'description', 'Carriage',   'quantity', 7,     'rate', 10.0050, 'discount_amount', 0.01, 'revenue_ledger_id', v_freight),
      jsonb_build_object('line_order', 2, 'description', 'Sub-paisa',  'quantity', 2,     'rate', 0.0850,  'revenue_ledger_id', v_purchases),
      jsonb_build_object('line_order', 3, 'description', 'Half paisa A', 'quantity', 1, 'rate', 0.0050, 'revenue_ledger_id', v_freight),
      jsonb_build_object('line_order', 4, 'description', 'Half paisa B', 'quantity', 1, 'rate', 0.0050, 'revenue_ledger_id', v_freight),
      jsonb_build_object('line_order', 5, 'description', 'Half paisa C', 'quantity', 1, 'rate', 0.0050, 'revenue_ledger_id', v_freight))));

  -- V9 — soft-deleted, and deliberately enormous, so any report that forgets
  -- the is_deleted filter is off by an amount nobody could mistake for
  -- rounding. It touches a party as well as cash, so the outstanding list is
  -- tested for the same exclusion.
  v_v9 := public.create_voucher(v_company, 'journal', '2025-06-20', 'A/V9 keyed in twice, deleted', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_alpha, 'debit_amount', 99999, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 99999, 'line_order', 1)));

  -- V10 — posts to the ledger that was retired while empty.
  perform public.create_voucher(v_company, 'journal', '2025-06-05', 'A/V10 sold to a retired account', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_retired, 'debit_amount', 1234.56, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales,   'debit_amount', 0, 'credit_amount', 1234.56, 'line_order', 1)));

  -- V11 — dated years ahead. Outstanding balances are life-to-date by design
  -- and must include it; every date-bounded report must not.
  v_v11 := public.create_voucher(v_company, 'sales', '2030-01-01', 'A/V11 dated far ahead', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_alpha, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Next decade', 'quantity', 1, 'rate', 8888.88, 'revenue_ledger_id', v_sales))));

  -- V12 — a bank receipt inside the period, so the dashboard's inflow tile has
  -- something on the bank side as well as the cash side.
  perform public.create_voucher(v_company, 'receipt', '2025-06-15', 'A/V12 commission received', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_bank_main,  'debit_amount', 300, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_commission, 'debit_amount', 0, 'credit_amount', 300, 'line_order', 1)));

  -- V13 — the proprietor takes cash out. A debit on a capital-nature ledger.
  perform public.create_voucher(v_company, 'payment', '2025-06-12', 'A/V13 drawings', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_drawings, 'debit_amount', 3000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_cash,     'debit_amount', 0, 'credit_amount', 3000, 'line_order', 1)));

  -- V14 — a second soft-deleted voucher, this one through the cash box. V9
  -- touches a debtor and an income ledger, which between them reach the Trial
  -- Balance, the P&L, the Daybook and the outstanding list — but not the
  -- dashboard, whose tiles only ever look at cash and bank. Without this one
  -- "a soft-deleted voucher moves no dashboard tile" passes for want of a
  -- deleted voucher the dashboard could have seen.
  v_v14 := public.create_voucher(v_company, 'receipt', '2025-06-18', 'A/V14 cash receipt, deleted', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 77777, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 77777, 'line_order', 1)));

  -- Force the deferred balance and invoice-line triggers now, so
  -- vouchers.total_amount is populated for the rest of this script rather than
  -- at a COMMIT that never comes.
  set constraints all immediate;
  set constraints all deferred;

  update public.vouchers set is_deleted = true where id in (v_v9, v_v14);

  perform set_config('audit.a_company', v_company::text, false);
  perform set_config('audit.a_cash', v_cash::text, false);
  perform set_config('audit.a_bank_main', v_bank_main::text, false);
  perform set_config('audit.a_bank_od', v_bank_od::text, false);
  perform set_config('audit.a_alpha', v_alpha::text, false);
  perform set_config('audit.a_beta', v_beta::text, false);
  perform set_config('audit.a_retired', v_retired::text, false);
  perform set_config('audit.a_dormant', v_dormant::text, false);
  perform set_config('audit.a_opening_only', v_opening_only::text, false);
  perform set_config('audit.a_gamma', v_gamma::text, false);
  perform set_config('audit.a_delta', v_delta::text, false);
  perform set_config('audit.a_capital', v_capital::text, false);
  perform set_config('audit.a_drawings', v_drawings::text, false);
  perform set_config('audit.a_sales', v_sales::text, false);
  perform set_config('audit.a_purchases', v_purchases::text, false);
  perform set_config('audit.a_freight', v_freight::text, false);
  perform set_config('audit.a_rent', v_rent::text, false);
  perform set_config('audit.a_commission', v_commission::text, false);
  perform set_config('audit.a_machine', v_machine::text, false);
  perform set_config('audit.a_v3', v_v3::text, false);
  perform set_config('audit.a_v8', v_v8::text, false);
  perform set_config('audit.a_v9', v_v9::text, false);
  perform set_config('audit.a_v14', v_v14::text, false);
  perform set_config('audit.a_v11', v_v11::text, false);
end;
$$;

-- COMPANY B — one question only: what happens to a voucher dated before
-- book_beginning_date. Nothing in the schema forbids one (there is no check
-- constraint, no trigger, and the CSV importer and restore paths both accept
-- whatever date they are given), and get_balance_sheet's profit subquery is the
-- one place in the reporting layer that bounds a window at that date.
--
-- Kept in its own company because if this is a defect it puts the Balance Sheet
-- permanently out of balance, which would mask every other result on the same
-- dataset.

do $$
declare
  v_company uuid;
  v_g_cash uuid; v_g_dinc uuid; v_g_capital uuid;
  v_cash uuid; v_sales uuid; v_capital uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('AUDIT B Early Co', '2025-04-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_g_cash    from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  select id into v_g_dinc    from public.account_groups where company_id = v_company and name = 'Direct Incomes';
  select id into v_g_capital from public.account_groups where company_id = v_company and name = 'Capital Account';

  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_cash, 'B Cash') returning id into v_cash;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_dinc, 'B Sales') returning id into v_sales;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_capital, 'B Capital') returning id into v_capital;

  -- One day before the books are supposed to begin.
  perform public.create_voucher(v_company, 'journal', '2025-03-31', 'B/V1 dated before book beginning', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 1000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 1000, 'line_order', 1)));

  -- And one comfortably inside them, so the report has something it agrees on.
  perform public.create_voucher(v_company, 'journal', '2025-05-01', 'B/V2 ordinary sale', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 500, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 500, 'line_order', 1)));

  set constraints all immediate;
  set constraints all deferred;

  perform set_config('audit.b_company', v_company::text, false);
  perform set_config('audit.b_cash', v_cash::text, false);
  perform set_config('audit.b_sales', v_sales::text, false);
end;
$$;

-- COMPANY C — contra balances inside the Trading account. "Sales Returns"
-- grouped under Direct Incomes and "Purchase Returns" under Direct Expenses is
-- how these are ordinarily set up (it is Tally's own arrangement), and each
-- carries a balance on the opposite side to its group's normal balance for its
-- whole life.
--
-- Its own company for the same reason as B: this is the fixture that decides
-- whether get_profit_and_loss's abs() is a presentation choice or a
-- subtraction that has become an addition.

do $$
declare
  v_company uuid;
  v_g_cash uuid; v_g_dinc uuid; v_g_dexp uuid;
  v_cash uuid; v_sales uuid; v_sret uuid; v_purch uuid; v_pret uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('AUDIT C Returns Co', '2025-04-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_g_cash from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  select id into v_g_dinc from public.account_groups where company_id = v_company and name = 'Direct Incomes';
  select id into v_g_dexp from public.account_groups where company_id = v_company and name = 'Direct Expenses';

  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_cash, 'C Cash')            returning id into v_cash;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_dinc, 'C Sales')           returning id into v_sales;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_dinc, 'C Sales Returns')   returning id into v_sret;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_dexp, 'C Purchases')       returning id into v_purch;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_dexp, 'C Purchase Returns') returning id into v_pret;

  perform public.create_voucher(v_company, 'journal', '2025-05-05', 'C/V1 sold for cash', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 10000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 10000, 'line_order', 1)));

  perform public.create_voucher(v_company, 'journal', '2025-05-10', 'C/V2 goods came back', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_sret, 'debit_amount', 2500, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_cash, 'debit_amount', 0, 'credit_amount', 2500, 'line_order', 1)));

  perform public.create_voucher(v_company, 'journal', '2025-05-15', 'C/V3 bought for cash', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_purch, 'debit_amount', 6000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 0, 'credit_amount', 6000, 'line_order', 1)));

  perform public.create_voucher(v_company, 'journal', '2025-05-20', 'C/V4 sent goods back', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash, 'debit_amount', 1500, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_pret, 'debit_amount', 0, 'credit_amount', 1500, 'line_order', 1)));

  set constraints all immediate;
  set constraints all deferred;

  perform set_config('audit.c_company', v_company::text, false);
  perform set_config('audit.c_sales', v_sales::text, false);
  perform set_config('audit.c_sret', v_sret::text, false);
  perform set_config('audit.c_purch', v_purch::text, false);
  perform set_config('audit.c_pret', v_pret::text, false);
end;
$$;

-- COMPANY D — the empty and single-row cases. A company with no vouchers at
-- all, one ledger whose entire balance is an opening figure, and nothing else.
-- Every report has to have an answer for it, including "one row of zeroes"
-- where that is the right answer and "no rows" where that is.

do $$
declare
  v_company uuid;
  v_g_debtor uuid; v_g_capital uuid;
  v_debtor uuid; v_capital uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('AUDIT D Quiet Co', '2026-01-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_g_debtor  from public.account_groups where company_id = v_company and name = 'Sundry Debtors';
  select id into v_g_capital from public.account_groups where company_id = v_company and name = 'Capital Account';

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_debtor, 'D Opening Debtor', 5000.00, 'debit') returning id into v_debtor;
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_capital, 'D Capital', 5000.00, 'credit') returning id into v_capital;

  perform set_config('audit.d_company', v_company::text, false);
  perform set_config('audit.d_debtor', v_debtor::text, false);
  perform set_config('audit.d_capital', v_capital::text, false);
end;
$$;

-- COMPANY E — a bank account emptied this month and then retired, plus one
-- voucher that debits and credits the SAME ledger.
--
-- 0017 decided that an inactive ledger at nil is hidden from the statements,
-- and get_dashboard_summary applies that test to `balance_now`. The two
-- remaining dashboard figures are not balances at all: `*_change` is a
-- difference between two dates, and month inflow/outflow is gross movement
-- through a period. Whether a rule about the balance TODAY is the right filter
-- for a figure about what happened LAST MONTH is the question this fixture
-- asks.

do $$
declare
  v_company uuid;
  v_g_cash uuid; v_g_bank uuid; v_g_capital uuid;
  v_cash uuid; v_bank_old uuid; v_bank_retired uuid; v_capital uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('AUDIT E Retired Bank Co', '2025-04-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_g_cash    from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  select id into v_g_bank    from public.account_groups where company_id = v_company and name = 'Bank Accounts';
  select id into v_g_capital from public.account_groups where company_id = v_company and name = 'Capital Account';

  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_cash, 'E Cash') returning id into v_cash;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_bank, 'E Bank Closed') returning id into v_bank_old;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_bank, 'E Bank Retired') returning id into v_bank_retired;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_g_capital, 'E Capital') returning id into v_capital;

  -- Retired while empty and then posted to, so it is inactive AND holding
  -- money. 0017's rule says the statements must show it; the tile that reads
  -- the same money has to agree with them.
  update public.ledgers set is_active = false where id = v_bank_retired;

  perform public.create_voucher(v_company, 'receipt', '2025-05-10', 'E/V1 capital paid into the bank', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_bank_old, 'debit_amount', 50000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_capital,  'debit_amount', 0, 'credit_amount', 50000, 'line_order', 1)));

  -- The account is emptied THIS month, then closed.
  perform public.create_voucher(v_company, 'contra', '2025-06-05', 'E/V2 account closed, balance drawn out', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,     'debit_amount', 50000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_bank_old, 'debit_amount', 0, 'credit_amount', 50000, 'line_order', 1)));

  -- Three lines, two of them on the same ledger and on opposite sides. Legal,
  -- ordinary (a correction inside one voucher), and the case a running-balance
  -- window function is most likely to get wrong.
  perform public.create_voucher(v_company, 'journal', '2025-06-20', 'E/V3 both sides of one ledger', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,    'debit_amount', 100, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_cash,    'debit_amount', 0, 'credit_amount', 40, 'line_order', 1),
      jsonb_build_object('ledger_id', v_capital, 'debit_amount', 0, 'credit_amount', 60, 'line_order', 2)));

  perform public.create_voucher(v_company, 'receipt', '2025-06-25', 'E/V4 paid into the retired account', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_bank_retired, 'debit_amount', 700, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_capital,      'debit_amount', 0, 'credit_amount', 700, 'line_order', 1)));

  set constraints all immediate;
  set constraints all deferred;

  -- Nil at this point, so 0017's deactivation guard permits it.
  update public.ledgers set is_active = false where id = v_bank_old;

  perform set_config('audit.e_company', v_company::text, false);
  perform set_config('audit.e_cash', v_cash::text, false);
  perform set_config('audit.e_bank_old', v_bank_old::text, false);
  perform set_config('audit.e_bank_retired', v_bank_retired::text, false);
end;
$$;

-- COMPANY F — an opening balance on an income ledger, and nothing else.
--
-- Reachable: the ledger form's opening-amount field is not conditional on the
-- kind of ledger, and its Advanced disclosure offers every group including
-- Direct Incomes. Somebody migrating mid-year and carrying their year-to-date
-- sales across would do exactly this. Whether the reports survive it is a
-- separate question from whether it is good bookkeeping.

do $$
declare
  v_company uuid;
  v_g_cash uuid; v_g_dinc uuid;
  v_cash uuid; v_sales uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('AUDIT F Carried Income Co', '2025-04-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_g_cash from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  select id into v_g_dinc from public.account_groups where company_id = v_company and name = 'Direct Incomes';

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_cash, 'F Cash', 9000.00, 'debit') returning id into v_cash;
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_g_dinc, 'F Sales Brought Forward', 9000.00, 'credit') returning id into v_sales;

  perform set_config('audit.f_company', v_company::text, false);
  perform set_config('audit.f_cash', v_cash::text, false);
  perform set_config('audit.f_sales', v_sales::text, false);
end;
$$;

\echo '  fixtures built'


-- ================================================ 2. THE FIXTURE ITSELF, PINNED

\echo ''
\echo '2. The fixture agrees with figures worked out by hand'

-- Everything after this section compares a function against pg_temp.raw_balance
-- and friends. If those helpers are wrong, every comparison agrees and the
-- audit reports nothing. So the helpers are pinned here against balances
-- computed on paper from the voucher list above, before they are trusted with
-- anything else.

do $$
declare
  v_c uuid := current_setting('audit.a_company')::uuid;
  v_as_of date := '2025-06-30';
  v_dr numeric; v_cr numeric;
begin
  perform pg_temp.section('2. fixture self-check');

  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_cash')::uuid, v_as_of),
    103000.00, 'A Cash at 2025-06-30 is 100000 opening + 1000 + 5000 - 3000');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_bank_od')::uuid, v_as_of),
    -40000.00, 'A Bank Overdraft at 2025-06-30 is 40000 in credit — an asset-nature ledger overdrawn');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_beta')::uuid, v_as_of),
    -5000.00, 'A Debtor Beta at 2025-06-30 is 5000 in credit — a customer holding an advance');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_delta')::uuid, '2026-03-31'),
    7000.00, 'A Creditor Delta at 2026-03-31 is 7000 in debit — a supplier holding our advance');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_alpha')::uuid, v_as_of),
    29099.99, 'A Debtor Alpha at 2025-06-30 is 30000 - 1000 + 99.99, with the deleted 99999 nowhere');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_gamma')::uuid, v_as_of),
    -45071.46, 'A Creditor Gamma at 2025-06-30 is 20000 + 25000 + 71.46 in credit');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_freight')::uuid, v_as_of),
    70.06, 'A Freight at 2025-06-30 is 70.03 + three half-paisa lines rounded up');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_purchases')::uuid, v_as_of),
    40001.40, 'A Purchases at 2025-06-30 is 40000 + 1.23 + 0.17');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_retired')::uuid, v_as_of),
    1234.56, 'A Debtor Retired holds 1234.56 despite being inactive');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_rent')::uuid, v_as_of),
    0.00, 'A Rent is still nil at 2025-06-30 — its only voucher is dated the day after');
  perform pg_temp.chk_eq(pg_temp.raw_balance(v_c, current_setting('audit.a_rent')::uuid, '2025-07-01'),
    2500.00, 'and 2500 the very next day');

  -- The whole company nets to zero. Double entry plus balanced openings make
  -- this true of any correct dataset, so if it is false here the fixture is
  -- broken and nothing below means anything.
  select
    coalesce(sum(case when b > 0 then b end), 0),
    coalesce(sum(case when b < 0 then -b end), 0)
  into v_dr, v_cr
  from (
    select pg_temp.raw_balance(v_c, l.id, v_as_of) as b
    from public.ledgers l where l.company_id = v_c
  ) s;

  perform pg_temp.chk_eq(v_dr, 263706.01, 'the fixture''s debit side at 2025-06-30, from raw rows');
  perform pg_temp.chk_eq(v_cr, 263706.01, 'the fixture''s credit side at 2025-06-30, from raw rows');

  perform pg_temp.chk_eq(pg_temp.raw_net_profit(v_c, '2025-04-01', '2025-06-30'), -38436.91,
    'and the period result is a loss of 38436.91, worked out per nature');
end;
$$;


-- ================================================== 3. INVARIANT 1 — TRIAL BALANCE

\echo ''
\echo '3. Invariant 1 — the Trial Balance tallies'

do $$
declare
  v_c uuid := current_setting('audit.a_company')::uuid;
  v_date date;
  v_dr numeric; v_cr numeric;
begin
  perform pg_temp.section('3. trial balance tallies');

  -- Every date that matters: before anything, on book beginning, either side
  -- of both period boundaries, mid-year, the last day of the year, and a date
  -- past every voucher including the forward-dated one.
  foreach v_date in array array[
    '2025-03-01'::date, '2025-04-01', '2025-05-30', '2025-05-31', '2025-06-01',
    '2025-06-30', '2025-07-01', '2026-03-31', '2030-12-31', '9999-12-31'
  ] loop
    select coalesce(sum(debit_balance), 0), coalesce(sum(credit_balance), 0)
      into v_dr, v_cr
      from public.get_trial_balance(v_c, v_date);
    perform pg_temp.chk(v_dr = v_cr,
      format('Trial Balance tallies at %s', v_date),
      pg_temp.paise(v_dr), pg_temp.paise(v_cr));
  end loop;

  -- The tally is not vacuous: it has to tally at a figure, and the figure has
  -- to be the one the rows say.
  select coalesce(sum(debit_balance), 0), coalesce(sum(credit_balance), 0)
    into v_dr, v_cr from public.get_trial_balance(v_c, '2025-06-30');
  perform pg_temp.chk_eq(v_dr, 263706.01, 'and it tallies at the hand-computed 263706.01, not at nothing');

  -- Company D: two ledgers, no vouchers at all.
  select coalesce(sum(debit_balance), 0), coalesce(sum(credit_balance), 0)
    into v_dr, v_cr from public.get_trial_balance(current_setting('audit.d_company')::uuid, '2026-06-30');
  perform pg_temp.chk_eq(v_dr, 5000.00, 'a company with no vouchers still shows its opening balances (Dr)');
  perform pg_temp.chk_eq(v_cr, 5000.00, 'and they tally (Cr)');

  -- And at a date BEFORE its books begin. The opening balances are reported in
  -- full, because get_trial_balance has no lower bound at all. Recorded as an
  -- observation rather than a defect: an opening balance is a statement about
  -- the moment the books opened, and there is no meaningful "before" for it.
  select coalesce(sum(debit_balance), 0), coalesce(sum(credit_balance), 0)
    into v_dr, v_cr from public.get_trial_balance(current_setting('audit.d_company')::uuid, '2025-12-31');
  perform pg_temp.chk_eq(v_dr, 5000.00, 'as of a date before book beginning, openings are still shown in full (Dr)');
  perform pg_temp.chk_eq(v_cr, 5000.00, 'and still tally (Cr)');
end;
$$;


-- ============================ 4. INVARIANT 4 — EVERY LEDGER'S TRIAL BALANCE FIGURE

\echo ''
\echo '4. Invariant 4 — each ledger''s Trial Balance figure is its opening plus its postings'

do $$
declare
  v_c uuid := current_setting('audit.a_company')::uuid;
  v_date date;
  r record;
  v_expected numeric;
  v_seen int;
  v_missing int;
begin
  perform pg_temp.section('4. per-ledger trial balance');

  foreach v_date in array array['2025-05-31'::date, '2025-06-30', '2026-03-31', '9999-12-31'] loop
    -- Every row the function returns must equal the independently computed
    -- balance, and must put it on exactly one side.
    for r in select * from public.get_trial_balance(v_c, v_date) loop
      v_expected := pg_temp.raw_balance(v_c, r.ledger_id, v_date);
      perform pg_temp.chk_eq(r.debit_balance - r.credit_balance, v_expected,
        format('%s at %s: Trial Balance figure equals opening +/- postings', r.ledger_name, v_date));
      perform pg_temp.chk(r.debit_balance = 0 or r.credit_balance = 0,
        format('%s at %s: the figure sits on one side only', r.ledger_name, v_date),
        '0 on one side', pg_temp.paise(least(r.debit_balance, r.credit_balance)));
      perform pg_temp.chk(r.debit_balance >= 0 and r.credit_balance >= 0,
        format('%s at %s: neither column is negative', r.ledger_name, v_date));
    end loop;

    -- And every ledger the function LEAVES OUT must genuinely be at nil, and
    -- must be inactive. A ledger silently dropped while holding money is the
    -- 0017 defect, and it would not show up in the loop above at all.
    select count(*) into v_missing
    from public.ledgers l
    where l.company_id = v_c
      and not exists (select 1 from public.get_trial_balance(v_c, v_date) t where t.ledger_id = l.id)
      and (pg_temp.raw_balance(v_c, l.id, v_date) <> 0 or l.is_active);
    perform pg_temp.chk(v_missing = 0,
      format('at %s no ledger holding a balance, and no active ledger, is missing from the Trial Balance', v_date),
      '0', v_missing::text);
  end loop;

  -- The two halves of 0017's rule, named, so the sweep above cannot pass by
  -- accident on a fixture that never reached the interesting state.
  select count(*) into v_seen from public.get_trial_balance(v_c, '2025-06-30') t
   where t.ledger_id = current_setting('audit.a_retired')::uuid;
  perform pg_temp.chk(v_seen = 1, 'an inactive ledger still holding a balance appears on the Trial Balance', '1', v_seen::text);
  perform pg_temp.chk(
    (select not l.is_active from public.ledgers l where l.id = current_setting('audit.a_retired')::uuid),
    'and it really is inactive, so that assertion was not vacuous');

  select count(*) into v_seen from public.get_trial_balance(v_c, '2025-06-30') t
   where t.ledger_id = current_setting('audit.a_dormant')::uuid;
  perform pg_temp.chk(v_seen = 0, 'an inactive ledger at nil stays hidden', '0', v_seen::text);

  -- The soft-deleted voucher. Its 99999 would land on A Debtor Alpha.
  perform pg_temp.chk(
    (select v.is_deleted from public.vouchers v where v.id = current_setting('audit.a_v9')::uuid),
    'the soft-deleted voucher is on the books as deleted, so what follows is not vacuous');
  perform pg_temp.chk_eq(
    (select t.debit_balance from public.get_trial_balance(v_c, '2025-06-30') t
      where t.ledger_id = current_setting('audit.a_alpha')::uuid),
    29099.99, 'a soft-deleted voucher contributes nothing to the Trial Balance');

  -- The date boundary, stated on its own: get_trial_balance uses <=, so a
  -- voucher dated exactly on the as-of date is in.
  perform pg_temp.chk_eq(
    (select t.debit_balance from public.get_trial_balance(v_c, '2025-05-31') t
      where t.ledger_id = current_setting('audit.a_cash')::uuid),
    101000.00, 'a voucher dated exactly on the as-of date is included');
  perform pg_temp.chk_eq(
    (select t.debit_balance from public.get_trial_balance(v_c, '2025-05-30') t
      where t.ledger_id = current_setting('audit.a_cash')::uuid),
    100000.00, 'and is not included the day before');

  -- The opening balance, counted once and signed by its type.
  perform pg_temp.chk_eq(
    (select t.debit_balance from public.get_trial_balance(v_c, '2025-03-01') t
      where t.ledger_id = current_setting('audit.a_opening_only')::uuid),
    12000.00, 'a debit opening balance is reported once, as a debit');
  perform pg_temp.chk_eq(
    (select t.credit_balance from public.get_trial_balance(v_c, '2025-03-01') t
      where t.ledger_id = current_setting('audit.a_capital')::uuid),
    172000.00, 'a credit opening balance is reported once, as a credit');
end;
$$;


-- ================================== 5. INVARIANT 5 — THE LEDGER STATEMENT AGREES

\echo ''
\echo '5. Invariant 5 — a Ledger Statement''s closing balance is that ledger''s Trial Balance figure'

do $$
declare
  v_c uuid := current_setting('audit.a_company')::uuid;
  l record;
  v_final numeric;
  v_expected numeric;
  v_opening numeric;
  v_rows int;
  v_from date := '2025-06-01';
  v_to date := '2025-06-30';
begin
  perform pg_temp.section('5. ledger statement');

  for l in select id, name from public.ledgers where company_id = v_c order by name loop
    -- What the statement is compared against is derived from raw rows, not
    -- from another report: opening balance plus every posting up to the last
    -- day of the window.
    v_expected := pg_temp.raw_balance(v_c, l.id, v_to);

    -- The last running balance the statement prints. The function returns its
    -- rows already ordered, so the last one is taken by offset rather than by
    -- re-imposing an ordering of our own — re-sorting here would silently
    -- repair a function that emitted them in the wrong order.
    select s.running_balance into v_final
      from public.get_ledger_statement(v_c, l.id, v_from, v_to) s
      offset (select count(*) - 1 from public.get_ledger_statement(v_c, l.id, v_from, v_to))
      limit 1;

    perform pg_temp.chk_eq(v_final, v_expected,
      format('%s: statement closes at its balance on %s', l.name, v_to));

    -- And the opening row is the balance the day before the window opens,
    -- counted once.
    select s.running_balance into v_opening
      from public.get_ledger_statement(v_c, l.id, v_from, v_to) s
      limit 1;
    perform pg_temp.chk_eq(v_opening, pg_temp.raw_balance(v_c, l.id, v_from - 1),
      format('%s: statement opens at its balance on %s', l.name, v_from - 1));

    -- Every debit and credit in between, and no others.
    select count(*) into v_rows from public.get_ledger_statement(v_c, l.id, v_from, v_to) s
      where s.voucher_id is not null;
    perform pg_temp.chk(
      v_rows = (select count(*) from public.voucher_entries e
                 where e.ledger_id = l.id
                   and exists (select 1 from public.vouchers v
                                where v.id = e.voucher_id and v.company_id = v_c
                                  and v.is_deleted = false
                                  and v.voucher_date between v_from and v_to)),
      format('%s: the statement carries exactly its postings in the window', l.name),
      (select count(*)::text from public.voucher_entries e
        where e.ledger_id = l.id
          and exists (select 1 from public.vouchers v
                       where v.id = e.voucher_id and v.company_id = v_c
                         and v.is_deleted = false
                         and v.voucher_date between v_from and v_to)),
      v_rows::text);
  end loop;

  -- The boundaries, named. A Cash is touched on 05-31 (before), 06-30 (the
  -- last day) and 07-01 (after).
  select count(*) into v_rows from public.get_ledger_statement(
    v_c, current_setting('audit.a_cash')::uuid, v_from, v_to) s where s.voucher_id is not null;
  perform pg_temp.chk(v_rows = 2, 'A Cash''s June statement carries the 06-12 and 06-30 postings and no others', '2', v_rows::text);
  perform pg_temp.chk_eq(
    (select s.running_balance from public.get_ledger_statement(v_c, current_setting('audit.a_cash')::uuid, v_from, v_to) s limit 1),
    101000.00, 'and opens at 101000, the 05-31 receipt already inside the opening figure');

  -- A ledger with an opening balance and nothing else at all: one row, and it
  -- is the opening.
  select count(*) into v_rows from public.get_ledger_statement(
    current_setting('audit.d_company')::uuid, current_setting('audit.d_debtor')::uuid, '2026-01-01', '2026-12-31');
  perform pg_temp.chk(v_rows = 1, 'a ledger with only an opening balance yields exactly the opening row', '1', v_rows::text);
  perform pg_temp.chk_eq(
    (select s.running_balance from public.get_ledger_statement(
      current_setting('audit.d_company')::uuid, current_setting('audit.d_debtor')::uuid, '2026-01-01', '2026-12-31') s limit 1),
    5000.00, 'and it reads 5000');

  -- The retired ledger has a statement too — no report may hide it.
  perform pg_temp.chk_eq(
    (select s.running_balance from public.get_ledger_statement(
      v_c, current_setting('audit.a_retired')::uuid, v_from, v_to) s
      offset (select count(*) - 1 from public.get_ledger_statement(
        v_c, current_setting('audit.a_retired')::uuid, v_from, v_to)) limit 1),
    1234.56, 'an inactive ledger still has a statement, and it closes at its balance');

  -- An empty window on a ledger that has postings outside it.
  select count(*) into v_rows from public.get_ledger_statement(
    v_c, current_setting('audit.a_cash')::uuid, '2025-08-01', '2025-08-31');
  perform pg_temp.chk(v_rows = 1, 'a window containing nothing yields the opening row alone', '1', v_rows::text);
  perform pg_temp.chk_eq(
    (select s.running_balance from public.get_ledger_statement(
      v_c, current_setting('audit.a_cash')::uuid, '2025-08-01', '2025-08-31') s limit 1),
    pg_temp.raw_balance(v_c, current_setting('audit.a_cash')::uuid, '2025-07-31'),
    'and that row is the balance carried in');
end;
$$;


-- ============================================== 6. INVARIANT 6 — THE DAYBOOK

\echo ''
\echo '6. Invariant 6 — the Daybook is the vouchers in the period, at their totals'

do $$
declare
  v_c uuid := current_setting('audit.a_company')::uuid;
  v_rows int; v_expected_rows int;
  v_total numeric; v_expected_total numeric;
  v_from date := '2025-06-01';
  v_to date := '2025-06-30';
begin
  perform pg_temp.section('6. daybook');

  select count(*), coalesce(sum(total_amount), 0) into v_rows, v_total
    from public.get_daybook(v_c, v_from, v_to);

  select count(*), coalesce(sum(v.total_amount), 0) into v_expected_rows, v_expected_total
    from public.vouchers v
   where v.company_id = v_c and v.is_deleted = false
     and v.voucher_date >= v_from and v.voucher_date <= v_to;

  perform pg_temp.chk(v_rows = v_expected_rows, 'the Daybook lists every voucher in the period and no other',
    v_expected_rows::text, v_rows::text);
  perform pg_temp.chk_eq(v_total, v_expected_total, 'and its total is the sum of their total_amount');
  perform pg_temp.chk_eq(v_total, 49706.01, 'which is the hand-computed 49706.01');
  perform pg_temp.chk(v_rows = 7, 'seven vouchers, the deleted one not among them', '7', v_rows::text);

  -- Each voucher's total, one at a time, against its own postings — so a
  -- daybook total that happened to net out cannot pass.
  perform pg_temp.chk(
    not exists (
      select 1 from public.get_daybook(v_c, v_from, v_to) d
      where d.total_amount is distinct from (
        select coalesce(sum(e.debit_amount), 0) from public.voucher_entries e where e.voucher_id = d.voucher_id)),
    'every Daybook row''s amount is that voucher''s own debits');

  -- Inclusivity, on both edges.
  perform pg_temp.chk(
    exists (select 1 from public.get_daybook(v_c, v_from, v_to) d where d.voucher_date = v_from),
    'a voucher dated exactly on p_from_date is in the Daybook');
  perform pg_temp.chk(
    exists (select 1 from public.get_daybook(v_c, v_from, v_to) d where d.voucher_date = v_to),
    'a voucher dated exactly on p_to_date is in the Daybook');
  perform pg_temp.chk(
    not exists (select 1 from public.get_daybook(v_c, v_from, v_to) d where d.voucher_date < v_from or d.voucher_date > v_to),
    'and nothing outside the window is');
  perform pg_temp.chk(
    exists (select 1 from public.vouchers v where v.company_id = v_c and v.is_deleted = false
             and v.voucher_date in (v_from - 1, v_to + 1)),
    'there are vouchers one day either side, so the previous assertion was not vacuous');

  -- The deleted voucher.
  perform pg_temp.chk(
    not exists (select 1 from public.get_daybook(v_c, v_from, v_to) d
                 where d.voucher_id = current_setting('audit.a_v9')::uuid),
    'the soft-deleted voucher is not in the Daybook');

  -- A period with nothing in it.
  select count(*) into v_rows from public.get_daybook(v_c, '2025-08-01', '2025-08-31');
  perform pg_temp.chk(v_rows = 0, 'a period containing nothing yields no Daybook rows', '0', v_rows::text);

  -- A company with nothing in it.
  select count(*) into v_rows from public.get_daybook(current_setting('audit.d_company')::uuid, '2026-01-01', '2026-12-31');
  perform pg_temp.chk(v_rows = 0, 'a company with no vouchers yields no Daybook rows', '0', v_rows::text);

  -- A single day that is both ends of the window.
  select count(*), coalesce(sum(total_amount), 0) into v_rows, v_total
    from public.get_daybook(v_c, '2025-06-30', '2025-06-30');
  perform pg_temp.chk(v_rows = 1, 'a one-day window returns that day''s single voucher', '1', v_rows::text);
  perform pg_temp.chk_eq(v_total, 5000.00, 'at its own amount');
end;
$$;


-- ========================================== 7. INVARIANT 2 — THE BALANCE SHEET

\echo ''
\echo '7. Invariant 2 — the Balance Sheet''s two sides agree'

do $$
declare
  v_c uuid := current_setting('audit.a_company')::uuid;
  v_date date;
  v_assets numeric; v_liabs numeric;
  v_side text; v_amount numeric;
begin
  perform pg_temp.section('7. balance sheet tallies');

  foreach v_date in array array[
    '2025-03-01'::date, '2025-04-01', '2025-05-31', '2025-06-01', '2025-06-30',
    '2025-07-01', '2026-03-31', '2030-12-31'
  ] loop
    select
      coalesce(sum(amount) filter (where side = 'asset'), 0),
      coalesce(sum(amount) filter (where side = 'liability'), 0)
    into v_assets, v_liabs
    from public.get_balance_sheet(v_c, v_date);
    perform pg_temp.chk(v_assets = v_liabs,
      format('Balance Sheet: assets = liabilities at %s', v_date),
      pg_temp.paise(v_liabs), pg_temp.paise(v_assets));
  end loop;

  select
    coalesce(sum(amount) filter (where side = 'asset'), 0),
    coalesce(sum(amount) filter (where side = 'liability'), 0)
  into v_assets, v_liabs from public.get_balance_sheet(v_c, '2025-06-30');
  perform pg_temp.chk_eq(v_assets, 262071.46, 'and it tallies at the hand-computed 262071.46, not at nothing');

  -- Every ledger line's amount is the magnitude of its balance, and its side
  -- follows the SIGN of that balance — 0012's rule, re-tested on ledgers whose
  -- sign is opposite to their nature. Three of the four everyday cases 0012
  -- lists are in this fixture, plus a capital ledger in debit, which is not.
  for v_side, v_amount in
    select b.side, b.amount from public.get_balance_sheet(v_c, '2025-06-30') b
    where b.ledger_id = current_setting('audit.a_bank_od')::uuid
  loop
    perform pg_temp.chk(v_side = 'liability', 'an overdrawn bank is a liability, not a negative asset', 'liability', v_side);
    perform pg_temp.chk_eq(v_amount, 40000.00, 'at the magnitude of the overdraft');
  end loop;

  for v_side, v_amount in
    select b.side, b.amount from public.get_balance_sheet(v_c, '2025-06-30') b
    where b.ledger_id = current_setting('audit.a_beta')::uuid
  loop
    perform pg_temp.chk(v_side = 'liability', 'a customer in credit is a liability', 'liability', v_side);
    perform pg_temp.chk_eq(v_amount, 5000.00, 'at the amount he is owed');
  end loop;

  for v_side, v_amount in
    select b.side, b.amount from public.get_balance_sheet(v_c, '2026-03-31') b
    where b.ledger_id = current_setting('audit.a_delta')::uuid
  loop
    perform pg_temp.chk(v_side = 'asset', 'a supplier holding our advance is an asset', 'asset', v_side);
    perform pg_temp.chk_eq(v_amount, 7000.00, 'at the advance');
  end loop;

  for v_side, v_amount in
    select b.side, b.amount from public.get_balance_sheet(v_c, '2025-06-30') b
    where b.ledger_id = current_setting('audit.a_drawings')::uuid
  loop
    perform pg_temp.chk(v_side = 'asset', 'drawings — a capital-nature ledger in debit — sit on the asset side', 'asset', v_side);
    perform pg_temp.chk_eq(v_amount, 3000.00, 'at what was drawn');
  end loop;

  -- Every line, swept: amount is |balance| and side follows its sign.
  perform pg_temp.chk(
    not exists (
      select 1 from public.get_balance_sheet(v_c, '2025-06-30') b
      where b.ledger_id is not null
        and (b.amount is distinct from abs(pg_temp.raw_balance(v_c, b.ledger_id, '2025-06-30'))
          or b.side is distinct from case when pg_temp.raw_balance(v_c, b.ledger_id, '2025-06-30') > 0
                                          then 'asset' else 'liability' end)),
    'every Balance Sheet line is its ledger''s magnitude, on the side its sign says');

  -- And nothing with a balance is missing from it.
  perform pg_temp.chk(
    not exists (
      select 1 from public.ledgers l
      join public.account_groups g on g.id = l.group_id
      where l.company_id = v_c
        and g.nature in ('current_asset', 'current_liability', 'fixed_asset', 'capital')
        and pg_temp.raw_balance(v_c, l.id, '2025-06-30') <> 0
        and not exists (select 1 from public.get_balance_sheet(v_c, '2025-06-30') b where b.ledger_id = l.id)),
    'no balance-sheet ledger holding money is left off the sheet');

  -- Company D: opening balances only, and a zero result.
  select
    coalesce(sum(amount) filter (where side = 'asset'), 0),
    coalesce(sum(amount) filter (where side = 'liability'), 0)
  into v_assets, v_liabs from public.get_balance_sheet(current_setting('audit.d_company')::uuid, '2026-06-30');
  perform pg_temp.chk_eq(v_assets, 5000.00, 'a company with only openings: assets');
  perform pg_temp.chk_eq(v_liabs, 5000.00, 'and liabilities, including a Net Profit line of nil');

  -- As of a date before its books begin. get_balance_sheet's profit window
  -- runs book_beginning..as_of, which is empty here; the ledger lines have no
  -- lower bound at all.
  select
    coalesce(sum(amount) filter (where side = 'asset'), 0),
    coalesce(sum(amount) filter (where side = 'liability'), 0)
  into v_assets, v_liabs from public.get_balance_sheet(current_setting('audit.d_company')::uuid, '2025-12-31');
  perform pg_temp.chk(v_assets = v_liabs,
    'as of a date before book beginning, the sheet still tallies',
    pg_temp.paise(v_liabs), pg_temp.paise(v_assets));
end;
$$;


-- ===================================== 8. INVARIANT 3 — P&L AGAINST BALANCE SHEET

\echo ''
\echo '8. Invariant 3 — the P&L''s net profit is the Balance Sheet''s Net Profit line'

-- The P&L is period-scoped and returns one unsigned `amount` per ledger; the
-- Balance Sheet's profit line is life-to-date from book_beginning_date. Given
-- the same window, the app's own arithmetic over the P&L rows — see
-- app/(app)/[companyId]/reports/profit-loss/page.tsx, which computes
--   gross = sum(direct_income) - sum(direct_expense)
--   net   = gross + sum(indirect_income) - sum(indirect_expense)
-- — must land on the same figure. That expression is reproduced exactly here,
-- because it is the number a user reads off the screen.

create or replace function pg_temp.pl_implied_net(p_company uuid, p_from date, p_to date)
returns numeric language sql stable as $$
  select
    coalesce(sum(amount) filter (where nature = 'direct_income'), 0)
  - coalesce(sum(amount) filter (where nature = 'direct_expense'), 0)
  + coalesce(sum(amount) filter (where nature = 'indirect_income'), 0)
  - coalesce(sum(amount) filter (where nature = 'indirect_expense'), 0)
  from public.get_profit_and_loss(p_company, p_from, p_to);
$$;

create or replace function pg_temp.bs_net_profit(p_company uuid, p_as_of date)
returns numeric language sql stable as $$
  select coalesce(sum(case when side = 'liability' then amount else -amount end), 0)
  from public.get_balance_sheet(p_company, p_as_of)
  where ledger_id is null;
$$;

do $$
declare
  v_a uuid := current_setting('audit.a_company')::uuid;
  v_c uuid := current_setting('audit.c_company')::uuid;
  v_begin_a date := '2025-04-01';
  v_begin_c date := '2025-04-01';
  v_date date;
  v_rows int;
begin
  perform pg_temp.section('8. P&L vs balance sheet net profit');

  -- Company A: every ledger's sign is the natural one for its group.
  foreach v_date in array array['2025-04-01'::date, '2025-06-01', '2025-06-30', '2026-03-31'] loop
    perform pg_temp.chk_eq(
      pg_temp.pl_implied_net(v_a, v_begin_a, v_date),
      pg_temp.bs_net_profit(v_a, v_date),
      format('A: the P&L''s implied net profit is the Balance Sheet''s figure at %s', v_date));
    -- And both are the figure the raw rows give.
    perform pg_temp.chk_eq(
      pg_temp.bs_net_profit(v_a, v_date),
      pg_temp.raw_net_profit(v_a, v_begin_a, v_date),
      format('A: and that figure is income less expense from the raw entries at %s', v_date));
  end loop;

  -- Company C: a Sales Returns ledger under Direct Incomes carries a debit
  -- balance, and a Purchase Returns ledger under Direct Expenses carries a
  -- credit one. Both are ordinary. Neither has the sign its group implies.
  perform pg_temp.chk(
    pg_temp.raw_balance(v_c, current_setting('audit.c_sret')::uuid, '2025-06-30') > 0,
    'C: the Sales Returns ledger really does carry a debit balance');
  perform pg_temp.chk(
    pg_temp.raw_balance(v_c, current_setting('audit.c_pret')::uuid, '2025-06-30') < 0,
    'C: and Purchase Returns really does carry a credit one');

  perform pg_temp.chk_eq(pg_temp.raw_net_profit(v_c, v_begin_c, '2025-06-30'), 3000.00,
    'C: the period result from the raw entries is a profit of 3000');
  perform pg_temp.chk_eq(pg_temp.bs_net_profit(v_c, '2025-06-30'), 3000.00,
    'C: and the Balance Sheet agrees');
  perform pg_temp.chk_eq(
    pg_temp.pl_implied_net(v_c, v_begin_c, '2025-06-30'),
    pg_temp.bs_net_profit(v_c, '2025-06-30'),
    'C: the P&L''s implied net profit is the Balance Sheet''s figure');

  -- Named, so the finding above reads unambiguously in the summary.
  perform pg_temp.chk_eq(
    (select amount from public.get_profit_and_loss(v_c, v_begin_c, '2025-06-30')
      where ledger_id = current_setting('audit.c_sret')::uuid),
    -2500.00,
    'C: a Direct Income ledger in debit is reported as a negative contribution');
  perform pg_temp.chk_eq(
    (select amount from public.get_profit_and_loss(v_c, v_begin_c, '2025-06-30')
      where ledger_id = current_setting('audit.c_pret')::uuid),
    -1500.00,
    'C: and a Direct Expense ledger in credit likewise');

  -- The P&L's own window is inclusive at both ends, and period-scoped.
  perform pg_temp.chk_eq(
    (select coalesce(sum(amount), 0) from public.get_profit_and_loss(v_a, '2025-06-01', '2025-06-01')),
    99.99, 'A: a one-day P&L on p_from_date = p_to_date sees that day''s invoice');
  perform pg_temp.chk_eq(
    (select coalesce(sum(amount), 0) from public.get_profit_and_loss(v_a, '2025-06-02', '2025-06-02')),
    0.00, 'A: and the next day sees nothing');

  -- A ledger whose movement in the window nets to nil is left out entirely,
  -- rather than reported at zero.
  select count(*) into v_rows from public.get_profit_and_loss(v_a, '2025-08-01', '2025-08-31');
  perform pg_temp.chk(v_rows = 0, 'A: a period with no trading yields no P&L rows', '0', v_rows::text);

  select count(*) into v_rows from public.get_profit_and_loss(current_setting('audit.d_company')::uuid, '2026-01-01', '2026-12-31');
  perform pg_temp.chk(v_rows = 0, 'a company with no vouchers yields no P&L rows', '0', v_rows::text);

  -- The soft-deleted voucher's 99999 would be the largest figure on A's P&L.
  perform pg_temp.chk_eq(
    (select amount from public.get_profit_and_loss(v_a, v_begin_a, '2025-06-30')
      where ledger_id = current_setting('audit.a_sales')::uuid),
    1334.55, 'A: a soft-deleted voucher contributes nothing to the P&L');
end;
$$;


-- ================================ 9. THE BOOK-BEGINNING WINDOW ON THE BALANCE SHEET

\echo ''
\echo '9. A voucher dated before book_beginning_date'

do $$
declare
  v_b uuid := current_setting('audit.b_company')::uuid;
  v_assets numeric; v_liabs numeric;
begin
  perform pg_temp.section('9. pre-book-beginning voucher');

  -- The fixture is real: a balanced voucher, not deleted, dated before the
  -- company's book_beginning_date, and nothing in the schema refused it.
  perform pg_temp.chk(
    exists (select 1 from public.vouchers v
             where v.company_id = v_b and v.is_deleted = false
               and v.voucher_date < (select c.book_beginning_date from public.companies c where c.id = v_b)),
    'a voucher dated before book_beginning_date can be written down at all');

  -- The Trial Balance, which has no lower bound, counts it on both sides.
  perform pg_temp.chk(
    (select coalesce(sum(debit_balance), 0) from public.get_trial_balance(v_b, '2025-06-30'))
    = (select coalesce(sum(credit_balance), 0) from public.get_trial_balance(v_b, '2025-06-30')),
    'B: the Trial Balance still tallies');
  perform pg_temp.chk_eq(
    (select coalesce(sum(debit_balance), 0) from public.get_trial_balance(v_b, '2025-06-30')),
    1500.00, 'B: at 1500 — both vouchers counted');

  -- The Balance Sheet's ledger lines have no lower bound either, but its
  -- profit subquery does: `between v_book_beginning_date and p_as_of_date`.
  select
    coalesce(sum(amount) filter (where side = 'asset'), 0),
    coalesce(sum(amount) filter (where side = 'liability'), 0)
  into v_assets, v_liabs from public.get_balance_sheet(v_b, '2025-06-30');

  perform pg_temp.chk(v_assets = v_liabs,
    'B: the Balance Sheet''s two sides agree',
    pg_temp.paise(v_liabs), pg_temp.paise(v_assets));

  perform pg_temp.chk_eq(pg_temp.bs_net_profit(v_b, '2025-06-30'),
    pg_temp.raw_net_profit(v_b, '0001-01-01', '2025-06-30'),
    'B: the Balance Sheet''s profit figure is every income and expense entry on the books');
end;
$$;


-- ========================================= 10. INVARIANT 7 — THE DASHBOARD TILES

\echo ''
\echo '10. Invariant 7 — the dashboard''s cash and bank are the Trial Balance''s'

do $$
declare
  v_c uuid := current_setting('audit.a_company')::uuid;
  d record;
  v_cash_raw numeric; v_bank_raw numeric;
  v_cash_prev numeric; v_bank_prev numeric;
  v_in numeric; v_out numeric;
  v_date date;
  v_tb_cash_bank numeric;
begin
  perform pg_temp.section('10. dashboard');

  foreach v_date in array array['2025-06-01'::date, '2025-06-15', '2025-06-30', '2025-07-31'] loop
    select * into d from public.get_dashboard_summary(v_c, v_date);

    -- Independently: sum the signed balances of every cash_bank ledger,
    -- splitting on the same group-name test the function uses, from raw rows.
    select
      coalesce(sum(pg_temp.raw_balance(v_c, l.id, v_date)) filter (where g.name ilike '%cash%'), 0),
      coalesce(sum(pg_temp.raw_balance(v_c, l.id, v_date)) filter (where g.name not ilike '%cash%'), 0)
    into v_cash_raw, v_bank_raw
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    where l.company_id = v_c and g.ledger_role = 'cash_bank'
      and (l.is_active or pg_temp.raw_balance(v_c, l.id, v_date) <> 0);

    perform pg_temp.chk_eq(d.cash_in_hand, v_cash_raw, format('dashboard cash in hand at %s', v_date));
    perform pg_temp.chk_eq(d.bank_balance, v_bank_raw, format('dashboard bank balance at %s', v_date));

    -- And the same two figures as the Trial Balance reports them at that date,
    -- which is invariant 7 as stated. Computed from get_trial_balance's own
    -- output because that is the comparison being asked for.
    select coalesce(sum(t.debit_balance - t.credit_balance), 0) into v_tb_cash_bank
    from public.get_trial_balance(v_c, v_date) t
    join public.ledgers l on l.id = t.ledger_id
    join public.account_groups g on g.id = l.group_id
    where g.ledger_role = 'cash_bank';

    perform pg_temp.chk_eq(d.cash_in_hand + d.bank_balance, v_tb_cash_bank,
      format('dashboard cash + bank equals the Trial Balance''s cash_bank ledgers at %s', v_date));

    -- The month-on-month change tiles.
    select
      coalesce(sum(pg_temp.raw_balance(v_c, l.id, date_trunc('month', v_date)::date - 1)) filter (where g.name ilike '%cash%'), 0),
      coalesce(sum(pg_temp.raw_balance(v_c, l.id, date_trunc('month', v_date)::date - 1)) filter (where g.name not ilike '%cash%'), 0)
    into v_cash_prev, v_bank_prev
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    where l.company_id = v_c and g.ledger_role = 'cash_bank'
      and (l.is_active or pg_temp.raw_balance(v_c, l.id, v_date) <> 0);

    perform pg_temp.chk_eq(d.cash_in_hand_change, v_cash_raw - v_cash_prev, format('dashboard cash change at %s', v_date));
    perform pg_temp.chk_eq(d.bank_balance_change, v_bank_raw - v_bank_prev, format('dashboard bank change at %s', v_date));

    -- Gross movement month to date: every debit and every credit on those
    -- ledgers, not the net.
    select
      coalesce(sum(e.debit_amount), 0), coalesce(sum(e.credit_amount), 0)
    into v_in, v_out
    from public.voucher_entries e
    join public.vouchers v on v.id = e.voucher_id
    join public.ledgers l on l.id = e.ledger_id
    join public.account_groups g on g.id = l.group_id
    where v.company_id = v_c and v.is_deleted = false
      and g.ledger_role = 'cash_bank'
      and (l.is_active or pg_temp.raw_balance(v_c, l.id, v_date) <> 0)
      and v.voucher_date >= date_trunc('month', v_date)::date
      and v.voucher_date <= v_date;

    perform pg_temp.chk_eq(d.month_inflow, v_in, format('dashboard month inflow at %s', v_date));
    perform pg_temp.chk_eq(d.month_outflow, v_out, format('dashboard month outflow at %s', v_date));
  end loop;

  -- The June figures, pinned.
  select * into d from public.get_dashboard_summary(v_c, '2025-06-30');
  perform pg_temp.chk_eq(d.cash_in_hand, 103000.00, 'cash in hand at 2025-06-30 is 103000');
  perform pg_temp.chk_eq(d.bank_balance, 10300.00, 'bank balance is 50300 less a 40000 overdraft = 10300');
  perform pg_temp.chk_eq(d.cash_in_hand_change, 2000.00, 'cash is up 2000 on the month');
  perform pg_temp.chk_eq(d.bank_balance_change, -39700.00, 'and the banks are down 39700');
  perform pg_temp.chk_eq(d.month_inflow, 5300.00, 'month inflow is gross: 5000 cash + 300 bank');
  perform pg_temp.chk_eq(d.month_outflow, 43000.00, 'month outflow is gross: 40000 overdraft + 3000 drawings');

  -- The first of a month, where month_start = as_of and the window is one day.
  select * into d from public.get_dashboard_summary(v_c, '2025-06-01');
  perform pg_temp.chk_eq(d.month_inflow, 0.00, 'on the first of the month the window is that day alone (inflow)');
  perform pg_temp.chk_eq(d.month_outflow, 0.00, 'and likewise outflow');
  perform pg_temp.chk_eq(d.cash_in_hand_change, 0.00, 'with no change yet this month');

  -- A company with no cash or bank ledgers at all must still answer.
  select * into d from public.get_dashboard_summary(current_setting('audit.d_company')::uuid, '2026-06-30');
  perform pg_temp.chk(d is not null, 'a company with no cash or bank ledgers still gets a dashboard row');
  perform pg_temp.chk_eq(d.cash_in_hand, 0.00, 'reading nil for cash');
  perform pg_temp.chk_eq(d.bank_balance, 0.00, 'nil for bank');
  perform pg_temp.chk_eq(d.month_inflow, 0.00, 'nil in');
  perform pg_temp.chk_eq(d.month_outflow, 0.00, 'and nil out');

  -- The deleted voucher again: it would move cash by 99999.
  perform pg_temp.chk_eq(
    (select cash_in_hand from public.get_dashboard_summary(v_c, '2025-06-30')),
    103000.00, 'a soft-deleted voucher moves no dashboard tile');
end;
$$;


-- ================================ 11. INVARIANT 8 — OUTSTANDING RECEIVABLES/PAYABLES

\echo ''
\echo '11. Invariant 8 — outstanding balances reconcile with the debtor and creditor ledgers'

do $$
declare
  v_c uuid := current_setting('audit.a_company')::uuid;
  v_recv numeric; v_pay numeric;
  v_recv_raw numeric; v_pay_raw numeric;
  v_tb_recv numeric; v_tb_pay numeric;
  v_rows int;
  r record;
begin
  perform pg_temp.section('11. outstanding balances');

  select
    coalesce(sum(amount) filter (where direction = 'receivable'), 0),
    coalesce(sum(amount) filter (where direction = 'payable'), 0)
  into v_recv, v_pay
  from public.get_outstanding_balances(v_c);

  -- Independently, from raw rows: life to date, every debtor- or
  -- creditor-role ledger, split by the sign of its balance.
  select
    coalesce(sum(b) filter (where b > 0), 0),
    coalesce(sum(-b) filter (where b < 0), 0)
  into v_recv_raw, v_pay_raw
  from (
    select pg_temp.raw_balance_ltd(v_c, l.id) as b
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    where l.company_id = v_c and g.ledger_role in ('debtor', 'creditor')
  ) s;

  perform pg_temp.chk_eq(v_recv, v_recv_raw, 'total receivables is the sum of every party ledger in debit');
  perform pg_temp.chk_eq(v_pay, v_pay_raw, 'total payables is the sum of every party ledger in credit');
  perform pg_temp.chk_eq(v_recv, 58223.43, 'which is the hand-computed 58223.43 receivable');
  perform pg_temp.chk_eq(v_pay, 50071.46, 'and 50071.46 payable');

  -- And against the Trial Balance at the same (unbounded) date, which is what
  -- "reconcile with debtor and creditor balances" means when one report is
  -- life-to-date and the other takes a date: they must agree at 9999-12-31,
  -- which is the date lib/supabase/queries/ledgers.ts already uses for exactly
  -- this figure.
  select
    coalesce(sum(t.debit_balance), 0), coalesce(sum(t.credit_balance), 0)
  into v_tb_recv, v_tb_pay
  from public.get_trial_balance(v_c, '9999-12-31') t
  join public.ledgers l on l.id = t.ledger_id
  join public.account_groups g on g.id = l.group_id
  where g.ledger_role in ('debtor', 'creditor');

  perform pg_temp.chk_eq(v_recv, v_tb_recv, 'receivables equal the Trial Balance''s party debits, life to date');
  perform pg_temp.chk_eq(v_pay, v_tb_pay, 'payables equal its party credits');

  -- Every row's amount and direction, one at a time.
  for r in select * from public.get_outstanding_balances(v_c) loop
    perform pg_temp.chk_eq(
      case when r.direction = 'receivable' then r.amount else -r.amount end,
      pg_temp.raw_balance_ltd(v_c, r.ledger_id),
      format('%s: outstanding amount and direction match its balance', r.ledger_name));
    perform pg_temp.chk(r.amount > 0,
      format('%s: the amount is positive — direction carries the sign', r.ledger_name));
    perform pg_temp.chk(
      r.last_transaction_date is not distinct from (
        select max(v.voucher_date) from public.voucher_entries e
        join public.vouchers v on v.id = e.voucher_id
        where e.ledger_id = r.ledger_id and v.company_id = v_c and v.is_deleted = false),
      format('%s: last transaction date is its latest live posting', r.ledger_name));
  end loop;

  -- The sign-flip cases, named. This is 0012's lesson in a report that has
  -- never been checked against data.
  perform pg_temp.chk(
    (select direction from public.get_outstanding_balances(v_c)
      where ledger_id = current_setting('audit.a_beta')::uuid) = 'payable',
    'a customer sitting in credit is a payable');
  perform pg_temp.chk(
    (select party_kind from public.get_outstanding_balances(v_c)
      where ledger_id = current_setting('audit.a_beta')::uuid) = 'customer',
    'and is still described as a customer');
  perform pg_temp.chk(
    (select direction from public.get_outstanding_balances(v_c)
      where ledger_id = current_setting('audit.a_delta')::uuid) = 'receivable',
    'a supplier holding our advance is a receivable');
  perform pg_temp.chk_eq(
    (select amount from public.get_outstanding_balances(v_c)
      where ledger_id = current_setting('audit.a_delta')::uuid),
    7000.00, 'at the advance, in full');

  -- Life to date, so the forward-dated invoice is in.
  perform pg_temp.chk_eq(
    (select amount from public.get_outstanding_balances(v_c)
      where ledger_id = current_setting('audit.a_alpha')::uuid),
    37988.87, 'a bill dated years ahead is already outstanding');
  perform pg_temp.chk(
    (select last_transaction_date from public.get_outstanding_balances(v_c)
      where ledger_id = current_setting('audit.a_alpha')::uuid) = '2030-01-01',
    'and it is what the last-transaction date reports');

  -- A party whose whole balance is an opening figure has no last date.
  perform pg_temp.chk(
    (select last_transaction_date from public.get_outstanding_balances(v_c)
      where ledger_id = current_setting('audit.a_opening_only')::uuid) is null,
    'a party never posted to has no last transaction date');
  perform pg_temp.chk_eq(
    (select amount from public.get_outstanding_balances(v_c)
      where ledger_id = current_setting('audit.a_opening_only')::uuid),
    12000.00, 'but its opening balance is outstanding all the same');

  -- Inclusions and exclusions.
  perform pg_temp.chk(
    exists (select 1 from public.get_outstanding_balances(v_c)
             where ledger_id = current_setting('audit.a_retired')::uuid),
    'an inactive party still holding a balance is listed');
  perform pg_temp.chk(
    not exists (select 1 from public.get_outstanding_balances(v_c)
                 where ledger_id = current_setting('audit.a_dormant')::uuid),
    'an inactive party at nil is not');
  perform pg_temp.chk(
    not exists (select 1 from public.get_outstanding_balances(v_c)
                 where ledger_id in (current_setting('audit.a_cash')::uuid,
                                     current_setting('audit.a_sales')::uuid,
                                     current_setting('audit.a_bank_od')::uuid,
                                     current_setting('audit.a_machine')::uuid)),
    'and cash, bank, sales and plant are not parties');

  -- The soft-deleted voucher's 99999 would be on A Debtor Alpha.
  perform pg_temp.chk_eq(
    (select amount from public.get_outstanding_balances(v_c)
      where ledger_id = current_setting('audit.a_alpha')::uuid),
    37988.87, 'a soft-deleted voucher is not owed by anybody');

  -- A company with one debtor and no vouchers.
  select count(*) into v_rows from public.get_outstanding_balances(current_setting('audit.d_company')::uuid);
  perform pg_temp.chk(v_rows = 1, 'a company with one opening debtor and no vouchers lists exactly him', '1', v_rows::text);
  perform pg_temp.chk_eq(
    (select amount from public.get_outstanding_balances(current_setting('audit.d_company')::uuid)),
    5000.00, 'at his opening balance');
end;
$$;


-- ============================== 12. INVARIANT 9 — INVOICE LINES, TOTAL AND POSTINGS

\echo ''
\echo '12. Invariant 9 — invoice lines, the voucher total and the postings are one number'

do $$
declare
  v_c uuid := current_setting('audit.a_company')::uuid;
  v_bad int;
begin
  perform pg_temp.section('12. invoice arithmetic');

  -- Across every voucher in every fixture company: debits = credits =
  -- total_amount, and where there are invoice lines, their sum too.
  select count(*) into v_bad
  from public.vouchers v
  where v.company_id in (
      current_setting('audit.a_company')::uuid, current_setting('audit.b_company')::uuid,
      current_setting('audit.c_company')::uuid, current_setting('audit.d_company')::uuid)
    and (
      v.total_amount is distinct from (select coalesce(sum(e.debit_amount), 0) from public.voucher_entries e where e.voucher_id = v.id)
   or v.total_amount is distinct from (select coalesce(sum(e.credit_amount), 0) from public.voucher_entries e where e.voucher_id = v.id));
  perform pg_temp.chk(v_bad = 0, 'every voucher''s total_amount is both its debits and its credits', '0', v_bad::text);

  select count(*) into v_bad
  from public.vouchers v
  where v.company_id = v_c
    and exists (select 1 from public.invoice_lines i where i.voucher_id = v.id)
    and v.total_amount is distinct from (select coalesce(sum(i.line_amount), 0) from public.invoice_lines i where i.voucher_id = v.id);
  perform pg_temp.chk(v_bad = 0, 'and every invoice''s lines total exactly what it was posted for', '0', v_bad::text);

  -- V3: three lines at 33.3333. The paise are settled per line, so the answer
  -- is 99.99. Rounding the sum instead would give 100.00.
  perform pg_temp.chk_eq(
    (select coalesce(sum(i.line_amount), 0) from public.invoice_lines i where i.voucher_id = current_setting('audit.a_v3')::uuid),
    99.99, 'three lines at 33.3333 come to 99.99, not 100.00');
  perform pg_temp.chk_eq(
    (select v.total_amount from public.vouchers v where v.id = current_setting('audit.a_v3')::uuid),
    99.99, 'and the voucher was posted for 99.99');
  perform pg_temp.chk_eq(
    (select coalesce(sum(e.credit_amount), 0) from public.voucher_entries e
      where e.voucher_id = current_setting('audit.a_v3')::uuid),
    99.99, 'and the grouped credit is the same 99.99, not a re-rounded 100.00');

  -- V8: six awkward lines. 1.23 + 70.03 + 0.17 + 0.01 + 0.01 + 0.01 = 71.46.
  -- Rounding the raw sum (71.4445678) would give 71.44.
  perform pg_temp.chk_eq(
    (select i.line_amount from public.invoice_lines i
      where i.voucher_id = current_setting('audit.a_v8')::uuid and i.line_order = 0),
    1.23, 'a quantity of 0.001 at a four-decimal rate rounds to 1.23');
  perform pg_temp.chk_eq(
    (select i.line_amount from public.invoice_lines i
      where i.voucher_id = current_setting('audit.a_v8')::uuid and i.line_order = 1),
    70.03, 'a half-paisa line rounds up to 70.04 before its 0.01 discount');
  perform pg_temp.chk_eq(
    (select i.line_amount from public.invoice_lines i
      where i.voucher_id = current_setting('audit.a_v8')::uuid and i.line_order = 3),
    0.01, 'and a line worth half a paisa rounds up to one');
  perform pg_temp.chk_eq(
    (select coalesce(sum(i.line_amount), 0) from public.invoice_lines i where i.voucher_id = current_setting('audit.a_v8')::uuid),
    71.46, 'the six lines come to 71.46 — the sum of the rounded, not the rounding of the sum (71.44)');
  perform pg_temp.chk_eq(
    (select v.total_amount from public.vouchers v where v.id = current_setting('audit.a_v8')::uuid),
    71.46, 'and that is what the voucher was posted for');

  -- The grouped postings: two revenue ledgers, at the subtotals of their own
  -- lines, and a party leg at the whole.
  perform pg_temp.chk_eq(
    (select e.debit_amount from public.voucher_entries e
      where e.voucher_id = current_setting('audit.a_v8')::uuid
        and e.ledger_id = current_setting('audit.a_purchases')::uuid),
    1.40, 'the two Purchases lines post as one debit of 1.40');
  perform pg_temp.chk_eq(
    (select e.debit_amount from public.voucher_entries e
      where e.voucher_id = current_setting('audit.a_v8')::uuid
        and e.ledger_id = current_setting('audit.a_freight')::uuid),
    70.06, 'the four Freight lines as one debit of 70.06');
  perform pg_temp.chk_eq(
    (select e.credit_amount from public.voucher_entries e
      where e.voucher_id = current_setting('audit.a_v8')::uuid
        and e.ledger_id = current_setting('audit.a_gamma')::uuid),
    71.46, 'and the supplier is credited the whole 71.46');

  -- The rounding survives into the reports rather than being re-rounded there.
  perform pg_temp.chk_eq(
    (select t.debit_balance from public.get_trial_balance(v_c, '2025-06-30') t
      where t.ledger_id = current_setting('audit.a_freight')::uuid),
    70.06, 'and the Trial Balance carries the odd paise through unaltered');
  perform pg_temp.chk_eq(
    (select d.total_amount from public.get_daybook(v_c, '2025-06-10', '2025-06-10') d),
    71.46, 'as does the Daybook');
end;
$$;


-- ============ 13. THE DASHBOARD'S OTHER FOUR FIGURES, WHICH ARE NOT BALANCES

\echo ''
\echo '13. The change and movement tiles when a bank account was emptied and retired'

-- Sections 10's expectations replicate get_dashboard_summary's own
-- "active, or holding money today" predicate, because that is what invariant 7
-- compares against the Trial Balance and it is right for the two balance
-- tiles. It cannot be the right expectation for the other four figures, so
-- these assert the accounting fact instead:
--
--   * the change tile must be the change the Trial Balance shows between the
--     same two dates, because that is the only thing "banks are down X" can
--     honestly mean;
--   * gross movement must be every debit and every credit that passed through
--     a cash or bank ledger during the month, because money that left is money
--     that left whatever the account's status is today.

do $$
declare
  v_e uuid := current_setting('audit.e_company')::uuid;
  d record;
  v_in numeric; v_out numeric;
  v_tb_bank_now numeric; v_tb_bank_prev numeric;
  v_rows int;
  v_final numeric;
begin
  perform pg_temp.section('13. dashboard change and movement tiles');

  -- The fixture is real, in both respects.
  perform pg_temp.chk(
    (select not l.is_active from public.ledgers l where l.id = current_setting('audit.e_bank_old')::uuid),
    'E: the closed bank account really is inactive');
  perform pg_temp.chk_eq(
    pg_temp.raw_balance(v_e, current_setting('audit.e_bank_old')::uuid, '2025-06-30'), 0.00,
    'E: and really is at nil today');
  perform pg_temp.chk_eq(
    pg_temp.raw_balance(v_e, current_setting('audit.e_bank_old')::uuid, '2025-05-31'), 50000.00,
    'E: but held 50000 at the end of last month');

  select * into d from public.get_dashboard_summary(v_e, '2025-06-30');

  -- Invariant 7 itself still holds here — the two balance tiles are right.
  select coalesce(sum(t.debit_balance - t.credit_balance), 0) into v_tb_bank_now
  from public.get_trial_balance(v_e, '2025-06-30') t
  join public.ledgers l on l.id = t.ledger_id
  join public.account_groups g on g.id = l.group_id
  where g.ledger_role = 'cash_bank';
  perform pg_temp.chk_eq(d.cash_in_hand + d.bank_balance, v_tb_bank_now,
    'E: dashboard cash + bank still equals the Trial Balance today');

  -- 0017's dashboard half, on the account that is inactive and yet holds money.
  perform pg_temp.chk(
    (select not l.is_active from public.ledgers l where l.id = current_setting('audit.e_bank_retired')::uuid),
    'E: the retired-but-funded account really is inactive');
  perform pg_temp.chk_eq(
    pg_temp.raw_balance(v_e, current_setting('audit.e_bank_retired')::uuid, '2025-06-30'), 700.00,
    'E: and really does hold 700');
  perform pg_temp.chk_eq(d.bank_balance, 700.00,
    'E: so the bank tile counts it, exactly as the Trial Balance does');

  -- The change tile, against the Trial Balance at both ends of the month.
  select coalesce(sum(t.debit_balance - t.credit_balance), 0) into v_tb_bank_prev
  from public.get_trial_balance(v_e, '2025-05-31') t
  join public.ledgers l on l.id = t.ledger_id
  join public.account_groups g on g.id = l.group_id
  where g.ledger_role = 'cash_bank' and g.name not ilike '%cash%';

  select coalesce(sum(t.debit_balance - t.credit_balance), 0) into v_tb_bank_now
  from public.get_trial_balance(v_e, '2025-06-30') t
  join public.ledgers l on l.id = t.ledger_id
  join public.account_groups g on g.id = l.group_id
  where g.ledger_role = 'cash_bank' and g.name not ilike '%cash%';

  perform pg_temp.chk_eq(v_tb_bank_prev, 50000.00, 'E: the Trial Balance had 50000 in the banks on 2025-05-31');
  perform pg_temp.chk_eq(v_tb_bank_now, 700.00, 'E: and 700 in them on 2025-06-30');
  perform pg_temp.chk_eq(d.bank_balance_change, v_tb_bank_now - v_tb_bank_prev,
    'E: so the bank change tile must read -49300');

  -- Gross movement through every cash and bank ledger this month, is_active
  -- ignored, which is what a cash-flow tile is for.
  select coalesce(sum(e.debit_amount), 0), coalesce(sum(e.credit_amount), 0)
  into v_in, v_out
  from public.voucher_entries e
  join public.vouchers v on v.id = e.voucher_id
  join public.ledgers l on l.id = e.ledger_id
  join public.account_groups g on g.id = l.group_id
  where v.company_id = v_e and v.is_deleted = false
    and g.ledger_role = 'cash_bank'
    and v.voucher_date between '2025-06-01' and '2025-06-30';

  perform pg_temp.chk_eq(v_out, 50040.00, 'E: 50040 left the cash and bank accounts in June, by the raw entries');
  perform pg_temp.chk_eq(v_in, 50800.00, 'E: and 50800 came in');
  perform pg_temp.chk_eq(d.month_inflow, v_in, 'E: the inflow tile is the gross debits through cash and bank');
  perform pg_temp.chk_eq(d.month_outflow, v_out, 'E: the outflow tile is the gross credits through them');

  -- The three-line voucher with both sides on one ledger.
  select count(*) into v_rows from public.get_ledger_statement(
    v_e, current_setting('audit.e_cash')::uuid, '2025-06-01', '2025-06-30') s where s.voucher_id is not null;
  perform pg_temp.chk(v_rows = 3, 'E: a ledger debited and credited by the same voucher gets both rows', '3', v_rows::text);

  select s.running_balance into v_final from public.get_ledger_statement(
    v_e, current_setting('audit.e_cash')::uuid, '2025-06-01', '2025-06-30') s
    offset (select count(*) - 1 from public.get_ledger_statement(
      v_e, current_setting('audit.e_cash')::uuid, '2025-06-01', '2025-06-30')) limit 1;
  perform pg_temp.chk_eq(v_final, 50060.00, 'E: and the running balance nets them: 50000 + 100 - 40');
  perform pg_temp.chk_eq(v_final, pg_temp.raw_balance(v_e, current_setting('audit.e_cash')::uuid, '2025-06-30'),
    'E: which is its Trial Balance figure');

  perform pg_temp.chk_eq(
    (select d2.total_amount from public.get_daybook(v_e, '2025-06-20', '2025-06-20') d2),
    100.00, 'E: and the Daybook counts that voucher once, at 100');
end;
$$;


-- ================== 14. AN OPENING BALANCE ON AN INCOME OR EXPENSE LEDGER

\echo ''
\echo '14. An opening balance on an income ledger'

do $$
declare
  v_f uuid := current_setting('audit.f_company')::uuid;
  v_assets numeric; v_liabs numeric;
  v_rows int;
begin
  perform pg_temp.section('14. opening balance on an income ledger');

  perform pg_temp.chk_eq(
    (select coalesce(sum(t.credit_balance), 0) from public.get_trial_balance(v_f, '2025-06-30') t
      where t.ledger_id = current_setting('audit.f_sales')::uuid),
    9000.00, 'F: the Trial Balance reports the income ledger''s opening credit');
  perform pg_temp.chk(
    (select coalesce(sum(debit_balance), 0) from public.get_trial_balance(v_f, '2025-06-30'))
    = (select coalesce(sum(credit_balance), 0) from public.get_trial_balance(v_f, '2025-06-30')),
    'F: and the Trial Balance tallies');

  select count(*) into v_rows from public.get_profit_and_loss(v_f, '2025-04-01', '2025-06-30');
  perform pg_temp.chk(v_rows = 0, 'F: the P&L reports nothing, because it reads entries and there are none', '0', v_rows::text);

  select
    coalesce(sum(amount) filter (where side = 'asset'), 0),
    coalesce(sum(amount) filter (where side = 'liability'), 0)
  into v_assets, v_liabs from public.get_balance_sheet(v_f, '2025-06-30');
  perform pg_temp.chk(v_assets = v_liabs,
    'F: the Balance Sheet''s two sides agree',
    pg_temp.paise(v_liabs), pg_temp.paise(v_assets));
end;
$$;


-- ================================================================== SUMMARY

\echo ''
\echo 'Summary'

do $$
declare
  r record;
  v_failed int;
  v_total int;
begin
  select count(*) into v_failed from pg_temp.audit_findings;

  if v_failed = 0 then
    raise notice '';
    raise notice 'NO DISCREPANCIES. Every invariant held on every fixture.';
    return;
  end if;

  raise notice '';
  raise notice '%  DISCREPANCIES', v_failed;
  raise notice '';
  for r in select * from pg_temp.audit_findings order by seq loop
    raise notice '  [%] %', r.section, r.what;
    raise notice '        expected %   actual %', coalesce(r.expected, '-'), coalesce(r.actual, '-');
  end loop;
  raise notice '';

  raise exception 'AUDIT FOUND % DISCREPANCIES (listed above)', v_failed;
end;
$$;

rollback;

-- ============================================================ MUTATION LOG
--
-- An assertion never seen to fail is not evidence. Every one of the 475
-- assertions above was exercised by deliberately breaking the function it
-- watches, re-running this file on top of the break, and comparing the
-- resulting failure set with the eight-item baseline. 38 mutations, applied
-- one at a time inside their own rolled-back transaction:
--
--   get_trial_balance      opening balance dropped; opening sign flipped;
--                          as-of made exclusive; is_deleted filter removed;
--                          0017 reverted to `is_active = true`; the debit and
--                          credit columns swapped.                  all caught
--   get_balance_sheet      0012 reverted to side-from-nature; net profit sign
--                          flipped; ledger lines made exclusive; opening
--                          dropped; is_deleted removed; fixed assets dropped
--                          from the nature filter.                  all caught
--   get_profit_and_loss    window made exclusive; is_deleted removed; the
--                          indirect natures dropped.                all caught
--                          Removing abs() removes exactly the three company C
--                          findings and breaks nothing else.
--                          Removing the `normal_balance` branch entirely —
--                          i.e. always computing debit - credit — changes NO
--                          assertion, because abs(cr - dr) = abs(dr - cr).
--                          That branch is unreachable under the abs(), which
--                          is itself the clearest statement of the defect.
--   get_daybook            is_deleted removed; window made exclusive; the
--                          total taken from a line instead of the header.
--                                                                   all caught
--   get_ledger_statement   opening made inclusive of p_from_date (double
--                          counting that day); opening dropped from the
--                          running total; the running total signed the other
--                          way; window made exclusive; is_deleted removed;
--                          opening_balance_type ignored.            all caught
--   get_dashboard_summary  opening dropped; prev_month_end off by one; net
--                          movement instead of gross; inflow and outflow
--                          swapped; the cash/bank split inverted; 0017
--                          reverted to `is_active = true`; the change tile
--                          reporting the balance; the month window widened;
--                          is_deleted removed.                      all caught
--   get_outstanding_balances
--                          direction taken from the group role rather than
--                          the sign; opening dropped; opening sign ignored;
--                          is_deleted removed; the amount left signed; the
--                          last date taken from created_at; inactive parties
--                          dropped.                                 all caught
--   generate_invoice_entries
--                          posting round(sum(qty * rate)) instead of
--                          sum(line_amount) — two paise adrift on voucher V8.
--                          Rejected outright by check_invoice_lines_match();
--                          with that guard neutered as well, 24 assertions
--                          here fail, from the pinned line amounts through to
--                          the Trial Balance and the Daybook.        caught
--
-- Two mutations were caught only after this file was widened, and both gaps
-- are worth remembering because each made an assertion pass for the wrong
-- reason:
--
--   * the dashboard's 0017 half needed a bank account that is inactive AND
--     still holding money (E Bank Retired). Without one, reverting the
--     dashboard to `is_active = true` changed nothing observable.
--   * "a soft-deleted voucher moves no dashboard tile" needed a deleted
--     voucher through the CASH BOX (A/V14). The other deleted voucher touches
--     a debtor and an income ledger, neither of which any tile reads, so the
--     assertion was testing nothing.
