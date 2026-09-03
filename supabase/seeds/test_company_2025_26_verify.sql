-- Proves the reports agree with supabase/seeds/test_company_2025_26.sql.
--
--   psql "postgresql://postgres@localhost:5432/hisab_verify" \
--     -v ON_ERROR_STOP=1 -f supabase/seeds/test_company_2025_26_verify.sql
--
-- It opens a transaction and rolls the whole thing back, so it is safe to run
-- against a database holding real data (it will simply find no test company
-- and say so). Sections 0 to 10 only read; section 11 writes one voucher into
-- the transaction it is about to roll back, the way guarantees.sql builds its
-- own fixtures, because the case it needs would leave a permanently wrong set
-- of books if it were seeded.
--
-- ---------------------------------------------------- THIS RUN DOES NOT PASS
--
-- Five of the 92 assertions fail today, and between them they are TWO defects
-- in the reports, not five mistakes in the expectations. They are left failing
-- on purpose; a test quietly adjusted to agree with the code would have
-- nothing to say. Each carries its diagnosis at the assertion:
--
--   * section 9, twice — the dashboard splits cash from bank on
--     `g.name ilike '%cash%'`, so a bank group called "Cash Credit Accounts"
--     lands in the cash tile. The cash tile reads -95,028.01 and the bank
--     tile 5,65,200.00, each out by 1,83,240.00 in opposite directions. Their
--     sum is right, which is why nothing else catches it.
--   * section 11, three times — get_profit_and_loss reports abs() of each
--     ledger's movement, so an income ledger left in DEBIT by a credit note
--     is added to income instead of subtracted from it. The P&L overstates
--     the result by twice the reversal (6,500.00 on the fixture there) while
--     the Balance Sheet stays right, and the two statements disagree about
--     the same books on the same date.
--
-- Everything else holds: 87 assertions, including every paise.
--
-- ------------------------------------------------- how the expectations are made
--
-- Every expected figure is derived from the SOURCE amounts, never by asking
-- the function under test what it thinks:
--
--   * the closing Trial Balance is a hardcoded VALUES list of all 31 ledgers,
--     worked out by hand from the seed's opening balances and its 53 vouchers
--     before this file was written. A report that changes and an expectation
--     that changes with it prove nothing, so the expectation cannot move
--     without somebody editing it deliberately.
--   * every other statement figure is recomputed here from
--     ledgers.opening_balance_amount and voucher_entries directly, in this
--     file, with its own is_deleted and date filters.
--   * invoice totals are recomputed from quantity, rate and discount_amount.
--     invoice_lines.line_amount is NOT read, because line_amount is the
--     generated column whose arithmetic is the thing being checked.
--
-- --------------------------------------------------------- how failures read
--
-- pg_temp.expect() is guarantees.sql's, with one change: it RECORDS a failure
-- and carries on, and a final block raises with the full list. Fail-fast is
-- right for guarantees.sql, where each assertion builds on the fixture the
-- last one left; here the assertions are independent readings of one finished
-- set of books, and stopping at the first disagreement would hide the other
-- twelve. The run still ends in an exception and a non-zero exit code.
--
-- `is not true`, not `not ...`: a condition that evaluates to NULL is a
-- failure, not a pass. Several assertions below compare against a value the
-- database is supposed to have produced, and a report that produced no row at
-- all yields NULL rather than false.

\set ON_ERROR_STOP on

begin;

create temp table results (
  seq serial primary key,
  ok boolean not null,
  what text not null,
  detail text
) on commit drop;

