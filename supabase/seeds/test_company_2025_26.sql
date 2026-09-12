-- A rich test company on the Indian financial year 2025-26.
--
-- Where demo_company.sql is a small, friendly first-run fixture on a JULY
-- financial year, this one exists to be *audited*. It is deliberately large,
-- deliberately awkward, and every awkward thing in it is here because a
-- specific migration exists to handle it or because it is where a rounding
-- bug would surface.
--
-- Usage — a scratch database only, never a real one:
--
--   psql "postgresql://postgres@localhost:5432/hisab_verify" \
--     -v ON_ERROR_STOP=1 -f supabase/seeds/test_company_2025_26.sql
--
-- and then prove the reports agree with it:
--
--   psql "postgresql://postgres@localhost:5432/hisab_verify" \
--     -v ON_ERROR_STOP=1 -f supabase/seeds/test_company_2025_26_verify.sql
--
-- (`npm run db:test` builds that database from the migrations and rolls the
-- guarantees suite back, so it is empty and ready for this.)
--
-- Like demo_company.sql, this file does NOT create accounts: it needs an
-- auth.users row to own the company and raises if it finds none. On a
-- Supabase project, sign up first. On a scratch local database built by
-- run-local.sh, the compatibility harness has created an empty auth.users, so
-- put one row in it:
--
--   insert into auth.users
--     (id, instance_id, aud, role, email, email_confirmed_at,
--      raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
--   values
--     (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
--      'authenticated', 'authenticated', 'owner@example.test', now(),
--      '{}'::jsonb, '{"full_name":"Test Owner"}'::jsonb, now(), now());
--
-- ---------------------------------------------------------------- contents
--
--   * financial_year_start_month = 4, books 1 Apr 2025 -> 31 Mar 2026
--   * opening balances on both sides, tallying at 11,79,500.00 each way:
--     cash, two bank accounts (one of them a credit-balance cash credit
--     limit), two debtors, two creditors, a statutory due, two fixed assets,
--     an inactive ledger, and capital
--   * 54 vouchers — 53 live and one soft-deleted — covering all six types,
--     with at least three in every one of the twelve months, including
--     1 April 2025 and 31 March 2026, both year boundaries
--   * sixteen invoices (ten sales, six purchase) carrying 48 real
--     invoice_lines between them: several lines to the SAME revenue ledger
--     (the generator's grouping), lines to DIFFERENT ledgers on one invoice,
--     fractional quantities, four-decimal rates, and per-line discounts
--   * two deliberate rounding cases (section 4 below)
--   * an overdrawn bank account — a credit balance on a cash_bank ledger,
--     which is what migration 0012 exists for
--   * a customer sitting in credit and a supplier sitting in debit — what
--     0025 has to classify by the sign of the balance rather than by the role
--     of the group
--   * an inactive ledger still holding a balance — what 0017 exists for
--   * a party settled to exactly nil, which must NOT appear in Outstanding
--   * one soft-deleted voucher for 99,999.99, an amount chosen to be
--     unmistakable if it ever leaks into a report
--   * a lock date of 30 June 2025, so the first fifteen vouchers are behind it
--   * three-level account groups on three different branches of the tree
--   * a party with a 62-character name
--
-- ------------------------------------------------------- 4. the paise cases
--
-- invoice_lines.line_amount is `round(quantity * rate, 2) - discount_amount`,
-- GENERATED ALWAYS ... STORED. The paise are settled once per line and every
-- total downstream is a sum of already-2dp values. Two invoices exist purely
-- to prove that:
--
--   SAL .../00004 (14 Jun 2025) carries three lines of 1 x 33.3330. Each
--   stores 33.33, so the invoice totals 1,391.99. A generator that grouped
--   the raw quantity x rate instead would credit round(99.999 + 1292.00, 2)
--   = 1,392.00 against a party debited 1,391.99 and leave the books one
--   paisa out. The verify script asserts 1391.99 and asserts that the naive
--   figure differs.
--
--   SAL .../00008 (27 Jan 2026) carries three lines of 3 x 33.3330. Each of
--   those is 99.9990 and rounds UP to 100.00, the opposite direction to the
--   first case, so the two invoices between them exercise both halves of
--   round().
--
-- Fractional quantities against four-decimal rates appear on several more
-- lines — 46.500 mtr at 118.7500, 425.500 kg at 68.7500, 220.750 mtr at
-- 236.5000, 1420.750 kg at 59.7500 — every one of which extends to something
-- that is not a whole paisa.
--
-- --------------------------------------------------------------- re-running
--
-- Re-running this file creates a SECOND company with the same name; nothing
-- here deletes anything, because a seed that deletes is a seed that will one
-- day be pointed at the wrong database. Drop and rebuild the scratch database
-- instead (`npm run db:test`).

\set ON_ERROR_STOP on

begin;

do $seed$
declare
  -- CHANGE ME if you want a particular owner. Defaults to the oldest auth
  -- user, exactly as demo_company.sql does; this file does not create accounts.
  v_user uuid := (select id from auth.users order by created_at limit 1);

  v_co uuid;

  -- seeded groups
  g_bank uuid; g_cash uuid; g_debt uuid; g_cred uuid; g_out uuid;
  g_pm uuid; g_furn uuid; g_cap uuid; g_cl uuid;
  g_di uuid; g_de uuid; g_ii uuid; g_ie uuid;

  -- groups this file adds (three of them three levels deep)
  g_cc uuid; g_retail uuid; g_veh uuid; g_stat uuid; g_admin uuid; g_util uuid;

  -- ledgers
  l_cash uuid; l_oldcash uuid; l_hdfc uuid; l_icici uuid;
  l_ganpati uuid; l_vishwa uuid; l_anand uuid; l_retail uuid;
  l_bharat uuid; l_sanghvi uuid; l_modern uuid; l_konkan uuid;
  l_tds uuid; l_rentpay uuid;
  l_van uuid; l_furn uuid; l_capital uuid;
  l_sale_hw uuid; l_sale_pipe uuid; l_deliv uuid;
  l_disc uuid; l_intinc uuid;
  l_purch uuid; l_frin uuid;
  l_rent uuid; l_salary uuid; l_elec uuid; l_phone uuid;
  l_bankchg uuid; l_frout uuid; l_depr uuid;

  v_deleted_voucher uuid;
begin
  if v_user is null then
    raise exception 'No auth user to own the test company — create one first.';
  end if;

  -- create_voucher() stamps created_by from auth.uid(). Setting the claim the
  -- way PostgREST would means the audit columns are populated rather than
  -- null, so the Daybook's "entered by" column has something in it.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  insert into public.companies (
    name, book_beginning_date, financial_year_start_month, base_currency,
    address, phone, email, created_by)
  values (
    'Sharma Trading & Hardware Co.', '2025-04-01', 4, 'INR',
    E'Shop 14, Girgaon Hardware Market\nKalbadevi Road, Mumbai 400002\nMaharashtra',
    '+91 22 2240 1188', 'accounts@sharmatrading.example', v_user)
  returning id into v_co;

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_co, v_user, 'admin', 'active', v_user);

  perform app_private.seed_chart_of_accounts(v_co);

  select id into g_bank from public.account_groups where company_id = v_co and name = 'Bank Accounts';
  select id into g_cash from public.account_groups where company_id = v_co and name = 'Cash-in-Hand';
  select id into g_debt from public.account_groups where company_id = v_co and name = 'Sundry Debtors';
  select id into g_cred from public.account_groups where company_id = v_co and name = 'Sundry Creditors';
  select id into g_out  from public.account_groups where company_id = v_co and name = 'Outstanding Expenses';
  select id into g_pm   from public.account_groups where company_id = v_co and name = 'Plant & Machinery';
  select id into g_furn from public.account_groups where company_id = v_co and name = 'Furniture';
  select id into g_cap  from public.account_groups where company_id = v_co and name = 'Capital Account';
  select id into g_cl   from public.account_groups where company_id = v_co and name = 'Current Liabilities';
  select id into g_di   from public.account_groups where company_id = v_co and name = 'Direct Incomes';
  select id into g_de   from public.account_groups where company_id = v_co and name = 'Direct Expenses';
  select id into g_ii   from public.account_groups where company_id = v_co and name = 'Indirect Incomes';
  select id into g_ie   from public.account_groups where company_id = v_co and name = 'Indirect Expenses';

  -- ------------------------------------------------------------- 1. groups
  --
  -- nature and normal_balance are supplied because both columns are NOT NULL,
  -- but enforce_account_group_nature() overwrites nature with the parent's
  -- regardless — a child can never disagree with its parent.
  --
  -- Three of these are a third level: Bank Accounts -> Cash Credit Accounts,
  -- Sundry Debtors -> Retail Customers, Plant & Machinery -> Delivery
  -- Vehicles. Indirect Expenses -> Administrative Overheads -> Utilities &
  -- Communication is a fourth.
  insert into public.account_groups
    (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
  values
    (v_co, g_bank, 'Cash Credit Accounts',      'current_asset',     'debit',  'cash_bank',   2),
    (v_co, g_debt, 'Retail Customers',          'current_asset',     'debit',  'debtor',      1),
    (v_co, g_pm,   'Delivery Vehicles',         'fixed_asset',       'debit',  'fixed_asset', 1),
    (v_co, g_cl,   'Statutory Dues',            'current_liability', 'credit', 'other',       4),
    (v_co, g_ie,   'Administrative Overheads',  'indirect_expense',  'debit',  'expense',     1);

  select id into g_cc     from public.account_groups where company_id = v_co and name = 'Cash Credit Accounts';
  select id into g_retail from public.account_groups where company_id = v_co and name = 'Retail Customers';
  select id into g_veh    from public.account_groups where company_id = v_co and name = 'Delivery Vehicles';
  select id into g_stat   from public.account_groups where company_id = v_co and name = 'Statutory Dues';
  select id into g_admin  from public.account_groups where company_id = v_co and name = 'Administrative Overheads';

  insert into public.account_groups
    (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
  values (v_co, g_admin, 'Utilities & Communication', 'indirect_expense', 'debit', 'expense', 1);

  select id into g_util from public.account_groups where company_id = v_co and name = 'Utilities & Communication';

  -- ------------------------------------------------------------ 2. ledgers
  --
  -- Opening balances tally exactly:
  --
  --   Dr  45,000.00  Cash in Hand
  --   Dr  12,000.00  Old Cash Counter — Andheri shop (closed)   [inactive]
  --   Dr 3,20,000.00 HDFC Bank — Current A/c 50210
  --   Dr 1,85,000.00 Ganpati Hardware & Sanitary Stores ...
  --   Dr   92,500.00 Vishwakarma Steel Traders
  --   Dr 4,50,000.00 Delivery Van — MH 04 CJ 1188
  --   Dr   75,000.00 Office Furniture & Fixtures
  --   -----------------------------------------------------------
  --      11,79,500.00
  --
  --   Cr 1,25,000.00 ICICI Bank — Cash Credit A/c 0088   [asset nature,
  --                                                       credit balance]
  --   Cr 1,42,000.00 Bharat Pipes & Fittings Pvt Ltd
  --   Cr   68,000.00 Sanghvi Metal Corporation
  --   Cr    8,500.00 TDS Payable (194C)
  --   Cr 8,36,000.00 Sharma Family Capital A/c
  --   -----------------------------------------------------------
  --      11,79,500.00
  insert into public.ledgers
    (company_id, group_id, name, opening_balance_amount, opening_balance_type, created_by)
  values
    (v_co, g_cash,   'Cash in Hand',                            45000,  'debit',  v_user),
    (v_co, g_bank,   'HDFC Bank — Current A/c 50210',           320000, 'debit',  v_user),
    -- An asset-nature ledger carrying a CREDIT opening balance. A cash credit
    -- limit is drawn, so the "bank account" is a liability from day one; this
    -- is the everyday shape of the defect 0012 was written for.
    (v_co, g_cc,     'ICICI Bank — Cash Credit A/c 0088',       125000, 'credit', v_user),
    -- 62 characters, with an ampersand, a comma, brackets and an em dash.
    (v_co, g_debt,   'Ganpati Hardware & Sanitary Stores (Kalbadevi), Mumbai 400002', 185000, 'debit', v_user),
    (v_co, g_debt,   'Vishwakarma Steel Traders',               92500,  'debit',  v_user),
    (v_co, g_debt,   'Anand Enterprises',                       0,      'debit',  v_user),
    (v_co, g_retail, 'Retail Counter Sales — Sundry',           0,      'debit',  v_user),
    (v_co, g_cred,   'Bharat Pipes & Fittings Pvt Ltd',         142000, 'credit', v_user),
    (v_co, g_cred,   'Sanghvi Metal Corporation',               68000,  'credit', v_user),
    (v_co, g_cred,   'Modern Packaging Supplies',               0,      'credit', v_user),
    (v_co, g_cred,   'Konkan Roadways (transport)',             0,      'credit', v_user),
    (v_co, g_stat,   'TDS Payable (194C)',                      8500,   'credit', v_user),
    (v_co, g_out,    'Rent Payable',                            0,      'credit', v_user),
    (v_co, g_veh,    'Delivery Van — MH 04 CJ 1188',            450000, 'debit',  v_user),
    (v_co, g_furn,   'Office Furniture & Fixtures',             75000,  'debit',  v_user),
    (v_co, g_cap,    'Sharma Family Capital A/c',               836000, 'credit', v_user),
    (v_co, g_di,     'Sales — Hardware & Fittings',             0,      'credit', v_user),
    (v_co, g_di,     'Sales — Pipes & Plumbing',                0,      'credit', v_user),
    (v_co, g_di,     'Delivery Charges Recovered',              0,      'credit', v_user),
    (v_co, g_ii,     'Discount Received',                       0,      'credit', v_user),
    (v_co, g_ii,     'Interest on Deposits',                    0,      'credit', v_user),
    (v_co, g_de,     'Purchases — Trading Goods',               0,      'debit',  v_user),
    (v_co, g_de,     'Freight Inward',                          0,      'debit',  v_user),
    (v_co, g_admin,  'Shop Rent',                               0,      'debit',  v_user),
    (v_co, g_admin,  'Salaries & Wages',                        0,      'debit',  v_user),
    (v_co, g_admin,  'Bank Interest & Charges',                 0,      'debit',  v_user),
    (v_co, g_admin,  'Freight Outward',                         0,      'debit',  v_user),
    (v_co, g_admin,  'Depreciation',                            0,      'debit',  v_user),
    (v_co, g_util,   'Electricity Charges',                     0,      'debit',  v_user),
    (v_co, g_util,   'Telephone & Internet',                    0,      'debit',  v_user);

  -- An inactive ledger that still holds 12,000.00. Inserted inactive rather
  -- than deactivated afterwards, because 0017's protect_ledger_deactivation()
  -- refuses the true -> false transition on a ledger carrying a balance — and
  -- rightly so. This is the state books can already be in (imported, restored
  -- from a backup, or deactivated before 0017 landed), and 0017's other half
  -- says every one of those balances must still reach the statements.
  insert into public.ledgers
    (company_id, group_id, name, opening_balance_amount, opening_balance_type, is_active, created_by)
  values (v_co, g_cash, 'Old Cash Counter — Andheri shop (closed)', 12000, 'debit', false, v_user);

  select id into l_cash     from public.ledgers where company_id = v_co and name = 'Cash in Hand';
  select id into l_oldcash  from public.ledgers where company_id = v_co and name = 'Old Cash Counter — Andheri shop (closed)';
  select id into l_hdfc     from public.ledgers where company_id = v_co and name = 'HDFC Bank — Current A/c 50210';
  select id into l_icici    from public.ledgers where company_id = v_co and name = 'ICICI Bank — Cash Credit A/c 0088';
  select id into l_ganpati  from public.ledgers where company_id = v_co and name = 'Ganpati Hardware & Sanitary Stores (Kalbadevi), Mumbai 400002';
  select id into l_vishwa   from public.ledgers where company_id = v_co and name = 'Vishwakarma Steel Traders';
  select id into l_anand    from public.ledgers where company_id = v_co and name = 'Anand Enterprises';
  select id into l_retail   from public.ledgers where company_id = v_co and name = 'Retail Counter Sales — Sundry';
  select id into l_bharat   from public.ledgers where company_id = v_co and name = 'Bharat Pipes & Fittings Pvt Ltd';
  select id into l_sanghvi  from public.ledgers where company_id = v_co and name = 'Sanghvi Metal Corporation';
  select id into l_modern   from public.ledgers where company_id = v_co and name = 'Modern Packaging Supplies';
  select id into l_konkan   from public.ledgers where company_id = v_co and name = 'Konkan Roadways (transport)';
  select id into l_tds      from public.ledgers where company_id = v_co and name = 'TDS Payable (194C)';
  select id into l_rentpay  from public.ledgers where company_id = v_co and name = 'Rent Payable';
  select id into l_van      from public.ledgers where company_id = v_co and name = 'Delivery Van — MH 04 CJ 1188';
  select id into l_furn     from public.ledgers where company_id = v_co and name = 'Office Furniture & Fixtures';
  select id into l_capital  from public.ledgers where company_id = v_co and name = 'Sharma Family Capital A/c';
  select id into l_sale_hw  from public.ledgers where company_id = v_co and name = 'Sales — Hardware & Fittings';
  select id into l_sale_pipe from public.ledgers where company_id = v_co and name = 'Sales — Pipes & Plumbing';
  select id into l_deliv    from public.ledgers where company_id = v_co and name = 'Delivery Charges Recovered';
  select id into l_disc     from public.ledgers where company_id = v_co and name = 'Discount Received';
  select id into l_intinc   from public.ledgers where company_id = v_co and name = 'Interest on Deposits';
  select id into l_purch    from public.ledgers where company_id = v_co and name = 'Purchases — Trading Goods';
  select id into l_frin     from public.ledgers where company_id = v_co and name = 'Freight Inward';
  select id into l_rent     from public.ledgers where company_id = v_co and name = 'Shop Rent';
  select id into l_salary   from public.ledgers where company_id = v_co and name = 'Salaries & Wages';
  select id into l_elec     from public.ledgers where company_id = v_co and name = 'Electricity Charges';
  select id into l_phone    from public.ledgers where company_id = v_co and name = 'Telephone & Internet';
  select id into l_bankchg  from public.ledgers where company_id = v_co and name = 'Bank Interest & Charges';
  select id into l_frout    from public.ledgers where company_id = v_co and name = 'Freight Outward';
  select id into l_depr     from public.ledgers where company_id = v_co and name = 'Depreciation';

  -- ----------------------------------------------------------- 3. vouchers
  --
  -- Always through create_voucher(), never a direct insert: header and lines
  -- must land in one transaction or the deferred balance trigger fires before
  -- the lines exist. Invoices go through the same RPC with p_invoice, so the
  -- entries are generated by app_private.generate_invoice_entries() exactly as
  -- they would be from the form.

  -- ============================================================ APRIL 2025

  -- 1 Apr 2025 — the first day of the year, and an invoice with three lines,
  -- two of which share a revenue ledger (grouping) while the third does not.
  -- 46.500 mtr x 118.7500 = 5,521.875, which is not a whole paisa.
  perform public.create_voucher(v_co, 'sales', '2025-04-01',
    'Opening order — Ganpati Hardware', 'GS/25-26/001', '2025-04-01',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_ganpati,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'CP Brass Bib Cock 15mm',
          'quantity', 120, 'unit', 'nos', 'rate', 285.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 1, 'description', 'SS Door Hinges 4 inch (heavy)',
          'quantity', 250, 'unit', 'nos', 'rate', 62.5000, 'discount_amount', 500.00,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 2, 'description', 'CPVC Pipe 25mm SDR-11',
          'quantity', 46.500, 'unit', 'mtr', 'rate', 118.7500, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_pipe))));

  -- 1 Apr 2025 — the other boundary voucher.
  perform public.create_voucher(v_co, 'journal', '2025-04-01', 'Shop rent for April accrued', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_rent,    'debit_amount', 18000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_rentpay, 'debit_amount', 0, 'credit_amount', 18000, 'line_order', 1)));

  -- 85.750 mtr x 142.5000 = 12,219.375. Two lines to Purchases, one to
  -- Freight Inward — the mirror of the sales grouping.
  perform public.create_voucher(v_co, 'purchase', '2025-04-07',
    'Pipes and fittings — Bharat Pipes', 'BPF/2025-26/0417', '2025-04-06',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_bharat,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'GI Pipe 20mm B-class',
          'quantity', 85.750, 'unit', 'mtr', 'rate', 142.5000, 'discount_amount', 0,
          'revenue_ledger_id', l_purch),
        jsonb_build_object('line_order', 1, 'description', 'Brass Ferrule 15mm',
          'quantity', 300, 'unit', 'nos', 'rate', 41.2500, 'discount_amount', 750.00,
          'revenue_ledger_id', l_purch),
        jsonb_build_object('line_order', 2, 'description', 'Transport — Bhiwandi to Kalbadevi',
          'quantity', 1, 'unit', null, 'rate', 2850.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_frin))));

  perform public.create_voucher(v_co, 'receipt', '2025-04-12', 'Ganpati Hardware — on account', 'NEFT 4412', '2025-04-12',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc,    'debit_amount', 150000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_ganpati, 'debit_amount', 0, 'credit_amount', 150000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'payment', '2025-04-22', 'Bharat Pipes — part settlement', 'RTGS 88201', '2025-04-22',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_bharat, 'debit_amount', 100000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc,   'debit_amount', 0, 'credit_amount', 100000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'contra', '2025-04-28', 'Cash drawn from HDFC for counter float', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_cash, 'debit_amount', 25000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc, 'debit_amount', 0, 'credit_amount', 25000, 'line_order', 1)));

  -- ============================================================== MAY 2025

  -- 425.500 kg x 68.7500 = 29,253.125 and 12.500 kg x 16.6650 = 208.3125:
  -- two more lines that do not land on a whole paisa, plus a discount.
  perform public.create_voucher(v_co, 'sales', '2025-05-05',
    'Structural steel — Vishwakarma', 'GS/25-26/002', '2025-05-05',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_vishwa,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'MS Angle 50x50x5',
          'quantity', 425.500, 'unit', 'kg', 'rate', 68.7500, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 1, 'description', 'Galvanised binding wire 18g',
          'quantity', 12.500, 'unit', 'kg', 'rate', 16.6650, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 2, 'description', 'CPVC Elbow 25mm',
          'quantity', 150, 'unit', 'nos', 'rate', 44.0000, 'discount_amount', 300.00,
          'revenue_ledger_id', l_sale_pipe),
        jsonb_build_object('line_order', 3, 'description', 'PTFE thread seal tape 12mm',
          'quantity', 500, 'unit', 'nos', 'rate', 8.7500, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_pipe))));

  -- A three-line payment: salary net of TDS deducted.
  perform public.create_voucher(v_co, 'payment', '2025-05-16', 'Staff salaries for April, net of TDS', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_salary, 'debit_amount', 62000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc,   'debit_amount', 0, 'credit_amount', 55500, 'line_order', 1),
      jsonb_build_object('ledger_id', l_tds,    'debit_amount', 0, 'credit_amount', 6500,  'line_order', 2)));

  perform public.create_voucher(v_co, 'receipt', '2025-05-20', 'Vishwakarma — cheque into CC account', 'CHQ 551209', '2025-05-19',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_icici,  'debit_amount', 40000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_vishwa, 'debit_amount', 0, 'credit_amount', 40000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'journal', '2025-05-31', 'Shop rent for May accrued', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_rent,    'debit_amount', 18000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_rentpay, 'debit_amount', 0, 'credit_amount', 18000, 'line_order', 1)));

  -- ============================================================= JUNE 2025

  -- 340.250 kg x 61.5000 = 20,925.375.
  perform public.create_voucher(v_co, 'purchase', '2025-06-03',
    'MS flats and bars — Sanghvi Metal', 'SMC-1147', '2025-06-02',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_sanghvi,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'MS Flat 40x6',
          'quantity', 1250.000, 'unit', 'kg', 'rate', 62.4000, 'discount_amount', 0,
          'revenue_ledger_id', l_purch),
        jsonb_build_object('line_order', 1, 'description', 'MS Square bar 12mm',
          'quantity', 340.250, 'unit', 'kg', 'rate', 61.5000, 'discount_amount', 0,
          'revenue_ledger_id', l_purch),
        jsonb_build_object('line_order', 2, 'description', 'Lorry freight — Kalamboli yard',
          'quantity', 1, 'unit', null, 'rate', 4500.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_frin))));

  -- THE PAISE CASE, HALF ONE. Three lines of 1 x 33.3330. Each stores
  -- round(33.3330, 2) = 33.33, so the three come to 99.99 and the invoice to
  -- 1,391.99. Grouped from the raw quantity x rate it would be
  -- round(99.999 + 1292.00, 2) = 1,392.00 — one paisa more than the party is
  -- debited. Every line here credits the SAME ledger, so the whole invoice
  -- posts as one credit and there is nowhere for a stray paisa to hide.
  perform public.create_voucher(v_co, 'sales', '2025-06-14',
    'Counter sale — assorted', null, null,
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_retail,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Assorted galvanised nails — grade A',
          'quantity', 1, 'unit', 'kg', 'rate', 33.3330, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 1, 'description', 'Assorted galvanised nails — grade B',
          'quantity', 1, 'unit', 'kg', 'rate', 33.3330, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 2, 'description', 'Assorted galvanised nails — grade C',
          'quantity', 1, 'unit', 'kg', 'rate', 33.3330, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 3, 'description', 'Cotton waste (cleaning)',
          'quantity', 5, 'unit', 'kg', 'rate', 40.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 4, 'description', 'Hacksaw blade 12 inch',
          'quantity', 24, 'unit', 'nos', 'rate', 45.5000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw))));

  perform public.create_voucher(v_co, 'receipt', '2025-06-20', 'Counter sale realised in cash', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_cash,   'debit_amount', 1391.99, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_retail, 'debit_amount', 0, 'credit_amount', 1391.99, 'line_order', 1)));

  perform public.create_voucher(v_co, 'payment', '2025-06-30', 'Shop rent for April and May paid', 'CHQ 100114', '2025-06-30',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_rentpay, 'debit_amount', 36000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc,    'debit_amount', 0, 'credit_amount', 36000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'contra', '2025-06-30', 'Counter cash banked', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc, 'debit_amount', 30000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_cash, 'debit_amount', 0, 'credit_amount', 30000, 'line_order', 1)));

  -- ============================================================= JULY 2025

  perform public.create_voucher(v_co, 'purchase', '2025-07-08',
    'Packing material — Modern Packaging', 'MPS/25-26/031', '2025-07-07',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_modern,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Corrugated box 18x12x10',
          'quantity', 400, 'unit', 'nos', 'rate', 27.7500, 'discount_amount', 0,
          'revenue_ledger_id', l_purch),
        jsonb_build_object('line_order', 1, 'description', 'Stretch wrap film 23 micron',
          'quantity', 18.250, 'unit', 'kg', 'rate', 168.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_purch))));

  -- Deliberately more than the bill: an advance against the season's orders.
  -- Modern Packaging ends the year in DEBIT — a supplier who owes us — which
  -- 0025 must report as a receivable despite the group's creditor role.
  perform public.create_voucher(v_co, 'payment', '2025-07-11', 'Modern Packaging — advance against season orders', 'NEFT 5591', '2025-07-11',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_modern, 'debit_amount', 50000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc,   'debit_amount', 0, 'credit_amount', 50000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'sales', '2025-07-19',
    'Sanitaryware — Ganpati Hardware', 'GS/25-26/003', '2025-07-19',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_ganpati,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'SS Sink 24x18 satin finish',
          'quantity', 12, 'unit', 'nos', 'rate', 3285.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 1, 'description', 'Sink waste coupling 32mm',
          'quantity', 12, 'unit', 'nos', 'rate', 275.0000, 'discount_amount', 300.00,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 2, 'description', 'PVC connection pipe 18 inch',
          'quantity', 24, 'unit', 'nos', 'rate', 88.5000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_pipe))));

  perform public.create_voucher(v_co, 'journal', '2025-07-25', 'Outward freight billed by Konkan Roadways', 'KR/7742', '2025-07-24',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_frout,  'debit_amount', 7800, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_konkan, 'debit_amount', 0, 'credit_amount', 7800, 'line_order', 1)));

  perform public.create_voucher(v_co, 'receipt', '2025-07-31', 'Ganpati Hardware — on account', 'NEFT 6120', '2025-07-31',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc,    'debit_amount', 40000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_ganpati, 'debit_amount', 0, 'credit_amount', 40000, 'line_order', 1)));

  -- =========================================================== AUGUST 2025

  -- 75,000 received against an order later billed at only 30,000, so Anand
  -- Enterprises ends the year 45,000 in CREDIT — a customer we owe. 0025 must
  -- report that as a payable, not as a negative receivable.
  perform public.create_voucher(v_co, 'receipt', '2025-08-05', 'Anand Enterprises — advance against order', 'NEFT 6338', '2025-08-05',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc,  'debit_amount', 75000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_anand, 'debit_amount', 0, 'credit_amount', 75000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'sales', '2025-08-14',
    'Valves — Anand Enterprises', 'GS/25-26/004', '2025-08-14',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_anand,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Ball valve 25mm forged brass',
          'quantity', 40, 'unit', 'nos', 'rate', 612.5000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_pipe),
        jsonb_build_object('line_order', 1, 'description', 'Union 25mm brass',
          'quantity', 40, 'unit', 'nos', 'rate', 148.7500, 'discount_amount', 450.00,
          'revenue_ledger_id', l_sale_pipe))));

  perform public.create_voucher(v_co, 'payment', '2025-08-22', 'Electricity bill — shop meter', 'MSEDCL 8811', '2025-08-20',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_elec, 'debit_amount', 9450, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_cash, 'debit_amount', 0, 'credit_amount', 9450, 'line_order', 1)));

  perform public.create_voucher(v_co, 'contra', '2025-08-29', 'Cash drawn on cash credit limit', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_cash,  'debit_amount', 20000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_icici, 'debit_amount', 0, 'credit_amount', 20000, 'line_order', 1)));

  -- ======================================================== SEPTEMBER 2025

  -- 220.750 mtr x 236.5000 = 52,207.375.
  perform public.create_voucher(v_co, 'purchase', '2025-09-04',
    'PPR pipe and couplers — Bharat Pipes', 'BPF/2025-26/0912', '2025-09-03',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_bharat,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'PPR Pipe 32mm PN10',
          'quantity', 220.750, 'unit', 'mtr', 'rate', 236.5000, 'discount_amount', 0,
          'revenue_ledger_id', l_purch),
        jsonb_build_object('line_order', 1, 'description', 'PPR Coupler 32mm',
          'quantity', 180, 'unit', 'nos', 'rate', 96.2500, 'discount_amount', 0,
          'revenue_ledger_id', l_purch),
        jsonb_build_object('line_order', 2, 'description', 'Freight — Wadala godown',
          'quantity', 1, 'unit', null, 'rate', 3200.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_frin))));

  perform public.create_voucher(v_co, 'payment', '2025-09-15', 'Bharat Pipes — part settlement from CC', 'RTGS 90114', '2025-09-15',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_bharat, 'debit_amount', 60000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_icici,  'debit_amount', 0, 'credit_amount', 60000, 'line_order', 1)));

  -- Depreciation written against the asset itself, so the fixed asset on the
  -- Balance Sheet is not simply its opening figure.
  perform public.create_voucher(v_co, 'journal', '2025-09-26', 'Depreciation on delivery van (half year)', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_depr, 'debit_amount', 37500, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_van,  'debit_amount', 0, 'credit_amount', 37500, 'line_order', 1)));

  perform public.create_voucher(v_co, 'receipt', '2025-09-30', 'Interest credited on fixed deposit', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc,   'debit_amount', 5600, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_intinc, 'debit_amount', 0, 'credit_amount', 5600, 'line_order', 1)));

  -- ========================================================== OCTOBER 2025

  -- 880.500 kg x 178.4000 = 1,57,081.20.
  perform public.create_voucher(v_co, 'sales', '2025-10-09',
    'Chequered plate — Vishwakarma', 'GS/25-26/005', '2025-10-09',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_vishwa,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'MS Chequered plate 5mm',
          'quantity', 880.500, 'unit', 'kg', 'rate', 178.4000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 1, 'description', 'Cutting and handling charges',
          'quantity', 1, 'unit', null, 'rate', 2250.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw))));

  perform public.create_voucher(v_co, 'payment', '2025-10-18', 'Telephone and broadband — quarter', 'VI 44120', '2025-10-15',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_phone, 'debit_amount', 4720, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc,  'debit_amount', 0, 'credit_amount', 4720, 'line_order', 1)));

  perform public.create_voucher(v_co, 'receipt', '2025-10-27', 'Vishwakarma — on account', 'NEFT 7203', '2025-10-27',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc,   'debit_amount', 70000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_vishwa, 'debit_amount', 0, 'credit_amount', 70000, 'line_order', 1)));

  -- ========================================================= NOVEMBER 2025

  perform public.create_voucher(v_co, 'payment', '2025-11-06', 'Sanghvi Metal — part settlement', 'RTGS 91882', '2025-11-06',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_sanghvi, 'debit_amount', 80000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc,    'debit_amount', 0, 'credit_amount', 80000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'journal', '2025-11-17', 'Cash discount allowed by Bharat Pipes', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_bharat, 'debit_amount', 3250, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_disc,   'debit_amount', 0, 'credit_amount', 3250, 'line_order', 1)));

  perform public.create_voucher(v_co, 'sales', '2025-11-28',
    'GI fittings — Ganpati Hardware', 'GS/25-26/006', '2025-11-28',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_ganpati,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'GI Elbow 20mm',
          'quantity', 600, 'unit', 'nos', 'rate', 38.7500, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_pipe),
        jsonb_build_object('line_order', 1, 'description', 'GI Tee 20mm',
          'quantity', 450, 'unit', 'nos', 'rate', 46.2500, 'discount_amount', 1200.00,
          'revenue_ledger_id', l_sale_pipe),
        jsonb_build_object('line_order', 2, 'description', 'Pipe wrench 14 inch',
          'quantity', 20, 'unit', 'nos', 'rate', 585.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw))));

  -- ========================================================= DECEMBER 2025

  -- 1420.750 kg x 59.7500 = 84,889.8125.
  perform public.create_voucher(v_co, 'purchase', '2025-12-05',
    'MS round bar — Sanghvi Metal', 'SMC-1288', '2025-12-04',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_sanghvi,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'MS Round bar 16mm',
          'quantity', 1420.750, 'unit', 'kg', 'rate', 59.7500, 'discount_amount', 0,
          'revenue_ledger_id', l_purch),
        jsonb_build_object('line_order', 1, 'description', 'Loading and crane charges',
          'quantity', 1, 'unit', null, 'rate', 1850.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_frin))));

  perform public.create_voucher(v_co, 'payment', '2025-12-16', 'Staff salaries for November, net of TDS', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_salary, 'debit_amount', 64000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc,   'debit_amount', 0, 'credit_amount', 57500, 'line_order', 1),
      jsonb_build_object('ledger_id', l_tds,    'debit_amount', 0, 'credit_amount', 6500,  'line_order', 2)));

  perform public.create_voucher(v_co, 'contra', '2025-12-24', 'Cash drawn for festival counter float', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_cash, 'debit_amount', 35000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc, 'debit_amount', 0, 'credit_amount', 35000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'journal', '2025-12-31', 'Shop rent for June to November accrued', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_rent,    'debit_amount', 108000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_rentpay, 'debit_amount', 0, 'credit_amount', 108000, 'line_order', 1)));

  -- ========================================================== JANUARY 2026

  perform public.create_voucher(v_co, 'receipt', '2026-01-08', 'Ganpati Hardware — on account', 'NEFT 8014', '2026-01-08',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc,    'debit_amount', 25000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_ganpati, 'debit_amount', 0, 'credit_amount', 25000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'payment', '2026-01-19', 'Cash credit interest and charges for the year', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_bankchg, 'debit_amount', 18240, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_icici,   'debit_amount', 0, 'credit_amount', 18240, 'line_order', 1)));

  -- THE PAISE CASE, HALF TWO. Three lines of 3 x 33.3330. Each is 99.9990,
  -- which rounds UP to 100.00 — the opposite direction to 14 June's three
  -- lines of 1 x 33.3330, so the pair covers both halves of round(). Grouped
  -- from the raw figures this invoice comes to the same 4,270.00, which is
  -- exactly why one case is not enough to prove anything.
  perform public.create_voucher(v_co, 'sales', '2026-01-27',
    'Counter sale — assorted', null, null,
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_retail,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Assorted hardware oddments — tray A',
          'quantity', 3, 'unit', 'kg', 'rate', 33.3330, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 1, 'description', 'Assorted hardware oddments — tray B',
          'quantity', 3, 'unit', 'kg', 'rate', 33.3330, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 2, 'description', 'Assorted hardware oddments — tray C',
          'quantity', 3, 'unit', 'kg', 'rate', 33.3330, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 3, 'description', 'Paint brush 3 inch',
          'quantity', 36, 'unit', 'nos', 'rate', 82.5000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 4, 'description', 'Emery paper assorted grit',
          'quantity', 100, 'unit', 'nos', 'rate', 11.2500, 'discount_amount', 125.00,
          'revenue_ledger_id', l_sale_hw))));

  perform public.create_voucher(v_co, 'receipt', '2026-01-31', 'Counter sale realised in cash', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_cash,   'debit_amount', 4270.00, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_retail, 'debit_amount', 0, 'credit_amount', 4270.00, 'line_order', 1)));

  -- ========================================================= FEBRUARY 2026

  perform public.create_voucher(v_co, 'purchase', '2026-02-06',
    'Packing material — Modern Packaging', 'MPS/25-26/104', '2026-02-05',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_modern,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'BOPP tape 48mm x 65m',
          'quantity', 240, 'unit', 'nos', 'rate', 38.5000, 'discount_amount', 0,
          'revenue_ledger_id', l_purch),
        jsonb_build_object('line_order', 1, 'description', 'Bubble wrap roll 1m',
          'quantity', 6.750, 'unit', 'kg', 'rate', 285.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_purch))));

  perform public.create_voucher(v_co, 'sales', '2026-02-11',
    'Door hardware — Ganpati Hardware', 'GS/25-26/007', '2026-02-11',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_ganpati,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Hydraulic door closer 80kg',
          'quantity', 45, 'unit', 'nos', 'rate', 2485.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 1, 'description', 'Mortice lock set — brass',
          'quantity', 30, 'unit', 'set', 'rate', 1875.0000, 'discount_amount', 2250.00,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 2, 'description', 'Concealed cistern 8 ltr',
          'quantity', 8, 'unit', 'nos', 'rate', 6412.5000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_pipe))));

  perform public.create_voucher(v_co, 'payment', '2026-02-14', 'Electricity bill — shop meter', 'MSEDCL 9440', '2026-02-12',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_elec, 'debit_amount', 11280, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc, 'debit_amount', 0, 'credit_amount', 11280, 'line_order', 1)));

  perform public.create_voucher(v_co, 'journal', '2026-02-20', 'Outward freight billed by Konkan Roadways', 'KR/8815', '2026-02-19',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_frout,  'debit_amount', 9600, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_konkan, 'debit_amount', 0, 'credit_amount', 9600, 'line_order', 1)));

  perform public.create_voucher(v_co, 'receipt', '2026-02-25', 'Ganpati Hardware — settlement of door hardware bill', 'NEFT 8877', '2026-02-25',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc,    'debit_amount', 200000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_ganpati, 'debit_amount', 0, 'credit_amount', 200000, 'line_order', 1)));

  -- Settles Konkan Roadways to EXACTLY nil. A party at zero must not appear
  -- on the Outstanding screen, and must still appear on the Trial Balance.
  perform public.create_voucher(v_co, 'payment', '2026-02-27', 'Konkan Roadways — full settlement', 'CHQ 100178', '2026-02-27',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_konkan, 'debit_amount', 17400, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc,   'debit_amount', 0, 'credit_amount', 17400, 'line_order', 1)));

  -- ============================================================ MARCH 2026

  -- 2250.500 kg x 166.8000 = 3,75,383.40, and three DIFFERENT revenue
  -- ledgers on one invoice.
  perform public.create_voucher(v_co, 'sales', '2026-03-05',
    'Beams and fabrication — Vishwakarma', 'GS/25-26/008', '2026-03-05',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', l_vishwa,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'MS Beam ISMB 150',
          'quantity', 2250.500, 'unit', 'kg', 'rate', 166.8000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 1, 'description', 'Fabrication and welding charges',
          'quantity', 1, 'unit', null, 'rate', 18500.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_sale_hw),
        jsonb_build_object('line_order', 2, 'description', 'Delivery to site — Panvel',
          'quantity', 1, 'unit', null, 'rate', 6750.0000, 'discount_amount', 0,
          'revenue_ledger_id', l_deliv))));

  perform public.create_voucher(v_co, 'receipt', '2026-03-18', 'Vishwakarma — on account', 'RTGS 93310', '2026-03-18',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc,   'debit_amount', 120000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_vishwa, 'debit_amount', 0, 'credit_amount', 120000, 'line_order', 1)));

  -- THE SOFT-DELETED VOUCHER. 99,999.99 is chosen to be unmistakable: if any
  -- report, tile or total moves by that amount, it read a deleted voucher.
  -- Created through the ordinary path so it is a real, balanced, numbered
  -- voucher — the number it consumed stays consumed, exactly as a real
  -- deletion in the app leaves it.
  select public.create_voucher(v_co, 'journal', '2026-03-24',
    'Entered in error — rent accrual duplicated', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_rent,    'debit_amount', 99999.99, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_rentpay, 'debit_amount', 0, 'credit_amount', 99999.99, 'line_order', 1)))
  into v_deleted_voucher;

  update public.vouchers set is_deleted = true, updated_by = v_user
  where id = v_deleted_voucher;

  -- 31 Mar 2026 — the last day of the year, three vouchers on it.
  perform public.create_voucher(v_co, 'journal', '2026-03-31', 'Shop rent for December to March accrued', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_rent,    'debit_amount', 72000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_rentpay, 'debit_amount', 0, 'credit_amount', 72000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'payment', '2026-03-31', 'TDS on contractors deposited', 'CIN 2603260011', '2026-03-31',
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_tds,  'debit_amount', 13000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_hdfc, 'debit_amount', 0, 'credit_amount', 13000, 'line_order', 1)));

  perform public.create_voucher(v_co, 'contra', '2026-03-31', 'Counter cash banked at year end', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', l_hdfc, 'debit_amount', 15000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', l_cash, 'debit_amount', 0, 'credit_amount', 15000, 'line_order', 1)));

  -- --------------------------------------------------------- 4. lock date
  --
  -- Set last, because the RLS policies refuse a write dated on or before it.
  -- Everything from 1 April to 30 June 2025 — fifteen vouchers, including
  -- both 1 April boundary vouchers and two invoices — is now behind it.
  update public.companies set lock_date = '2025-06-30' where id = v_co;

  raise notice 'Seeded company % — Sharma Trading & Hardware Co., FY 2025-26', v_co;
end;
$seed$;

commit;
