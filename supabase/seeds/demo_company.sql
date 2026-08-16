-- A demo company that exercises the whole app in one place.
--
-- Deliberately on a JULY financial year, because an April one hides the most
-- common class of date bug — the report presets, the FY label and the voucher
-- numbering sequence all have to follow the company rather than assume April.
--
-- Usage: set the owner below to an existing auth user, then run it. It does
-- not create accounts; the user must already exist.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/demo_company.sql
--
-- What it leaves you with, and why each piece is there:
--
--   * a three-level group tree (Current Assets → Cash-in-Hand → Petty Cash),
--     so the Account Groups screen has something to indent
--   * a "GST Payable" group left on ledger_role 'other', which is the single
--     most common surprise when extending the chart — its ledgers will not
--     appear in a Payment voucher's cash leg
--   * one deactivated ledger, so the status column and Reactivate action are
--     not theoretical
--   * one voucher of each of the six types, across two months, so the
--     Daybook, both statements and the dashboard all have data
--   * a lock date before every voucher, so Settings and the notifications
--     bell show it without blocking anything
--
-- Opening balances are chosen to balance (520,000 Dr against 520,000 Cr), so
-- the Trial Balance tallies from the first screen.

\set ON_ERROR_STOP on

begin;

do $$
declare
  -- CHANGE ME: the user who should own the demo company.
  v_user uuid := (select id from auth.users order by created_at limit 1);

  v_co uuid;
  g_ca uuid; g_cl uuid; g_cash uuid; g_bank uuid; g_debt uuid; g_cred uuid;
  g_di uuid; g_de uuid; g_ie uuid; g_capital uuid; g_petty uuid;
  l_cash uuid; l_bank uuid; l_debtor uuid; l_creditor uuid;
  l_sales uuid; l_purch uuid; l_rent uuid;
begin
  if v_user is null then
    raise exception 'No auth user to own the demo company — create one first.';
  end if;

  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency, created_by)
  values ('Test Books — July FY', '2025-07-01', 7, 'INR', v_user)
  returning id into v_co;

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_co, v_user, 'admin', 'active', v_user);

  perform app_private.seed_chart_of_accounts(v_co);

  select id into g_ca      from public.account_groups where company_id = v_co and name = 'Current Assets';
  select id into g_cl      from public.account_groups where company_id = v_co and name = 'Current Liabilities';
  select id into g_cash    from public.account_groups where company_id = v_co and name = 'Cash-in-Hand';
  select id into g_bank    from public.account_groups where company_id = v_co and name = 'Bank Accounts';
  select id into g_debt    from public.account_groups where company_id = v_co and name = 'Sundry Debtors';
  select id into g_cred    from public.account_groups where company_id = v_co and name = 'Sundry Creditors';
  select id into g_di      from public.account_groups where company_id = v_co and name = 'Direct Incomes';
  select id into g_de      from public.account_groups where company_id = v_co and name = 'Direct Expenses';
  select id into g_ie      from public.account_groups where company_id = v_co and name = 'Indirect Expenses';
  select id into g_capital from public.account_groups where company_id = v_co and name = 'Capital Account';

  -- nature and normal_balance are supplied because both columns are NOT NULL,
  -- but enforce_account_group_nature() overwrites nature with the parent's
  -- regardless — a child can never disagree with its parent.
  insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
  values (v_co, g_cash, 'Petty Cash', 'current_asset', 'debit', 'cash_bank', 1);

  insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
  values (v_co, g_cl, 'GST Payable', 'current_liability', 'credit', 'other', 9);

  select id into g_petty from public.account_groups where company_id = v_co and name = 'Petty Cash';

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type, created_by) values
    (v_co, g_cash,    'Cash',              20000,  'debit',  v_user),
    (v_co, g_bank,    'HDFC Bank',         500000, 'debit',  v_user),
    (v_co, g_capital, 'Owner''s Capital',  520000, 'credit', v_user),
    (v_co, g_debt,    'Kulkarni Traders',  0,      'debit',  v_user),
    (v_co, g_cred,    'Deshmukh Supplies', 0,      'credit', v_user),
    (v_co, g_di,      'Sales Account',     0,      'credit', v_user),
    (v_co, g_de,      'Purchase Account',  0,      'debit',  v_user),
    (v_co, g_ie,      'Rent Expense',      0,      'debit',  v_user),
    (v_co, g_petty,   'Petty Cash Box',    0,      'debit',  v_user);

  insert into public.ledgers (company_id, group_id, name, is_active, created_by)
  values (v_co, g_ie, 'Old Courier Account (closed)', false, v_user);

  select id into l_cash     from public.ledgers where company_id = v_co and name = 'Cash';
  select id into l_bank     from public.ledgers where company_id = v_co and name = 'HDFC Bank';
  select id into l_debtor   from public.ledgers where company_id = v_co and name = 'Kulkarni Traders';
  select id into l_creditor from public.ledgers where company_id = v_co and name = 'Deshmukh Supplies';
  select id into l_sales    from public.ledgers where company_id = v_co and name = 'Sales Account';
  select id into l_purch    from public.ledgers where company_id = v_co and name = 'Purchase Account';
  select id into l_rent     from public.ledgers where company_id = v_co and name = 'Rent Expense';

  -- Always through create_voucher(), never a direct insert: header and lines
  -- must land in one transaction or the deferred balance trigger fires before
  -- the lines exist.
  perform public.create_voucher(v_co, 'sales', '2026-07-05', 'Invoice KT-114', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_debtor, 'debit_amount', 118000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_sales,  'debit_amount', 0, 'credit_amount', 118000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'receipt', '2026-07-12', 'Part payment against KT-114', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_bank,   'debit_amount', 100000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_debtor, 'debit_amount', 0, 'credit_amount', 100000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'purchase', '2026-07-18', 'Raw material — Deshmukh', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_purch,    'debit_amount', 62000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_creditor, 'debit_amount', 0, 'credit_amount', 62000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'payment', '2026-08-02', 'Deshmukh — on account', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_creditor, 'debit_amount', 40000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_bank,     'debit_amount', 0, 'credit_amount', 40000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'contra', '2026-08-05', 'Cash drawn from bank', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_cash, 'debit_amount', 15000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_bank, 'debit_amount', 0, 'credit_amount', 15000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'journal', '2026-08-10', 'August rent accrued', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_rent,     'debit_amount', 25000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_creditor, 'debit_amount', 0, 'credit_amount', 25000, 'line_order', 1)));

  update public.companies set lock_date = '2026-06-30' where id = v_co;

  raise notice 'Seeded company %', v_co;
end;
$$;

commit;