create or replace function pg_temp.expect(p_condition boolean, p_what text, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into results (ok, what, detail) values (p_condition is true, p_what, p_detail);
  if p_condition is true then
    raise notice '  ok    %', p_what;
  else
    raise warning '  FAIL  % % ', p_what, coalesce('-- ' || p_detail, '');
  end if;
end;
$$;

-- Reports two numerics as "expected X, got Y" so a paise-level disagreement
-- is readable without hunting for it.
create or replace function pg_temp.money(p_expected numeric, p_actual numeric)
returns text language sql immutable as $$
  select 'expected ' || coalesce(to_char(p_expected, 'FM9999999990.00'), '(null)')
      || ', got '    || coalesce(to_char(p_actual,   'FM9999999990.00'), '(null)')
      || ', out by ' || coalesce(to_char(coalesce(p_actual,0) - coalesce(p_expected,0), 'FM9999999990.00'), '?');
$$;

-- The company under test, and the two dates every report is asked for.
create temp view t as
  select c.id as co, c.book_beginning_date as bb, date '2026-03-31' as asof
  from public.companies c
  where c.name = 'Sharma Trading & Hardware Co.'
  order by c.created_at
  limit 1;

do $$
begin
  if not exists (select 1 from t) then
    raise exception 'No "Sharma Trading & Hardware Co." in this database. Load supabase/seeds/test_company_2025_26.sql first.';
  end if;
end;
$$;

-- --------------------------------------------------------------------------
-- The independent balance: opening balance, signed, plus every entry on every
-- non-deleted voucher up to the as-of date. Written out here rather than
-- taken from get_trial_balance(), because get_trial_balance() is the thing
-- being checked.
-- --------------------------------------------------------------------------
create temp view expected_balance as
  select
    l.id as ledger_id,
    l.name as ledger_name,
    l.is_active,
    g.nature,
    g.ledger_role,
    g.name as group_name,
    coalesce(l.opening_balance_amount, 0)
      * case when l.opening_balance_type = 'debit' then 1 else -1 end
    + coalesce((
        select sum(ve.debit_amount - ve.credit_amount)
        from public.voucher_entries ve
        join public.vouchers v on v.id = ve.voucher_id
        where ve.ledger_id = l.id
          and v.company_id = (select co from t)
          and v.is_deleted = false
          and v.voucher_date <= (select asof from t)
      ), 0)::numeric(18,2) as signed
  from public.ledgers l
  join public.account_groups g on g.id = l.group_id
  where l.company_id = (select co from t);

-- The same thing worked out by hand, before any of these functions was run.
create temp table hand_trial_balance (ledger_name text primary key, signed numeric(18,2));
insert into hand_trial_balance values
  ('Cash in Hand',                                                   76211.99),
  ('Old Cash Counter — Andheri shop (closed)',                       12000.00),
  ('HDFC Bank — Current A/c 50210',                                 565200.00),
  ('ICICI Bank — Cash Credit A/c 0088',                            -183240.00),
  ('Ganpati Hardware & Sanitary Stores (Kalbadevi), Mumbai 400002',  141078.38),
  ('Vishwakarma Steel Traders',                                     462601.04),
  ('Anand Enterprises',                                             -45000.00),
  ('Retail Counter Sales — Sundry',                                       0.00),
  ('Bharat Pipes & Fittings Pvt Ltd',                               -78176.76),
  ('Sanghvi Metal Corporation',                                    -178165.19),
  ('Modern Packaging Supplies',                                      24670.25),
  ('Konkan Roadways (transport)',                                        0.00),
  ('TDS Payable (194C)',                                             -8500.00),
  ('Rent Payable',                                                 -180000.00),
  ('Delivery Van — MH 04 CJ 1188',                                  412500.00),
  ('Office Furniture & Fixtures',                                    75000.00),
  ('Sharma Family Capital A/c',                                    -836000.00),
  ('Sales — Hardware & Fittings',                                  -857608.03),
  ('Sales — Pipes & Plumbing',                                     -142483.38),
  ('Delivery Charges Recovered',                                     -6750.00),
  ('Discount Received',                                              -3250.00),
  ('Interest on Deposits',                                           -5600.00),
  ('Purchases — Trading Goods',                                     302521.70),
  ('Freight Inward',                                                 12400.00),
  ('Shop Rent',                                                     216000.00),
  ('Salaries & Wages',                                              126000.00),
  ('Bank Interest & Charges',                                        18240.00),
  ('Freight Outward',                                                17400.00),
  ('Depreciation',                                                   37500.00),
  ('Electricity Charges',                                            20730.00),
  ('Telephone & Internet',                                            4720.00);

\echo ''
\echo '0. The seed is what it claims to be'

do $$
declare
  v_co uuid := (select co from t);
  v_n int; v_m int;
begin
  perform pg_temp.expect(
    (select financial_year_start_month from public.companies where id = v_co) = 4,
    'the company runs an April financial year');

  perform pg_temp.expect(
    (select book_beginning_date from public.companies where id = v_co) = date '2025-04-01',
    'the books begin on 1 April 2025');

  perform pg_temp.expect(
    (select lock_date from public.companies where id = v_co) = date '2025-06-30',
    'a lock date of 30 June 2025 is set');

  select count(*) into v_n from public.vouchers
   where company_id = v_co and is_deleted = false and voucher_date <= date '2025-06-30';
  perform pg_temp.expect(v_n = 15, 'fifteen vouchers sit behind the lock date', 'found ' || v_n);

  select count(distinct voucher_type) into v_n from public.vouchers
   where company_id = v_co and is_deleted = false;
  perform pg_temp.expect(v_n = 6, 'all six voucher types are present', 'found ' || v_n);

  select count(distinct date_trunc('month', voucher_date)) into v_m from public.vouchers
   where company_id = v_co and is_deleted = false;
  perform pg_temp.expect(v_m = 12, 'every one of the twelve months has vouchers', 'found ' || v_m);

  perform pg_temp.expect(
    exists (select 1 from public.vouchers where company_id = v_co and is_deleted = false and voucher_date = date '2025-04-01')
    and exists (select 1 from public.vouchers where company_id = v_co and is_deleted = false and voucher_date = date '2026-03-31'),
    'both financial year boundaries carry vouchers');

  select count(*) into v_n from public.vouchers where company_id = v_co and is_deleted = true;
  perform pg_temp.expect(v_n = 1, 'exactly one voucher is soft-deleted', 'found ' || v_n);

  perform pg_temp.expect(
    exists (select 1 from public.ledgers where company_id = v_co and is_active = false),
    'an inactive ledger exists');

  select count(*) into v_n from public.invoice_lines where company_id = v_co;
  perform pg_temp.expect(v_n = 48, 'forty-eight invoice lines were written', 'found ' || v_n);

  -- Four levels on the Indirect Expenses branch, three on three others.
  select count(*) into v_n
    from public.account_groups g
    join public.account_groups p on p.id = g.parent_group_id
   where g.company_id = v_co and p.parent_group_id is not null;
  perform pg_temp.expect(v_n >= 1, 'the group tree goes at least three levels deep', 'found ' || v_n || ' third-level groups');

  perform pg_temp.expect(
    (select max(length(name)) from public.ledgers where company_id = v_co) >= 60,
    'a party carries a genuinely long name');
end;
$$;

\echo ''
\echo '1. The opening Trial Balance tallies'

do $$
declare
  v_co uuid := (select co from t);
  v_dr numeric(18,2); v_cr numeric(18,2);
  v_tb_dr numeric(18,2); v_tb_cr numeric(18,2);
begin
  -- Straight off the ledgers table, before any report is involved.
  select coalesce(sum(opening_balance_amount) filter (where opening_balance_type = 'debit'), 0),
         coalesce(sum(opening_balance_amount) filter (where opening_balance_type = 'credit'), 0)
    into v_dr, v_cr
    from public.ledgers where company_id = v_co;

  perform pg_temp.expect(v_dr = 1179500.00, 'opening debits are 11,79,500.00', pg_temp.money(1179500.00, v_dr));
  perform pg_temp.expect(v_cr = 1179500.00, 'opening credits are 11,79,500.00', pg_temp.money(1179500.00, v_cr));
  perform pg_temp.expect(v_dr = v_cr, 'the opening balances tally exactly', pg_temp.money(v_dr, v_cr));

  -- And the Trial Balance as at the day before the books open must report
  -- exactly those figures and nothing else.
  select coalesce(sum(debit_balance), 0), coalesce(sum(credit_balance), 0)
    into v_tb_dr, v_tb_cr
    from public.get_trial_balance(v_co, date '2025-03-31');

  perform pg_temp.expect(v_tb_dr = v_dr,
    'the Trial Balance at 31 Mar 2025 shows the opening debits', pg_temp.money(v_dr, v_tb_dr));
  perform pg_temp.expect(v_tb_cr = v_cr,
    'the Trial Balance at 31 Mar 2025 shows the opening credits', pg_temp.money(v_cr, v_tb_cr));
end;
$$;

\echo ''
\echo '2. The closing Trial Balance tallies, and every line of it is right'

do $$
declare
  v_co uuid := (select co from t);
  v_asof date := (select asof from t);
  v_dr numeric(18,2); v_cr numeric(18,2);
  v_bad int; v_row record; v_detail text;
begin
  select coalesce(sum(debit_balance), 0), coalesce(sum(credit_balance), 0)
    into v_dr, v_cr from public.get_trial_balance(v_co, v_asof);

  perform pg_temp.expect(v_dr = v_cr,
    'total debit equals total credit, exactly', pg_temp.money(v_dr, v_cr));
  perform pg_temp.expect(v_dr = 2524773.36,
    'and the total is the 25,24,773.36 worked out by hand', pg_temp.money(2524773.36, v_dr));

  -- Every line, against the hand-computed list.
  v_bad := 0;
  for v_row in
    select coalesce(tb.ledger_name, h.ledger_name) as nm,
           h.signed as expected,
           (coalesce(tb.debit_balance,0) - coalesce(tb.credit_balance,0))::numeric(18,2) as actual,
           tb.ledger_name is null as missing
      from hand_trial_balance h
      full join public.get_trial_balance(v_co, v_asof) tb on tb.ledger_name = h.ledger_name
  loop
    if v_row.missing then
      v_bad := v_bad + 1;
      raise warning '        %: absent from the Trial Balance, expected %', v_row.nm, v_row.expected;
    elsif v_row.expected is null then
      v_bad := v_bad + 1;
      raise warning '        %: on the Trial Balance at %, not expected at all', v_row.nm, v_row.actual;
    elsif v_row.expected <> v_row.actual then
      v_bad := v_bad + 1;
      raise warning '        %: %', v_row.nm, pg_temp.money(v_row.expected, v_row.actual);
    end if;
  end loop;
  perform pg_temp.expect(v_bad = 0,
    'all 31 ledgers report the balance worked out by hand', v_bad || ' disagreed');

  -- The three ledgers the migrations exist for.
  perform pg_temp.expect(
    (select credit_balance from public.get_trial_balance(v_co, v_asof)
      where ledger_name = 'ICICI Bank — Cash Credit A/c 0088') = 183240.00,
    'the overdrawn bank account reports a CREDIT balance of 1,83,240.00');

  perform pg_temp.expect(
    (select debit_balance from public.get_trial_balance(v_co, v_asof)
      where ledger_name = 'Old Cash Counter — Andheri shop (closed)') = 12000.00,
    'the inactive ledger still reaches the Trial Balance with its 12,000.00');

  perform pg_temp.expect(
    (select count(*) from public.get_trial_balance(v_co, v_asof)
      where ledger_name = 'Konkan Roadways (transport)') = 1,
    'a party settled to nil is still listed, at nil');
end;
$$;

\echo ''
\echo '3. The Balance Sheet balances'

do $$
declare
  v_co uuid := (select co from t);
  v_asof date := (select asof from t);
  v_assets numeric(18,2); v_liab numeric(18,2);
  v_exp_assets numeric(18,2); v_exp_liab numeric(18,2);
  v_profit numeric(18,2);
  v_bad int; v_row record;
begin
  select coalesce(sum(amount) filter (where side = 'asset'), 0),
         coalesce(sum(amount) filter (where side = 'liability'), 0)
    into v_assets, v_liab
    from public.get_balance_sheet(v_co, v_asof);

  perform pg_temp.expect(v_assets = v_liab,
    'assets equal liabilities, exactly', pg_temp.money(v_assets, v_liab));

  -- Independently: a balance-sheet ledger sitting in debit is an asset at its
  -- magnitude, one sitting in credit is a liability at its magnitude, and the
  -- period result closes the gap. Nothing here consults get_balance_sheet.
  select coalesce(sum(-signed) filter (where signed < 0), 0)
    into v_exp_liab
    from expected_balance
   where nature in ('current_asset','current_liability','fixed_asset','capital');

  select coalesce(sum(signed) filter (where signed > 0), 0)
    into v_exp_assets
    from expected_balance
   where nature in ('current_asset','current_liability','fixed_asset','capital');

  select coalesce(sum(ve.credit_amount - ve.debit_amount), 0) into v_profit
    from public.voucher_entries ve
    join public.vouchers v on v.id = ve.voucher_id
    join public.ledgers l on l.id = ve.ledger_id
    join public.account_groups g on g.id = l.group_id
   where v.company_id = v_co and v.is_deleted = false
     and v.voucher_date between (select bb from t) and v_asof
     and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense');

  if v_profit >= 0 then v_exp_liab := v_exp_liab + v_profit;
  else v_exp_assets := v_exp_assets + abs(v_profit); end if;

  perform pg_temp.expect(v_assets = v_exp_assets,
    'the asset side is the 17,69,261.66 the source amounts imply', pg_temp.money(v_exp_assets, v_assets));
  perform pg_temp.expect(v_liab = v_exp_liab,
    'the liability side is too', pg_temp.money(v_exp_liab, v_liab));
  perform pg_temp.expect(v_assets = 1769261.66,
    'and it is the figure worked out by hand', pg_temp.money(1769261.66, v_assets));

  -- Every line, against the independently computed balance.
  v_bad := 0;
  for v_row in
    select bs.ledger_name, bs.side, bs.amount, eb.signed
      from public.get_balance_sheet(v_co, v_asof) bs
      join expected_balance eb on eb.ledger_id = bs.ledger_id
  loop
    if v_row.amount <> abs(v_row.signed)
       or v_row.side <> (case when v_row.signed > 0 then 'asset' else 'liability' end) then
      v_bad := v_bad + 1;
      raise warning '        %: side %, amount % against a signed balance of %',
        v_row.ledger_name, v_row.side, v_row.amount, v_row.signed;
    end if;
  end loop;
  perform pg_temp.expect(v_bad = 0,
    'every Balance Sheet line is on the side its balance puts it, at its magnitude', v_bad || ' disagreed');

  -- 0012's case, stated plainly: an asset-nature ledger in credit is a
  -- liability on the sheet, not a negative asset.
  perform pg_temp.expect(
    (select side from public.get_balance_sheet(v_co, v_asof)
      where ledger_name = 'ICICI Bank — Cash Credit A/c 0088') = 'liability',
    'the overdrawn bank account is shown as a liability, not an asset');

  perform pg_temp.expect(
    (select side from public.get_balance_sheet(v_co, v_asof)
      where ledger_name = 'Anand Enterprises') = 'liability',
    'the customer sitting in credit is shown as a liability');

  perform pg_temp.expect(
    (select side from public.get_balance_sheet(v_co, v_asof)
      where ledger_name = 'Modern Packaging Supplies') = 'asset',
    'the supplier sitting in debit is shown as an asset');

  perform pg_temp.expect(
    (select count(*) from public.get_balance_sheet(v_co, v_asof)
      where ledger_name = 'Old Cash Counter — Andheri shop (closed)') = 1,
    'the inactive ledger holding 12,000.00 reaches the Balance Sheet');
end;
$$;

\echo ''
\echo '4. The P&L agrees with the Balance Sheet'

do $$
declare
  v_co uuid := (select co from t);
  v_asof date := (select asof from t);
  v_bb date := (select bb from t);
  v_source numeric(18,2);
  v_bs_line numeric(18,2);
  v_bs_side text;
  v_pl_net numeric(18,2);
  v_gross numeric(18,2);
  v_di numeric(18,2); v_de numeric(18,2); v_ii numeric(18,2); v_ie numeric(18,2);
begin
  -- The independent figure: total income less total expense, straight off the
  -- entries. Income contributes +(credit-debit); expense contributes
  -- -(debit-credit), the same expression — so one uniform sum is correct.
  select coalesce(sum(ve.credit_amount - ve.debit_amount), 0) into v_source
    from public.voucher_entries ve
    join public.vouchers v on v.id = ve.voucher_id
    join public.ledgers l on l.id = ve.ledger_id
    join public.account_groups g on g.id = l.group_id
   where v.company_id = v_co and v.is_deleted = false
     and v.voucher_date between v_bb and v_asof
     and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense');

  perform pg_temp.expect(v_source = 260179.71,
    'the source amounts give a net profit of 2,60,179.71', pg_temp.money(260179.71, v_source));

  select amount, side into v_bs_line, v_bs_side
    from public.get_balance_sheet(v_co, v_asof) where ledger_id is null;

  perform pg_temp.expect(v_bs_line = abs(v_source),
    'the Balance Sheet''s Net Profit line is that same figure', pg_temp.money(abs(v_source), v_bs_line));
  perform pg_temp.expect(v_bs_side = case when v_source >= 0 then 'liability' else 'asset' end,
    'and it is on the side a profit belongs on');

  -- What the P&L screen adds up: Gross Profit = direct income - direct
  -- expense; Net Profit = Gross Profit + indirect income - indirect expense.
  select coalesce(sum(amount) filter (where nature = 'direct_income'), 0),
         coalesce(sum(amount) filter (where nature = 'direct_expense'), 0),
         coalesce(sum(amount) filter (where nature = 'indirect_income'), 0),
         coalesce(sum(amount) filter (where nature = 'indirect_expense'), 0)
    into v_di, v_de, v_ii, v_ie
    from public.get_profit_and_loss(v_co, v_bb, v_asof);

  v_gross := v_di - v_de;
  v_pl_net := v_gross + v_ii - v_ie;

  perform pg_temp.expect(v_gross = 691919.71,
    'the P&L''s Gross Profit is 6,91,919.71', pg_temp.money(691919.71, v_gross));
  perform pg_temp.expect(v_pl_net = v_source,
    'the P&L''s Net Profit equals the source amounts', pg_temp.money(v_source, v_pl_net));
  perform pg_temp.expect(v_pl_net = v_bs_line * case when v_bs_side = 'liability' then 1 else -1 end,
    'the P&L''s Net Profit equals the Balance Sheet''s Net Profit line', pg_temp.money(v_bs_line, v_pl_net));

  -- Each P&L line against the independent balance for that ledger. The
  -- function reports abs(), so a ledger whose net movement runs against its
  -- group's normal balance would be reported positive; asserting the
  -- magnitude AND the count catches a line that flipped.
  perform pg_temp.expect(
    (select count(*) from public.get_profit_and_loss(v_co, v_bb, v_asof) pl
      join expected_balance eb on eb.ledger_id = pl.ledger_id
      where pl.amount <> abs(eb.signed)) = 0,
    'every P&L line is the magnitude of that ledger''s own balance');

  perform pg_temp.expect(
    (select count(*) from public.get_profit_and_loss(v_co, v_bb, v_asof)) =
    (select count(*) from expected_balance
      where nature in ('direct_income','direct_expense','indirect_income','indirect_expense')
        and signed <> 0),
    'the P&L lists every income and expense ledger that moved, and no other');
end;
$$;

\echo ''
\echo '5. Every voucher balances'

do $$
declare
  v_co uuid := (select co from t);
  v_bad int;
begin
  select count(*) into v_bad
    from public.vouchers v
    join lateral (
      select coalesce(sum(debit_amount), 0) dr, coalesce(sum(credit_amount), 0) cr, count(*) n
      from public.voucher_entries ve where ve.voucher_id = v.id
    ) s on true
   where v.company_id = v_co and (s.dr <> s.cr or s.n < 2);
  perform pg_temp.expect(v_bad = 0,
    'every voucher — deleted one included — sums debit = credit over at least two lines',
    v_bad || ' did not');

  select count(*) into v_bad
    from public.vouchers v
    join lateral (select coalesce(sum(debit_amount), 0) dr from public.voucher_entries ve where ve.voucher_id = v.id) s on true
   where v.company_id = v_co and v.total_amount <> s.dr;
  perform pg_temp.expect(v_bad = 0,
    'and vouchers.total_amount is that same sum', v_bad || ' did not');

  -- The Daybook is the voucher list; its total_amount column must be the same
  -- number, for every voucher in the year.
  select count(*) into v_bad
    from public.get_daybook(v_co, (select bb from t), (select asof from t)) d
    join lateral (select coalesce(sum(debit_amount), 0) dr from public.voucher_entries ve where ve.voucher_id = d.voucher_id) s on true
   where d.total_amount <> s.dr;
  perform pg_temp.expect(v_bad = 0, 'the Daybook reports each voucher at that same total', v_bad || ' did not');

  perform pg_temp.expect(
    (select count(*) from public.get_daybook(v_co, (select bb from t), (select asof from t))) = 53,
    'the Daybook lists 53 vouchers for the year');
end;
$$;

\echo ''
\echo '6. Invoice integrity, to the paise'

do $$
declare
  v_co uuid := (select co from t);
  v_row record;
  v_bad int := 0;
  v_n int := 0;
begin
  for v_row in
    select
      v.id, v.voucher_number, v.voucher_type, v.voucher_date, v.total_amount, v.party_ledger_id,
      -- Recomputed from quantity, rate and discount. line_amount is NOT read:
      -- it is the generated column being checked.
      (select sum(round(il.quantity * il.rate, 2) - il.discount_amount)
         from public.invoice_lines il where il.voucher_id = v.id)::numeric(18,2) as by_hand,
      (select sum(il.line_amount)
         from public.invoice_lines il where il.voucher_id = v.id)::numeric(18,2) as stored,
      (select coalesce(sum(ve.debit_amount), 0) from public.voucher_entries ve where ve.voucher_id = v.id)::numeric(18,2) as posted_dr,
      (select coalesce(sum(ve.credit_amount), 0) from public.voucher_entries ve where ve.voucher_id = v.id)::numeric(18,2) as posted_cr,
      (select coalesce(sum(ve.debit_amount + ve.credit_amount), 0) from public.voucher_entries ve
         where ve.voucher_id = v.id and ve.ledger_id = v.party_ledger_id)::numeric(18,2) as party_leg,
      (select count(distinct il.revenue_ledger_id) from public.invoice_lines il where il.voucher_id = v.id) as distinct_ledgers,
      (select count(*) from public.voucher_entries ve where ve.voucher_id = v.id) as entries
    from public.vouchers v
   where v.company_id = v_co and v.is_deleted = false
     and exists (select 1 from public.invoice_lines il where il.voucher_id = v.id)
   order by v.voucher_date, v.voucher_number
  loop
    v_n := v_n + 1;
    if v_row.by_hand <> v_row.stored then
      v_bad := v_bad + 1;
      raise warning '        % line_amount: %', v_row.voucher_number, pg_temp.money(v_row.by_hand, v_row.stored);
    end if;
    if v_row.by_hand <> v_row.total_amount then
      v_bad := v_bad + 1;
      raise warning '        % total_amount: %', v_row.voucher_number, pg_temp.money(v_row.by_hand, v_row.total_amount);
    end if;
    if v_row.by_hand <> v_row.posted_dr or v_row.by_hand <> v_row.posted_cr then
      v_bad := v_bad + 1;
      raise warning '        % postings: dr %, cr %, expected % each',
        v_row.voucher_number, v_row.posted_dr, v_row.posted_cr, v_row.by_hand;
    end if;
    if v_row.party_leg <> v_row.by_hand then
      v_bad := v_bad + 1;
      raise warning '        % party leg: %', v_row.voucher_number, pg_temp.money(v_row.by_hand, v_row.party_leg);
    end if;
    -- One party leg plus one entry per distinct revenue ledger: the grouping.
    if v_row.entries <> v_row.distinct_ledgers + 1 then
      v_bad := v_bad + 1;
      raise warning '        % grouping: % entries for % distinct revenue ledgers plus a party',
        v_row.voucher_number, v_row.entries, v_row.distinct_ledgers;
    end if;
  end loop;

  perform pg_temp.expect(v_n = 16, 'sixteen invoices carry lines — ten sales, six purchase', 'found ' || v_n);
  perform pg_temp.expect(v_bad = 0,
    'for every invoice, hand-computed lines = total_amount = postings, and the postings are grouped',
    v_bad || ' disagreements');

  -- An invoice with three lines to one ledger and one to another must post
  -- three entries, not four.
  perform pg_temp.expect(
    (select count(*) from public.voucher_entries ve
      join public.vouchers v on v.id = ve.voucher_id
     where v.company_id = v_co and v.voucher_date = date '2025-04-01' and v.voucher_type = 'sales') = 3,
    'the 1 Apr invoice''s two same-ledger lines post as ONE credit, not two');
end;
$$;

\echo ''
\echo '6b. The two rounding cases'

do $$
declare
  v_co uuid := (select co from t);
  v_id uuid;
  v_hand numeric(18,2); v_naive numeric(18,2); v_total numeric(18,2); v_cr numeric(18,2);
begin
  -- 14 Jun 2025: three lines of 1 x 33.3330. Each stores 33.33.
  select v.id, v.total_amount into v_id, v_total
    from public.vouchers v
   where v.company_id = v_co and v.voucher_date = date '2025-06-14' and v.voucher_type = 'sales';

  select sum(round(quantity * rate, 2) - discount_amount),                  -- per line, then summed
         round(sum(quantity * rate), 2) - sum(discount_amount)              -- summed, then rounded once
    into v_hand, v_naive
    from public.invoice_lines where voucher_id = v_id;

  select coalesce(sum(credit_amount), 0) into v_cr
    from public.voucher_entries where voucher_id = v_id;

  perform pg_temp.expect(v_hand = 1391.99,
    'three lines of 1 x 33.3330 settle at 33.33 each, so the invoice is 1,391.99', pg_temp.money(1391.99, v_hand));
  perform pg_temp.expect(v_naive = 1392.00,
    'rounding the sum instead of the lines would give 1,392.00 — so this case is not vacuous', pg_temp.money(1392.00, v_naive));
  perform pg_temp.expect(v_total = 1391.99,
    'and the voucher was posted for 1,391.99, not 1,392.00', pg_temp.money(1391.99, v_total));
  perform pg_temp.expect(v_cr = 1391.99,
    'the grouped credit is 1,391.99, so the party is not debited a paisa more than the goods',
    pg_temp.money(1391.99, v_cr));

  -- 27 Jan 2026: three lines of 3 x 33.3330 = 99.9990, which round UP.
  select v.id, v.total_amount into v_id, v_total
    from public.vouchers v
   where v.company_id = v_co and v.voucher_date = date '2026-01-27' and v.voucher_type = 'sales';

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines
      where voucher_id = v_id and round(quantity * rate, 2) - discount_amount = 100.00
        and quantity = 3 and rate = 33.3330) = 3,
    'three lines of 3 x 33.3330 each round UP to 100.00, the other half of round()');
  perform pg_temp.expect(v_total = 4270.00,
    'and that invoice totals 4,270.00', pg_temp.money(4270.00, v_total));

  -- Fractional quantities against four-decimal rates, which is where the
  -- generated column earns its keep.
  perform pg_temp.expect(
    (select count(*) from public.invoice_lines il
      join public.vouchers v on v.id = il.voucher_id
     where v.company_id = v_co
       and il.quantity <> trunc(il.quantity)
       and il.quantity * il.rate <> round(il.quantity * il.rate, 2)) >= 6,
    'at least six lines carry a fractional quantity whose extension is off a whole paisa');
end;
$$;

\echo ''
\echo '7. The Ledger Statement agrees with the Trial Balance'

do $$
declare
  v_co uuid := (select co from t);
  v_asof date := (select asof from t);
  v_bb date := (select bb from t);
  v_row record;
  v_closing numeric(18,2);
  v_opening numeric(18,2);
  v_bad int := 0; v_n int := 0;
begin
  -- Every ledger, not a sample: 31 of them is cheap and a sample is where a
  -- one-ledger bug hides.
  for v_row in select ledger_id, ledger_name, signed from expected_balance order by ledger_name loop
    v_n := v_n + 1;

    -- The last row of the statement, taken the way the screen takes it: the
    -- final running balance in the order the function returns.
    select running_balance into v_closing from (
      select running_balance, row_number() over () as rn
        from public.get_ledger_statement(v_co, v_row.ledger_id, v_bb, v_asof)
    ) s order by rn desc limit 1;

    select running_balance into v_opening from (
      select running_balance, row_number() over () as rn
        from public.get_ledger_statement(v_co, v_row.ledger_id, v_bb, v_asof)
    ) s order by rn limit 1;

    if v_closing is distinct from v_row.signed then
      v_bad := v_bad + 1;
      raise warning '        %: closing running balance %', v_row.ledger_name, pg_temp.money(v_row.signed, v_closing);
    end if;

    if v_opening is distinct from
       (select coalesce(opening_balance_amount, 0) * case when opening_balance_type = 'debit' then 1 else -1 end
          from public.ledgers where id = v_row.ledger_id) then
      v_bad := v_bad + 1;
      raise warning '        %: opening row does not match the ledger''s opening balance', v_row.ledger_name;
    end if;
  end loop;

  perform pg_temp.expect(v_n = 31, 'all 31 ledgers were checked', 'checked ' || v_n);
  perform pg_temp.expect(v_bad = 0,
    'each statement''s closing running balance is that ledger''s Trial Balance figure', v_bad || ' disagreed');

  -- And the running balance is genuinely running: the sum of the movements it
  -- lists equals the change from its opening row to its closing one.
  perform pg_temp.expect(
    (select coalesce(sum(debit_amount - credit_amount), 0)
       from public.get_ledger_statement(v_co,
              (select ledger_id from expected_balance where ledger_name = 'HDFC Bank — Current A/c 50210'),
              v_bb, v_asof))
    = 565200.00 - 320000.00,
    'the movements listed on the HDFC statement account for the whole change in the year');
end;
$$;

\echo ''
\echo '8. Outstanding agrees with the Trial Balance'

do $$
declare
  v_co uuid := (select co from t);
  v_recv numeric(18,2); v_pay numeric(18,2);
  v_exp_recv numeric(18,2); v_exp_pay numeric(18,2);
  v_bad int;
begin
  select coalesce(sum(amount) filter (where direction = 'receivable'), 0),
         coalesce(sum(amount) filter (where direction = 'payable'), 0)
    into v_recv, v_pay
    from public.get_outstanding_balances(v_co);

  -- Independently, from the balances: a party in debit is a receivable at its
  -- magnitude, a party in credit is a payable at its magnitude.
  select coalesce(sum(signed) filter (where signed > 0), 0),
         coalesce(sum(-signed) filter (where signed < 0), 0)
    into v_exp_recv, v_exp_pay
    from expected_balance where ledger_role in ('debtor','creditor');

  perform pg_temp.expect(v_recv = v_exp_recv,
    'receivables reconcile with the debit balances on party ledgers', pg_temp.money(v_exp_recv, v_recv));
  perform pg_temp.expect(v_pay = v_exp_pay,
    'payables reconcile with the credit balances on party ledgers', pg_temp.money(v_exp_pay, v_pay));
  perform pg_temp.expect(v_recv = 628349.67,
    'receivables come to 6,28,349.67', pg_temp.money(628349.67, v_recv));
  perform pg_temp.expect(v_pay = 301341.95,
    'payables come to 3,01,341.95', pg_temp.money(301341.95, v_pay));

  -- And row by row.
  select count(*) into v_bad
    from public.get_outstanding_balances(v_co) o
    join expected_balance eb on eb.ledger_id = o.ledger_id
   where o.amount <> abs(eb.signed)
      or o.direction <> case when eb.signed > 0 then 'receivable' else 'payable' end;
  perform pg_temp.expect(v_bad = 0,
    'every outstanding row is the magnitude and the direction of that ledger''s balance', v_bad || ' disagreed');

  perform pg_temp.expect(
    (select count(*) from public.get_outstanding_balances(v_co)) =
    (select count(*) from expected_balance where ledger_role in ('debtor','creditor') and signed <> 0),
    'the list names every party carrying a balance and no other');

  -- The two cases 0025 has to get from the sign rather than from the role.
  perform pg_temp.expect(
    (select direction || '/' || party_kind from public.get_outstanding_balances(v_co)
      where ledger_name = 'Anand Enterprises') = 'payable/customer',
    'the customer in credit is a payable, still described as a customer');

  perform pg_temp.expect(
    (select direction || '/' || party_kind from public.get_outstanding_balances(v_co)
      where ledger_name = 'Modern Packaging Supplies') = 'receivable/supplier',
    'the supplier in debit is a receivable, still described as a supplier');

  perform pg_temp.expect(
    not exists (select 1 from public.get_outstanding_balances(v_co)
                 where ledger_name = 'Konkan Roadways (transport)'),
    'the party settled to exactly nil is absent');

  perform pg_temp.expect(
    (select last_transaction_date from public.get_outstanding_balances(v_co)
      where ledger_name = 'Anand Enterprises') = date '2025-08-14',
    'and the last transaction date is the latest voucher touching the party');
end;
$$;

\echo ''
\echo '9. The dashboard agrees'

do $$
declare
  v_co uuid := (select co from t);
  v_asof date := (select asof from t);
  v_cash numeric(18,2); v_bank numeric(18,2);
  v_in numeric(18,2); v_out numeric(18,2);
  v_exp_total numeric(18,2); v_exp_cash numeric(18,2); v_exp_bank numeric(18,2);
  v_exp_in numeric(18,2); v_exp_out numeric(18,2);
begin
  select cash_in_hand, bank_balance, month_inflow, month_outflow
    into v_cash, v_bank, v_in, v_out
    from public.get_dashboard_summary(v_co, v_asof);

  select coalesce(sum(signed), 0) into v_exp_total
    from expected_balance where ledger_role = 'cash_bank';

  perform pg_temp.expect(v_cash + v_bank = v_exp_total,
    'the cash and bank tiles together equal the cash_bank ledgers'' balances',
    pg_temp.money(v_exp_total, v_cash + v_bank));
  perform pg_temp.expect(v_cash + v_bank = 470171.99,
    'and that is 4,70,171.99', pg_temp.money(470171.99, v_cash + v_bank));

  -- THE SPLIT, which is a separate question from the total, and which this
  -- seed expects to FAIL. get_dashboard_summary decides cash from bank with
  --
  --   (g.name ilike '%cash%') as is_cash
  --
  -- so the ICICI ledger, which sits in a group called "Cash Credit Accounts",
  -- is counted as cash in hand. A cash credit account is an overdraft
  -- facility with a bank; "cash credit" is the standard Indian name for it,
  -- so this is not a contrived group name. The consequence is that the cash
  -- tile reads -95,028.01 — a shop that appears to hold negative cash — while
  -- the bank tile reads 5,65,200.00, both wrong by the same 1,83,240.00, and
  -- the total stays right so nothing else notices.
  --
  -- Proof that the group name alone is the cause: rename that group to
  -- "Overdraft Facilities", change nothing else, and the tiles become
  -- 88,211.99 and 3,81,960.00.
  --
  -- Left as a failing assertion deliberately. See the note at the top of this
  -- file about what is a defect and what is an expectation.
  select coalesce(sum(signed) filter (where group_name = 'Cash-in-Hand'), 0),
         coalesce(sum(signed) filter (where group_name <> 'Cash-in-Hand'), 0)
    into v_exp_cash, v_exp_bank
    from expected_balance where ledger_role = 'cash_bank';

  perform pg_temp.expect(v_cash = v_exp_cash,
    'the cash tile is the cash ledgers only (88,211.99)', pg_temp.money(v_exp_cash, v_cash));
  perform pg_temp.expect(v_bank = v_exp_bank,
    'the bank tile is the bank ledgers only (3,81,960.00)', pg_temp.money(v_exp_bank, v_bank));

  -- Gross movement through those ledgers in the as-of month.
  select coalesce(sum(ve.debit_amount), 0), coalesce(sum(ve.credit_amount), 0)
    into v_exp_in, v_exp_out
    from public.voucher_entries ve
    join public.vouchers v on v.id = ve.voucher_id
    join expected_balance eb on eb.ledger_id = ve.ledger_id
   where v.company_id = v_co and v.is_deleted = false
     and eb.ledger_role = 'cash_bank'
     and v.voucher_date between date_trunc('month', v_asof)::date and v_asof;

  perform pg_temp.expect(v_in = v_exp_in, 'the month''s inflow is the gross debits through cash and bank', pg_temp.money(v_exp_in, v_in));
  perform pg_temp.expect(v_out = v_exp_out, 'the month''s outflow is the gross credits', pg_temp.money(v_exp_out, v_out));
end;
$$;

\echo ''
\echo '10. The soft-deleted voucher appears in none of it'

do $$
declare
  v_co uuid := (select co from t);
  v_asof date := (select asof from t);
  v_bb date := (select bb from t);
  v_del uuid;
  v_amt numeric(18,2) := 99999.99;
begin
  select id into v_del from public.vouchers where company_id = v_co and is_deleted = true;

  -- Not vacuous: the voucher really is on the books, balanced, and for the
  -- amount the rest of this section looks for.
  perform pg_temp.expect(
    (select total_amount from public.vouchers where id = v_del) = v_amt,
    'the deleted voucher really exists, for 99,999.99');
  perform pg_temp.expect(
    (select count(*) from public.voucher_entries where voucher_id = v_del) = 2,
    'and its two entries are still in the table, so every filter below is doing work');

  perform pg_temp.expect(
    not exists (select 1 from public.get_daybook(v_co, v_bb, v_asof) where voucher_id = v_del),
    'the Daybook does not list it');

  perform pg_temp.expect(
    (select debit_balance from public.get_trial_balance(v_co, v_asof) where ledger_name = 'Shop Rent') = 216000.00,
    'Shop Rent on the Trial Balance is 2,16,000.00, not 3,15,999.99');

  perform pg_temp.expect(
    (select credit_balance from public.get_trial_balance(v_co, v_asof) where ledger_name = 'Rent Payable') = 180000.00,
    'Rent Payable is 1,80,000.00, not 2,79,999.99');

  perform pg_temp.expect(
    (select amount from public.get_profit_and_loss(v_co, v_bb, v_asof) where ledger_name = 'Shop Rent') = 216000.00,
    'the P&L charges 2,16,000.00 of rent');

  perform pg_temp.expect(
    (select amount from public.get_balance_sheet(v_co, v_asof) where ledger_name = 'Rent Payable') = 180000.00,
    'the Balance Sheet carries 1,80,000.00 of rent payable');

  perform pg_temp.expect(
    (select amount from public.get_balance_sheet(v_co, v_asof) where ledger_id is null) = 260179.71,
    'the Net Profit line is 2,60,179.71, not 1,60,179.72');

  perform pg_temp.expect(
    not exists (select 1 from public.get_ledger_statement(v_co,
                  (select id from public.ledgers where company_id = v_co and name = 'Shop Rent'), v_bb, v_asof)
                 where voucher_id = v_del),
    'the Shop Rent statement does not list it');

  perform pg_temp.expect(
    (select count(*) from public.get_ledger_statement(v_co,
        (select id from public.ledgers where company_id = v_co and name = 'Shop Rent'), v_bb, v_asof)) = 5,
    'that statement has an opening row and four rent charges, not five');

  -- Outstanding and the dashboard are already asserted above against balances
  -- that exclude it; this states the consequence directly.
  perform pg_temp.expect(
    (select amount from public.get_outstanding_balances(v_co) where ledger_name = 'Bharat Pipes & Fittings Pvt Ltd') = 78176.76,
    'Outstanding is unaffected by it');

  perform pg_temp.expect(
    (select cash_in_hand + bank_balance from public.get_dashboard_summary(v_co, v_asof)) = 470171.99,
    'and so are the dashboard tiles');
end;
$$;

\echo ''
\echo '11. A credit note bigger than what it reverses'

-- The one case this file builds a fixture for rather than reading the seed,
-- because putting it in the books would leave a permanently wrong set of
-- accounts for anyone browsing them in the app. It is written and rolled back
-- with everything else, the way guarantees.sql builds its own fixtures.
--
-- The case is ordinary: a delivery charge of 6,750 is recovered from a
-- customer in March, the site is cancelled and 10,000 is credited back
-- (covering an earlier charge too). "Delivery Charges Recovered" — a
-- direct_income ledger — ends the year with a 3,250 DEBIT balance. Nothing
-- exotic: a sales return, a rate revision or a credit note does this to an
-- income ledger, and a supplier rebate does it to an expense one.
--
-- get_profit_and_loss reports abs() of each ledger's movement, and the
-- statement screen adds every direct_income row to income. So 3,250 of
-- REVERSED income is added as 3,250 of income, and the P&L overstates the
-- result by twice that. The Balance Sheet, whose profit figure is one uniform
-- sum(credit - debit) with no abs() and no per-nature branching, gets it
-- right — and the two statements disagree.
--
-- This is 0012's defect one report later: a magnitude reported on the side
-- its group nominally belongs to, rather than on the side its balance
-- actually points. 0012 fixed it on the Balance Sheet and 0017 says
-- get_profit_and_loss "was already right"; it was right about is_active, and
-- this is a different thing.
do $$
declare
  v_co uuid := (select co from t);
  v_asof date := (select asof from t);
  v_bb date := (select bb from t);
  v_signed numeric(18,2);
  v_pl_amount numeric(18,2);
  v_pl_net numeric(18,2);
  v_bs_net numeric(18,2);
  v_source numeric(18,2);
begin
  perform public.create_voucher(v_co, 'journal', '2026-03-20',
    'Delivery charges credited back — Panvel site cancelled', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id',
        (select id from public.ledgers where company_id = v_co and name = 'Delivery Charges Recovered'),
        'debit_amount', 10000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id',
        (select id from public.ledgers where company_id = v_co and name = 'Ganpati Hardware & Sanitary Stores (Kalbadevi), Mumbai 400002'),
        'debit_amount', 0, 'credit_amount', 10000, 'line_order', 1)));

  -- The truth, from the entries: 6,750.00 credited less 10,000.00 debited.
  select coalesce(sum(ve.debit_amount - ve.credit_amount), 0) into v_signed
    from public.voucher_entries ve
    join public.vouchers v on v.id = ve.voucher_id
   where v.company_id = v_co and v.is_deleted = false and v.voucher_date <= v_asof
     and ve.ledger_id = (select id from public.ledgers where company_id = v_co and name = 'Delivery Charges Recovered');

  perform pg_temp.expect(v_signed = 3250.00,
    'the income ledger really is 3,250.00 in DEBIT, so this section is not vacuous',
    pg_temp.money(3250.00, v_signed));

  perform pg_temp.expect(
    (select debit_balance from public.get_trial_balance(v_co, v_asof)
      where ledger_name = 'Delivery Charges Recovered') = 3250.00,
    'and the Trial Balance says so too');

  -- The independent net profit, from the source amounts.
  select coalesce(sum(ve.credit_amount - ve.debit_amount), 0) into v_source
    from public.voucher_entries ve
    join public.vouchers v on v.id = ve.voucher_id
    join public.ledgers l on l.id = ve.ledger_id
    join public.account_groups g on g.id = l.group_id
   where v.company_id = v_co and v.is_deleted = false
     and v.voucher_date between v_bb and v_asof
     and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense');

  perform pg_temp.expect(v_source = 250179.71,
    'the source amounts now give a net profit of 2,50,179.71', pg_temp.money(250179.71, v_source));

  select amount into v_pl_amount from public.get_profit_and_loss(v_co, v_bb, v_asof)
   where ledger_name = 'Delivery Charges Recovered';

  perform pg_temp.expect(v_pl_amount = -3250.00,
    'the P&L reports the reversed income as NEGATIVE income, not as 3,250 of income',
    pg_temp.money(-3250.00, v_pl_amount));

  select coalesce(sum(amount) filter (where nature = 'direct_income'), 0)
       - coalesce(sum(amount) filter (where nature = 'direct_expense'), 0)
       + coalesce(sum(amount) filter (where nature = 'indirect_income'), 0)
       - coalesce(sum(amount) filter (where nature = 'indirect_expense'), 0)
    into v_pl_net
    from public.get_profit_and_loss(v_co, v_bb, v_asof);

  select amount * case when side = 'liability' then 1 else -1 end into v_bs_net
    from public.get_balance_sheet(v_co, v_asof) where ledger_id is null;

  perform pg_temp.expect(v_bs_net = v_source,
    'the Balance Sheet''s profit figure survives the credit note', pg_temp.money(v_source, v_bs_net));
  perform pg_temp.expect(v_pl_net = v_source,
    'the P&L''s implied net profit survives it too', pg_temp.money(v_source, v_pl_net));
  perform pg_temp.expect(v_pl_net = v_bs_net,
    'and the two statements still agree with each other', pg_temp.money(v_bs_net, v_pl_net));
end;
$$;

\echo ''

do $$
declare
  v_fail int;
  v_total int;
  v_list text;
begin
  select count(*) filter (where not ok), count(*) into v_fail, v_total from results;

  if v_fail = 0 then
    raise notice '%', repeat('-', 70);
    raise notice 'ALL % ASSERTIONS HELD', v_total;
    raise notice '%', repeat('-', 70);
    return;
  end if;

  select string_agg('  ' || seq || '. ' || what || coalesce(E'\n      ' || detail, ''), E'\n' order by seq)
    into v_list from results where not ok;

  raise exception E'% of % assertions FAILED:\n%', v_fail, v_total, v_list;
end;
$$;

rollback;
