-- Tests for the guarantees the database makes, not the app.
--
-- These are the rules that must hold even if every line of TypeScript is
-- rewritten: a voucher cannot be unbalanced, a locked period cannot be posted
-- into by an accountant, and one company cannot see another's rows.
--
-- Written as a plain script rather than pgTAP so it runs anywhere psql does,
-- including a Supabase SQL editor. It creates its own fixtures and rolls the
-- whole thing back, so it is safe to run against a database with real data.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/guarantees.sql
--
-- Any failure raises an exception and aborts; a run that reaches the end and
-- prints "ALL GUARANTEES HELD" passed.

\set ON_ERROR_STOP on

begin;

-- `is not true`, not `not ...`: a condition that evaluates to NULL is not a
-- pass. Comparing against a column that turns out to be null — `v_party =
-- v_debtor` where the party was never recorded — yields NULL, and `not NULL`
-- is NULL, which skips the raise and reports `ok` for an assertion that never
-- actually held. Several of the assertions below compare a value the database
-- is supposed to have stored, so a vacuous pass is exactly the failure mode
-- they exist to catch.
create or replace function pg_temp.expect(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if p_condition is not true then
    raise exception 'FAILED: %', p_what;
  end if;
  raise notice '  ok  %', p_what;
end;
$$;

-- Asserts that `p_sql` raises, and that the message mentions `p_expect`.
--
-- Both guards below are written to fail closed, for the same reason
-- pg_temp.expect() above is. `position(x in y) = 0` is NULL rather than false
-- if either operand is NULL — a caller passing a null p_expect, or an sqlerrm
-- that somehow came back empty — and a NULL condition skips the raise and
-- reports `ok` for an assertion that was never checked. Neither is reachable
-- from any call site in this file today; both are one refactor away from being
-- reachable, and the failure mode is a green test that proves nothing.
create or replace function pg_temp.expect_error(p_sql text, p_expect text, p_what text)
returns void language plpgsql as $$
declare
  v_message text;
begin
  begin
    execute p_sql;
    raise exception 'FAILED: % (expected an error, none raised)', p_what;
  exception
    when others then
      v_message := sqlerrm;
      if coalesce(v_message, '') like 'FAILED:%' then
        raise;
      end if;
      if (position(lower(p_expect) in lower(v_message)) > 0) is not true then
        raise exception 'FAILED: % (expected %, got %)', p_what, p_expect, v_message;
      end if;
      raise notice '  ok  % -> %', p_what, v_message;
  end;
end;
$$;

-- ---------------------------------------------------------------- fixtures

do $$
declare
  v_company uuid;
  v_other_company uuid;
  v_cash uuid;
  v_sales uuid;
  v_group uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Test Co', '2025-04-01', 4, 'INR') returning id into v_company;

  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Other Co', '2025-04-01', 4, 'INR') returning id into v_other_company;

  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Cash-in-Hand';

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_group, 'ZZ Cash', 0, 'debit') returning id into v_cash;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_group, 'ZZ Sales', 0, 'credit') returning id into v_sales;

  perform set_config('test.company', v_company::text, false);
  perform set_config('test.other_company', v_other_company::text, false);
  perform set_config('test.cash', v_cash::text, false);
  perform set_config('test.sales', v_sales::text, false);
end;
$$;

-- ------------------------------------------------- 1. double-entry balance

\echo '1. The double-entry guarantee'

do $$
declare
  v_company uuid := current_setting('test.company')::uuid;
  v_cash uuid := current_setting('test.cash')::uuid;
  v_sales uuid := current_setting('test.sales')::uuid;
begin
  -- A balanced voucher is accepted.
  perform pg_temp.expect(
    public.create_voucher(
      v_company, 'receipt', '2026-04-05', 'balanced', null, null,
      jsonb_build_array(
        jsonb_build_object('ledger_id', v_cash,  'debit_amount', 500, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 500, 'line_order', 1)
      )
    ) is not null,
    'a balanced voucher is accepted'
  );

  -- The triggers are DEFERRED, so the violation only surfaces when the
  -- constraint is checked — which is what SET CONSTRAINTS forces here.
  perform pg_temp.expect_error(
    format($q$
      select public.create_voucher(
        %L, 'receipt', '2026-04-05', 'unbalanced', null, null,
        jsonb_build_array(
          jsonb_build_object('ledger_id', %L, 'debit_amount', 500, 'credit_amount', 0, 'line_order', 0),
          jsonb_build_object('ledger_id', %L, 'debit_amount', 0, 'credit_amount', 400, 'line_order', 1)
        )
      );
      set constraints all immediate;
    $q$, v_company, v_cash, v_sales),
    'unbalanced',
    'an unbalanced voucher is rejected'
  );

  perform pg_temp.expect_error(
    format($q$
      select public.create_voucher(
        %L, 'receipt', '2026-04-05', 'single line', null, null,
        jsonb_build_array(
          jsonb_build_object('ledger_id', %L, 'debit_amount', 500, 'credit_amount', 0, 'line_order', 0)
        )
      );
      set constraints all immediate;
    $q$, v_company, v_cash),
    'at least two line items',
    'a single-line voucher is rejected'
  );
end;
$$;

-- ------------------------------------------------------- 2. system groups

\echo '2. System account groups are protected'

do $$
declare
  v_company uuid := current_setting('test.company')::uuid;
  v_system uuid;
begin
  select id into v_system from public.account_groups
  where company_id = v_company and is_system and name = 'Current Assets';

  perform pg_temp.expect_error(
    format('delete from public.account_groups where id = %L', v_system),
    'Cannot delete a system account group',
    'a system group cannot be deleted'
  );

  perform pg_temp.expect_error(
    format($q$update public.account_groups set nature = 'capital' where id = %L$q$, v_system),
    'Cannot change nature, parent, or system flag',
    'a system group cannot be reclassified'
  );
end;
$$;

-- ------------------------------------------------- 3. nature is inherited

\echo '3. A sub-group inherits its parent nature'

do $$
declare
  v_company uuid := current_setting('test.company')::uuid;
  v_parent uuid;
  v_child uuid;
  v_nature text;
begin
  select id into v_parent from public.account_groups
  where company_id = v_company and name = 'Current Liabilities';

  -- Deliberately claims the wrong nature; the trigger must overwrite it.
  insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role)
  values (v_company, v_parent, 'ZZ GST Payable', 'capital', 'credit', 'other')
  returning id into v_child;

  select nature into v_nature from public.account_groups where id = v_child;
  perform pg_temp.expect(v_nature = 'current_liability', 'a child group takes its parent nature, not the one supplied');

  perform pg_temp.expect_error(
    format('update public.account_groups set parent_group_id = %L where id = %L', v_child, v_child),
    'cycle',
    'a group cannot be made its own parent'
  );
end;
$$;

-- ------------------------------------------------------- 4. tenant scoping

\echo '4. Cross-tenant isolation'

do $$
declare
  v_company uuid := current_setting('test.company')::uuid;
  v_other uuid := current_setting('test.other_company')::uuid;
  v_group uuid;
begin
  select id into v_group from public.account_groups where company_id = v_company limit 1;

  -- The composite foreign key on (group_id, company_id) is what stops one
  -- company's ledger from being filed under another company's group.
  perform pg_temp.expect_error(
    format($q$
      insert into public.ledgers (company_id, group_id, name)
      values (%L, %L, 'ZZ Cross Tenant')
    $q$, v_other, v_group),
    'foreign key',
    'a ledger cannot reference another company''s group'
  );

  perform pg_temp.expect(
    (select count(*) from public.ledgers where company_id = v_other) = 0,
    'the second company has no ledgers of its own'
  );
end;
$$;

-- ------------------------------------------------------------ 5. lock date

\echo '5. The lock date'

do $$
declare
  v_company uuid := current_setting('test.company')::uuid;
  v_locked date := '2026-06-30';
begin
  update public.companies set lock_date = v_locked where id = v_company;

  -- RLS is what enforces this, and it is not active for the owner role this
  -- script runs as, so the policy expression is evaluated directly instead.
  perform pg_temp.expect(
    not ('2026-06-15'::date > coalesce((select lock_date from public.companies where id = v_company), '1900-01-01')),
    'a date inside the locked period fails the policy predicate'
  );
  perform pg_temp.expect(
    '2026-07-01'::date > coalesce((select lock_date from public.companies where id = v_company), '1900-01-01'),
    'a date after the lock date passes the policy predicate'
  );
end;
$$;

-- -------------------------------------- 6. inactive ledgers with a balance

\echo '6. A deactivated ledger still appears in the statements'

-- is_active hides a ledger from the *pickers*, never from the *statements*. A
-- balance that exists has to appear somewhere, or the Trial Balance stops
-- tallying and the Balance Sheet's two sides stop agreeing.
--
-- The fixture reaches "inactive and holding a balance" the way a real book
-- does rather than by deactivating a ledger that already holds one: the
-- ledger is deactivated while it is still empty, and is posted to afterwards.
-- Nothing stops a voucher naming an inactive ledger — the picker hides it, a
-- CSV import or a direct API write does not. Reaching the state this way also
-- keeps this section compatible with the deactivation guard in section 7.
--
-- Two fixture rules keep the tally arithmetic honest, and they are the same
-- rules a real book obeys:
--   * the company's opening balances must themselves net to zero
--   * P&L-nature ledgers carry no opening balance, and every voucher is dated
--     on or after book_beginning_date — get_balance_sheet's Net Profit line
--     only counts entries inside that window, so anything outside it would
--     unbalance the sheet for reasons that have nothing to do with is_active.

do $$
declare
  v_company uuid;
  v_group uuid;
  v_open_cash uuid;
  v_open_capital uuid;
  v_bank uuid;
  v_sales uuid;
  v_creditor uuid;
  v_dormant uuid;
  v_spare uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Inactive Co', '2025-04-01', 4, 'INR') returning id into v_company;

  perform app_private.seed_chart_of_accounts(v_company);

  -- Opening balances that net to zero: 5000 Dr of cash against 5000 Cr of
  -- capital.
  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_group, 'ZZ Opening Cash', 5000, 'debit') returning id into v_open_cash;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Capital Account';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_group, 'ZZ Opening Capital', 5000, 'credit') returning id into v_open_capital;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Bank Accounts';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Closed Bank') returning id into v_bank;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Inactive Sales') returning id into v_sales;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Dropped Creditor') returning id into v_creditor;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Dormant Creditor') returning id into v_dormant;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Spare Creditor') returning id into v_spare;

  -- Deactivated while still empty, which is allowed and always will be.
  update public.ledgers set is_active = false
  where id in (v_bank, v_creditor, v_dormant);

  -- ...and posted to afterwards. ZZ Dormant Creditor deliberately is not: an
  -- inactive ledger with a *zero* balance must stay out of the statements.
  perform public.create_voucher(
    v_company, 'receipt', '2026-04-10', 'cash sale banked', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_bank,  'debit_amount', 1200, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 1200, 'line_order', 1)
    )
  );

  perform public.create_voucher(
    v_company, 'receipt', '2026-04-12', 'advance received from a supplier', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_bank,     'debit_amount', 800, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_creditor, 'debit_amount', 0, 'credit_amount', 800, 'line_order', 1)
    )
  );

  perform set_config('test.zz_company', v_company::text, false);
  perform set_config('test.zz_open_cash', v_open_cash::text, false);
  perform set_config('test.zz_bank', v_bank::text, false);
  perform set_config('test.zz_sales', v_sales::text, false);
  perform set_config('test.zz_creditor', v_creditor::text, false);
  perform set_config('test.zz_dormant', v_dormant::text, false);
  perform set_config('test.zz_spare', v_spare::text, false);
end;
$$;

do $$
declare
  v_company uuid := current_setting('test.zz_company')::uuid;
  v_as_of date := '2026-04-30';
  v_debit numeric(18,2);
  v_credit numeric(18,2);
  v_assets numeric(18,2);
  v_liabilities numeric(18,2);
  v_bank_tile numeric(18,2);
begin
  -- Dr 5000 opening cash + 2000 bank = 7000.
  -- Cr 5000 opening capital + 1200 sales + 800 creditor = 7000.
  select coalesce(sum(debit_balance), 0), coalesce(sum(credit_balance), 0)
  into v_debit, v_credit
  from public.get_trial_balance(v_company, v_as_of);

  perform pg_temp.expect(
    v_debit = v_credit,
    format('the Trial Balance tallies when an inactive ledger holds a balance (Dr %s vs Cr %s)', v_debit, v_credit)
  );

  -- Assets 5000 cash + 2000 bank = 7000.
  -- Liabilities 5000 capital + 800 creditor + 1200 net profit = 7000.
  select
    coalesce(sum(amount) filter (where side = 'asset'), 0),
    coalesce(sum(amount) filter (where side = 'liability'), 0)
  into v_assets, v_liabilities
  from public.get_balance_sheet(v_company, v_as_of);

  perform pg_temp.expect(
    v_assets = v_liabilities,
    format('the Balance Sheet''s two sides agree when an inactive ledger holds a balance (assets %s vs liabilities %s)', v_assets, v_liabilities)
  );

  perform pg_temp.expect(
    exists (
      select 1 from public.get_trial_balance(v_company, v_as_of) tb
      where tb.ledger_id = current_setting('test.zz_creditor')::uuid
    ),
    'an inactive ledger holding a balance is listed on the Trial Balance'
  );

  perform pg_temp.expect(
    not exists (
      select 1 from public.get_trial_balance(v_company, v_as_of) tb
      where tb.ledger_id = current_setting('test.zz_dormant')::uuid
    ),
    'an inactive ledger with a zero balance stays off the Trial Balance'
  );

  -- The dashboard reads the same book, so its tiles cannot disagree with the
  -- Trial Balance about what a bank account holds.
  select ds.bank_balance into v_bank_tile
  from public.get_dashboard_summary(v_company, v_as_of) ds;

  perform pg_temp.expect(
    v_bank_tile = 2000,
    format('the dashboard bank tile still counts a deactivated bank account (%s)', v_bank_tile)
  );
end;
$$;

-- ---------------------------------- 7. deactivating a ledger with a balance

\echo '7. A ledger holding a balance cannot be deactivated'

do $$
declare
  v_open_cash uuid := current_setting('test.zz_open_cash')::uuid;
  v_sales uuid := current_setting('test.zz_sales')::uuid;
  v_creditor uuid := current_setting('test.zz_creditor')::uuid;
  v_spare uuid := current_setting('test.zz_spare')::uuid;
begin
  -- An opening balance on its own is enough to block it — there need not be
  -- a single voucher.
  perform pg_temp.expect_error(
    format('update public.ledgers set is_active = false where id = %L', v_open_cash),
    'still holds a balance',
    'a ledger carrying only an opening balance cannot be deactivated'
  );

  -- The message has to name the figure, or the user cannot tell what to clear.
  perform pg_temp.expect_error(
    format('update public.ledgers set is_active = false where id = %L', v_open_cash),
    '5000',
    'the refusal names the balance that has to be cleared'
  );

  -- Posted entries alone are equally enough.
  perform pg_temp.expect_error(
    format('update public.ledgers set is_active = false where id = %L', v_sales),
    'still holds a balance',
    'a ledger carrying only posted entries cannot be deactivated'
  );

  -- The guard is about the balance, not about is_active: a ledger that has
  -- been cleared to zero is still perfectly deactivatable.
  update public.ledgers set is_active = false where id = v_spare;
  perform pg_temp.expect(
    (select not l.is_active from public.ledgers l where l.id = v_spare),
    'a ledger with a zero balance can still be deactivated'
  );

  -- And it only fires on the true -> false transition. A whole-row rewrite
  -- that re-states is_active = false on an already-inactive ledger — which is
  -- the shape restore_company_backup() and revert_company_changes_since() both
  -- use — must not be refused.
  update public.ledgers set is_active = false, notes = 'kept for history'
  where id = v_creditor;
  perform pg_temp.expect(
    (select l.notes from public.ledgers l where l.id = v_creditor) = 'kept for history',
    'an already-inactive ledger holding a balance can still be edited'
  );

  -- Reactivation is never blocked: the rule is one-directional.
  update public.ledgers set is_active = true where id = v_creditor;
  perform pg_temp.expect(
    (select l.is_active from public.ledgers l where l.id = v_creditor),
    'an inactive ledger holding a balance can always be reactivated'
  );
end;
$$;

-- --------------------------------- 8. re-dating a voucher across a year end

\echo '8. A voucher cannot be re-dated into another financial year'

-- A voucher number is minted from the financial year of the date it was
-- created with, and update_voucher() never revisited it. Moving the date
-- across a year boundary left a number describing a series the voucher was no
-- longer in — and left the other year free to mint that same number again.
-- The refusal is the fix; renumbering is not, because the number may already
-- be on paper.
--
-- Two companies, because April is the default and hides this whole class of
-- bug: a guard that hard-coded April would pass every case written against an
-- April company and still be wrong for a July one. The demo seed uses July
-- deliberately, so the July cases here are the ones that matter most — one
-- date change crosses April but not July and must be *allowed*, the other
-- crosses July but not April and must be *refused*. Only a guard that reads
-- the company's own financial_year_start_month gets both right.

do $$
declare
  v_company uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_voucher uuid;
  v_number text;
  v_lines jsonb;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ April FY Co', '2025-04-01', 4, 'INR') returning id into v_company;

  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Apr Cash') returning id into v_cash;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Apr Sales') returning id into v_sales;

  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 900, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 900, 'line_order', 1)
  );

  -- April start: month 4 >= 4, so 2026-04-05 is the first month of 2026-27.
  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-05', 'issued in 2026-27', null, null, v_lines
  );

  select voucher_number into v_number from public.vouchers where id = v_voucher;
  perform pg_temp.expect(
    v_number = 'SAL/2026-27/00001',
    format('the number is minted from the voucher''s own financial year (%s)', v_number)
  );

  -- 2026-03-31 is the last day of 2025-26. Crossing back is refused, and the
  -- message has to name both years or the user cannot tell what happened.
  perform pg_temp.expect_error(
    format($q$select public.update_voucher(%L, '2026-03-31', 'dragged back a year', null, null, %L::jsonb)$q$,
           v_voucher, v_lines::text),
    '2026-27',
    'a re-date across the year end is refused, naming the year the number came from'
  );

  perform pg_temp.expect_error(
    format($q$select public.update_voucher(%L, '2026-03-31', 'dragged back a year', null, null, %L::jsonb)$q$,
           v_voucher, v_lines::text),
    '2025-26',
    'the refusal also names the year the date was being moved into'
  );

  perform pg_temp.expect_error(
    format($q$select public.update_voucher(%L, '2026-03-31', 'dragged back a year', null, null, %L::jsonb)$q$,
           v_voucher, v_lines::text),
    'Delete this voucher and re-enter it',
    'the refusal says what to do instead'
  );

  -- The guard sits ahead of every write, so a refused edit leaves the header
  -- untouched *and* the line set unreplaced — not a voucher stripped of its
  -- lines by an edit that then changed its mind.
  perform pg_temp.expect(
    (select v.voucher_date from public.vouchers v where v.id = v_voucher) = '2026-04-05'::date
    and (select v.financial_year_label from public.vouchers v where v.id = v_voucher) = '2026-27'
    and (select v.voucher_number from public.vouchers v where v.id = v_voucher) = v_number,
    'the refused re-date left the date, the year label and the number as they were'
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e where e.voucher_id = v_voucher) = 2,
    'the refused re-date left the voucher''s lines in place'
  );

  -- 2027-03-31 is a different calendar year but the *same* financial year, so
  -- the ordinary correction still works.
  perform public.update_voucher(v_voucher, '2027-03-31', 'moved within the year', null, null, v_lines);

  perform pg_temp.expect(
    (select v.voucher_date from public.vouchers v where v.id = v_voucher) = '2027-03-31'::date,
    'a date change inside the same financial year still succeeds'
  );

  perform pg_temp.expect(
    (select v.voucher_number from public.vouchers v where v.id = v_voucher) = v_number,
    'a same-year date change leaves the number alone'
  );
end;
$$;

do $$
declare
  v_company uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_early uuid;
  v_late uuid;
  v_number text;
  v_lines jsonb;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ July FY Co', '2025-07-01', 7, 'INR') returning id into v_company;

  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Jul Cash') returning id into v_cash;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Jul Sales') returning id into v_sales;

  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 700, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 700, 'line_order', 1)
  );

  -- July start: month 6 < 7, so 2026-06-30 is the *last* day of 2025-26, not
  -- of 2026-27 as an April company would have it.
  v_late := public.create_voucher(
    v_company, 'sales', '2026-06-30', 'last day of 2025-26 on a July year', null, null, v_lines
  );

  select voucher_number into v_number from public.vouchers where id = v_late;
  perform pg_temp.expect(
    v_number = 'SAL/2025-26/00001',
    format('a July-year company files 30 June under the year that began the previous July (%s)', v_number)
  );

  -- Crosses July: 2025-26 -> 2026-27. Must be refused. An April-shaped guard
  -- would see 2026-27 on both sides and wave it through.
  perform pg_temp.expect_error(
    format($q$select public.update_voucher(%L, '2026-07-01', 'over the July boundary', null, null, %L::jsonb)$q$,
           v_late, v_lines::text),
    '2026-27',
    'a July-year company refuses a date change that crosses 1 July'
  );

  perform pg_temp.expect(
    (select v.voucher_date from public.vouchers v where v.id = v_late) = '2026-06-30'::date,
    'the refused July-boundary re-date left the voucher where it was'
  );

  -- Crosses April but not July: both dates sit in 2025-26 on this company, so
  -- this must be *allowed*. A guard that hard-coded April would refuse it, and
  -- the user would be unable to correct an ordinary date typo.
  v_early := public.create_voucher(
    v_company, 'sales', '2026-03-31', 'inside 2025-26 on a July year', null, null, v_lines
  );

  perform public.update_voucher(v_early, '2026-04-01', 'over the April boundary, which is nothing here', null, null, v_lines);

  perform pg_temp.expect(
    (select v.voucher_date from public.vouchers v where v.id = v_early) = '2026-04-01'::date,
    'a July-year company allows a date change that crosses 1 April'
  );

  perform pg_temp.expect(
    (select v.financial_year_label from public.vouchers v where v.id = v_early) = '2025-26',
    'and both sides of that change are still the same financial year'
  );
end;
$$;

-- ----------------------------------------------- helpers for sections 9-10

-- Everything above this point runs as the database owner with no JWT, and
-- that is enough, because none of it tests something that asks who you are.
-- The last two sections do: revert_company_changes_since() refuses outright
-- unless auth.uid() is an active admin of the company, accept_company_invite()
-- matches the invite against the caller's own email address, and the ledger
-- delete guard turns on whether the caller is an admin. company_members.user_id
-- and audit_log.changed_by are both foreign keys into auth.users, so a
-- made-up uuid will not do — there has to be a real row.
--
-- Inserting one directly is the only way to get it here: the GoTrue signup API
-- is not reachable from psql, and this project's instance rejects invented
-- test addresses in any case. Nothing that could be signed in with is created
-- — no password is set — and the whole transaction is rolled back at the end
-- of the file like everything else in it.
create or replace function pg_temp.make_user(p_email text)
returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    id, instance_id, aud, role, email, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  )
  values (
    v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    p_email, now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  );
  return v_id;
end;
$$;

-- auth.uid() and auth.jwt() read the request's claims out of a GUC, so
-- becoming a user is a matter of setting it. `true` scopes the setting to
-- this transaction, which is rolled back regardless. Pass null to go back to
-- being nobody.
create or replace function pg_temp.act_as(p_user uuid)
returns void language plpgsql as $$
declare
  v_email text;
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '', true);
    return;
  end if;
  select u.email into v_email from auth.users u where u.id = p_user;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user, 'email', v_email, 'role', 'authenticated')::text,
    true
  );
end;
$$;

-- audit_log.changed_at defaults to now(), and now() is the *transaction's*
-- start time — this whole file is a single transaction, so every audit row the
-- fixtures write carries the same instant and no "undo since T" could ever cut
-- between two of them. The fixtures therefore stamp their own times, spacing
-- the steps apart the way wall-clock time would have in production. Rows
-- already stamped sit in the past and are left alone.
create or replace function pg_temp.stamp_audit(p_company uuid, p_at timestamptz)
returns void language plpgsql as $$
begin
  update public.audit_log set changed_at = p_at
  where company_id = p_company and changed_at >= now();
end;
$$;

-- --------------------------------------- 9. undo rewinds voucher numbering

\echo '9. Undoing voucher creations rewinds the numbering'

-- revert_company_changes_since() rewinds vouchers, voucher_entries, ledgers
-- and account_groups. voucher_number_sequences is not in that list and cannot
-- be — it carries no audit trigger — so undoing a batch of invoices deleted
-- them and left next_number where their creation had pushed it. The series
-- then skipped those numbers permanently, with no way to reissue them through
-- the UI. A numbering series exists to be consecutive; a hole in it is not a
-- cosmetic problem.
--
-- Note the `set constraints all deferred` after each undo. The undo ends with
-- `set constraints all immediate`, and that setting lasts for the rest of the
-- transaction — which in production is the end of the RPC, and here is the
-- rest of this file. Left immediate, the very next create_voucher() would be
-- rejected the moment its header landed, before any line could balance it.

do $$
declare
  v_user uuid;
  v_company uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
  v_mark timestamptz;
  v_voucher uuid;
  v_number text;
begin
  v_user := pg_temp.make_user('zz-undo-admin@hisab.invalid');
  perform pg_temp.act_as(v_user);

  -- Through the real RPC, so the admin membership the undo insists on is the
  -- one the application would actually have created.
  v_company := public.create_company('ZZ Undo All Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Undo Cash') returning id into v_cash;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Undo Sales') returning id into v_sales;

  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 100, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 100, 'line_order', 1)
  );

  -- The company and its ledgers are put an hour in the past, so the undo
  -- below reaches the vouchers and nothing else.
  perform pg_temp.stamp_audit(v_company, now() - interval '60 minutes');
  v_mark := now() - interval '45 minutes';

  perform public.create_voucher(v_company, 'sales', '2026-04-05', 'first', null, null, v_lines);
  perform pg_temp.stamp_audit(v_company, now() - interval '40 minutes');

  perform public.create_voucher(v_company, 'sales', '2026-04-06', 'second', null, null, v_lines);
  perform pg_temp.stamp_audit(v_company, now() - interval '30 minutes');

  perform public.create_voucher(v_company, 'sales', '2026-04-07', 'third', null, null, v_lines);
  perform pg_temp.stamp_audit(v_company, now() - interval '20 minutes');

  perform pg_temp.expect(
    (select count(*) from public.vouchers v where v.company_id = v_company) = 3
    and (select s.next_number from public.voucher_number_sequences s
         where s.company_id = v_company and s.voucher_type = 'sales'
           and s.financial_year_label = '2026-27') = 4,
    'three sales vouchers leave the sequence pointing at the fourth number'
  );

  perform public.revert_company_changes_since(v_company, v_mark);
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.vouchers v where v.company_id = v_company) = 0,
    'the undo removed all three vouchers'
  );

  perform pg_temp.expect(
    (select s.next_number from public.voucher_number_sequences s
     where s.company_id = v_company and s.voucher_type = 'sales'
       and s.financial_year_label = '2026-27') = 1,
    'a series with nothing left in it is rewound to 1'
  );

  -- The assertion that matters: the next invoice is numbered 00001, not
  -- 00004. Before this fix the series began at its fourth number and the
  -- first three could never be issued.
  v_voucher := public.create_voucher(v_company, 'sales', '2026-04-08', 'after the undo', null, null, v_lines);
  select voucher_number into v_number from public.vouchers where id = v_voucher;

  perform pg_temp.expect(
    v_number = 'SAL/2026-27/00001',
    format('the first voucher created after a full undo is numbered 00001 (%s)', v_number)
  );

  perform pg_temp.act_as(null);
end;
$$;

do $$
declare
  v_user uuid;
  v_company uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
  v_voucher uuid;
  v_number text;
begin
  v_user := pg_temp.make_user('zz-undo-partial@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_company := public.create_company('ZZ Undo Tail Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Tail Cash') returning id into v_cash;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Tail Sales') returning id into v_sales;

  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 250, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 250, 'line_order', 1)
  );

  perform pg_temp.stamp_audit(v_company, now() - interval '60 minutes');

  perform public.create_voucher(v_company, 'sales', '2026-04-05', 'kept', null, null, v_lines);
  perform pg_temp.stamp_audit(v_company, now() - interval '40 minutes');

  perform public.create_voucher(v_company, 'sales', '2026-04-06', 'kept', null, null, v_lines);
  perform pg_temp.stamp_audit(v_company, now() - interval '30 minutes');

  perform public.create_voucher(v_company, 'sales', '2026-04-07', 'undone', null, null, v_lines);
  perform pg_temp.stamp_audit(v_company, now() - interval '20 minutes');

  -- Cuts between the second voucher and the third, so only the newest comes
  -- off. The rewind has to land on 3, not on 1 and not on 4 — this is the
  -- case a blanket "reset to 1" would get wrong and reissue numbers that two
  -- surviving vouchers already hold.
  perform public.revert_company_changes_since(v_company, now() - interval '25 minutes');
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.vouchers v where v.company_id = v_company) = 2,
    'an undo of the newest change alone leaves the two earlier vouchers'
  );

  perform pg_temp.expect(
    (select s.next_number from public.voucher_number_sequences s
     where s.company_id = v_company and s.voucher_type = 'sales'
       and s.financial_year_label = '2026-27') = 3,
    'the sequence is rewound to one above the highest surviving number, not to 1'
  );

  v_voucher := public.create_voucher(v_company, 'sales', '2026-04-08', 'reissued', null, null, v_lines);
  select voucher_number into v_number from public.vouchers where id = v_voucher;

  perform pg_temp.expect(
    v_number = 'SAL/2026-27/00003',
    format('the number the undone voucher held is reissued, and only that one (%s)', v_number)
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ------------------------------------------- 10. revoked access stays gone

\echo '10. A revoked member cannot let themselves back in'

-- Revoking a membership left any invite already sent to that person 'pending'
-- and its token live, and accept_company_invite() upserted with
-- `status = 'active'` without asking what the existing membership row said.
-- So the one control an admin has for removing somebody was undone by a link
-- already sitting in that person's inbox — at the invited role, with no admin
-- involved.
--
-- The first block is the positive control: redeeming an invite still has to
-- work, or the two blocks after it would pass for the wrong reason.

do $$
declare
  v_admin uuid;
  v_joiner uuid;
  v_company uuid;
  v_token uuid;
  v_joined uuid;
begin
  v_admin := pg_temp.make_user('zz-invite-admin@hisab.invalid');
  v_joiner := pg_temp.make_user('zz-invite-joiner@hisab.invalid');

  perform pg_temp.act_as(v_admin);
  v_company := public.create_company('ZZ Invite Co', '2025-04-01', 4::smallint, 'INR');

  insert into public.company_invites (company_id, email, role, invited_by)
  values (v_company, 'zz-invite-joiner@hisab.invalid', 'accountant', v_admin)
  returning token into v_token;

  perform pg_temp.act_as(v_joiner);
  v_joined := public.accept_company_invite(v_token);

  perform pg_temp.expect(
    v_joined = v_company
    and (select cm.status from public.company_members cm
         where cm.company_id = v_company and cm.user_id = v_joiner) = 'active'
    and (select cm.role from public.company_members cm
         where cm.company_id = v_company and cm.user_id = v_joiner) = 'accountant',
    'an ordinary invite is still redeemable and still confers the invited role'
  );

  perform pg_temp.act_as(null);
end;
$$;

do $$
declare
  v_admin uuid;
  v_member uuid;
  v_company uuid;
  v_invite uuid;
  v_token uuid;
begin
  v_admin := pg_temp.make_user('zz-revoke-admin@hisab.invalid');
  v_member := pg_temp.make_user('zz-revoke-member@hisab.invalid');

  perform pg_temp.act_as(v_admin);
  v_company := public.create_company('ZZ Revoke Co', '2025-04-01', 4::smallint, 'INR');

  -- A pending invite outstanding at the same time as a live membership: the
  -- admin added them directly and the link they were sent is still good.
  insert into public.company_invites (company_id, email, role, invited_by)
  values (v_company, 'zz-revoke-member@hisab.invalid', 'accountant', v_admin)
  returning id, token into v_invite, v_token;

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_company, v_member, 'accountant', 'active', v_admin);

  perform pg_temp.expect(
    (select i.status from public.company_invites i where i.id = v_invite) = 'pending',
    'the invite is pending before the membership is revoked'
  );

  update public.company_members
  set status = 'revoked'
  where company_id = v_company and user_id = v_member;

  perform pg_temp.expect(
    (select i.status from public.company_invites i where i.id = v_invite) <> 'pending',
    'revoking a membership takes that user''s pending invite down with it'
  );

  -- And the link itself is dead. Before the fix this call succeeded and put
  -- the user back at the invited role.
  perform pg_temp.act_as(v_member);

  perform pg_temp.expect_error(
    format('select public.accept_company_invite(%L)', v_token),
    'no longer pending',
    'a revoked member cannot redeem the invite they were holding'
  );

  perform pg_temp.expect(
    (select cm.status from public.company_members cm
     where cm.company_id = v_company and cm.user_id = v_member) = 'revoked',
    'and the membership is still revoked afterwards'
  );

  perform pg_temp.act_as(null);
end;
$$;

do $$
declare
  v_admin uuid;
  v_member uuid;
  v_company uuid;
  v_token uuid;
begin
  v_admin := pg_temp.make_user('zz-revoke2-admin@hisab.invalid');
  v_member := pg_temp.make_user('zz-revoke2-member@hisab.invalid');

  perform pg_temp.act_as(v_admin);
  v_company := public.create_company('ZZ Revoke Later Co', '2025-04-01', 4::smallint, 'INR');

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_company, v_member, 'accountant', 'active', v_admin);

  update public.company_members
  set status = 'revoked'
  where company_id = v_company and user_id = v_member;

  -- The invite is issued *after* the revocation, so nothing took it down and
  -- it is genuinely pending. This is the half of the fix that lives inside
  -- accept_company_invite(), and it is what stops a stale or duplicated
  -- invite reaching the upsert. It is also the trade-off documented in 0020:
  -- re-inviting a revoked person does not work on its own — an admin has to
  -- restore the membership as well.
  insert into public.company_invites (company_id, email, role, invited_by)
  values (v_company, 'zz-revoke2-member@hisab.invalid', 'admin', v_admin)
  returning token into v_token;

  perform pg_temp.act_as(v_member);

  perform pg_temp.expect_error(
    format('select public.accept_company_invite(%L)', v_token),
    'revoked',
    'a live invite still cannot be redeemed while the membership is revoked'
  );

  perform pg_temp.expect(
    (select cm.status from public.company_members cm
     where cm.company_id = v_company and cm.user_id = v_member) = 'revoked'
    and (select cm.role from public.company_members cm
         where cm.company_id = v_company and cm.user_id = v_member) = 'accountant',
    'the refused redemption did not promote the revoked member to the invited role'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ------------------------- 11. deleting a ledger that carries a balance

\echo '11. An opening balance cannot be changed by deleting the ledger'

-- protect_ledger_financial_fields() makes opening balances admin-only, and it
-- is a BEFORE UPDATE trigger. ledgers_delete admits any accountant and
-- ledgers_insert lets them set whatever opening balance they like, so
-- delete-then-recreate did exactly what the update trigger forbids. Only
-- untransacted ledgers are exposed — the foreign key from voucher_entries
-- refuses to let go of the rest — which is precisely where an opening balance
-- brought forward from the previous books sits.

do $$
declare
  v_admin uuid;
  v_accountant uuid;
  v_company uuid;
  v_group uuid;
  v_with_balance uuid;
  v_at_nil uuid;
  v_second uuid;
begin
  v_admin := pg_temp.make_user('zz-ledger-admin@hisab.invalid');
  v_accountant := pg_temp.make_user('zz-ledger-accountant@hisab.invalid');

  perform pg_temp.act_as(v_admin);
  v_company := public.create_company('ZZ Ledger Delete Co', '2025-04-01', 4::smallint, 'INR');

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_company, v_accountant, 'accountant', 'active', v_admin);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';

  -- Untransacted on purpose: a ledger with entries cannot be deleted by
  -- anybody, so it would prove nothing about who is allowed to.
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_group, 'ZZ Brought Forward', 5000, 'debit') returning id into v_with_balance;

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_group, 'ZZ Brought Forward Too', 5000, 'debit') returning id into v_second;

  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Empty Debtor') returning id into v_at_nil;

  perform pg_temp.act_as(v_accountant);

  perform pg_temp.expect_error(
    format('delete from public.ledgers where id = %L', v_with_balance),
    'Only an admin can delete ledger',
    'an accountant cannot delete a ledger carrying an opening balance'
  );

  -- The message has to name the figure and the side, or the user cannot tell
  -- what an admin is being asked to look at.
  perform pg_temp.expect_error(
    format('delete from public.ledgers where id = %L', v_with_balance),
    '5000.00 Dr',
    'the refusal names the opening balance that put the ledger out of reach'
  );

  perform pg_temp.expect(
    exists (select 1 from public.ledgers l where l.id = v_with_balance),
    'and the ledger is still there afterwards'
  );

  -- Nothing financial is at stake on a ledger sitting at nil, and tidying the
  -- chart of accounts is ordinary bookkeeping work.
  delete from public.ledgers where id = v_at_nil;
  perform pg_temp.expect(
    not exists (select 1 from public.ledgers l where l.id = v_at_nil),
    'an accountant can still delete a ledger with no opening balance'
  );

  -- The rule is about who, not about whether: an admin may delete it, exactly
  -- as an admin may change it under protect_ledger_financial_fields().
  perform pg_temp.act_as(v_admin);

  delete from public.ledgers where id = v_second;
  perform pg_temp.expect(
    not exists (select 1 from public.ledgers l where l.id = v_second),
    'an admin can delete a ledger carrying an opening balance'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ------------------------------------ 12. a sales invoice is double entry

\echo '12. A sales invoice posts as ordinary double entry'

-- The whole architecture of invoicing rests on one claim: an invoice is not a
-- new kind of document, it is a voucher whose lines were written down in more
-- detail. invoice_lines is the source; voucher_entries stays derived, and
-- every report, the daybook, the audit trail and backup/restore keep reading
-- the entries and never learn that invoices exist.
--
-- So the guarantee is that the generator produces *ordinary* double entry:
-- one debit on the party for the whole invoice, and one credit per distinct
-- revenue ledger — grouped, so three lines against one sales ledger are one
-- credit and not three. If this section ever fails, the reports have started
-- disagreeing with the invoice that fed them.

do $$
declare
  v_company uuid;
  v_group uuid;
  v_debtor uuid;
  v_goods uuid;
  v_services uuid;
  v_voucher uuid;
  v_entries int;
  v_line_total numeric(18,2);
  v_total numeric(18,2);
  v_debit numeric(18,2);
  v_credit numeric(18,2);
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Invoice Co', '2025-04-01', 4, 'INR') returning id into v_company;

  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Inv Debtor') returning id into v_debtor;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Inv Goods') returning id into v_goods;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Indirect Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Inv Services') returning id into v_services;

  -- Three lines, two revenue ledgers: 1000.00 + 100.00 of goods and 450.00 of
  -- services (500.00 less a 50.00 discount) = 1550.00.
  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-05', 'three lines, two revenue ledgers', null, null,
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', v_debtor,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Widgets', 'quantity', 10,
                           'unit', 'nos', 'rate', 100, 'discount_amount', 0,
                           'revenue_ledger_id', v_goods),
        jsonb_build_object('line_order', 1, 'description', 'Gadgets', 'quantity', 2.5,
                           'unit', 'kg', 'rate', 40, 'discount_amount', 0,
                           'revenue_ledger_id', v_goods),
        jsonb_build_object('line_order', 2, 'description', 'Installation', 'quantity', 1,
                           'rate', 500, 'discount_amount', 50,
                           'revenue_ledger_id', v_services)
      )
    )
  );

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 3,
    'a three-line invoice stores three invoice lines'
  );

  select count(*) into v_entries from public.voucher_entries e where e.voucher_id = v_voucher;
  perform pg_temp.expect(
    v_entries = 3,
    format('three lines across two revenue ledgers post exactly three entries, not four (%s)', v_entries)
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e
     where e.voucher_id = v_voucher and e.debit_amount > 0) = 1,
    'exactly one debit entry — the party — however many lines the invoice has'
  );

  perform pg_temp.expect(
    (select e.debit_amount from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_debtor) = 1550.00,
    'the party is debited with the whole invoice'
  );

  -- The grouping assertion: two lines hit the goods ledger and they arrive as
  -- one credit of 1100.00.
  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_goods) = 1
    and (select e.credit_amount from public.voucher_entries e
         where e.voucher_id = v_voucher and e.ledger_id = v_goods) = 1100.00,
    'two lines against one revenue ledger are credited once, for their subtotal'
  );

  perform pg_temp.expect(
    (select e.credit_amount from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_services) = 450.00,
    'the other revenue ledger is credited with its own subtotal'
  );

  select coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0)
  into v_debit, v_credit
  from public.voucher_entries where voucher_id = v_voucher;

  perform pg_temp.expect(
    v_debit = v_credit,
    format('the generated entries balance (Dr %s vs Cr %s)', v_debit, v_credit)
  );

  -- total_amount is written by the deferred balance trigger, so it is still
  -- zero until the constraints are forced. Forcing them here is also what
  -- proves the generated entries survive the same check every hand-entered
  -- voucher passes.
  set constraints all immediate;
  set constraints all deferred;

  select coalesce(sum(l.line_amount), 0) into v_line_total
  from public.invoice_lines l where l.voucher_id = v_voucher;
  select v.total_amount into v_total from public.vouchers v where v.id = v_voucher;

  perform pg_temp.expect(
    v_line_total = v_total and v_total = 1550.00,
    format('the invoice lines total exactly what the voucher was posted for (lines %s vs voucher %s)',
           v_line_total, v_total)
  );

  select coalesce(sum(debit_balance), 0), coalesce(sum(credit_balance), 0)
  into v_debit, v_credit
  from public.get_trial_balance(v_company, '2026-04-30');

  perform pg_temp.expect(
    v_debit = v_credit and v_debit = 1550.00,
    format('the Trial Balance tallies over an invoice (Dr %s vs Cr %s)', v_debit, v_credit)
  );

  perform set_config('test.inv_company', v_company::text, false);
  perform set_config('test.inv_debtor', v_debtor::text, false);
  perform set_config('test.inv_goods', v_goods::text, false);
  perform set_config('test.inv_services', v_services::text, false);
  perform set_config('test.inv_voucher', v_voucher::text, false);
end;
$$;

-- The rounding edge. A rate is a unit price and can carry more decimals than
-- money does, so the paise have to be settled once, per line, and never
-- recomputed afterwards. Three lines at 33.333 each round to 33.33 and total
-- 99.99. A generator that grouped the raw quantity x rate instead would credit
-- round(99.999) = 100.00 against a party debited 99.99, and every invoice with
-- an odd rate would leave the books a paisa out.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_voucher uuid;
  v_debit numeric(18,2);
  v_credit numeric(18,2);
begin
  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-06', 'three lines that do not divide evenly', null, null,
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', v_debtor,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Third of a hundred', 'quantity', 1,
                           'rate', 33.333, 'revenue_ledger_id', v_goods),
        jsonb_build_object('line_order', 1, 'description', 'Third of a hundred', 'quantity', 1,
                           'rate', 33.333, 'revenue_ledger_id', v_goods),
        jsonb_build_object('line_order', 2, 'description', 'Third of a hundred', 'quantity', 1,
                           'rate', 33.333, 'revenue_ledger_id', v_goods)
      )
    )
  );

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l
     where l.voucher_id = v_voucher and l.line_amount = 33.33) = 3,
    'a line at 33.333 is settled to 33.33 once, on the line'
  );

  select coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0)
  into v_debit, v_credit
  from public.voucher_entries where voucher_id = v_voucher;

  perform pg_temp.expect(
    v_debit = v_credit and v_debit = 99.99,
    format('three lines at 33.333 tally to the paise (Dr %s vs Cr %s)', v_debit, v_credit)
  );

  perform pg_temp.expect(
    (select coalesce(sum(l.line_amount), 0) from public.invoice_lines l where l.voucher_id = v_voucher) = v_credit,
    'and the grouped credit is the sum of the settled lines, not a re-rounded total'
  );

  set constraints all immediate;
  set constraints all deferred;
end;
$$;

-- An invoice payload is only meaningful on the two voucher types that have a
-- party and a revenue side, and there is one write path, never two: a caller
-- cannot hand-write entries and supply invoice lines at the same time and
-- leave the database to decide which one the books should believe.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_invoice text;
begin
  v_invoice := jsonb_build_object(
    'party_ledger_id', v_debtor,
    'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Widgets', 'quantity', 1,
                         'rate', 100, 'revenue_ledger_id', v_goods)
    )
  )::text;

  perform pg_temp.expect_error(
    format($q$select public.create_voucher(%L, 'journal', '2026-04-07', 'not an invoice', null, null, '[]'::jsonb, %L::jsonb)$q$,
           v_company, v_invoice),
    'only for sales and purchase',
    'a journal voucher cannot carry invoice lines'
  );

  perform pg_temp.expect_error(
    format($q$
      select public.create_voucher(%L, 'sales', '2026-04-07', 'both at once', null, null,
        jsonb_build_array(
          jsonb_build_object('ledger_id', %L, 'debit_amount', 100, 'credit_amount', 0, 'line_order', 0),
          jsonb_build_object('ledger_id', %L, 'debit_amount', 0, 'credit_amount', 100, 'line_order', 1)
        ),
        %L::jsonb)
    $q$, v_company, v_debtor, v_goods, v_invoice),
    'both',
    'a voucher cannot be given hand-written entries and invoice lines at once'
  );

  perform pg_temp.expect_error(
    format($q$select public.create_voucher(%L, 'sales', '2026-04-07', 'no party', null, null, '[]'::jsonb,
             jsonb_build_object('lines', jsonb_build_array(
               jsonb_build_object('description', 'Widgets', 'quantity', 1, 'rate', 100, 'revenue_ledger_id', %L))))$q$,
           v_company, v_goods),
    'party',
    'an invoice without a party ledger is refused'
  );

  perform pg_temp.expect_error(
    format($q$select public.create_voucher(%L, 'sales', '2026-04-07', 'no lines', null, null, '[]'::jsonb,
             jsonb_build_object('party_ledger_id', %L, 'lines', '[]'::jsonb))$q$,
           v_company, v_debtor),
    'at least one',
    'an invoice with no lines at all is refused'
  );
end;
$$;

-- --------------------------------------------- 13. the purchase mirror image

\echo '13. A purchase invoice posts the mirror image'

-- Same generator, opposite sides: the party is credited for the whole bill and
-- each distinct expense ledger is debited with its own grouped subtotal. Worth
-- its own section because a generator that hard-coded the sales direction
-- would pass every assertion in section 12 and still put every purchase in the
-- book backwards.

do $$
declare
  v_company uuid;
  v_group uuid;
  v_creditor uuid;
  v_purchases uuid;
  v_freight uuid;
  v_voucher uuid;
  v_debit numeric(18,2);
  v_credit numeric(18,2);
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Purchase Co', '2025-04-01', 4, 'INR') returning id into v_company;

  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Pur Creditor') returning id into v_creditor;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Pur Purchases') returning id into v_purchases;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Indirect Expenses';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Pur Freight') returning id into v_freight;

  -- 600.00 + 200.00 of stock and 75.00 of freight = 875.00.
  v_voucher := public.create_voucher(
    v_company, 'purchase', '2026-04-05', 'a supplier bill', 'BILL-9', '2026-04-04',
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', v_creditor,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Steel sheet', 'quantity', 6,
                           'unit', 'nos', 'rate', 100, 'revenue_ledger_id', v_purchases),
        jsonb_build_object('line_order', 1, 'description', 'Fasteners', 'quantity', 200,
                           'unit', 'nos', 'rate', 1, 'revenue_ledger_id', v_purchases),
        jsonb_build_object('line_order', 2, 'description', 'Delivery', 'quantity', 1,
                           'rate', 75, 'revenue_ledger_id', v_freight)
      )
    )
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e where e.voucher_id = v_voucher) = 3,
    'a purchase invoice posts one entry per party plus one per distinct expense ledger'
  );

  perform pg_temp.expect(
    (select e.credit_amount from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_creditor) = 875.00,
    'the party is credited with the whole bill, not debited'
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_purchases) = 1
    and (select e.debit_amount from public.voucher_entries e
         where e.voucher_id = v_voucher and e.ledger_id = v_purchases) = 800.00,
    'the expense ledger two lines share is debited once, for their subtotal'
  );

  perform pg_temp.expect(
    (select e.debit_amount from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_freight) = 75.00,
    'and the second expense ledger is debited with its own'
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e
     where e.voucher_id = v_voucher and e.credit_amount > 0) = 1,
    'exactly one credit entry — the party — however many lines the bill has'
  );

  set constraints all immediate;
  set constraints all deferred;

  select coalesce(sum(debit_balance), 0), coalesce(sum(credit_balance), 0)
  into v_debit, v_credit
  from public.get_trial_balance(v_company, '2026-04-30');

  perform pg_temp.expect(
    v_debit = v_credit and v_debit = 875.00,
    format('the Trial Balance tallies over a purchase invoice (Dr %s vs Cr %s)', v_debit, v_credit)
  );
end;
$$;

-- ------------------------------------------ 14. vouchers without invoice lines

\echo '14. A voucher with no invoice lines is untouched by any of this'

-- There are 57 sales and purchase vouchers already in the books with no
-- invoice lines, and they are not a backlog waiting to be upgraded: a voucher
-- with no invoice lines is a valid voucher, permanently. The old seven-
-- argument call has to keep resolving, the entries have to be exactly what was
-- passed in, and nothing may start requiring an invoice.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_voucher uuid;
  v_lines jsonb;
begin
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_debtor, 'debit_amount', 700, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_goods,  'debit_amount', 0, 'credit_amount', 700, 'line_order', 1)
  );

  -- Seven arguments, exactly as every existing caller writes it.
  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-08', 'the old way, still the way', null, null, v_lines
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e where e.voucher_id = v_voucher) = 2
    and (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 0,
    'a sales voucher created the old way has its two entries and no invoice lines'
  );

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.total_amount from public.vouchers v where v.id = v_voucher) = 700.00,
    'and it is totalled from its entries exactly as before'
  );

  -- Six arguments on the edit, likewise.
  perform public.update_voucher(v_voucher, '2026-04-09', 'edited the old way', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_debtor, 'debit_amount', 900, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_goods,  'debit_amount', 0, 'credit_amount', 900, 'line_order', 1)
    ));

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e where e.voucher_id = v_voucher) = 2
    and (select v.total_amount from public.vouchers v where v.id = v_voucher) = 900.00
    and (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 0,
    'and editing it the old way still replaces its entries and grows no invoice lines'
  );

  -- Passing the payload explicitly as null must be the same thing as leaving
  -- it off, or every existing generated client breaks the moment it starts
  -- sending the new argument.
  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-10', 'explicitly no invoice', null, null, v_lines, null
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e where e.voucher_id = v_voucher) = 2
    and (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 0,
    'an explicit null invoice payload behaves exactly as an omitted one'
  );

  set constraints all immediate;
  set constraints all deferred;
end;
$$;

-- create_voucher gained its argument by being dropped and recreated, because
-- two functions differing only by a defaulted argument are ambiguous to
-- PostgREST. The CSV importer's server-side loop calls it positionally, from
-- inside another function, and plpgsql resolves that call at run time — so a
-- signature change breaks it silently, at import time, and nowhere earlier.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_result record;
begin
  select * into v_result from public.create_vouchers_bulk(
    v_company,
    jsonb_build_array(jsonb_build_object(
      'group_key', 'zz-import-1',
      'voucher_type', 'sales',
      'voucher_date', '2026-04-14',
      'narration', 'imported from a CSV',
      'lines', jsonb_build_array(
        jsonb_build_object('ledger_id', v_debtor, 'debit_amount', 400, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', v_goods,  'debit_amount', 0, 'credit_amount', 400, 'line_order', 1)
      )
    ))
  );

  perform pg_temp.expect(
    v_result.error_message is null and v_result.voucher_id is not null,
    format('the CSV importer''s bulk path still resolves create_voucher (%s)',
           coalesce(v_result.error_message, 'no error'))
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e where e.voucher_id = v_result.voucher_id) = 2
    and (select count(*) from public.invoice_lines l where l.voucher_id = v_result.voucher_id) = 0,
    'and an imported voucher is still two plain entries and no invoice'
  );
end;
$$;

-- ------------------------------------------------- 15. editing an invoice

\echo '15. Editing an invoice replaces its lines and its entries together'

-- update_voucher already replaced a voucher's whole line set atomically. The
-- invoice lines have to be replaced in the same transaction and by the same
-- call, or an edit leaves the printed invoice describing one thing and the
-- ledgers another.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_services uuid := current_setting('test.inv_services')::uuid;
  v_voucher uuid := current_setting('test.inv_voucher')::uuid;
  v_invoice jsonb;
begin
  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 3
    and (select count(*) from public.voucher_entries e where e.voucher_id = v_voucher) = 3,
    'the invoice from section 12 starts at three lines and three entries'
  );

  -- Down to two lines, both against the services ledger: the goods ledger has
  -- to leave the voucher entirely.
  v_invoice := jsonb_build_object(
    'party_ledger_id', v_debtor,
    'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Consulting', 'quantity', 4,
                         'unit', 'hrs', 'rate', 250, 'revenue_ledger_id', v_services),
      jsonb_build_object('line_order', 1, 'description', 'Report', 'quantity', 1,
                         'rate', 200, 'revenue_ledger_id', v_services)
    )
  );

  perform public.update_voucher(v_voucher, '2026-04-05', 'now a services invoice', null, null,
                                '[]'::jsonb, v_invoice);

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 2,
    'the edit replaced the invoice lines rather than adding to them'
  );

  perform pg_temp.expect(
    not exists (select 1 from public.invoice_lines l
                where l.voucher_id = v_voucher and l.description = 'Widgets'),
    'and the lines that were removed are gone'
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries e where e.voucher_id = v_voucher) = 2
    and not exists (select 1 from public.voucher_entries e
                    where e.voucher_id = v_voucher and e.ledger_id = v_goods),
    'the entries were regenerated with them, and the ledger no line names is no longer posted to'
  );

  perform pg_temp.expect(
    (select e.debit_amount from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_debtor) = 1200.00
    and (select e.credit_amount from public.voucher_entries e
         where e.voucher_id = v_voucher and e.ledger_id = v_services) = 1200.00
    and (select v.total_amount from public.vouchers v where v.id = v_voucher) = 1200.00,
    'and the party, the revenue ledger and the voucher total all agree on the new figure'
  );

  -- The year guard from 0018 sits ahead of every write in update_voucher. A
  -- refused edit must leave the invoice lines alone as well as the entries —
  -- not an invoice stripped of its lines by an edit that then changed its mind.
  perform pg_temp.expect_error(
    format($q$select public.update_voucher(%L, '2026-03-31', 'dragged back a year', null, null, '[]'::jsonb, %L::jsonb)$q$,
           v_voucher, v_invoice::text),
    'financial year',
    'a refused re-date of an invoice is still refused'
  );

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 2
    and (select count(*) from public.voucher_entries e where e.voucher_id = v_voucher) = 2,
    'and it left both the invoice lines and the entries in place'
  );

  -- An invoice saved back through the plain six-argument path would have its
  -- lines deleted with its entries and rewritten as an ordinary voucher: the
  -- descriptions, quantities and rates gone, the totals still tallying, and
  -- nothing downstream any the wiser. It is refused instead — the only way an
  -- invoice stops being one is by being deleted and re-entered.
  perform pg_temp.expect_error(
    format($q$select public.update_voucher(%L, '2026-04-05', 'flattened', null, null,
             jsonb_build_array(
               jsonb_build_object('ledger_id', %L, 'debit_amount', 1200, 'credit_amount', 0, 'line_order', 0),
               jsonb_build_object('ledger_id', %L, 'debit_amount', 0, 'credit_amount', 1200, 'line_order', 1)))$q$,
           v_voucher, v_debtor, v_services),
    'is an invoice',
    'an invoice cannot be saved back as a plain voucher, silently dropping its lines'
  );

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 2
    and (select l.description from public.invoice_lines l
         where l.voucher_id = v_voucher and l.line_order = 0) = 'Consulting',
    'and the refusal left the invoice exactly as it was'
  );
end;
$$;

-- ------------------------------------------------ 16. backup and restore

\echo '16. A backup round-trips invoice lines'

-- A backup that silently drops the invoice lines is worse than no backup: the
-- ledgers restore, the totals restore, and the document the customer was sent
-- is gone with no error anywhere to say so. The ids have to be remapped the
-- same way everything else is — the restored line has to point at the restored
-- revenue ledger and the restored voucher, not at the ids the file was written
-- with.

do $$
declare
  v_user uuid;
  v_company uuid;
  v_restored uuid;
  v_group uuid;
  v_debtor uuid;
  v_goods uuid;
  v_services uuid;
  v_voucher uuid;
  v_payload jsonb;
  v_new_voucher uuid;
begin
  v_user := pg_temp.make_user('zz-backup-invoice@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_company := public.create_company('ZZ Backup Invoice Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Bak Debtor') returning id into v_debtor;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Bak Goods') returning id into v_goods;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Indirect Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Bak Services') returning id into v_services;

  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-05', 'an invoice worth keeping', null, null,
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', v_debtor,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Widgets', 'quantity', 3,
                           'unit', 'nos', 'rate', 150.50, 'discount_amount', 1.50,
                           'revenue_ledger_id', v_goods),
        jsonb_build_object('line_order', 1, 'description', 'Fitting', 'quantity', 2,
                           'unit', 'hrs', 'rate', 100, 'revenue_ledger_id', v_services)
      )
    )
  );

  set constraints all immediate;
  set constraints all deferred;

  -- The company address is on the invoice header, so it has to survive a
  -- round trip too, or a restored book prints invoices from nobody.
  update public.companies
  set address = '12 Mint Road, Mumbai 400001', phone = '+91 22 5555 0100', email = 'books@zzbackup.invalid'
  where id = v_company;

  v_payload := public.export_company_backup(v_company);

  perform pg_temp.expect(
    jsonb_array_length(v_payload->'invoice_lines') = 2,
    'the backup carries the invoice lines'
  );

  v_restored := public.restore_company_backup(v_payload, 'new', null);
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.company_id = v_restored) = 2,
    'and the restore puts them back'
  );

  select v.id into v_new_voucher from public.vouchers v
  where v.company_id = v_restored and v.narration = 'an invoice worth keeping';

  perform pg_temp.expect(
    v_new_voucher is not null and v_new_voucher <> v_voucher
    and (select count(*) from public.invoice_lines l where l.voucher_id = v_new_voucher) = 2,
    'the restored lines hang off the restored voucher, which is a different row'
  );

  -- The remapping assertion. Pointing at the original ledger id would be a
  -- cross-company reference, which the composite foreign key would have
  -- refused outright; pointing at the wrong ledger of the *right* company is
  -- the failure this catches.
  perform pg_temp.expect(
    (select l2.name from public.invoice_lines l
     join public.ledgers l2 on l2.id = l.revenue_ledger_id
     where l.voucher_id = v_new_voucher and l.description = 'Widgets') = 'ZZ Bak Goods'
    and (select l2.name from public.invoice_lines l
         join public.ledgers l2 on l2.id = l.revenue_ledger_id
         where l.voucher_id = v_new_voucher and l.description = 'Fitting') = 'ZZ Bak Services',
    'each restored line points at the restored copy of its own revenue ledger'
  );

  perform pg_temp.expect(
    (select l.revenue_ledger_id from public.invoice_lines l
     where l.voucher_id = v_new_voucher and l.description = 'Widgets') <> v_goods,
    'and not at the ledger id the backup file was written with'
  );

  -- 3 x 150.50 less 1.50 = 450.00, plus 2 x 100 = 200.00.
  perform pg_temp.expect(
    (select coalesce(sum(l.line_amount), 0) from public.invoice_lines l where l.voucher_id = v_new_voucher) = 650.00
    and (select v.total_amount from public.vouchers v where v.id = v_new_voucher) = 650.00,
    'the restored lines still total what the restored voucher was posted for'
  );

  perform pg_temp.expect(
    (select e.debit_amount from public.voucher_entries e
     join public.ledgers l2 on l2.id = e.ledger_id
     where e.voucher_id = v_new_voucher and l2.name = 'ZZ Bak Debtor') = 650.00,
    'and the restored party entry is remapped to the restored party ledger'
  );

  perform pg_temp.expect(
    (select c.address from public.companies c where c.id = v_restored) = '12 Mint Road, Mumbai 400001'
    and (select c.phone from public.companies c where c.id = v_restored) = '+91 22 5555 0100'
    and (select c.email from public.companies c where c.id = v_restored) = 'books@zzbackup.invalid',
    'the company details an invoice is printed from survive the round trip'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ----------------------------------------------------------- 17. undo

\echo '17. Undo rewinds invoice lines along with their entries'

-- Undo is offered as the safe, reversible option, so it has to actually put
-- the books back — including the invoice. An undo that removed a voucher's
-- entries and left its invoice lines behind would leave orphaned document
-- detail; one that rewound an *edit* but not the lines it replaced would leave
-- the invoice describing a version of itself the ledgers no longer hold.

do $$
declare
  v_user uuid;
  v_company uuid;
  v_group uuid;
  v_debtor uuid;
  v_goods uuid;
  v_mark timestamptz;
  v_voucher uuid;
begin
  v_user := pg_temp.make_user('zz-undo-invoice@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_company := public.create_company('ZZ Undo Invoice Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Undo Debtor') returning id into v_debtor;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Undo Goods') returning id into v_goods;

  perform pg_temp.stamp_audit(v_company, now() - interval '60 minutes');
  v_mark := now() - interval '45 minutes';

  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-05', 'to be undone', null, null,
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', v_debtor,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Widgets', 'quantity', 2,
                           'rate', 100, 'revenue_ledger_id', v_goods),
        jsonb_build_object('line_order', 1, 'description', 'Gadgets', 'quantity', 1,
                           'rate', 50, 'revenue_ledger_id', v_goods)
      )
    )
  );
  set constraints all immediate;
  set constraints all deferred;
  perform pg_temp.stamp_audit(v_company, now() - interval '40 minutes');

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.company_id = v_company) = 2,
    'the invoice is there before the undo'
  );

  perform pg_temp.expect(
    exists (select 1 from public.audit_log a
            where a.company_id = v_company and a.table_name = 'invoice_lines'),
    'and the audit trail recorded it — without that there is nothing to rewind'
  );

  perform public.revert_company_changes_since(v_company, v_mark);
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.company_id = v_company) = 0
    and (select count(*) from public.voucher_entries e where e.company_id = v_company) = 0
    and (select count(*) from public.vouchers v where v.company_id = v_company) = 0,
    'the undo took the invoice lines off with the entries and the voucher'
  );

  perform pg_temp.act_as(null);
end;
$$;

do $$
declare
  v_user uuid;
  v_company uuid;
  v_group uuid;
  v_debtor uuid;
  v_goods uuid;
  v_voucher uuid;
begin
  v_user := pg_temp.make_user('zz-undo-invoice-edit@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_company := public.create_company('ZZ Undo Invoice Edit Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Undo2 Debtor') returning id into v_debtor;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Undo2 Goods') returning id into v_goods;

  perform pg_temp.stamp_audit(v_company, now() - interval '60 minutes');

  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-05', 'issued', null, null,
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', v_debtor,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'As invoiced', 'quantity', 3,
                           'unit', 'nos', 'rate', 100, 'revenue_ledger_id', v_goods)
      )
    )
  );
  set constraints all immediate;
  set constraints all deferred;
  perform pg_temp.stamp_audit(v_company, now() - interval '40 minutes');

  -- The mistaken edit: two lines for a different figure entirely.
  perform public.update_voucher(v_voucher, '2026-04-05', 'edited by mistake', null, null, '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', v_debtor,
      'lines', jsonb_build_array(
        jsonb_build_object('line_order', 0, 'description', 'Wrong', 'quantity', 1,
                           'rate', 5, 'revenue_ledger_id', v_goods),
        jsonb_build_object('line_order', 1, 'description', 'Also wrong', 'quantity', 1,
                           'rate', 5, 'revenue_ledger_id', v_goods)
      )
    ));
  set constraints all immediate;
  set constraints all deferred;
  perform pg_temp.stamp_audit(v_company, now() - interval '20 minutes');

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 2
    and (select v.total_amount from public.vouchers v where v.id = v_voucher) = 10.00,
    'the mistaken edit is in place before the undo'
  );

  -- Cuts between the two, so only the edit comes off.
  perform public.revert_company_changes_since(v_company, now() - interval '30 minutes');
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.voucher_id = v_voucher) = 1,
    'undoing the edit put the original line count back'
  );

  perform pg_temp.expect(
    (select l.description from public.invoice_lines l where l.voucher_id = v_voucher) = 'As invoiced'
    and (select l.quantity from public.invoice_lines l where l.voucher_id = v_voucher) = 3
    and (select l.unit from public.invoice_lines l where l.voucher_id = v_voucher) = 'nos'
    and (select l.line_amount from public.invoice_lines l where l.voucher_id = v_voucher) = 300.00,
    'with the original description, quantity, unit and amount'
  );

  perform pg_temp.expect(
    (select coalesce(sum(e.debit_amount), 0) from public.voucher_entries e where e.voucher_id = v_voucher) = 300.00
    and (select v.total_amount from public.vouchers v where v.id = v_voucher) = 300.00,
    'and the entries and the voucher total came back with it'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ------------------------------------------- 18. cross-tenant invoice lines

\echo '18. An invoice line cannot reach into another company'

-- The composite foreign keys are the point: (voucher_id, company_id) and
-- (revenue_ledger_id, company_id) both carry the tenant, so a line crediting
-- another company's income ledger is not merely blocked by a policy that could
-- be got around — it cannot be written down at all.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_other uuid := current_setting('test.other_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_voucher uuid := current_setting('test.inv_voucher')::uuid;
  v_group uuid;
  v_foreign_ledger uuid;
begin
  perform app_private.seed_chart_of_accounts(v_other);

  select id into v_group from public.account_groups
  where company_id = v_other and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_other, v_group, 'ZZ Foreign Sales') returning id into v_foreign_ledger;

  perform pg_temp.expect_error(
    format($q$
      insert into public.invoice_lines
        (voucher_id, company_id, revenue_ledger_id, line_order, description, quantity, rate)
      values (%L, %L, %L, 9, 'Smuggled', 1, 100)
    $q$, v_voucher, v_company, v_foreign_ledger),
    'foreign key',
    'an invoice line cannot credit another company''s ledger'
  );

  perform pg_temp.expect_error(
    format($q$
      insert into public.invoice_lines
        (voucher_id, company_id, revenue_ledger_id, line_order, description, quantity, rate)
      values (%L, %L, %L, 9, 'Smuggled', 1, 100)
    $q$, v_voucher, v_other, v_foreign_ledger),
    'foreign key',
    'nor can it be filed under one company against another company''s voucher'
  );

  -- And the same thing through the write path, which is how it would actually
  -- be attempted.
  perform pg_temp.expect_error(
    format($q$select public.create_voucher(%L, 'sales', '2026-04-11', 'reaching out', null, null, '[]'::jsonb,
             jsonb_build_object('party_ledger_id', %L, 'lines', jsonb_build_array(
               jsonb_build_object('description', 'Smuggled', 'quantity', 1, 'rate', 100,
                                  'revenue_ledger_id', %L))))$q$,
           v_company, v_debtor, v_foreign_ledger),
    'foreign key',
    'and the write path cannot be used to get around it either'
  );

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.company_id = v_other) = 0,
    'the other company has no invoice lines of its own'
  );
end;
$$;

-- ----------------------------------------------- 19. the lock date on lines

\echo '19. The lock date blocks an invoice line, exactly as it blocks an entry'

-- invoice_lines is client-writable, like voucher_entries, so it needs the same
-- policies — including the lock-date rule. Otherwise an accountant who cannot
-- touch a closed period's postings could still rewrite what the invoice behind
-- them says, which is the document a tax auditor reads.
--
-- Unlike sections 5 and 9-11, this one exercises RLS for real rather than
-- evaluating the policy predicate by hand: the script runs as the owner, for
-- whom RLS is not enforced, so it becomes the `authenticated` role for the
-- duration. Supabase grants that role table privileges as part of its platform
-- setup and the local harness does not, so the grants are restated here; they
-- are rolled back with everything else.

do $$
declare
  v_admin uuid;
  v_accountant uuid;
  v_company uuid;
  v_group uuid;
  v_debtor uuid;
  v_goods uuid;
  v_locked uuid;
  v_open uuid;
  v_line uuid;
begin
  v_admin := pg_temp.make_user('zz-lock-admin@hisab.invalid');
  v_accountant := pg_temp.make_user('zz-lock-accountant@hisab.invalid');

  perform pg_temp.act_as(v_admin);
  v_company := public.create_company('ZZ Lock Invoice Co', '2025-04-01', 4::smallint, 'INR');

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_company, v_accountant, 'accountant', 'active', v_admin);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Lock Debtor') returning id into v_debtor;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Lock Goods') returning id into v_goods;

  v_locked := public.create_voucher(
    v_company, 'sales', '2026-04-05', 'inside the closed period', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_debtor, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Closed', 'quantity', 1,
                         'rate', 100, 'revenue_ledger_id', v_goods)))
  );

  v_open := public.create_voucher(
    v_company, 'sales', '2026-08-05', 'after the lock date', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_debtor, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Open', 'quantity', 1,
                         'rate', 100, 'revenue_ledger_id', v_goods)))
  );

  set constraints all immediate;
  set constraints all deferred;

  update public.companies set lock_date = '2026-06-30' where id = v_company;

  select l.id into v_line from public.invoice_lines l where l.voucher_id = v_locked;

  perform set_config('test.lock_company', v_company::text, false);
  perform set_config('test.lock_accountant', v_accountant::text, false);
  perform set_config('test.lock_goods', v_goods::text, false);
  perform set_config('test.lock_locked', v_locked::text, false);
  perform set_config('test.lock_open', v_open::text, false);
  perform set_config('test.lock_line', v_line::text, false);

  perform pg_temp.act_as(null);
end;
$$;

grant select, insert, update, delete on
  public.invoice_lines, public.voucher_entries, public.vouchers,
  public.ledgers, public.account_groups, public.companies, public.company_members
  to authenticated;

do $$
declare
  v_company uuid := current_setting('test.lock_company')::uuid;
  v_goods uuid := current_setting('test.lock_goods')::uuid;
  v_locked uuid := current_setting('test.lock_locked')::uuid;
  v_open uuid := current_setting('test.lock_open')::uuid;
  v_line uuid := current_setting('test.lock_line')::uuid;
begin
  perform pg_temp.expect(
    (select c.relrowsecurity from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'invoice_lines'),
    'row level security is enabled on invoice_lines at all'
  );

  -- The policies are asserted to be the voucher_entries policies with the
  -- table name changed, which is a stronger statement than any single case:
  -- whatever the entry rule is, the line rule is the same rule.
  perform pg_temp.expect(
    (select count(*) from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'invoice_lines'
       and exists (
         select 1 from pg_policies q
         where q.schemaname = 'public' and q.tablename = 'voucher_entries'
           and q.cmd = p.cmd
           and coalesce(replace(q.qual, 'voucher_entries', 'invoice_lines'), '') = coalesce(p.qual, '')
           and coalesce(replace(q.with_check, 'voucher_entries', 'invoice_lines'), '') = coalesce(p.with_check, '')
       )) = 4,
    'all four invoice_lines policies are the voucher_entries policies verbatim'
  );
end;
$$;

do $$
declare
  v_accountant uuid := current_setting('test.lock_accountant')::uuid;
  v_company uuid := current_setting('test.lock_company')::uuid;
  v_goods uuid := current_setting('test.lock_goods')::uuid;
  v_locked uuid := current_setting('test.lock_locked')::uuid;
  v_open uuid := current_setting('test.lock_open')::uuid;
  v_line uuid := current_setting('test.lock_line')::uuid;
begin
  perform pg_temp.act_as(v_accountant);
  set local role authenticated;

  perform pg_temp.expect_error(
    format($q$
      insert into public.invoice_lines
        (voucher_id, company_id, revenue_ledger_id, line_order, description, quantity, rate)
      values (%L, %L, %L, 5, 'Slipped in behind the lock', 1, 100)
    $q$, v_locked, v_company, v_goods),
    'row-level security',
    'an accountant cannot add an invoice line to a locked period'
  );

  -- UPDATE and DELETE carry a USING clause and no WITH CHECK — which is how
  -- voucher_entries has always been written, and this section's whole claim is
  -- that the two are the same rule. A USING clause is a visibility filter, not
  -- a veto, so a blocked edit is silent: the statement simply matches no rows.
  -- The guarantee is therefore about what is still there afterwards, not about
  -- what was raised.
  update public.invoice_lines set description = 'Rewritten' where id = v_line;
  perform pg_temp.expect(
    (select l.description from public.invoice_lines l where l.id = v_line) = 'Closed',
    'nor edit one that is already there — the locked line keeps its description'
  );

  delete from public.invoice_lines where id = v_line;
  perform pg_temp.expect(
    exists (select 1 from public.invoice_lines l where l.id = v_line),
    'nor delete one — the locked line survives the attempt'
  );

  -- The positive control. Without it the three assertions above would pass
  -- just as well against a policy that refused everything.
  insert into public.invoice_lines
    (voucher_id, company_id, revenue_ledger_id, line_order, description, quantity, rate)
  values (v_open, v_company, v_goods, 5, 'Ordinary work in an open period', 1, 100);

  perform pg_temp.expect(
    exists (select 1 from public.invoice_lines l
            where l.voucher_id = v_open and l.line_order = 5),
    'and the same accountant can write an invoice line after the lock date'
  );

  reset role;
  perform pg_temp.act_as(null);

  -- Tidied away as the owner: that stray line was written straight into the
  -- table rather than through the write path, so it does not match the
  -- postings, and section 12's invariant would fail at the end of the file.
  delete from public.invoice_lines where voucher_id = v_open and line_order = 5;
end;
$$;

-- --------------------------------------------------------- 20. discounts

\echo '20. A discount reduces the posting, not just the printed line'

-- A discount that only changed what the invoice looked like would leave the
-- customer billed one figure and the ledgers holding another. It comes off the
-- line amount, so it comes off the posting, because the posting is nothing but
-- the sum of the line amounts.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_voucher uuid;
begin
  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-12', 'one line, discounted', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_debtor, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Widgets', 'quantity', 10,
                         'rate', 50, 'discount_amount', 100, 'revenue_ledger_id', v_goods)))
  );

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select l.line_amount from public.invoice_lines l where l.voucher_id = v_voucher) = 400.00,
    'the discount comes off the line amount'
  );

  perform pg_temp.expect(
    (select e.debit_amount from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_debtor) = 400.00
    and (select e.credit_amount from public.voucher_entries e
         where e.voucher_id = v_voucher and e.ledger_id = v_goods) = 400.00,
    'the party is billed 400.00 and the income ledger credited 400.00, not the 500.00 before discount'
  );

  perform pg_temp.expect(
    (select v.total_amount from public.vouchers v where v.id = v_voucher) = 400.00,
    'and the voucher is worth what was actually charged'
  );

  -- A discount bigger than the line it is discounting is not a discount.
  perform pg_temp.expect_error(
    format($q$select public.create_voucher(%L, 'sales', '2026-04-13', 'negative line', null, null, '[]'::jsonb,
             jsonb_build_object('party_ledger_id', %L, 'lines', jsonb_build_array(
               jsonb_build_object('description', 'Too generous', 'quantity', 1, 'rate', 100,
                                  'discount_amount', 150, 'revenue_ledger_id', %L))))$q$,
           v_company, v_debtor, v_goods),
    'check constraint',
    'a discount larger than the line amount is refused'
  );
end;
$$;

-- --------------------------------------- 21. an invoice records its party

\echo '21. An invoice records who it is to'

-- 0021 stored an invoice's party — the customer on a sale, the supplier on a
-- bill — nowhere at all. It was recoverable only by the convention that
-- generate_invoice_entries() writes the party leg at line_order 0, and nothing
-- in the schema held that convention up: a hand-written voucher_entries row
-- that reordered the legs would have made the printed invoice name the wrong
-- customer while every trigger, constraint and guarantee in this file still
-- passed.
--
-- vouchers.party_ledger_id is the record now, and voucher_entries stays
-- derived from it like everything else. So the assertions are two-sided: the
-- column holds a party, and it is the same ledger the generator posted
-- against. Either half alone would let the two drift.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_voucher uuid;
  v_party uuid;
begin
  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-15', 'a sale that remembers its customer', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_debtor, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Widgets', 'quantity', 4,
                         'rate', 25, 'revenue_ledger_id', v_goods)))
  );

  set constraints all immediate;
  set constraints all deferred;

  select v.party_ledger_id into v_party from public.vouchers v where v.id = v_voucher;

  perform pg_temp.expect(
    v_party = v_debtor,
    'a sales invoice stores the customer it was made out to'
  );

  perform pg_temp.expect(
    v_party = (select e.ledger_id from public.voucher_entries e
               where e.voucher_id = v_voucher and e.line_order = 0),
    'and it is the same ledger the generator posted the party leg against'
  );

  perform pg_temp.expect(
    (select e.debit_amount from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_party) = 100.00
    and (select e.credit_amount from public.voucher_entries e
         where e.voucher_id = v_voucher and e.ledger_id = v_party) = 0,
    'and on a sale that ledger is the one debited, for the whole invoice'
  );

  perform set_config('test.party_voucher', v_voucher::text, false);
end;
$$;

-- The purchase side, for the same reason section 13 exists: a write path that
-- hard-coded the sales direction would store the party just as faithfully and
-- still be describing the wrong leg of a bill.

do $$
declare
  v_company uuid;
  v_group uuid;
  v_creditor uuid;
  v_purchases uuid;
  v_voucher uuid;
  v_party uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Party Purchase Co', '2025-04-01', 4, 'INR') returning id into v_company;

  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Party Supplier') returning id into v_creditor;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Party Purchases') returning id into v_purchases;

  v_voucher := public.create_voucher(
    v_company, 'purchase', '2026-04-05', 'a bill that remembers its supplier', 'BILL-21', '2026-04-04',
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_creditor, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Steel sheet', 'quantity', 3,
                         'unit', 'nos', 'rate', 90, 'revenue_ledger_id', v_purchases)))
  );

  set constraints all immediate;
  set constraints all deferred;

  select v.party_ledger_id into v_party from public.vouchers v where v.id = v_voucher;

  perform pg_temp.expect(
    v_party = v_creditor,
    'a purchase bill stores the supplier it came from'
  );

  perform pg_temp.expect(
    v_party = (select e.ledger_id from public.voucher_entries e
               where e.voucher_id = v_voucher and e.line_order = 0),
    'and it too is the ledger the party leg was posted against'
  );

  perform pg_temp.expect(
    (select e.credit_amount from public.voucher_entries e
     where e.voucher_id = v_voucher and e.ledger_id = v_party) = 270.00
    and (select e.debit_amount from public.voucher_entries e
         where e.voucher_id = v_voucher and e.ledger_id = v_party) = 0,
    'but on a bill that ledger is credited, not debited'
  );
end;
$$;

-- ------------------------------- 22. the party is required of invoices only

\echo '22. An invoice must have a party; a plain voucher must not need one'

-- The column is nullable on purpose. A journal and a contra have no
-- counterparty, and the 57 sales and purchase vouchers already in the books
-- have no invoice lines and no party either — they are not a backlog waiting
-- to be upgraded, they are valid vouchers permanently.
--
-- So the rule is conditional, and it lives inside
-- check_invoice_lines_match(), which already returns immediately for a
-- voucher with no invoice lines. That early return *is* the
-- backward-compatibility guarantee, and a condition placed after it inherits
-- it: the new rule cannot reach a voucher that has no lines, by construction.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_invoice uuid := current_setting('test.party_voucher')::uuid;
  v_plain uuid;
begin
  -- The 57 legacy vouchers, in miniature: created the old way, no invoice
  -- lines, no party — and accepted, with the constraints forced so the claim
  -- is about what the database checks rather than what it has deferred.
  v_plain := public.create_voucher(
    v_company, 'sales', '2026-04-16', 'a sale with no invoice behind it', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_debtor, 'debit_amount', 700, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_goods,  'debit_amount', 0, 'credit_amount', 700, 'line_order', 1)
    )
  );

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_plain) is null
    and (select count(*) from public.invoice_lines l where l.voucher_id = v_plain) = 0
    and (select v.total_amount from public.vouchers v where v.id = v_plain) = 700.00,
    'a voucher with no invoice lines is stored with no party at all, and is accepted'
  );

  -- Give that same voucher invoice lines by hand and it becomes an invoice
  -- with nobody to bill. The line total is made to match the postings exactly
  -- (7 x 100 = 700.00) so the amount half of the invariant cannot be what
  -- fires: this is the party rule or nothing.
  perform pg_temp.expect_error(
    format($q$
      insert into public.invoice_lines
        (voucher_id, company_id, revenue_ledger_id, line_order, description, quantity, rate)
      values (%L, %L, %L, 0, 'Retro-fitted', 7, 100);
      set constraints all immediate;
    $q$, v_plain, v_company, v_goods),
    'party',
    'a voucher that grows invoice lines without a party is refused'
  );

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.voucher_id = v_plain) = 0,
    'and the refusal left it the plain voucher it was'
  );

  -- The same corruption seen from the other side. Removing the party of a
  -- voucher that *is* an invoice does not on its own touch a table the
  -- deferred trigger watches — but the moment its postings are written again,
  -- which is what any edit does, the invariant is checked and it is refused.
  perform pg_temp.expect_error(
    format($q$
      update public.vouchers set party_ledger_id = null where id = %L;
      update public.voucher_entries set narration = 'rewritten' where voucher_id = %L;
      set constraints all immediate;
    $q$, v_invoice, v_invoice),
    'party',
    'an invoice stripped of its party cannot have its postings rewritten under it'
  );

  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_invoice) = v_debtor,
    'and that invoice still names its customer'
  );

  perform set_config('test.party_plain', v_plain::text, false);
end;
$$;

-- ------------------------------------- 23. the party survives a round trip

\echo '23. Backup and restore carry the party, remapped'

-- A backup that dropped the party would restore a book full of invoices
-- addressed to nobody, with every total still tallying and no error anywhere
-- to say so. And a restore that carried the *original* uuid over would be
-- worse than an error: the composite foreign key would refuse it outright in
-- the lucky case, and in the unlucky one it would land on a ledger of the
-- target company that happened to share the id and quietly re-address the
-- invoice to a different customer. It has to go through the same ledger map
-- invoice_lines.revenue_ledger_id goes through.

do $$
declare
  v_user uuid;
  v_company uuid;
  v_restored uuid;
  v_group uuid;
  v_debtor uuid;
  v_goods uuid;
  v_voucher uuid;
  v_payload jsonb;
  v_new_voucher uuid;
  v_new_party uuid;
begin
  v_user := pg_temp.make_user('zz-backup-party@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_company := public.create_company('ZZ Backup Party Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Party Bak Debtor') returning id into v_debtor;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Party Bak Goods') returning id into v_goods;

  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-05', 'an invoice with a customer worth keeping', null, null,
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_debtor, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Widgets', 'quantity', 2,
                         'unit', 'nos', 'rate', 125, 'revenue_ledger_id', v_goods)))
  );

  set constraints all immediate;
  set constraints all deferred;

  v_payload := public.export_company_backup(v_company);

  -- export_company_backup builds each voucher with to_jsonb(v), so the column
  -- rides along the moment it exists — but "it should have come along" is
  -- exactly the assumption a backup is not allowed to make quietly.
  perform pg_temp.expect(
    (select bool_and(v ? 'party_ledger_id')
     from jsonb_array_elements(v_payload->'vouchers') v),
    'the backup file carries a party_ledger_id for every voucher in it'
  );

  v_restored := public.restore_company_backup(v_payload, 'new', null);
  set constraints all deferred;

  select v.id, v.party_ledger_id into v_new_voucher, v_new_party
  from public.vouchers v
  where v.company_id = v_restored and v.narration = 'an invoice with a customer worth keeping';

  perform pg_temp.expect(
    v_new_voucher is not null and v_new_voucher <> v_voucher and v_new_party is not null,
    'the restored invoice is a different row and still has a party'
  );

  perform pg_temp.expect(
    (select l.name from public.ledgers l where l.id = v_new_party) = 'ZZ Party Bak Debtor'
    and (select l.company_id from public.ledgers l where l.id = v_new_party) = v_restored,
    'and it points at the restored copy of its own customer, in the restored company'
  );

  -- The remapping assertion proper. Carrying the id over verbatim would pass
  -- every check above.
  perform pg_temp.expect(
    v_new_party <> v_debtor,
    'not at the ledger id the backup file was written with'
  );

  perform pg_temp.expect(
    v_new_party = (select e.ledger_id from public.voucher_entries e
                   where e.voucher_id = v_new_voucher and e.line_order = 0),
    'and the restored party and the restored party posting still agree'
  );

  -- Files written before this column existed have no such key, and must still
  -- restore — as vouchers with no party, which is what they were. Such a file
  -- has no invoice_lines key either: 0021 and 0022 are consecutive, and there
  -- is not one invoice line in the books between them. Stripping only the
  -- party would describe a file that never existed — an itemised invoice
  -- addressed to nobody — and the invariant above is right to refuse it.
  v_restored := public.restore_company_backup(
    jsonb_set(v_payload - 'invoice_lines', '{vouchers}', (
      select coalesce(jsonb_agg(v - 'party_ledger_id'), '[]'::jsonb)
      from jsonb_array_elements(v_payload->'vouchers') v
    )),
    'new', null
  );
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.vouchers v where v.company_id = v_restored) = 1
    and (select v.party_ledger_id from public.vouchers v where v.company_id = v_restored) is null
    and (select count(*) from public.voucher_entries e where e.company_id = v_restored) = 2,
    'a backup written before the column existed still restores, with no party'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ---------------------------------------------- 24. undo keeps the party

\echo '24. Undoing an invoice edit puts the party back'

-- revert_company_changes_since() replays a vouchers UPDATE by naming its
-- columns explicitly, so a column missing from that list is silently not
-- rewound: the undo would report success, put the lines, the entries and the
-- totals back, and leave the invoice addressed to whoever the mistaken edit
-- had named. Re-addressing an invoice is exactly the kind of mistake undo is
-- offered for.

do $$
declare
  v_user uuid;
  v_company uuid;
  v_group uuid;
  v_right uuid;
  v_wrong uuid;
  v_goods uuid;
  v_voucher uuid;
begin
  v_user := pg_temp.make_user('zz-undo-party@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_company := public.create_company('ZZ Undo Party Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Undo Right Customer') returning id into v_right;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Undo Wrong Customer') returning id into v_wrong;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Undo Party Goods') returning id into v_goods;

  perform pg_temp.stamp_audit(v_company, now() - interval '60 minutes');

  v_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-05', 'issued to the right customer', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_right, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'As invoiced', 'quantity', 3,
                         'unit', 'nos', 'rate', 100, 'revenue_ledger_id', v_goods)))
  );
  set constraints all immediate;
  set constraints all deferred;
  perform pg_temp.stamp_audit(v_company, now() - interval '40 minutes');

  -- The mistaken edit: the same goods, billed to somebody else entirely.
  perform public.update_voucher(v_voucher, '2026-04-05', 'sent to the wrong customer', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_wrong, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'As invoiced', 'quantity', 3,
                         'unit', 'nos', 'rate', 100, 'revenue_ledger_id', v_goods))));
  set constraints all immediate;
  set constraints all deferred;
  perform pg_temp.stamp_audit(v_company, now() - interval '20 minutes');

  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_voucher) = v_wrong,
    'the invoice is addressed to the wrong customer before the undo'
  );

  -- Cuts between the two, so only the edit comes off.
  perform public.revert_company_changes_since(v_company, now() - interval '30 minutes');
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_voucher) = v_right,
    'undoing the edit put the original customer back'
  );

  perform pg_temp.expect(
    (select e.ledger_id from public.voucher_entries e
     where e.voucher_id = v_voucher and e.line_order = 0) = v_right
    and (select coalesce(sum(e.debit_amount), 0) from public.voucher_entries e
         where e.voucher_id = v_voucher) = 300.00,
    'and the party posting came back with it, so the two still agree'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ------------------------------------ 25. a voucher cannot become an invoice

\echo '25. A voucher cannot change its nature under you'

-- 0021 left this asymmetric: update_voucher refused a plain-lines save of a
-- voucher that has invoice lines, but accepted an invoice payload for a
-- voucher that has none — so any of the 57 legacy vouchers could be silently
-- upgraded into an invoice, with descriptions, quantities and rates invented
-- at edit time and no record that they were. The database permitted it and
-- only a UI choice prevented it.
--
-- The justification is 0004's, for voucher_type being immutable: a voucher
-- should not change its nature under you.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_plain uuid := current_setting('test.party_plain')::uuid;
  v_invoice text;
begin
  v_invoice := jsonb_build_object(
    'party_ledger_id', v_debtor,
    'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Invented at edit time', 'quantity', 7,
                         'rate', 100, 'revenue_ledger_id', v_goods)
    )
  )::text;

  perform pg_temp.expect_error(
    format($q$select public.update_voucher(%L, '2026-04-16', 'upgraded behind your back', null, null, '[]'::jsonb, %L::jsonb)$q$,
           v_plain, v_invoice),
    'not an invoice',
    'a plain voucher cannot be turned into an invoice by an edit'
  );

  perform pg_temp.expect(
    (select count(*) from public.invoice_lines l where l.voucher_id = v_plain) = 0
    and (select v.party_ledger_id from public.vouchers v where v.id = v_plain) is null
    and (select count(*) from public.voucher_entries e where e.voucher_id = v_plain) = 2,
    'and the refusal left it a plain two-entry voucher with no party'
  );

  -- The refusal is symmetric with 0021's, which is the point: neither
  -- direction is a save a user ever means to make, and both say what to do
  -- instead rather than doing something surprising.
  perform pg_temp.expect(
    (select v.narration from public.vouchers v where v.id = v_plain) = 'a sale with no invoice behind it',
    'not even its narration was written before the refusal'
  );
end;
$$;

-- ------------------------------------------- 26. the party is tenant-scoped

\echo '26. An invoice cannot be made out to another company''s ledger'

-- Same reasoning as section 18, applied to the new column: the foreign key is
-- composite — (party_ledger_id, company_id) references ledgers (id,
-- company_id) — so an invoice addressed to another company's customer is not
-- merely blocked by a policy that a security-definer function could step
-- around, it cannot be written down at all.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_other uuid := current_setting('test.other_company')::uuid;
  v_goods uuid := current_setting('test.inv_goods')::uuid;
  v_voucher uuid := current_setting('test.party_voucher')::uuid;
  v_group uuid;
  v_foreign_party uuid;
begin
  select id into v_group from public.account_groups
  where company_id = v_other and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_other, v_group, 'ZZ Foreign Customer') returning id into v_foreign_party;

  perform pg_temp.expect_error(
    format($q$update public.vouchers set party_ledger_id = %L where id = %L$q$,
           v_foreign_party, v_voucher),
    'party_ledger_id',
    'a voucher cannot be pointed at another company''s ledger by hand'
  );

  -- And through the write path, which is how it would actually be attempted:
  -- a party id from one company posted against another company's books.
  perform pg_temp.expect_error(
    format($q$select public.create_voucher(%L, 'sales', '2026-04-17', 'somebody else''s customer', null, null, '[]'::jsonb,
             jsonb_build_object('party_ledger_id', %L, 'lines', jsonb_build_array(
               jsonb_build_object('description', 'Widgets', 'quantity', 1, 'rate', 100,
                                  'revenue_ledger_id', %L))))$q$,
           v_company, v_foreign_party, v_goods),
    'party_ledger_id',
    'and the write path cannot be used to address an invoice out of the company either'
  );

  perform pg_temp.expect(
    not exists (select 1 from public.vouchers v
                where v.company_id = v_company and v.party_ledger_id = v_foreign_party),
    'no voucher in this company names the other company''s ledger'
  );
end;
$$;

-- ---------------------------- 27. the party cannot be taken away afterwards

\echo '27. An invoice cannot have its party taken away'

-- Section 22 asserts the rule as check_invoice_lines_match() enforces it, and
-- that trigger is registered on invoice_lines and voucher_entries — the two
-- tables holding the things it compares. That is every path that writes
-- postings, which is every path the application offers. It is not every path
-- that reaches the column. A bare
--
--   update public.vouchers set party_ledger_id = null where id = ...
--
-- touches neither watched table, so nothing fires; the vouchers update policy
-- admits that statement from any member with write access in an unlocked
-- period, and the invoice is caught only the next time somebody rewrites its
-- postings — which may be never. Section 22's last case proves the eventual
-- catch, and deliberately does not prove this one: it writes the entries
-- itself, in the very next statement.
--
-- So this is the same corruption with the second statement taken away, which
-- is what a user with the SQL editor open, a mistaken bulk update, or a
-- future code path that only means to clear a field would actually do.

do $$
declare
  v_company uuid := current_setting('test.inv_company')::uuid;
  v_debtor uuid := current_setting('test.inv_debtor')::uuid;
  v_invoice uuid := current_setting('test.party_voucher')::uuid;
  v_plain uuid := current_setting('test.party_plain')::uuid;
  v_group uuid;
  v_second uuid;
begin
  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_invoice) = v_debtor
    and (select count(*) from public.invoice_lines l where l.voucher_id = v_invoice) = 1,
    'the invoice from section 21 still carries its line and its customer'
  );

  -- The whole of it: one statement, nothing else written, and the transaction
  -- asked to make good on what it has done.
  perform pg_temp.expect_error(
    format($q$
      update public.vouchers set party_ledger_id = null where id = %L;
      set constraints all immediate;
    $q$, v_invoice),
    'party',
    'an invoice cannot be stripped of its party by an update that touches nothing else'
  );

  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_invoice) = v_debtor
    and (select count(*) from public.invoice_lines l where l.voucher_id = v_invoice) = 1,
    'and the refusal left the invoice exactly as it was'
  );

  -- The positive control, and the thing this must never break: the same
  -- statement, on a voucher with no invoice lines. Set first and cleared
  -- after, because a column that was already null would not show the trigger
  -- had fired at all — only that nothing had happened.
  update public.vouchers set party_ledger_id = v_debtor where id = v_plain;
  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_plain) = v_debtor,
    'a voucher with no invoice lines can be given a party'
  );

  update public.vouchers set party_ledger_id = null where id = v_plain;
  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_plain) is null
    and (select count(*) from public.invoice_lines l where l.voucher_id = v_plain) = 0,
    'and can have it taken away again, which is the 57 legacy vouchers left alone'
  );

  -- The over-reach this must not become. The rule is that an invoice has a
  -- party, not that it keeps the one it was issued to: re-addressing a
  -- misdirected bill to another of the company's own customers is ordinary
  -- correction work, and it is what update_voucher does on every invoice edit.
  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Party Second Customer') returning id into v_second;

  update public.vouchers set party_ledger_id = v_second where id = v_invoice;
  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_invoice) = v_second,
    'an invoice can still be re-addressed from one customer to another'
  );

  update public.vouchers set party_ledger_id = v_debtor where id = v_invoice;
  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.party_ledger_id from public.vouchers v where v.id = v_invoice) = v_debtor,
    'and put back where it started'
  );
end;
$$;

-- ------------------------------------------- 28. the same bill entered twice

\echo '28. The same supplier bill entered twice is found'

-- vouchers.reference_number holds the supplier's own bill number on a
-- purchase, and until 0024 nothing anywhere looked at it twice: no unique
-- constraint, no index, and no warning in the entry flow. The same bill could
-- be keyed in on Monday and again on Thursday with no signal at all, which is
-- the ordinary road to paying a supplier twice.
--
-- The fix is deliberately a lookup and not a constraint. Two different
-- suppliers really do issue the same bill number, and one supplier's numbering
-- really does restart every April, so a unique index would refuse entries that
-- are correct. What the books need is for somebody to be told; the decision
-- stays with the person who can see both documents.
--
-- So what is guaranteed here is that the lookup answers truthfully, on both
-- sides: section 28 is everything it must find and the fact that finding it
-- stops nothing, and section 29 is everything it must not.

do $$
declare
  v_company uuid;
  v_group uuid;
  v_supplier_a uuid;
  v_supplier_b uuid;
  v_expense uuid;
  v_debtor uuid;
  v_income uuid;
  v_first uuid;
  v_second uuid;
  v_hit record;
  v_count int;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Bill Co', '2025-04-01', 4, 'INR') returning id into v_company;

  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Bill Supplier A') returning id into v_supplier_a;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Bill Supplier B') returning id into v_supplier_b;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Bill Purchases') returning id into v_expense;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Bill Customer') returning id into v_debtor;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Bill Revenue') returning id into v_income;

  v_first := public.create_voucher(
    v_company, 'purchase', '2026-04-05', 'the bill as first entered', 'INV-001', '2026-04-04',
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_supplier_a, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Steel sections', 'quantity', 1,
                         'rate', 1000, 'revenue_ledger_id', v_expense)
    ))
  );

  -- total_amount is written by the deferred balance trigger, and the warning
  -- names the amount, so it has to be settled before it is read.
  set constraints all immediate;
  set constraints all deferred;

  select * into v_hit
  from public.find_duplicate_bill(v_company, v_supplier_a, 'INV-001', '2026-04-20', null);

  perform pg_temp.expect(
    v_hit.voucher_id = v_first,
    'a supplier bill number already used by that supplier this year is found'
  );

  -- The warning has to name the existing voucher well enough for the user to
  -- recognise it without leaving the form, so all three parts come back with
  -- it rather than being fetched again per hit.
  perform pg_temp.expect(
    v_hit.voucher_number = (select v.voucher_number from public.vouchers v where v.id = v_first)
    and v_hit.voucher_date = '2026-04-05'::date
    and v_hit.total_amount = 1000.00,
    'and it carries the number, date and amount the warning has to state'
  );

  -- INV-001, inv-001 and ' INV-001 ' are one bill. A supplier's number is a
  -- label on a piece of paper, and which of those a user types depends on
  -- nothing but their keyboard that morning.
  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, 'inv-001', '2026-04-20', null)) = 1,
    'the same bill number in another case is the same bill'
  );

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, '   INV-001   ', '2026-04-20', null)) = 1,
    'and so is one with spaces around it'
  );

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, '  Inv-001', '2026-04-20', null)) = 1,
    'and one that is both at once'
  );

  -- Editing an invoice must not report the invoice itself. Without this the
  -- warning fires on every save of every purchase that has a bill number,
  -- which is the fastest way to teach a user to ignore it.
  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, 'INV-001', '2026-04-20', v_first)) = 0,
    'the voucher being edited is not a duplicate of itself'
  );

  -- And it is a warning, not a rule. Somebody who has both documents in front
  -- of them and knows they are two genuinely different deliveries has to be
  -- able to say so, and the only way to say so is for the save to go through.
  v_second := public.create_voucher(
    v_company, 'purchase', '2026-04-12', 'the same bill number, entered again', 'INV-001', '2026-04-04',
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_supplier_a, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Steel sections', 'quantity', 1,
                         'rate', 1000, 'revenue_ledger_id', v_expense)
    ))
  );

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    v_second is not null and v_second <> v_first,
    'a bill the lookup warns about can still be saved — this warns, it does not block'
  );

  select count(*) into v_count
  from public.find_duplicate_bill(v_company, v_supplier_a, 'INV-001', '2026-04-20', v_second);

  perform pg_temp.expect(
    v_count = 1,
    'and the second entry now finds the first, so the warning survives the decision to overrule it'
  );

  perform set_config('test.bill_company', v_company::text, false);
  perform set_config('test.bill_supplier_a', v_supplier_a::text, false);
  perform set_config('test.bill_supplier_b', v_supplier_b::text, false);
  perform set_config('test.bill_expense', v_expense::text, false);
  perform set_config('test.bill_debtor', v_debtor::text, false);
  perform set_config('test.bill_income', v_income::text, false);
  perform set_config('test.bill_first', v_first::text, false);
end;
$$;

-- ------------------------------------- 29. and everything that is not a bill

\echo '29. And nothing that is not the same bill'

-- The half that decides whether the warning is worth anything. A guard that
-- fires on entries that are not duplicates is worse than no guard: it is
-- dismissed on sight, and then it is dismissed on the day it was right.
--
-- Each case below is one voucher that shares nearly everything with the
-- original and differs in exactly one way, so a failure names the filter that
-- has gone.

do $$
declare
  v_company uuid := current_setting('test.bill_company')::uuid;
  v_supplier_a uuid := current_setting('test.bill_supplier_a')::uuid;
  v_supplier_b uuid := current_setting('test.bill_supplier_b')::uuid;
  v_expense uuid := current_setting('test.bill_expense')::uuid;
  v_debtor uuid := current_setting('test.bill_debtor')::uuid;
  v_income uuid := current_setting('test.bill_income')::uuid;
  v_other_company uuid;
  v_other_supplier uuid;
  v_other_expense uuid;
  v_group uuid;
  v_prior uuid;
  v_blank uuid;
  v_none uuid;
  v_sale uuid;
  v_deleted uuid;
begin
  -- Two suppliers issuing the same number is ordinary. Both of them number
  -- from 1 every April, and one of them is not evidence about the other.
  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_b, 'INV-001', '2026-04-20', null)) = 0,
    'another supplier using the same bill number is not a duplicate'
  );

  -- The same supplier's numbering restarts with the year, so INV-001 of
  -- 2025-26 and INV-001 of 2026-27 are two different bills. This company's
  -- year starts in April, so 10 June 2025 is the earlier one.
  v_prior := public.create_voucher(
    v_company, 'purchase', '2025-06-10', 'last year, same number', 'INV-001', '2025-06-09',
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_supplier_a, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Steel sections', 'quantity', 1,
                         'rate', 700, 'revenue_ledger_id', v_expense)
    ))
  );

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.financial_year_label from public.vouchers v where v.id = v_prior) = '2025-26'
    and (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, 'INV-001', '2025-06-20', null)) = 1,
    'the same number in the previous year is its own bill, found from within that year'
  );

  -- Two in this year (28 entered a second on purpose), one in the last, and
  -- the query dated into this year sees only this year's.
  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, 'INV-001', '2026-04-20', null)) = 2,
    'and a bill from a previous year is not a duplicate of one entered this year'
  );

  -- Most vouchers have no reference at all, and two of them are not two
  -- entries of one bill — they are two vouchers nobody wrote a number on.
  v_none := public.create_voucher(
    v_company, 'purchase', '2026-04-07', 'a bill with no number on it', null, null,
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_supplier_a, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Cartage', 'quantity', 1,
                         'rate', 200, 'revenue_ledger_id', v_expense)
    ))
  );

  v_blank := public.create_voucher(
    v_company, 'purchase', '2026-04-08', 'a bill whose number field was spacebarred', '   ', null,
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_supplier_a, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Cartage', 'quantity', 1,
                         'rate', 300, 'revenue_ledger_id', v_expense)
    ))
  );

  set constraints all immediate;
  set constraints all deferred;

  -- Not vacuous: both rows exist, are this supplier's, and are in this year.
  -- The only reason neither is returned is the reference itself.
  perform pg_temp.expect(
    (select v.reference_number from public.vouchers v where v.id = v_none) is null
    and (select v.reference_number from public.vouchers v where v.id = v_blank) = '   ',
    'a purchase with no bill number, and one with only spaces, are both on the books'
  );

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, null, '2026-04-20', null)) = 0,
    'no bill number is not a duplicate of the other vouchers that have none'
  );

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, '   ', '2026-04-20', null)) = 0,
    'and a bill number of nothing but spaces is not a duplicate of one that is also blank'
  );

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, '', '2026-04-20', null)) = 0,
    'nor is an empty one'
  );

  -- A sales invoice number is minted by HISAB and already unique by
  -- constraint; the risk this guard exists for is inbound paper. Everything
  -- else about this voucher matches the query — same company, same party,
  -- same number, same year — so the only thing keeping it out is its type.
  v_sale := public.create_voucher(
    v_company, 'sales', '2026-04-09', 'our own invoice, numbered by us', 'INV-001', null,
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_debtor, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Consulting', 'quantity', 1,
                         'rate', 1000, 'revenue_ledger_id', v_income)
    ))
  );

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.reference_number from public.vouchers v where v.id = v_sale) = 'INV-001'
    and (select v.party_ledger_id from public.vouchers v where v.id = v_sale) = v_debtor,
    'a sales invoice carrying the same reference is on the books too'
  );

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_debtor, 'INV-001', '2026-04-20', null)) = 0,
    'and a sales voucher is never a duplicate bill, whatever its reference says'
  );

  -- The company argument scopes the answer, not merely the party argument.
  --
  -- No voucher in these books can name another company's ledger — the
  -- composite foreign key from 0022 makes it unrepresentable, and section 26
  -- proves it — so the two arguments always agree when the application passes
  -- them. This asserts what happens when they do not: a caller asking about
  -- our company with somebody else's supplier gets nothing, rather than a
  -- report of that company's purchases. RLS would also stand in the way of a
  -- real user, and this block is running as the owner with RLS bypassed, which
  -- is exactly why the function's own filter has to be there too.
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Bill Other Co', '2025-04-01', 4, 'INR') returning id into v_other_company;

  perform app_private.seed_chart_of_accounts(v_other_company);

  select id into v_group from public.account_groups
  where company_id = v_other_company and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_other_company, v_group, 'ZZ Bill Other Supplier') returning id into v_other_supplier;

  select id into v_group from public.account_groups
  where company_id = v_other_company and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name)
  values (v_other_company, v_group, 'ZZ Bill Other Purchases') returning id into v_other_expense;

  perform public.create_voucher(
    v_other_company, 'purchase', '2026-04-05', 'another company''s bill', 'INV-001', null,
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_other_supplier, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Steel sections', 'quantity', 1,
                         'rate', 900, 'revenue_ledger_id', v_other_expense)
    ))
  );

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_other_company, v_other_supplier, 'INV-001', '2026-04-20', null)) = 1,
    'the other company can find its own bill in its own books'
  );

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_other_supplier, 'INV-001', '2026-04-20', null)) = 0,
    'and this company asking about that supplier is told nothing at all'
  );

  -- A voucher that has been deleted is not in the books, so it is not a bill
  -- that has already been entered. Warning about one would send the user to
  -- look for a voucher the list no longer shows.
  v_deleted := public.create_voucher(
    v_company, 'purchase', '2026-04-10', 'entered, then deleted', 'INV-DEL', '2026-04-09',
    '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_supplier_a, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Steel sections', 'quantity', 1,
                         'rate', 400, 'revenue_ledger_id', v_expense)
    ))
  );

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, 'INV-DEL', '2026-04-20', null)) = 1,
    'a bill on the books is found before it is deleted'
  );

  update public.vouchers set is_deleted = true where id = v_deleted;
  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_company, v_supplier_a, 'INV-DEL', '2026-04-20', null)) = 0,
    'and not after, because a deleted voucher is not a bill that has been entered'
  );
end;
$$;

-- ------------------------------------------ 30. the outstanding party list

\echo '30. Who owes me, and who I owe'

-- get_outstanding_balances (0025) is the only report that names the parties
-- behind "Sundry Debtors". It has to be right about three separate things: who
-- belongs in the list, which way each balance points, and how much.
--
-- The fixture is one company holding every shape a party ledger can take —
-- a customer who owes, a customer in credit, a supplier who is owed, a
-- supplier holding an advance, a party settled to nil, a retired party still
-- carrying money, and one whose whole balance is an opening figure — plus
-- cash, sales and expense ledgers that must never appear whatever they hold.

do $$
declare
  v_company uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_expense uuid;
  v_owing uuid;
  v_settled uuid;
  v_advance uuid;
  v_retired uuid;
  v_retired_nil uuid;
  v_opening uuid;
  v_owed uuid;
  v_prepaid uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Outstanding Co', '2025-04-01', 4, 'INR') returning id into v_company;

  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Cash') returning id into v_cash;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Sales') returning id into v_sales;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Purchases') returning id into v_expense;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Owing Customer') returning id into v_owing;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Settled Customer') returning id into v_settled;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Advance Customer') returning id into v_advance;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Retired Customer') returning id into v_retired;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Retired Nil Customer') returning id into v_retired_nil;
  -- The only balance this one will ever have is the figure it was created
  -- with: a party carried over from the old books and never posted to since.
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_group, 'ZZ Out Opening Customer', 250, 'debit') returning id into v_opening;

  select id into v_group from public.account_groups
  where company_id = v_company and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Owed Supplier') returning id into v_owed;
  insert into public.ledgers (company_id, group_id, name)
  values (v_company, v_group, 'ZZ Out Prepaid Supplier') returning id into v_prepaid;

  -- Retired while empty, then posted to — the same route section 6 uses to
  -- reach "inactive and holding a balance" without tripping the 0017 guard.
  update public.ledgers set is_active = false where id in (v_retired, v_retired_nil);

  -- A customer bought on credit and part-paid: 5000 out, 1500 back, 3500 left.
  perform public.create_voucher(
    v_company, 'journal', '2026-04-05', 'goods sold on credit', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_owing, 'debit_amount', 5000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 5000, 'line_order', 1)
    )
  );
  perform public.create_voucher(
    v_company, 'receipt', '2026-05-20', 'part payment received', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 1500, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_owing, 'debit_amount', 0, 'credit_amount', 1500, 'line_order', 1)
    )
  );

  -- A customer who bought and paid in full. Two vouchers, an active ledger,
  -- and nothing left owing.
  perform public.create_voucher(
    v_company, 'journal', '2026-04-06', 'goods sold on credit', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_settled, 'debit_amount', 1000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales,   'debit_amount', 0, 'credit_amount', 1000, 'line_order', 1)
    )
  );
  perform public.create_voucher(
    v_company, 'receipt', '2026-04-25', 'settled in full', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,    'debit_amount', 1000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_settled, 'debit_amount', 0, 'credit_amount', 1000, 'line_order', 1)
    )
  );

  -- A customer who paid before taking delivery. Nothing has been sold to him,
  -- so his ledger sits in credit and the shop owes him 900 of goods.
  perform public.create_voucher(
    v_company, 'receipt', '2026-04-08', 'advance received against an order', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,    'debit_amount', 900, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_advance, 'debit_amount', 0, 'credit_amount', 900, 'line_order', 1)
    )
  );

  -- A customer nobody deals with any more who never cleared his last bill.
  perform public.create_voucher(
    v_company, 'journal', '2026-04-09', 'the last bill he never paid', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_retired, 'debit_amount', 700, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales,   'debit_amount', 0, 'credit_amount', 700, 'line_order', 1)
    )
  );

  -- A supplier billed 4000 and paid 1000: 3000 still to pay.
  perform public.create_voucher(
    v_company, 'journal', '2026-04-11', 'stock bought on credit', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_expense, 'debit_amount', 4000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_owed,    'debit_amount', 0, 'credit_amount', 4000, 'line_order', 1)
    )
  );
  perform public.create_voucher(
    v_company, 'payment', '2026-05-02', 'part payment made', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_owed, 'debit_amount', 1000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_cash, 'debit_amount', 0, 'credit_amount', 1000, 'line_order', 1)
    )
  );

  -- A supplier paid in advance against an order not yet delivered: his ledger
  -- sits in debit and he owes the shop 600 of goods.
  perform public.create_voucher(
    v_company, 'payment', '2026-04-14', 'advance paid against an order', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_prepaid, 'debit_amount', 600, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_cash,    'debit_amount', 0, 'credit_amount', 600, 'line_order', 1)
    )
  );

  set constraints all immediate;
  set constraints all deferred;

  perform set_config('test.out_company', v_company::text, false);
  perform set_config('test.out_cash', v_cash::text, false);
  perform set_config('test.out_sales', v_sales::text, false);
  perform set_config('test.out_expense', v_expense::text, false);
  perform set_config('test.out_owing', v_owing::text, false);
  perform set_config('test.out_settled', v_settled::text, false);
  perform set_config('test.out_advance', v_advance::text, false);
  perform set_config('test.out_retired', v_retired::text, false);
  perform set_config('test.out_retired_nil', v_retired_nil::text, false);
  perform set_config('test.out_opening', v_opening::text, false);
  perform set_config('test.out_owed', v_owed::text, false);
  perform set_config('test.out_prepaid', v_prepaid::text, false);
end;
$$;

do $$
declare
  v_company uuid := current_setting('test.out_company')::uuid;
  v_row record;
  v_receivables numeric(18,2);
  v_payables numeric(18,2);
  v_first uuid;
  v_descending boolean;
begin
  -- A customer who owes is a receivable, for the amount still standing, dated
  -- by the last thing that touched him — not by the sale that opened the debt.
  select * into v_row from public.get_outstanding_balances(v_company) o
  where o.ledger_id = current_setting('test.out_owing')::uuid;

  perform pg_temp.expect(
    v_row.direction = 'receivable' and v_row.party_kind = 'customer'
    and v_row.amount = 3500.00 and v_row.last_transaction_date = '2026-05-20'::date,
    format('a customer who owes is a receivable for what is left (%s %s, last %s)',
           v_row.direction, v_row.amount, v_row.last_transaction_date)
  );

  -- And a supplier who is owed is the mirror image.
  select * into v_row from public.get_outstanding_balances(v_company) o
  where o.ledger_id = current_setting('test.out_owed')::uuid;

  perform pg_temp.expect(
    v_row.direction = 'payable' and v_row.party_kind = 'supplier'
    and v_row.amount = 3000.00 and v_row.last_transaction_date = '2026-05-02'::date,
    format('a supplier who is owed is a payable for what is left (%s %s, last %s)',
           v_row.direction, v_row.amount, v_row.last_transaction_date)
  );

  -- A party carried over from the old books and never posted to since is
  -- still owed, and saying so is the point. last_transaction_date is null
  -- because nothing has happened to him — inventing the opening date would be
  -- reporting a transaction that was never entered.
  select * into v_row from public.get_outstanding_balances(v_company) o
  where o.ledger_id = current_setting('test.out_opening')::uuid;

  perform pg_temp.expect(
    v_row.direction = 'receivable' and v_row.amount = 250.00,
    'an opening balance with no vouchers behind it is still outstanding'
  );
  perform pg_temp.expect(
    v_row.last_transaction_date is null,
    'and it has no last transaction date, because it has had no transactions'
  );

  -- 0017's rule, in a new report: is_active hides a ledger from the pickers,
  -- never from the statements. A retired customer who never paid is money
  -- that is still out there.
  perform pg_temp.expect(
    (select o.amount from public.get_outstanding_balances(v_company) o
     where o.ledger_id = current_setting('test.out_retired')::uuid) = 700.00,
    'an inactive ledger still holding a balance is still listed'
  );
  perform pg_temp.expect(
    (select l.is_active from public.ledgers l
     where l.id = current_setting('test.out_retired')::uuid) = false,
    'and it really is inactive, so that assertion was not vacuous'
  );

  -- The totals the screen puts at the top of each section.
  -- Receivable: 3500 owing + 700 retired + 250 opening + 600 supplier advance.
  -- Payable:    3000 owed  + 900 customer advance.
  select
    coalesce(sum(o.amount) filter (where o.direction = 'receivable'), 0),
    coalesce(sum(o.amount) filter (where o.direction = 'payable'), 0)
  into v_receivables, v_payables
  from public.get_outstanding_balances(v_company) o;

  perform pg_temp.expect(
    v_receivables = 5050.00 and v_payables = 3900.00,
    format('the two totals are the sums of their own sides (in %s, out %s)', v_receivables, v_payables)
  );

  -- Biggest first: the largest debtor is what the user opened the screen for.
  select o.ledger_id into v_first
  from public.get_outstanding_balances(v_company) o limit 1;

  perform pg_temp.expect(
    v_first = current_setting('test.out_owing')::uuid,
    'the largest outstanding amount comes back first'
  );

  select bool_and(ordered.amount <= ordered.prev_amount) into v_descending
  from (
    select o.amount, lag(o.amount) over () as prev_amount
    from public.get_outstanding_balances(v_company) o
  ) ordered
  where ordered.prev_amount is not null;

  perform pg_temp.expect(
    v_descending,
    'and the rest follow in descending order of amount'
  );
end;
$$;

-- ------------------------------- 31. and nothing that is not owed by a party

\echo '31. And nothing that is not money owed by a party'

-- The half that decides whether the list is worth opening. A settled customer
-- who keeps appearing at zero, or a cash ledger listed as a debtor, turns the
-- screen into something to scroll past.
--
-- The wrong-side cases are here rather than in 30 because they are the
-- decision this function makes that the Balance Sheet had to make before it,
-- in 0012: the side follows the sign of the balance, not the classification of
-- the group. A customer in credit is not a receivable of negative value, it is
-- money the shop owes.

do $$
declare
  v_company uuid := current_setting('test.out_company')::uuid;
  v_row record;
  v_other_company uuid;
  v_other_debtor uuid;
  v_other_sales uuid;
  v_group uuid;
begin
  -- A customer who paid an advance is a payable, and still says he is a
  -- customer. Both halves matter: the direction is the accounting fact, and
  -- the kind is what lets the screen explain the odd-looking row instead of
  -- quietly filing him among the suppliers.
  select * into v_row from public.get_outstanding_balances(v_company) o
  where o.ledger_id = current_setting('test.out_advance')::uuid;

  perform pg_temp.expect(
    v_row.direction = 'payable' and v_row.amount = 900.00,
    format('a customer sitting in credit is a payable, not a negative receivable (%s %s)',
           v_row.direction, v_row.amount)
  );
  perform pg_temp.expect(
    v_row.party_kind = 'customer',
    'and he is still reported as a customer, so the screen can say why he is there'
  );

  -- The mirror: a supplier holding our advance owes us goods.
  select * into v_row from public.get_outstanding_balances(v_company) o
  where o.ledger_id = current_setting('test.out_prepaid')::uuid;

  perform pg_temp.expect(
    v_row.direction = 'receivable' and v_row.amount = 600.00 and v_row.party_kind = 'supplier',
    format('a supplier holding an advance is a receivable, still reported as a supplier (%s %s)',
           v_row.direction, v_row.amount)
  );

  -- Settled is settled. Not vacuous: the ledger exists, is active, and has two
  -- vouchers behind it — the only reason it is absent is that it nets to nil.
  perform pg_temp.expect(
    (select count(*) from public.voucher_entries ve
     where ve.ledger_id = current_setting('test.out_settled')::uuid) = 2
    and (select l.is_active from public.ledgers l
         where l.id = current_setting('test.out_settled')::uuid),
    'the settled customer is an active ledger with entries against him'
  );
  perform pg_temp.expect(
    not exists (
      select 1 from public.get_outstanding_balances(v_company) o
      where o.ledger_id = current_setting('test.out_settled')::uuid
    ),
    'and a party who has settled up does not appear at all'
  );

  perform pg_temp.expect(
    not exists (
      select 1 from public.get_outstanding_balances(v_company) o
      where o.ledger_id = current_setting('test.out_retired_nil')::uuid
    ),
    'nor does an inactive party at nil — is_active is overridden by a balance, not by nothing'
  );

  -- Cash, sales and purchases all carry balances in this company. None of them
  -- is a party, and a list that included them would answer a different
  -- question than the one on the screen.
  perform pg_temp.expect(
    (select count(*) from public.get_trial_balance(v_company, '9999-12-31') tb
     where tb.ledger_id in (
       current_setting('test.out_cash')::uuid,
       current_setting('test.out_sales')::uuid,
       current_setting('test.out_expense')::uuid
     ) and (tb.debit_balance <> 0 or tb.credit_balance <> 0)) = 3,
    'the cash, sales and purchase ledgers all hold balances'
  );
  perform pg_temp.expect(
    not exists (
      select 1 from public.get_outstanding_balances(v_company) o
      where o.ledger_id in (
        current_setting('test.out_cash')::uuid,
        current_setting('test.out_sales')::uuid,
        current_setting('test.out_expense')::uuid
      )
    ),
    'and none of them is listed as somebody who owes money'
  );

  -- The company argument scopes the answer. This block runs as the table owner
  -- with RLS bypassed, so what is being tested is the function's own
  -- company_id filter rather than the policy that would also stand in a real
  -- user's way — and removing that filter is a mutation nothing else catches.
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Outstanding Other Co', '2025-04-01', 4, 'INR') returning id into v_other_company;

  perform app_private.seed_chart_of_accounts(v_other_company);

  select id into v_group from public.account_groups
  where company_id = v_other_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name)
  values (v_other_company, v_group, 'ZZ Out Other Customer') returning id into v_other_debtor;

  select id into v_group from public.account_groups
  where company_id = v_other_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name)
  values (v_other_company, v_group, 'ZZ Out Other Sales') returning id into v_other_sales;

  perform public.create_voucher(
    v_other_company, 'journal', '2026-04-05', 'another company''s credit sale', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_other_debtor, 'debit_amount', 9999, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_other_sales,  'debit_amount', 0, 'credit_amount', 9999, 'line_order', 1)
    )
  );

  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select o.amount from public.get_outstanding_balances(v_other_company) o
     where o.ledger_id = v_other_debtor) = 9999.00,
    'the other company can see its own debtor in its own books'
  );

  -- 9999 is larger than anything in the first company's books, so had it
  -- leaked it would be the first row rather than a missing one.
  perform pg_temp.expect(
    not exists (
      select 1 from public.get_outstanding_balances(v_company) o
      where o.ledger_id = v_other_debtor
    ),
    'and this company is told nothing about it'
  );
  perform pg_temp.expect(
    (select count(*) from public.get_outstanding_balances(v_company)) = 6,
    'this company sees six outstanding parties and no seventh'
  );
end;
$$;

-- ------------------------------------- 32. the P&L reports a nominal ledger
--                                           with the sign it actually carries

\echo '32. An income ledger in debit reduces income; an expense ledger in credit reduces expense'

-- Two companies, identical up to the point where one of them takes goods back.
--
-- ZZ PL Plain is the everyday book: sales, purchases, commission, rent, every
-- ledger sitting on the side its group implies. It exists so that "the sign is
-- reported" cannot be satisfied by a function that simply negates everything.
--
-- ZZ PL Returns adds the three ways a nominal ledger ends up on the other
-- side, all of them ordinary:
--
--   * a credit note larger than the sales booked so far, which leaves the
--     Sales ledger itself in debit;
--   * a "Sales Returns" ledger grouped under Direct Incomes, which carries a
--     debit for its whole life -- Tally's own arrangement, not a one-off;
--   * a "Purchase Returns" ledger under Direct Expenses, the mirror of it.
--
-- get_profit_and_loss used to wrap the group's own signed sum in abs(), so all
-- three were reported as magnitudes and the P&L page -- which computes
-- income - expense over them -- added every one of them the wrong way round.

do $$
declare
  v_plain uuid;
  v_returns uuid;
  v_company uuid;
  v_group uuid;
  v_cash uuid; v_sales uuid; v_sret uuid; v_purch uuid; v_pret uuid;
  v_comm uuid; v_rent uuid;
  v_which int;
begin
  for v_which in 1..2 loop
    insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
    values (case when v_which = 1 then 'ZZ PL Plain Co' else 'ZZ PL Returns Co' end,
            '2025-04-01', 4, 'INR')
    returning id into v_company;

    perform app_private.seed_chart_of_accounts(v_company);

    select id into v_group from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
    insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ PL Cash') returning id into v_cash;

    select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Incomes';
    insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ PL Sales') returning id into v_sales;
    insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ PL Sales Returns') returning id into v_sret;

    select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Expenses';
    insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ PL Purchases') returning id into v_purch;
    insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ PL Purchase Returns') returning id into v_pret;

    select id into v_group from public.account_groups where company_id = v_company and name = 'Indirect Incomes';
    insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ PL Commission') returning id into v_comm;

    select id into v_group from public.account_groups where company_id = v_company and name = 'Indirect Expenses';
    insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ PL Rent') returning id into v_rent;

    -- The ordinary trading both companies share: 6750 sold, 2000 bought,
    -- 500 of commission earned, 1200 of rent paid. Net result 4050.
    perform public.create_voucher(v_company, 'journal', '2026-05-05', 'ZZ PL sold for cash', null, null,
      jsonb_build_array(
        jsonb_build_object('ledger_id', v_cash,  'debit_amount', 6750, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 6750, 'line_order', 1)));
    perform public.create_voucher(v_company, 'journal', '2026-05-15', 'ZZ PL bought for cash', null, null,
      jsonb_build_array(
        jsonb_build_object('ledger_id', v_purch, 'debit_amount', 2000, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', v_cash,  'debit_amount', 0, 'credit_amount', 2000, 'line_order', 1)));
    perform public.create_voucher(v_company, 'journal', '2026-05-18', 'ZZ PL commission earned', null, null,
      jsonb_build_array(
        jsonb_build_object('ledger_id', v_cash, 'debit_amount', 500, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', v_comm, 'debit_amount', 0, 'credit_amount', 500, 'line_order', 1)));
    perform public.create_voucher(v_company, 'journal', '2026-05-25', 'ZZ PL rent paid', null, null,
      jsonb_build_array(
        jsonb_build_object('ledger_id', v_rent, 'debit_amount', 1200, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', v_cash, 'debit_amount', 0, 'credit_amount', 1200, 'line_order', 1)));

    if v_which = 2 then
      -- A credit note for more than has been billed so far. The customer is
      -- owed 10000 against 6750 of sales, so the Sales ledger ends in debit.
      perform public.create_voucher(v_company, 'journal', '2026-06-10', 'ZZ PL credit note against sales', null, null,
        jsonb_build_array(
          jsonb_build_object('ledger_id', v_sales, 'debit_amount', 10000, 'credit_amount', 0, 'line_order', 0),
          jsonb_build_object('ledger_id', v_cash,  'debit_amount', 0, 'credit_amount', 10000, 'line_order', 1)));
      -- Goods came back, booked to Sales Returns under Direct Incomes.
      perform public.create_voucher(v_company, 'journal', '2026-06-12', 'ZZ PL goods came back', null, null,
        jsonb_build_array(
          jsonb_build_object('ledger_id', v_sret, 'debit_amount', 2500, 'credit_amount', 0, 'line_order', 0),
          jsonb_build_object('ledger_id', v_cash, 'debit_amount', 0, 'credit_amount', 2500, 'line_order', 1)));
      -- And goods went back, booked to Purchase Returns under Direct Expenses.
      perform public.create_voucher(v_company, 'journal', '2026-06-14', 'ZZ PL sent goods back', null, null,
        jsonb_build_array(
          jsonb_build_object('ledger_id', v_cash, 'debit_amount', 1500, 'credit_amount', 0, 'line_order', 0),
          jsonb_build_object('ledger_id', v_pret, 'debit_amount', 0, 'credit_amount', 1500, 'line_order', 1)));

      v_returns := v_company;
      perform set_config('test.pl_r_sales', v_sales::text, false);
      perform set_config('test.pl_r_sret', v_sret::text, false);
      perform set_config('test.pl_r_purch', v_purch::text, false);
      perform set_config('test.pl_r_pret', v_pret::text, false);
      perform set_config('test.pl_r_comm', v_comm::text, false);
      perform set_config('test.pl_r_rent', v_rent::text, false);
    else
      v_plain := v_company;
      perform set_config('test.pl_p_sales', v_sales::text, false);
      perform set_config('test.pl_p_purch', v_purch::text, false);
    end if;
  end loop;

  set constraints all immediate;
  set constraints all deferred;

  perform set_config('test.pl_plain', v_plain::text, false);
  perform set_config('test.pl_returns', v_returns::text, false);
end;
$$;

do $$
declare
  v_plain uuid := current_setting('test.pl_plain')::uuid;
  v_returns uuid := current_setting('test.pl_returns')::uuid;
  v_amount numeric;
begin
  -- The everyday book first, so nothing below can pass by negating blindly.
  select amount into v_amount from public.get_profit_and_loss(v_plain, '2025-04-01', '2026-12-31')
  where ledger_id = current_setting('test.pl_p_sales')::uuid;
  perform pg_temp.expect(v_amount = 6750.00,
    format('an ordinary income ledger is reported positive (%s)', v_amount));

  select amount into v_amount from public.get_profit_and_loss(v_plain, '2025-04-01', '2026-12-31')
  where ledger_id = current_setting('test.pl_p_purch')::uuid;
  perform pg_temp.expect(v_amount = 2000.00,
    format('and an ordinary expense ledger is reported positive too (%s)', v_amount));

  -- The fixture really does leave these three ledgers on the far side. Asserted
  -- against the Trial Balance, which has always reported them correctly, so
  -- that a failure below is the P&L's and not the fixture's.
  perform pg_temp.expect(
    (select tb.debit_balance from public.get_trial_balance(v_returns, '2026-12-31') tb
     where tb.ledger_id = current_setting('test.pl_r_sales')::uuid) = 3250.00,
    'the Trial Balance shows the reversed Sales ledger sitting 3250 in debit'
  );
  perform pg_temp.expect(
    (select tb.debit_balance from public.get_trial_balance(v_returns, '2026-12-31') tb
     where tb.ledger_id = current_setting('test.pl_r_sret')::uuid) = 2500.00,
    'and Sales Returns, an income-nature ledger, 2500 in debit'
  );
  perform pg_temp.expect(
    (select tb.credit_balance from public.get_trial_balance(v_returns, '2026-12-31') tb
     where tb.ledger_id = current_setting('test.pl_r_pret')::uuid) = 1500.00,
    'and Purchase Returns, an expense-nature ledger, 1500 in credit'
  );

  -- An income ledger left in debit REDUCES income. Reported as a magnitude it
  -- would read 3250 and be added to sales, overstating income by 6500 -- twice
  -- the reversal, which is the shape of this whole family of defects.
  select amount into v_amount from public.get_profit_and_loss(v_returns, '2025-04-01', '2026-12-31')
  where ledger_id = current_setting('test.pl_r_sales')::uuid;
  perform pg_temp.expect(v_amount = -3250.00,
    format('an income ledger left in debit by a reversal reduces income (%s)', v_amount));

  select amount into v_amount from public.get_profit_and_loss(v_returns, '2025-04-01', '2026-12-31')
  where ledger_id = current_setting('test.pl_r_sret')::uuid;
  perform pg_temp.expect(v_amount = -2500.00,
    format('a Sales Returns ledger under Direct Incomes likewise (%s)', v_amount));

  -- The mirror image: an expense ledger left in credit reduces expense.
  select amount into v_amount from public.get_profit_and_loss(v_returns, '2025-04-01', '2026-12-31')
  where ledger_id = current_setting('test.pl_r_pret')::uuid;
  perform pg_temp.expect(v_amount = -1500.00,
    format('an expense ledger left in credit by a refund reduces expense (%s)', v_amount));

  -- And the two that never moved off their own side are untouched by all of it.
  select amount into v_amount from public.get_profit_and_loss(v_returns, '2025-04-01', '2026-12-31')
  where ledger_id = current_setting('test.pl_r_comm')::uuid;
  perform pg_temp.expect(v_amount = 500.00, 'an indirect income ledger is still reported positive');

  select amount into v_amount from public.get_profit_and_loss(v_returns, '2025-04-01', '2026-12-31')
  where ledger_id = current_setting('test.pl_r_rent')::uuid;
  perform pg_temp.expect(v_amount = 1200.00, 'and an indirect expense ledger too');
end;
$$;

-- ------------------------- 33. and the two statements agree on the net result

\echo '33. The P&L''s net profit is the Balance Sheet''s Net Profit line'

-- The arithmetic the P&L page does over those rows, reproduced exactly:
--   gross = sum(direct_income) - sum(direct_expense)
--   net   = gross + sum(indirect_income) - sum(indirect_expense)
-- See app/(app)/[companyId]/reports/profit-loss/page.tsx. This is the figure a
-- user reads off the screen, so it is the figure that has to be checked --
-- asserting the function's rows in isolation would have let this defect stand.
create or replace function pg_temp.pl_net(p_company uuid, p_from date, p_to date)
returns numeric language sql stable as $$
  select
    coalesce(sum(amount) filter (where nature = 'direct_income'), 0)
  - coalesce(sum(amount) filter (where nature = 'direct_expense'), 0)
  + coalesce(sum(amount) filter (where nature = 'indirect_income'), 0)
  - coalesce(sum(amount) filter (where nature = 'indirect_expense'), 0)
  from public.get_profit_and_loss(p_company, p_from, p_to);
$$;

-- The Balance Sheet's own Net Profit/Loss line, signed: a profit sits on the
-- liability side and a loss on the asset side. Named rather than taken from
-- "every synthetic row", because the sheet also carries a line for a trading
-- result brought forward and that one is not this period's result.
create or replace function pg_temp.bs_net(p_company uuid, p_as_of date)
returns numeric language sql stable as $$
  select coalesce(sum(case when b.side = 'liability' then b.amount else -b.amount end), 0)
  from public.get_balance_sheet(p_company, p_as_of) b
  where b.ledger_id is null
    and b.ledger_name in ('Net Profit (Current Period)', 'Net Loss (Current Period)');
$$;

do $$
declare
  v_plain uuid := current_setting('test.pl_plain')::uuid;
  v_returns uuid := current_setting('test.pl_returns')::uuid;
  v_date date;
  v_name text;
begin
  -- Without a reversal anywhere on the books. This is the case that already
  -- worked, and it is here so that a fix which agrees only in the awkward case
  -- cannot pass.
  perform pg_temp.expect(pg_temp.pl_net(v_plain, '2025-04-01', '2026-12-31') = 4050.00,
    format('the plain book''s net profit is 4050 (%s)', pg_temp.pl_net(v_plain, '2025-04-01', '2026-12-31')));
  perform pg_temp.expect(pg_temp.bs_net(v_plain, '2026-12-31') = 4050.00,
    format('and the Balance Sheet says 4050 too (%s)', pg_temp.bs_net(v_plain, '2026-12-31')));

  -- With one. 6750 sold less 10000 credited back is 3250 of negative sales;
  -- 2500 of sales returns; 2000 of purchases less 1500 returned; 500 earned
  -- and 1200 spent. A loss of 6950, where the abs() reported a profit of 1550.
  perform pg_temp.expect(pg_temp.pl_net(v_returns, '2025-04-01', '2026-12-31') = -6950.00,
    format('the reversed book''s net result is a loss of 6950 (%s)', pg_temp.pl_net(v_returns, '2025-04-01', '2026-12-31')));
  perform pg_temp.expect(pg_temp.bs_net(v_returns, '2026-12-31') = -6950.00,
    format('and the Balance Sheet agrees to the paisa (%s)', pg_temp.bs_net(v_returns, '2026-12-31')));

  -- The same equality on every date either book has activity on, in both
  -- books, so it is the identity being asserted and not one lucky total.
  foreach v_date in array array['2026-05-04'::date, '2026-05-05', '2026-05-25', '2026-06-09',
                                '2026-06-10', '2026-06-14', '2026-12-31'] loop
    perform pg_temp.expect(
      pg_temp.pl_net(v_plain, '2025-04-01', v_date) = pg_temp.bs_net(v_plain, v_date),
      format('plain book: the two statements agree at %s (%s)', v_date, pg_temp.bs_net(v_plain, v_date))
    );
    perform pg_temp.expect(
      pg_temp.pl_net(v_returns, '2025-04-01', v_date) = pg_temp.bs_net(v_returns, v_date),
      format('reversed book: the two statements agree at %s (%s)', v_date, pg_temp.bs_net(v_returns, v_date))
    );
  end loop;

  -- The Balance Sheet says so in words as well as in figures: a negative
  -- result is a Net Loss on the asset side, not a Net Profit on the other one.
  select b.ledger_name into v_name from public.get_balance_sheet(v_returns, '2026-12-31') b
  where b.ledger_id is null and b.ledger_name like 'Net %';
  perform pg_temp.expect(v_name = 'Net Loss (Current Period)',
    format('and calls it a loss rather than a profit (%s)', v_name));

  -- Both sheets still tally, which is the property the Net Profit line exists
  -- to produce and the one a wrong sign would break.
  perform pg_temp.expect(
    (select coalesce(sum(b.amount) filter (where b.side = 'asset'), 0)
          - coalesce(sum(b.amount) filter (where b.side = 'liability'), 0)
     from public.get_balance_sheet(v_returns, '2026-12-31') b) = 0,
    'and the reversed book''s Balance Sheet still tallies'
  );
end;
$$;

-- ---------------- 34. the Balance Sheet accounts for every balance on the books

\echo '34. The Balance Sheet''s profit figure covers the same books its ledger lines do'

-- The sheet tallies by construction only if its profit figure is drawn from
-- the same window and the same balances as the ledger lines it has to balance
-- against. It was drawn from neither:
--
--   * the ledger lines have no lower date bound; the profit figure started at
--     book_beginning_date. A voucher dated before that -- nothing in the
--     schema forbids one -- landed in the lines and not in the profit, and the
--     sheet went out by exactly that voucher;
--   * the ledger lines include each ledger's opening balance; the profit
--     figure read voucher_entries only. An opening balance on an income or
--     expense ledger -- what somebody migrating mid-year does when they carry
--     their year-to-date sales across -- appeared on neither side of the
--     sheet, and was silently lost.
--
-- Both fixtures assert the Trial Balance first. It has never had either bound,
-- so it is the independent witness that the books themselves are sound and the
-- disagreement is the Balance Sheet's.

do $$
declare
  v_early uuid;
  v_carried uuid;
  v_carried_loss uuid;
  v_group uuid;
  v_cash uuid; v_sales uuid; v_capital uuid; v_expense uuid;
begin
  -- (a) a voucher dated before the books were declared to begin.
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ BS Early Co', '2025-04-01', 4, 'INR') returning id into v_early;
  perform app_private.seed_chart_of_accounts(v_early);

  select id into v_group from public.account_groups where company_id = v_early and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_early, v_group, 'ZZ BE Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_early and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_early, v_group, 'ZZ BE Sales') returning id into v_sales;

  perform public.create_voucher(v_early, 'journal', '2025-03-31', 'ZZ BE dated before book beginning', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 1000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 1000, 'line_order', 1)));
  perform public.create_voucher(v_early, 'journal', '2026-05-01', 'ZZ BE an ordinary sale', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 500, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 500, 'line_order', 1)));

  -- (b) trading results carried in as opening balances on nominal ledgers.
  -- 9000 of sales and 4000 of expenses brought forward net to a 5000 profit
  -- carried in; the openings across the company tally, 13000 against 13000,
  -- because a Balance Sheet cannot be expected to agree when they do not.
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ BS Carried Co', '2025-04-01', 4, 'INR') returning id into v_carried;
  perform app_private.seed_chart_of_accounts(v_carried);

  select id into v_group from public.account_groups where company_id = v_carried and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_carried, v_group, 'ZZ BC Cash', 9000, 'debit') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_carried and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_carried, v_group, 'ZZ BC Sales Brought Forward', 9000, 'credit') returning id into v_sales;
  select id into v_group from public.account_groups where company_id = v_carried and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_carried, v_group, 'ZZ BC Expenses Brought Forward', 4000, 'debit') returning id into v_expense;
  select id into v_group from public.account_groups where company_id = v_carried and name = 'Capital Account';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_carried, v_group, 'ZZ BC Capital', 4000, 'credit') returning id into v_capital;

  -- (c) the mirror: more expense than income brought forward, so what comes
  -- across is a loss and belongs on the other side of the sheet.
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ BS Carried Loss Co', '2025-04-01', 4, 'INR') returning id into v_carried_loss;
  perform app_private.seed_chart_of_accounts(v_carried_loss);

  select id into v_group from public.account_groups where company_id = v_carried_loss and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_carried_loss, v_group, 'ZZ BL Expenses Brought Forward', 3000, 'debit');
  select id into v_group from public.account_groups where company_id = v_carried_loss and name = 'Capital Account';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_carried_loss, v_group, 'ZZ BL Capital', 3000, 'credit');

  set constraints all immediate;
  set constraints all deferred;

  perform set_config('test.bs_early', v_early::text, false);
  perform set_config('test.bs_carried', v_carried::text, false);
  perform set_config('test.bs_carried_loss', v_carried_loss::text, false);
  perform set_config('test.bs_c_sales', v_sales::text, false);
end;
$$;

do $$
declare
  v_early uuid := current_setting('test.bs_early')::uuid;
  v_carried uuid := current_setting('test.bs_carried')::uuid;
  v_loss uuid := current_setting('test.bs_carried_loss')::uuid;
  v_row record;
begin
  -- (a) The pre-book-beginning voucher exists and is ordinary: balanced, not
  -- deleted, and refused by nothing.
  perform pg_temp.expect(
    exists (select 1 from public.vouchers v
            where v.company_id = v_early and v.is_deleted = false
              and v.voucher_date < (select c.book_beginning_date from public.companies c where c.id = v_early)),
    'a voucher dated before book_beginning_date can be written down at all'
  );
  perform pg_temp.expect(
    (select coalesce(sum(tb.debit_balance), 0) from public.get_trial_balance(v_early, '2026-06-30') tb) = 1500.00
    and (select coalesce(sum(tb.credit_balance), 0) from public.get_trial_balance(v_early, '2026-06-30') tb) = 1500.00,
    'and the Trial Balance, which has no lower bound, counts it on both sides at 1500'
  );
  perform pg_temp.expect(
    (select coalesce(sum(b.amount) filter (where b.side = 'asset'), 0)
          - coalesce(sum(b.amount) filter (where b.side = 'liability'), 0)
     from public.get_balance_sheet(v_early, '2026-06-30') b) = 0,
    'so the Balance Sheet''s two sides agree despite it'
  );
  perform pg_temp.expect(
    pg_temp.bs_net(v_early, '2026-06-30') = 1500.00,
    format('because its profit figure counts every entry on the books, not only those since book beginning (%s)',
           pg_temp.bs_net(v_early, '2026-06-30'))
  );
  -- The P&L is period-scoped and says so: asked for the year it reports 500,
  -- and only a window that reaches back past the early voucher reproduces the
  -- Balance Sheet. That is the relationship between the two, stated rather
  -- than glossed over.
  perform pg_temp.expect(
    pg_temp.pl_net(v_early, '2025-04-01', '2026-06-30') = 500.00,
    'a P&L asked for a window that starts after the early voucher does not count it'
  );
  perform pg_temp.expect(
    pg_temp.pl_net(v_early, '0001-01-01', '2026-06-30') = pg_temp.bs_net(v_early, '2026-06-30'),
    'and a P&L asked for the whole of the books lands exactly on the Balance Sheet''s figure'
  );

  -- (b) The carried-forward trading result.
  perform pg_temp.expect(
    (select tb.credit_balance from public.get_trial_balance(v_carried, '2026-06-30') tb
     where tb.ledger_id = current_setting('test.bs_c_sales')::uuid) = 9000.00,
    'the Trial Balance reports an income ledger''s opening credit'
  );
  perform pg_temp.expect(
    (select coalesce(sum(tb.debit_balance), 0) from public.get_trial_balance(v_carried, '2026-06-30') tb)
    = (select coalesce(sum(tb.credit_balance), 0) from public.get_trial_balance(v_carried, '2026-06-30') tb),
    'and tallies, so the books themselves are sound'
  );
  perform pg_temp.expect(
    (select count(*) from public.get_profit_and_loss(v_carried, '2025-04-01', '2026-06-30')) = 0,
    'the P&L reports nothing, because an opening balance is not activity in a period'
  );
  perform pg_temp.expect(
    (select coalesce(sum(b.amount) filter (where b.side = 'asset'), 0)
          - coalesce(sum(b.amount) filter (where b.side = 'liability'), 0)
     from public.get_balance_sheet(v_carried, '2026-06-30') b) = 0,
    'and the Balance Sheet still tallies, so the carried figure was not lost'
  );

  select * into v_row from public.get_balance_sheet(v_carried, '2026-06-30') b
  where b.ledger_id is null and b.ledger_name like 'Opening %';
  perform pg_temp.expect(
    v_row.side = 'liability' and v_row.amount = 5000.00
    and v_row.ledger_name = 'Opening Profit (Brought Forward)',
    format('it is reported under its own name, netted: 9000 of income less 4000 of expense (%s %s %s)',
           v_row.ledger_name, v_row.side, v_row.amount)
  );
  perform pg_temp.expect(
    pg_temp.bs_net(v_carried, '2026-06-30') = 0.00
    and pg_temp.pl_net(v_carried, '2025-04-01', '2026-06-30') = 0.00,
    'and the Net Profit line is still this period''s result -- nil -- so the two statements still agree'
  );

  -- (c) And the other way round.
  select * into v_row from public.get_balance_sheet(v_loss, '2026-06-30') b
  where b.ledger_id is null and b.ledger_name like 'Opening %';
  perform pg_temp.expect(
    v_row.side = 'asset' and v_row.amount = 3000.00
    and v_row.ledger_name = 'Opening Loss (Brought Forward)',
    format('more expense than income brought forward is a loss, on the asset side (%s %s %s)',
           v_row.ledger_name, v_row.side, v_row.amount)
  );
  perform pg_temp.expect(
    (select coalesce(sum(b.amount) filter (where b.side = 'asset'), 0)
          - coalesce(sum(b.amount) filter (where b.side = 'liability'), 0)
     from public.get_balance_sheet(v_loss, '2026-06-30') b) = 0,
    'and that sheet tallies too'
  );

  -- No book that has neither gets a line it did not have before.
  perform pg_temp.expect(
    not exists (
      select 1 from public.get_balance_sheet(current_setting('test.pl_returns')::uuid, '2026-12-31') b
      where b.ledger_id is null and b.ledger_name like 'Opening %'
    ),
    'and a company with nothing brought forward grows no such line'
  );
end;
$$;

-- ------------------- 35. an overdraft named for cash is a bank, not a till

\echo '35. A bank overdraft in a group whose name contains "cash" is reported as bank'

-- "Cash Credit Accounts" is the standard Indian name for a bank overdraft
-- facility, and get_dashboard_summary split cash from bank on
-- `g.name ilike '%cash%'`. So an overdrawn cash credit account was subtracted
-- from physical cash: with 1,83,240 drawn the dashboard reported a till
-- holding minus a lakh of rupees, which is not a thing that can happen.
--
-- The fixture also carries a group renamed "Petty Cash", because the cheap
-- version of this fix -- excluding anything with a qualifier in its name --
-- would file a real till as a bank and be just as wrong in the other
-- direction.

do $$
declare
  v_company uuid;
  v_ca uuid;
  v_group uuid;
  v_cc_group uuid;
  v_petty_group uuid;
  v_till uuid; v_petty uuid; v_current uuid; v_cc uuid; v_rent uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Tiles Co', '2025-04-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_ca from public.account_groups where company_id = v_company and name = 'Current Assets';

  -- The company's own cash/bank groups, filed exactly as the ledger form
  -- would file them: the cash_bank role, under Current Assets.
  insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
  values (v_company, v_ca, 'Cash Credit Accounts', 'current_asset', 'debit', 'cash_bank', 5)
  returning id into v_cc_group;
  insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
  values (v_company, v_ca, 'Petty Cash', 'current_asset', 'debit', 'cash_bank', 6)
  returning id into v_petty_group;

  select id into v_group from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_group, 'ZZ T Till', 5000, 'debit') returning id into v_till;

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_petty_group, 'ZZ T Petty Cash Box', 1500, 'debit') returning id into v_petty;

  select id into v_group from public.account_groups where company_id = v_company and name = 'Bank Accounts';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_group, 'ZZ T Current A/c', 20000, 'debit') returning id into v_current;

  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type)
  values (v_company, v_cc_group, 'ZZ T ICICI Cash Credit A/c', 183240, 'credit') returning id into v_cc;

  select id into v_group from public.account_groups where company_id = v_company and name = 'Indirect Expenses';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ T Rent') returning id into v_rent;

  -- One payment out of the overdraft this month, so the change and movement
  -- tiles have something to be right or wrong about.
  perform public.create_voucher(v_company, 'payment', '2026-06-10', 'ZZ T rent paid from the cash credit account', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_rent, 'debit_amount', 1000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_cc,   'debit_amount', 0, 'credit_amount', 1000, 'line_order', 1)));

  set constraints all immediate;
  set constraints all deferred;

  perform set_config('test.tiles_company', v_company::text, false);
  perform set_config('test.tiles_cc_group', v_cc_group::text, false);
  perform set_config('test.tiles_petty_group', v_petty_group::text, false);
  perform set_config('test.tiles_till', v_till::text, false);
  perform set_config('test.tiles_petty', v_petty::text, false);
  perform set_config('test.tiles_current', v_current::text, false);
  perform set_config('test.tiles_cc', v_cc::text, false);
end;
$$;

do $$
declare
  v_company uuid := current_setting('test.tiles_company')::uuid;
  d record;
begin
  -- Not vacuous: the group really is a cash/bank group, and its name really
  -- does contain "cash". Rename it and the old code reported both tiles
  -- correctly, which is what proved the name was the cause.
  perform pg_temp.expect(
    (select g.ledger_role = 'cash_bank' and g.name ilike '%cash%'
     from public.account_groups g where g.id = current_setting('test.tiles_cc_group')::uuid),
    'the cash credit group is a cash/bank group whose name contains "cash"'
  );
  perform pg_temp.expect(
    (select tb.credit_balance from public.get_trial_balance(v_company, '2026-06-30') tb
     where tb.ledger_id = current_setting('test.tiles_cc')::uuid) = 184240.00,
    'and the account in it really is 184240 overdrawn, by the Trial Balance'
  );

  select * into d from public.get_dashboard_summary(v_company, '2026-06-30');

  perform pg_temp.expect(d.bank_balance = -164240.00,
    format('an overdrawn cash credit account is a bank overdraft: 20000 less 184240 (%s)', d.bank_balance));
  perform pg_temp.expect(d.cash_in_hand = 6500.00,
    format('and no part of it is physical cash, which is still the 6500 in the two tills (%s)', d.cash_in_hand));
  perform pg_temp.expect(d.bank_balance_change = -1000.00,
    format('the month''s drawing on it moves the bank tile (%s)', d.bank_balance_change));
  perform pg_temp.expect(d.cash_in_hand_change = 0.00,
    format('and leaves the cash tile alone, because no cash moved (%s)', d.cash_in_hand_change));
end;
$$;

-- ------------- 36. and a till is still a till, and the two tiles still add up

\echo '36. And a real cash ledger is still cash, and the tiles still sum to the same total'

-- The half that stops the fix from being an over-correction. Whatever rule
-- separates the two tiles, it has to leave a genuine cash-in-hand ledger where
-- it was, has to keep working for a company that renamed its cash group, and
-- must not change the total the two tiles add up to -- that total is the
-- Trial Balance's, and it was the one thing the old split got right.
--
-- The rule the database uses is the one lib/ledgers/party-type.ts already used
-- to decide which group a new ledger is filed in: a bank word wins, then a
-- cash word, then bank. The two must agree or the app files a ledger one way
-- and reports it the other, so the database's half is asserted here by name.

do $$
declare
  v_company uuid := current_setting('test.tiles_company')::uuid;
  d record;
  v_tb_total numeric;
begin
  perform pg_temp.expect(
    (select tb.debit_balance from public.get_trial_balance(v_company, '2026-06-30') tb
     where tb.ledger_id = current_setting('test.tiles_till')::uuid) = 5000.00
    and (select tb.debit_balance from public.get_trial_balance(v_company, '2026-06-30') tb
         where tb.ledger_id = current_setting('test.tiles_petty')::uuid) = 1500.00,
    'the seeded till holds 5000 and the renamed one 1500'
  );

  select * into d from public.get_dashboard_summary(v_company, '2026-06-30');

  perform pg_temp.expect(d.cash_in_hand = 6500.00,
    'a genuine cash-in-hand ledger is still reported as cash');
  perform pg_temp.expect(
    (select public.is_cash_group_name(g.name) from public.account_groups g
     where g.id = current_setting('test.tiles_petty_group')::uuid),
    'and so is one in a group a company renamed "Petty Cash"'
  );
  perform pg_temp.expect(
    (select not public.is_cash_group_name(g.name) from public.account_groups g
     where g.id = current_setting('test.tiles_cc_group')::uuid),
    'while "Cash Credit Accounts" is a bank group, which is where the two tiles differ'
  );
  perform pg_temp.expect(
    public.is_cash_group_name('Bank Accounts') = false
    and public.is_cash_group_name('Cash-in-Hand') = true
    and public.is_cash_group_name('HDFC Overdraft') = false
    and public.is_cash_group_name('Provisions') = false,
    'the rule reads: a bank word first, then a cash word, then bank -- the same order party-type.ts uses'
  );

  -- The sum is the invariant the split cannot be allowed to break: whichever
  -- side each ledger lands on, the two tiles together are the Trial Balance's
  -- cash and bank figure.
  select coalesce(sum(tb.debit_balance - tb.credit_balance), 0) into v_tb_total
  from public.get_trial_balance(v_company, '2026-06-30') tb
  join public.ledgers l on l.id = tb.ledger_id
  join public.account_groups g on g.id = l.group_id
  where g.ledger_role = 'cash_bank';

  perform pg_temp.expect(v_tb_total = -157740.00,
    format('the Trial Balance''s cash and bank ledgers come to -157740 (%s)', v_tb_total));
  perform pg_temp.expect(d.cash_in_hand + d.bank_balance = v_tb_total,
    format('and the two tiles still sum to exactly that (%s)', d.cash_in_hand + d.bank_balance));

  -- Gross movement is a property of the ledgers, not of the split, so it must
  -- be untouched by any of this.
  perform pg_temp.expect(d.month_inflow = 0.00 and d.month_outflow = 1000.00,
    format('and the month''s movement is unchanged by the split (%s in, %s out)', d.month_inflow, d.month_outflow));
end;
$$;

-- ------------- 37. a figure about a period counts everything that period had

\echo '37. The dashboard''s change and movement figures are about a period, not about today'

-- 0017 gave get_dashboard_summary the rule "active, or holding money", tested
-- against the balance TODAY, and hung all six figures off it. That is right
-- for the two balance tiles and wrong for the other four: a bank account
-- emptied this month and then closed has no balance today, so it dropped out
-- and took its history with it.
--
-- The bank change tile then read +700 on a month in which the banks went down
-- by 49,300, and the 50,000 that left the bank vanished from the outflow
-- figure while the same 50,000 arriving in cash stayed in the inflow one -- so
-- the month appeared to have created money.
--
-- The predicate is gone rather than moved. It never affected the two balance
-- tiles it was written for: a ledger it excludes is by definition sitting at
-- nil on the as-of date, so it contributes nothing to a balance either way.

do $$
declare
  v_company uuid;
  v_group uuid;
  v_cash uuid; v_bank uuid; v_capital uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Tiles History Co', '2025-04-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ TH Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Bank Accounts';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ TH Bank Closed') returning id into v_bank;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Capital Account';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ TH Capital') returning id into v_capital;

  perform public.create_voucher(v_company, 'receipt', '2026-05-10', 'ZZ TH capital paid into the bank', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_bank,    'debit_amount', 50000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_capital, 'debit_amount', 0, 'credit_amount', 50000, 'line_order', 1)));

  -- Emptied this month, into the till.
  perform public.create_voucher(v_company, 'contra', '2026-06-05', 'ZZ TH account closed, balance drawn out', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash, 'debit_amount', 50000, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_bank, 'debit_amount', 0, 'credit_amount', 50000, 'line_order', 1)));

  set constraints all immediate;
  set constraints all deferred;

  -- At nil now, so 0017's deactivation guard permits retiring it.
  update public.ledgers set is_active = false where id = v_bank;

  perform set_config('test.hist_company', v_company::text, false);
  perform set_config('test.hist_cash', v_cash::text, false);
  perform set_config('test.hist_bank', v_bank::text, false);
end;
$$;

do $$
declare
  v_company uuid := current_setting('test.hist_company')::uuid;
  d record;
  v_tb_total numeric;
begin
  -- Not vacuous: inactive, at nil today, and holding 50000 a month ago.
  perform pg_temp.expect(
    (select not l.is_active from public.ledgers l where l.id = current_setting('test.hist_bank')::uuid),
    'the closed bank account really is inactive'
  );
  perform pg_temp.expect(
    coalesce((select tb.debit_balance - tb.credit_balance from public.get_trial_balance(v_company, '2026-06-30') tb
              where tb.ledger_id = current_setting('test.hist_bank')::uuid), 0) = 0.00,
    'and really is at nil today'
  );
  perform pg_temp.expect(
    (select tb.debit_balance from public.get_trial_balance(v_company, '2026-05-31') tb
     where tb.ledger_id = current_setting('test.hist_bank')::uuid) = 50000.00,
    'but really did hold 50000 at the end of last month'
  );

  select * into d from public.get_dashboard_summary(v_company, '2026-06-30');

  -- The two balance tiles are unaffected, which is what makes dropping the
  -- predicate safe rather than a second change smuggled in beside the first.
  perform pg_temp.expect(d.bank_balance = 0.00 and d.cash_in_hand = 50000.00,
    format('the balance tiles are unchanged by any of this (%s cash, %s bank)', d.cash_in_hand, d.bank_balance));

  select coalesce(sum(tb.debit_balance - tb.credit_balance), 0) into v_tb_total
  from public.get_trial_balance(v_company, '2026-06-30') tb
  join public.ledgers l on l.id = tb.ledger_id
  join public.account_groups g on g.id = l.group_id
  where g.ledger_role = 'cash_bank';
  perform pg_temp.expect(d.cash_in_hand + d.bank_balance = v_tb_total,
    'and still sum to the Trial Balance''s cash and bank figure');

  -- The four that were wrong.
  perform pg_temp.expect(d.bank_balance_change = -50000.00,
    format('the bank change tile says the banks are down 50000, because they are (%s)', d.bank_balance_change));
  perform pg_temp.expect(d.cash_in_hand_change = 50000.00,
    format('and the cash tile says the till is up by the same (%s)', d.cash_in_hand_change));
  perform pg_temp.expect(d.month_outflow = 50000.00,
    format('the 50000 that left the bank is counted as it left (%s)', d.month_outflow));
  perform pg_temp.expect(d.month_inflow = 50000.00,
    format('against the 50000 that arrived in cash, so the month created no money (%s)', d.month_inflow));
end;
$$;

-- ------------------------------- 38. a book that is never closed at year end

\echo '38. A company that keeps one continuous set of books numbers straight through the year end'

-- A small trader who files no returns keeps a bahi-khata: one unbroken set of
-- books and one bill series that never restarts. HISAB forced a financial year
-- on him — the number reset every April and read SAL/2025-26/00001, which is
-- a year he does not keep and a segment he did not ask for.
--
-- companies.uses_financial_years is the choice, made once at creation. With it
-- off, next_voucher_number writes a single constant into financial_year_label
-- instead of deriving one from the date, so the primary key of
-- voucher_number_sequences, the unique index on vouchers and every query that
-- groups by that column keep working untouched — only the value changes — and
-- the displayed number loses its middle segment.
--
-- The constant is the literal 'continuous', and it is asserted here rather
-- than derived, because it is written into the books and into every backup
-- file permanently. A test that computed it the same way the code does would
-- agree with any value the code happened to pick, including a later change to
-- one, which is the one thing this column cannot survive.

do $$
declare
  v_off uuid;
  v_on uuid;
  v_group uuid;
  v_off_cash uuid; v_off_sales uuid;
  v_on_cash uuid;  v_on_sales uuid;
  v_off_lines jsonb;
  v_on_lines jsonb;
  v_v uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency, uses_financial_years)
  values ('ZZ Bahi Khata Co', '2025-04-01', 4, 'INR', false) returning id into v_off;

  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Closes Yearly Co', '2025-04-01', 4, 'INR') returning id into v_on;

  perform app_private.seed_chart_of_accounts(v_off);
  perform app_private.seed_chart_of_accounts(v_on);

  select id into v_group from public.account_groups where company_id = v_off and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ Bahi Cash') returning id into v_off_cash;
  select id into v_group from public.account_groups where company_id = v_off and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ Bahi Sales') returning id into v_off_sales;

  select id into v_group from public.account_groups where company_id = v_on and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ Yearly Cash') returning id into v_on_cash;
  select id into v_group from public.account_groups where company_id = v_on and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ Yearly Sales') returning id into v_on_sales;

  v_off_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_off_cash,  'debit_amount', 100, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_off_sales, 'debit_amount', 0, 'credit_amount', 100, 'line_order', 1));
  v_on_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_on_cash,  'debit_amount', 100, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_on_sales, 'debit_amount', 0, 'credit_amount', 100, 'line_order', 1));

  -- Two sales either side of 1 April, and a third two years on. An April
  -- company is the one whose boundary the default hides, so it is the one to
  -- cross.
  perform public.create_voucher(v_off, 'sales', '2026-03-20', 'before the year end', null, null, v_off_lines);
  perform public.create_voucher(v_off, 'sales', '2026-04-05', 'after the year end',  null, null, v_off_lines);
  perform public.create_voucher(v_off, 'sales', '2028-01-11', 'two years later',     null, null, v_off_lines);
  perform public.create_voucher(v_off, 'receipt', '2026-04-06', 'a receipt',         null, null, v_off_lines);

  perform public.create_voucher(v_on, 'sales', '2026-03-20', 'before the year end', null, null, v_on_lines);
  perform public.create_voucher(v_on, 'sales', '2026-04-05', 'after the year end',  null, null, v_on_lines);

  perform set_config('test.fy_off', v_off::text, false);
  perform set_config('test.fy_on', v_on::text, false);
end;
$$;

do $$
declare
  v_off uuid := current_setting('test.fy_off')::uuid;
  v_on uuid := current_setting('test.fy_on')::uuid;
  v_numbers text[];
begin
  -- Existing companies must keep today's behaviour, so the column defaults to
  -- "years on". ZZ Test Co at the top of this file was inserted without ever
  -- naming it.
  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = current_setting('test.company')::uuid),
    'a company created without saying anything keeps financial years'
  );
  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = v_on),
    'and so does the year-keeping company in this section'
  );
  perform pg_temp.expect(
    (select not c.uses_financial_years from public.companies c where c.id = v_off),
    'while the bahi-khata company does not'
  );

  -- THE NUMBERS. One series, no year segment, no reset in April and none two
  -- years later either.
  select array_agg(v.voucher_number order by v.voucher_date)
    into v_numbers
  from public.vouchers v where v.company_id = v_off and v.voucher_type = 'sales';

  perform pg_temp.expect(
    v_numbers = array['SAL/00001','SAL/00002','SAL/00003'],
    format('a continuous book numbers straight through the year end (%s)', v_numbers)
  );

  select array_agg(v.voucher_number order by v.voucher_date)
    into v_numbers
  from public.vouchers v where v.company_id = v_on and v.voucher_type = 'sales';

  perform pg_temp.expect(
    v_numbers = array['SAL/2025-26/00001','SAL/2026-27/00001'],
    format('and a year-keeping book still resets each April, year in the number (%s)', v_numbers)
  );

  -- Per voucher type, not per book: the receipt series starts at its own 1.
  perform pg_temp.expect(
    (select v.voucher_number from public.vouchers v
     where v.company_id = v_off and v.voucher_type = 'receipt') = 'REC/00001',
    'each voucher type still has a series of its own'
  );

  -- THE STORED LABEL. This is the value that goes into the table, into the
  -- primary key of the sequences, and into every backup file, forever.
  perform pg_temp.expect(
    (select bool_and(v.financial_year_label = 'continuous')
     from public.vouchers v where v.company_id = v_off),
    'every voucher in a continuous book is labelled ''continuous'''
  );
  perform pg_temp.expect(
    app_private.financial_year_label(v_off, '2026-03-20') = 'continuous'
    and app_private.financial_year_label(v_off, '2028-01-11') = 'continuous',
    'the label function returns the same constant whatever the date'
  );
  perform pg_temp.expect(
    app_private.financial_year_label(v_on, '2026-03-20') = '2025-26'
    and app_private.financial_year_label(v_on, '2026-04-05') = '2026-27',
    'and still derives the year from the date for a company that keeps years'
  );

  -- THE SEQUENCES. The table shape is untouched, so the difference is visible
  -- as one key per type instead of one key per type per year.
  perform pg_temp.expect(
    (select count(*) from public.voucher_number_sequences s
     where s.company_id = v_off and s.voucher_type = 'sales') = 1,
    'a continuous book keeps one sales sequence for its whole life'
  );
  perform pg_temp.expect(
    (select s.next_number from public.voucher_number_sequences s
     where s.company_id = v_off and s.voucher_type = 'sales'
       and s.financial_year_label = 'continuous') = 4,
    'pointing at the next number in that one series'
  );
  perform pg_temp.expect(
    (select count(*) from public.voucher_number_sequences s
     where s.company_id = v_on and s.voucher_type = 'sales') = 2,
    'while a year-keeping book opens a new sales sequence every year'
  );

  -- The constant must never be mistakable for a year label, or a reader of the
  -- table cannot tell a continuous book from a mis-derived one.
  perform pg_temp.expect(
    (select count(*) from public.voucher_number_sequences s
     where s.company_id = v_off and s.financial_year_label ~ '^\d{4}-\d{2}$') = 0,
    'and nothing in a continuous book is labelled with anything year-shaped'
  );
end;
$$;

-- --------------------------- 39. the year-end guard has no year end to guard

\echo '39. The re-dating guard fires for a year-keeping book and not for a continuous one'

-- 0018 refuses a voucher date change that crosses a financial year, because
-- the number was minted from the year the voucher had at the time and would
-- then claim the wrong one. A continuous book has no boundary to cross and no
-- year in the number, so there is nothing for the guard to protect and it must
-- not fire — while the company next door, which does close its books, must
-- still be refused on exactly the same move.
--
-- Both halves are asserted here rather than only the new one. The cheap way to
-- stop the guard firing for a continuous book is to stop it firing at all, and
-- that mutation passes every test that only looks at the bahi-khata.

do $$
declare
  v_off uuid := current_setting('test.fy_off')::uuid;
  v_on uuid := current_setting('test.fy_on')::uuid;
  v_off_cash uuid; v_off_sales uuid; v_on_cash uuid; v_on_sales uuid;
  v_off_lines jsonb; v_on_lines jsonb;
  v_off_voucher uuid; v_on_voucher uuid;
  v_number text;
begin
  select id into v_off_cash  from public.ledgers where company_id = v_off and name = 'ZZ Bahi Cash';
  select id into v_off_sales from public.ledgers where company_id = v_off and name = 'ZZ Bahi Sales';
  select id into v_on_cash   from public.ledgers where company_id = v_on  and name = 'ZZ Yearly Cash';
  select id into v_on_sales  from public.ledgers where company_id = v_on  and name = 'ZZ Yearly Sales';

  v_off_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_off_cash,  'debit_amount', 300, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_off_sales, 'debit_amount', 0, 'credit_amount', 300, 'line_order', 1));
  v_on_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_on_cash,  'debit_amount', 300, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_on_sales, 'debit_amount', 0, 'credit_amount', 300, 'line_order', 1));

  v_off_voucher := public.create_voucher(v_off, 'journal', '2026-04-05', 'keyed on the wrong side of April', null, null, v_off_lines);
  v_on_voucher  := public.create_voucher(v_on,  'journal', '2026-04-05', 'keyed on the wrong side of April', null, null, v_on_lines);

  select voucher_number into v_number from public.vouchers where id = v_off_voucher;
  perform pg_temp.expect(v_number = 'JRN/00001',
    format('the continuous book''s journal carries no year in its number (%s)', v_number));

  -- The correction that used to be refused. 2026-03-31 is a different
  -- financial year on an April company and the same continuous book.
  perform public.update_voucher(v_off_voucher, '2026-03-31', 'corrected to March', null, null, v_off_lines);

  perform pg_temp.expect(
    (select v.voucher_date from public.vouchers v where v.id = v_off_voucher) = '2026-03-31'::date,
    'a continuous book''s voucher can be re-dated across 1 April'
  );
  perform pg_temp.expect(
    (select v.voucher_number from public.vouchers v where v.id = v_off_voucher) = v_number
    and (select v.financial_year_label from public.vouchers v where v.id = v_off_voucher) = 'continuous',
    'and keeps the number and the label it was issued with'
  );

  -- Years apart is still one book.
  perform public.update_voucher(v_off_voucher, '2029-09-09', 'corrected again, years away', null, null, v_off_lines);
  perform pg_temp.expect(
    (select v.voucher_date from public.vouchers v where v.id = v_off_voucher) = '2029-09-09'::date
    and (select v.voucher_number from public.vouchers v where v.id = v_off_voucher) = v_number,
    'however far it moves, because there is no boundary to cross'
  );

  -- The other half: the guard is intact where there is a year.
  perform pg_temp.expect_error(
    format($q$select public.update_voucher(%L, '2026-03-31', 'dragged back a year', null, null, %L::jsonb)$q$,
           v_on_voucher, v_on_lines::text),
    'Cannot move voucher',
    'a year-keeping book still refuses the same re-date'
  );
  perform pg_temp.expect(
    (select v.voucher_date from public.vouchers v where v.id = v_on_voucher) = '2026-04-05'::date,
    'and the refused edit left that voucher exactly as it was'
  );
end;
$$;

-- ----------------- 40. the choice is fixed the moment the first voucher lands

\echo '40. How a company numbers its books cannot change once a voucher exists'

-- Flipping this after a voucher has been entered leaves two numbering schemes
-- in one book: SAL/2025-26/00001 and SAL/00001 side by side, each minted from
-- a different key, with no way to say which series a third voucher belongs to.
-- Retro-fitting the existing numbers is the other option, and it means
-- rewriting a uniqueness key that the old numbers can collide inside — two
-- years' worth of SAL/…/00001 becoming one SAL/00001.
--
-- So the database refuses it, and refuses it the moment there is anything to
-- protect and not before. Before the first voucher the choice costs nothing
-- and a user who picked wrong in the New Company dialog must be able to say so.
--
-- This is the rule book_beginning_date already follows in practice — set once,
-- at creation, never offered again — and the opposite of the mistake recorded
-- as audit finding F-17, where financial_year_start_month can still be changed
-- after posting and silently re-bases every year after it. F-17 is not fixed
-- here; this column simply does not repeat it.

do $$
declare
  v_company uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
  v_voucher uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Undecided Co', '2025-04-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  -- Before the first voucher it is free, in both directions and repeatedly.
  update public.companies set uses_financial_years = false where id = v_company;
  perform pg_temp.expect(
    (select not c.uses_financial_years from public.companies c where c.id = v_company),
    'an empty book can be switched to one continuous set of books'
  );

  update public.companies set uses_financial_years = true where id = v_company;
  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = v_company),
    'and switched back again'
  );

  update public.companies set uses_financial_years = false where id = v_company;

  select id into v_group from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Und Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Und Sales') returning id into v_sales;

  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 700, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 700, 'line_order', 1));

  -- A ledger is not a voucher. Setting up the chart of accounts, naming the
  -- customers, keying the opening balances — none of that mints a number, and
  -- a user who gets to the end of it and realises they picked wrong has lost
  -- nothing yet.
  perform pg_temp.expect(
    (select count(*) from public.vouchers v where v.company_id = v_company) = 0
    and (select count(*) from public.ledgers l where l.company_id = v_company) = 2,
    'ledgers on their own do not freeze the choice'
  );
  update public.companies set uses_financial_years = true where id = v_company;
  update public.companies set uses_financial_years = false where id = v_company;
  perform pg_temp.expect(
    (select not c.uses_financial_years from public.companies c where c.id = v_company),
    'so it is still free to change with a chart of accounts in place'
  );

  v_voucher := public.create_voucher(v_company, 'sales', '2026-04-05', 'the first entry', null, null, v_lines);

  perform pg_temp.expect_error(
    format('update public.companies set uses_financial_years = true where id = %L', v_company),
    'two numbering schemes',
    'once a voucher exists the choice cannot be changed'
  );
  perform pg_temp.expect_error(
    format('update public.companies set uses_financial_years = true where id = %L', v_company),
    'SAL/00001',
    'and the refusal names a number already issued, so the user can see what is at stake'
  );

  perform pg_temp.expect(
    (select not c.uses_financial_years from public.companies c where c.id = v_company),
    'the refused change left the setting alone'
  );

  -- Everything else about the company is still editable — this freezes one
  -- column, not the settings page.
  update public.companies set lock_date = '2026-04-01', name = 'ZZ Undecided Co (renamed)'
  where id = v_company;
  perform pg_temp.expect(
    (select c.lock_date from public.companies c where c.id = v_company) = '2026-04-01'::date,
    'the lock date can still be set on a company that has posted'
  );

  -- A whole-row rewrite that restates the same value is not a change, and must
  -- not be refused: that is the shape restore_company_backup() writes, and the
  -- shape any UPDATE naming every column takes.
  update public.companies set uses_financial_years = false, lock_date = null where id = v_company;
  perform pg_temp.expect(
    (select c.lock_date from public.companies c where c.id = v_company) is null,
    'and an update restating the same setting alongside another change goes through'
  );

  -- A deleted voucher still holds its number, so it still counts.
  update public.vouchers set is_deleted = true where id = v_voucher;
  perform pg_temp.expect_error(
    format('update public.companies set uses_financial_years = true where id = %L', v_company),
    'two numbering schemes',
    'a voucher deleted in the app still holds its number, so it still freezes the choice'
  );

  perform set_config('test.fy_frozen', v_company::text, false);
end;
$$;

do $$
declare
  v_company uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
begin
  -- The mirror image. A guard that only looked at one direction would let a
  -- year-keeping book be quietly turned into a continuous one, which is the
  -- worse of the two: its numbers already carry years the new scheme cannot
  -- mint.
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Frozen Yearly Co', '2025-04-01', 4, 'INR') returning id into v_company;
  perform app_private.seed_chart_of_accounts(v_company);

  select id into v_group from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ FY Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ FY Sales') returning id into v_sales;

  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 400, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 400, 'line_order', 1));

  perform public.create_voucher(v_company, 'sales', '2026-04-05', 'the first entry', null, null, v_lines);

  perform pg_temp.expect_error(
    format('update public.companies set uses_financial_years = false where id = %L', v_company),
    'two numbering schemes',
    'a year-keeping book that has posted cannot be turned into a continuous one either'
  );
  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = v_company),
    'and it is still a year-keeping book afterwards'
  );
end;
$$;

-- ------------------------ 41. a backup that remembers how the book is numbered

\echo '41. Backup and restore carry the choice, and the numbering that depends on it'

-- export_company_backup builds the company with to_jsonb(c), so the column
-- joins the file the moment it exists — asserted rather than assumed, for the
-- reason section 23 gives.
--
-- The restore is the half that loses data. It names the company's columns one
-- by one on both paths, and on the 'new' path it calls create_company(), which
-- until now had no way to be told. A backup of a bahi-khata restored as a
-- year-keeping company would carry every voucher's 'continuous' label across
-- and then mint SAL/2026-27/00001 beside SAL/00001 on the very next sale.

do $$
declare
  v_user uuid;
  v_company uuid;
  v_target uuid;
  v_restored uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
  v_payload jsonb;
  v_number text;
  v_numbers text[];
begin
  v_user := pg_temp.make_user('zz-continuous-backup@hisab.invalid');
  perform pg_temp.act_as(v_user);

  -- Through the RPC, which is the other half of this section: create_company
  -- has to be able to carry the choice at all.
  v_company := public.create_company('ZZ Bahi Backup Co', '2025-04-01', 4::smallint, 'INR', false);

  perform pg_temp.expect(
    (select not c.uses_financial_years from public.companies c where c.id = v_company),
    'create_company can be told to keep one continuous set of books'
  );

  select id into v_group from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ BB Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ BB Sales') returning id into v_sales;

  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 150, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 150, 'line_order', 1));

  perform public.create_voucher(v_company, 'sales', '2026-03-20', 'before the year end', null, null, v_lines);
  perform public.create_voucher(v_company, 'sales', '2026-04-05', 'after the year end',  null, null, v_lines);

  set constraints all immediate;
  set constraints all deferred;

  v_payload := public.export_company_backup(v_company);

  perform pg_temp.expect(
    (v_payload->'company'->>'uses_financial_years')::boolean = false,
    'the backup file records that this company keeps no financial years'
  );

  -- ---- restored as a new company ----------------------------------------
  v_restored := public.restore_company_backup(v_payload, 'new', null);
  set constraints all deferred;

  perform pg_temp.expect(
    v_restored <> v_company
    and (select not c.uses_financial_years from public.companies c where c.id = v_restored),
    'a restored copy keeps one continuous set of books'
  );

  select array_agg(v.voucher_number order by v.voucher_date) into v_numbers
  from public.vouchers v where v.company_id = v_restored;
  perform pg_temp.expect(
    v_numbers = array['SAL/00001','SAL/00002'],
    format('with the numbers it was backed up with (%s)', v_numbers)
  );

  -- The assertion the round trip is actually for: the restored book carries on
  -- numbering the way it did, rather than starting a year series beside its
  -- own history.
  perform public.create_voucher(
    v_restored, 'sales', '2026-04-09', 'entered after the restore', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', (select id from public.ledgers where company_id = v_restored and name = 'ZZ BB Cash'),
                         'debit_amount', 150, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', (select id from public.ledgers where company_id = v_restored and name = 'ZZ BB Sales'),
                         'debit_amount', 0, 'credit_amount', 150, 'line_order', 1)));

  select v.voucher_number into v_number from public.vouchers v
  where v.company_id = v_restored and v.narration = 'entered after the restore';
  perform pg_temp.expect(
    v_number = 'SAL/00003',
    format('and the next sale continues that same series (%s)', v_number)
  );

  -- ---- restored over a year-keeping company ------------------------------
  -- The overwrite path deletes every voucher before it touches the company
  -- row, so the freeze in section 40 permits this: the book being replaced is
  -- empty by the time the setting is written.
  v_target := public.create_company('ZZ Overwrite Target Co', '2025-04-01', 4::smallint, 'INR');
  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = v_target),
    'the company about to be overwritten keeps financial years'
  );

  perform public.restore_company_backup(v_payload, 'overwrite', v_target);
  set constraints all deferred;

  perform pg_temp.expect(
    (select not c.uses_financial_years from public.companies c where c.id = v_target),
    'restoring over it makes it a continuous book, as the file says'
  );

  select array_agg(v.voucher_number order by v.voucher_date) into v_numbers
  from public.vouchers v where v.company_id = v_target;
  perform pg_temp.expect(
    v_numbers = array['SAL/00001','SAL/00002'],
    format('with the file''s numbering and nothing of its own left (%s)', v_numbers)
  );

  -- ---- a file written before the column existed --------------------------
  -- Every backup taken until today has no such key, and must restore as what
  -- it was: a company that keeps financial years.
  --
  -- The fixture is a year-keeping company's file with the key removed, not
  -- this section's bahi-khata with the key removed. A backup written before
  -- 0027 can only have come from a company that kept financial years — there
  -- was no other kind — so its vouchers carry year labels. A file whose
  -- vouchers are labelled 'continuous' and whose company row says nothing is
  -- not an old file; it is the contradiction section 45 refuses, and building
  -- this case out of one would have been asserting behaviour on a file that
  -- cannot exist.
  v_target := public.create_company('ZZ Pre-column Backup Co', '2025-04-01', 4::smallint, 'INR');
  select id into v_group from public.account_groups where company_id = v_target and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_target, v_group, 'ZZ PC Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_target and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_target, v_group, 'ZZ PC Sales') returning id into v_sales;
  perform public.create_voucher(
    v_target, 'sales', '2026-04-05', 'a year-keeping entry', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,  'debit_amount', 150, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 150, 'line_order', 1)));
  set constraints all immediate;
  set constraints all deferred;

  v_payload := public.export_company_backup(v_target);
  perform pg_temp.expect(
    (select bool_and(e->>'financial_year_label' ~ '^\d{4}-\d{2}$')
       from jsonb_array_elements(v_payload->'vouchers') e),
    'the stand-in for an old file carries the year labels an old file carried'
  );

  v_restored := public.restore_company_backup(
    jsonb_set(v_payload, '{company}', (v_payload->'company') - 'uses_financial_years'),
    'new', null
  );
  set constraints all deferred;

  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = v_restored),
    'a backup written before the column existed restores as a year-keeping company'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ------------------------------- 42. two books, two schemes, no interference

\echo '42. A continuous book and a year-keeping one, side by side, do not touch each other'

-- One accountant keeps several sets of books at once, and now they can be
-- numbered two different ways. The sequences are keyed
-- (company_id, voucher_type, financial_year_label), so the isolation is the
-- company_id in that key doing its job — which is worth asserting, because the
-- constant is the first value in that column ever shared by two companies that
-- disagree about what it means.

do $$
declare
  v_off uuid;
  v_on uuid;
  v_group uuid;
  v_off_lines jsonb;
  v_on_lines jsonb;
  v_id uuid;
  v_numbers text[];
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency, uses_financial_years)
  values ('ZZ Side A Bahi Co', '2025-04-01', 4, 'INR', false) returning id into v_off;
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Side B Yearly Co', '2025-04-01', 4, 'INR') returning id into v_on;

  perform app_private.seed_chart_of_accounts(v_off);
  perform app_private.seed_chart_of_accounts(v_on);

  select id into v_group from public.account_groups where company_id = v_off and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ SA Cash') returning id into v_id;
  v_off_lines := jsonb_build_array(jsonb_build_object('ledger_id', v_id, 'debit_amount', 60, 'credit_amount', 0, 'line_order', 0));
  select id into v_group from public.account_groups where company_id = v_off and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ SA Sales') returning id into v_id;
  v_off_lines := v_off_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_id, 'debit_amount', 0, 'credit_amount', 60, 'line_order', 1));

  select id into v_group from public.account_groups where company_id = v_on and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ SB Cash') returning id into v_id;
  v_on_lines := jsonb_build_array(jsonb_build_object('ledger_id', v_id, 'debit_amount', 60, 'credit_amount', 0, 'line_order', 0));
  select id into v_group from public.account_groups where company_id = v_on and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ SB Sales') returning id into v_id;
  v_on_lines := v_on_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_id, 'debit_amount', 0, 'credit_amount', 60, 'line_order', 1));

  -- Interleaved, and across the boundary, because a shared sequence would only
  -- show up as an off-by-one and an alternating one at that.
  perform public.create_voucher(v_off, 'sales', '2026-03-01', 'A1', null, null, v_off_lines);
  perform public.create_voucher(v_on,  'sales', '2026-03-02', 'B1', null, null, v_on_lines);
  perform public.create_voucher(v_off, 'sales', '2026-04-03', 'A2', null, null, v_off_lines);
  perform public.create_voucher(v_on,  'sales', '2026-04-04', 'B2', null, null, v_on_lines);
  perform public.create_voucher(v_off, 'sales', '2026-04-05', 'A3', null, null, v_off_lines);

  select array_agg(v.voucher_number order by v.voucher_date) into v_numbers
  from public.vouchers v where v.company_id = v_off;
  perform pg_temp.expect(
    v_numbers = array['SAL/00001','SAL/00002','SAL/00003'],
    format('the continuous book counted only its own vouchers (%s)', v_numbers)
  );

  select array_agg(v.voucher_number order by v.voucher_date) into v_numbers
  from public.vouchers v where v.company_id = v_on;
  perform pg_temp.expect(
    v_numbers = array['SAL/2025-26/00001','SAL/2026-27/00001'],
    format('and the year-keeping book counted only its own (%s)', v_numbers)
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_number_sequences s
     where s.financial_year_label = 'continuous' and s.company_id = v_on) = 0,
    'no ''continuous'' sequence was opened for the year-keeping book'
  );
  perform pg_temp.expect(
    (select count(*) from public.voucher_number_sequences s
     where s.company_id = v_off and s.financial_year_label <> 'continuous') = 0,
    'and no year sequence for the continuous one'
  );

  -- The two labels are the same column and now hold two kinds of value, so the
  -- unique index on vouchers has to keep both apart within one company and
  -- across two.
  perform pg_temp.expect(
    (select count(distinct v.company_id) from public.vouchers v
     where v.financial_year_label = 'continuous'
       and v.voucher_number = 'SAL/00001') >= 2,
    'two different companies can each hold SAL/00001 under the same label'
  );
end;
$$;

-- ------------ 43. the two other things that reach for a financial year alone

\echo '43. The duplicate-bill warning and the undo''s rewind both follow the book they are in'

-- Two functions derive or group by financial_year_label on their own, and both
-- had to be looked at rather than assumed:
--
--   * find_duplicate_bill (0024) scopes the search to the financial year the
--     date falls in, so that a supplier who restarts at 1 every April is not
--     reported as a duplicate of himself. A book with no year has no such
--     restart to allow for and one unbroken run of inbound paper, so the whole
--     book is the right scope — which is what asking
--     app_private.financial_year_label() for the label produces, with no
--     special case anywhere in 0024.
--
--   * revert_company_changes_since (0019) rewinds each sequence to one above
--     the highest surviving sequence_number under its key. The key is whatever
--     is in the column, so a continuous book rewinds as one series.

do $$
declare
  v_off uuid;
  v_on uuid;
  v_group uuid;
  v_off_supplier uuid; v_off_expense uuid;
  v_on_supplier uuid;  v_on_expense uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency, uses_financial_years)
  values ('ZZ Bahi Bills Co', '2025-04-01', 4, 'INR', false) returning id into v_off;
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Yearly Bills Co', '2025-04-01', 4, 'INR') returning id into v_on;

  perform app_private.seed_chart_of_accounts(v_off);
  perform app_private.seed_chart_of_accounts(v_on);

  select id into v_group from public.account_groups where company_id = v_off and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ BBill Supplier') returning id into v_off_supplier;
  select id into v_group from public.account_groups where company_id = v_off and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ BBill Purchases') returning id into v_off_expense;

  select id into v_group from public.account_groups where company_id = v_on and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ YBill Supplier') returning id into v_on_supplier;
  select id into v_group from public.account_groups where company_id = v_on and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ YBill Purchases') returning id into v_on_expense;

  perform public.create_voucher(
    v_off, 'purchase', '2026-03-20', 'the bill as first entered', 'INV-77', '2026-03-19', '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_off_supplier, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Cement', 'quantity', 1, 'rate', 900,
                         'revenue_ledger_id', v_off_expense))));

  perform public.create_voucher(
    v_on, 'purchase', '2026-03-20', 'the bill as first entered', 'INV-77', '2026-03-19', '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_on_supplier, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Cement', 'quantity', 1, 'rate', 900,
                         'revenue_ledger_id', v_on_expense))));

  set constraints all immediate;
  set constraints all deferred;

  -- Not vacuous: both bills really are on the books, and both are found inside
  -- their own year.
  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_off, v_off_supplier, 'INV-77', '2026-03-25', null)) = 1
    and (select count(*) from public.find_duplicate_bill(v_on, v_on_supplier, 'INV-77', '2026-03-25', null)) = 1,
    'the same supplier''s bill number is found again within the same period, in both books'
  );

  -- 2026-04-10 is the next financial year for the year-keeping company and the
  -- same unbroken book for the other. The two answers are both right, and they
  -- differ.
  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_off, v_off_supplier, 'INV-77', '2026-04-10', null)) = 1,
    'a continuous book finds the same bill number again after April, because it is one series of paper'
  );
  perform pg_temp.expect(
    (select count(*) from public.find_duplicate_bill(v_on, v_on_supplier, 'INV-77', '2026-04-10', null)) = 0,
    'while a year-keeping book still allows a supplier to restart his numbering each year'
  );
end;
$$;

do $$
declare
  v_user uuid;
  v_company uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
  v_mark timestamptz;
  v_voucher uuid;
  v_number text;
begin
  v_user := pg_temp.make_user('zz-continuous-undo@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_company := public.create_company('ZZ Bahi Undo Co', '2025-04-01', 4::smallint, 'INR', false);

  select id into v_group from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ BU Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ BU Sales') returning id into v_sales;

  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 90, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 90, 'line_order', 1));

  perform pg_temp.stamp_audit(v_company, now() - interval '60 minutes');
  v_mark := now() - interval '45 minutes';

  -- Either side of April, so the three that come off are three that a
  -- year-keyed rewind would have split across two sequences.
  perform public.create_voucher(v_company, 'sales', '2026-03-28', 'first', null, null, v_lines);
  perform pg_temp.stamp_audit(v_company, now() - interval '40 minutes');
  perform public.create_voucher(v_company, 'sales', '2026-04-02', 'second', null, null, v_lines);
  perform pg_temp.stamp_audit(v_company, now() - interval '35 minutes');
  perform public.create_voucher(v_company, 'sales', '2026-04-03', 'third', null, null, v_lines);
  perform pg_temp.stamp_audit(v_company, now() - interval '20 minutes');

  perform pg_temp.expect(
    (select s.next_number from public.voucher_number_sequences s
     where s.company_id = v_company and s.voucher_type = 'sales'
       and s.financial_year_label = 'continuous') = 4,
    'three sales in a continuous book leave the one series pointing at the fourth number'
  );

  perform public.revert_company_changes_since(v_company, v_mark);
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.vouchers v where v.company_id = v_company) = 0
    and (select s.next_number from public.voucher_number_sequences s
         where s.company_id = v_company and s.voucher_type = 'sales'
           and s.financial_year_label = 'continuous') = 1,
    'undoing all three rewinds that one series to 1'
  );

  v_voucher := public.create_voucher(v_company, 'sales', '2026-04-08', 'after the undo', null, null, v_lines);
  select voucher_number into v_number from public.vouchers where id = v_voucher;
  perform pg_temp.expect(
    v_number = 'SAL/00001',
    format('so the first number is reissued rather than lost (%s)', v_number)
  );

  perform pg_temp.act_as(null);
end;
$$;


-- ------------------------- 44. the label's shape is a constraint, not a habit

\echo '44. A voucher''s financial year label is either the constant or a year'

-- 0027 turns financial_year_label into a column with exactly two kinds of
-- value in it: the constant a continuous book writes, and a financial year.
-- Until now that was a property of one function — everything that mints a
-- number asks app_private.financial_year_label() for the label, so everything
-- that mints a number gets one of the two. Nothing said it where the database
-- could enforce it, and the column is written directly by
-- restore_company_backup(), by the undo's replay, and by anything else that
-- ever inserts a voucher row.
--
-- The point is the *pair*: the uniqueness key is
-- (company_id, voucher_type, financial_year_label, voucher_number), so a
-- third kind of label is a third numbering series, and SAL/00001 can then
-- appear twice in one book without the key noticing.
--
-- The constraint asks continuous_year_label() for the constant rather than
-- repeating it, which is asserted below rather than assumed: the migration
-- spends a paragraph on that value living in one place, and a constraint that
-- had its own copy would be a second one.

do $$
declare
  v_company uuid;
  v_shape text;
begin
  select pg_get_constraintdef(c.oid) into v_shape
    from pg_constraint c
   where c.conrelid = 'public.vouchers'::regclass
     and c.conname = 'vouchers_financial_year_label_shape';

  perform pg_temp.expect(
    v_shape is not null,
    'the shape of the label is written on the table itself'
  );
  perform pg_temp.expect(
    v_shape like '%continuous_year_label%',
    'and it reads the constant from the one place the constant is defined'
  );

  -- Not vacuous, and the reason the constraint could be added as valid rather
  -- than NOT VALID: every row a fully seeded database holds already satisfies
  -- it. This runs after every fixture above has posted, so it is a statement
  -- about a database with books in it and not about an empty one.
  perform pg_temp.expect(
    (select count(*) from public.vouchers v) > 0,
    'there are vouchers on the books to make the next assertion mean something'
  );
  perform pg_temp.expect(
    (select count(*) from public.vouchers v
      where v.financial_year_label <> app_private.continuous_year_label()
        and v.financial_year_label !~ '^\d{4}-\d{2}$') = 0,
    'and not one voucher in this database carries a label of any other shape'
  );

  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency, uses_financial_years)
  values ('ZZ Label Shape Co', '2025-04-01', 4, 'INR', false) returning id into v_company;

  -- Everything that reads as "the label failed to compute" — which is the one
  -- thing the constant must never be mistaken for.
  perform pg_temp.expect_error(
    format($q$insert into public.vouchers
      (company_id, voucher_type, voucher_number, sequence_number, financial_year_label, voucher_date)
      values (%L, 'sales', 'SAL/00001', 1, '', '2026-04-05')$q$, v_company),
    'vouchers_financial_year_label_shape',
    'an empty label is refused by the database'
  );
  perform pg_temp.expect_error(
    format($q$insert into public.vouchers
      (company_id, voucher_type, voucher_number, sequence_number, financial_year_label, voucher_date)
      values (%L, 'sales', 'SAL/00001', 1, 'none', '2026-04-05')$q$, v_company),
    'vouchers_financial_year_label_shape',
    'and so is a word that reads as an absence'
  );

  -- Near-misses of the constant. The key is an exact-match key, so a label
  -- that merely looks like the constant is a separate series.
  perform pg_temp.expect_error(
    format($q$insert into public.vouchers
      (company_id, voucher_type, voucher_number, sequence_number, financial_year_label, voucher_date)
      values (%L, 'sales', 'SAL/00001', 1, 'Continuous', '2026-04-05')$q$, v_company),
    'vouchers_financial_year_label_shape',
    'a differently-cased constant is not the constant'
  );
  perform pg_temp.expect_error(
    format($q$insert into public.vouchers
      (company_id, voucher_type, voucher_number, sequence_number, financial_year_label, voucher_date)
      values (%L, 'sales', 'SAL/00001', 1, 'continuous ', '2026-04-05')$q$, v_company),
    'vouchers_financial_year_label_shape',
    'nor is the constant with a space on the end of it'
  );

  -- Near-misses of a year.
  perform pg_temp.expect_error(
    format($q$insert into public.vouchers
      (company_id, voucher_type, voucher_number, sequence_number, financial_year_label, voucher_date)
      values (%L, 'sales', 'SAL/00001', 1, '2025', '2026-04-05')$q$, v_company),
    'vouchers_financial_year_label_shape',
    'a bare year is not a financial year label'
  );
  perform pg_temp.expect_error(
    format($q$insert into public.vouchers
      (company_id, voucher_type, voucher_number, sequence_number, financial_year_label, voucher_date)
      values (%L, 'sales', 'SAL/00001', 1, '2025-2026', '2026-04-05')$q$, v_company),
    'vouchers_financial_year_label_shape',
    'nor is a four-digit second half'
  );

  -- The one case where the constraint is deliberately stronger than 0004's
  -- derivation. The label is built by concatenating the start year rather than
  -- padding it, so a voucher dated in the first millennium would derive
  -- '999-00'. No set of books anyone keeps opens before the year 1000, and a
  -- three-digit segment reads as a mis-derived year — which is the one thing
  -- the constant was chosen to be distinguishable from — so it is refused
  -- here rather than tolerated. 0027 says so in prose; this is where it is
  -- true.
  perform pg_temp.expect_error(
    format($q$insert into public.vouchers
      (company_id, voucher_type, voucher_number, sequence_number, financial_year_label, voucher_date)
      values (%L, 'sales', 'SAL/00001', 1, '999-00', '2026-04-05')$q$, v_company),
    'vouchers_financial_year_label_shape',
    'and an unpadded first-millennium year is refused rather than tolerated'
  );
end;
$$;

-- The other half, and the one that stops all of the above being satisfied by
-- a constraint that refuses everything: both labels the issuer actually mints
-- go in, through the ordinary door, in the two kinds of book.

do $$
declare
  v_off uuid;
  v_on uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
  v_voucher uuid;
begin
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency, uses_financial_years)
  values ('ZZ Shape Bahi Co', '2025-04-01', 4, 'INR', false) returning id into v_off;
  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency)
  values ('ZZ Shape Yearly Co', '2025-04-01', 4, 'INR') returning id into v_on;
  perform app_private.seed_chart_of_accounts(v_off);
  perform app_private.seed_chart_of_accounts(v_on);

  select id into v_group from public.account_groups where company_id = v_off and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ SB Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_off and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ SB Sales') returning id into v_sales;
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 10, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 10, 'line_order', 1));
  v_voucher := public.create_voucher(v_off, 'sales', '2026-04-05', 'shape, continuous', null, null, v_lines);
  perform pg_temp.expect(
    (select v.financial_year_label from public.vouchers v where v.id = v_voucher) = 'continuous',
    'the constraint lets through what a continuous book actually mints'
  );

  select id into v_group from public.account_groups where company_id = v_on and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ SY Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_on and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ SY Sales') returning id into v_sales;
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 10, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 10, 'line_order', 1));
  v_voucher := public.create_voucher(v_on, 'sales', '2026-04-05', 'shape, year-keeping', null, null, v_lines);
  perform pg_temp.expect(
    (select v.financial_year_label from public.vouchers v where v.id = v_voucher) = '2026-27',
    'and what a year-keeping one mints'
  );

  set constraints all immediate;
  set constraints all deferred;
end;
$$;

-- --------------------- 45. a backup has to agree with itself about its books

\echo '45. A backup whose setting contradicts its own labels is refused'

-- The company's setting and the labels its own vouchers carry are two
-- statements about the same thing, read out of the same file, and the restore
-- never compared them. Hand-edit the flag — or supply it as JSON null, which
-- the coalesce reads as absent — and the restore builds a company marked
-- year-keeping whose every voucher is labelled 'continuous'. The next sale
-- then mints SAL/2026-27/00001 beside SAL/00001: a book with two numbering
-- schemes in it, which is exactly the state migration 0027's section 6 exists
-- to make unreachable.
--
-- Section 44's constraint cannot catch this, and that is why both exist. Both
-- values are individually well-formed; only their combination is wrong.
--
-- The refusal has to come before anything is written, which the overwrite
-- case below is what proves: the target still holds its own books afterwards.

do $$
declare
  v_user uuid;
  v_off uuid;
  v_on uuid;
  v_target uuid;
  v_restored uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
  p_off jsonb;
  p_on jsonb;
  v_before text[];
begin
  v_user := pg_temp.make_user('zz-backup-agrees@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_off := public.create_company('ZZ Agree Bahi Co', '2025-04-01', 4::smallint, 'INR', false);
  select id into v_group from public.account_groups where company_id = v_off and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ AB Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_off and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ AB Sales') returning id into v_sales;
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 60, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 60, 'line_order', 1));
  perform public.create_voucher(v_off, 'sales', '2026-03-20', 'before April', null, null, v_lines);
  perform public.create_voucher(v_off, 'sales', '2026-04-05', 'after April', null, null, v_lines);

  v_on := public.create_company('ZZ Agree Yearly Co', '2025-04-01', 4::smallint, 'INR');
  select id into v_group from public.account_groups where company_id = v_on and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ AY Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_on and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ AY Sales') returning id into v_sales;
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 60, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 60, 'line_order', 1));
  perform public.create_voucher(v_on, 'sales', '2026-03-20', 'before April', null, null, v_lines);
  perform public.create_voucher(v_on, 'sales', '2026-04-05', 'after April', null, null, v_lines);

  set constraints all immediate;
  set constraints all deferred;

  p_off := public.export_company_backup(v_off);
  p_on  := public.export_company_backup(v_on);

  -- The honest files first. A refusal that also refused the real thing would
  -- be worse than the hole it closes, and this is the half that says so.
  v_restored := public.restore_company_backup(p_off, 'new', null);
  set constraints all deferred;
  perform pg_temp.expect(
    (select not c.uses_financial_years from public.companies c where c.id = v_restored)
    and (select bool_and(v.financial_year_label = 'continuous') from public.vouchers v where v.company_id = v_restored),
    'a backup that agrees with itself restores exactly as before, continuous'
  );
  v_restored := public.restore_company_backup(p_on, 'new', null);
  set constraints all deferred;
  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = v_restored)
    and (select bool_and(v.financial_year_label ~ '^\d{4}-\d{2}$') from public.vouchers v where v.company_id = v_restored),
    'and so does a year-keeping one'
  );

  -- The flag hand-edited on a continuous file: the dangerous direction, and
  -- the one the audit reached by editing one key in a downloaded file.
  perform pg_temp.expect_error(
    format('select public.restore_company_backup(%L::jsonb, ''new'')',
           jsonb_set(p_off, '{company,uses_financial_years}', 'true'::jsonb)),
    'contradicts itself',
    'a file claiming financial years over continuous labels is refused'
  );
  perform pg_temp.expect_error(
    format('select public.restore_company_backup(%L::jsonb, ''new'')',
           jsonb_set(p_off, '{company,uses_financial_years}', 'true'::jsonb)),
    'continuous',
    'and the refusal names the label that disagreed'
  );

  -- The mirror. A check written in one direction would let a year-keeping
  -- book be restored as a continuous one, which is the worse of the two: its
  -- numbers already carry years the new scheme cannot mint.
  perform pg_temp.expect_error(
    format('select public.restore_company_backup(%L::jsonb, ''new'')',
           jsonb_set(p_on, '{company,uses_financial_years}', 'false'::jsonb)),
    'contradicts itself',
    'a file claiming no financial years over year labels is refused too'
  );
  perform pg_temp.expect_error(
    format('select public.restore_company_backup(%L::jsonb, ''new'')',
           jsonb_set(p_on, '{company,uses_financial_years}', 'false'::jsonb)),
    '2025-26',
    'and that refusal names one of the years it found'
  );

  -- The key present and null, which the coalesce reads as the documented
  -- default. That default is right for a file written before the column
  -- existed and says nothing at all here, so the comparison is what has to
  -- catch it.
  perform pg_temp.expect_error(
    format('select public.restore_company_backup(%L::jsonb, ''new'')',
           jsonb_set(p_off, '{company,uses_financial_years}', 'null'::jsonb)),
    'contradicts itself',
    'a null setting on a continuous file is caught by the same comparison'
  );

  -- And the case that must keep working, in both of its shapes: a file
  -- written before the column existed restores as what its own labels say it
  -- was — a company that keeps financial years.
  v_restored := public.restore_company_backup(
    jsonb_set(p_on, '{company}', (p_on->'company') - 'uses_financial_years'), 'new', null);
  set constraints all deferred;
  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = v_restored),
    'a file with no such key still restores as a year-keeping company'
  );
  v_restored := public.restore_company_backup(
    jsonb_set(p_on, '{company,uses_financial_years}', 'null'::jsonb), 'new', null);
  set constraints all deferred;
  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = v_restored),
    'and so does one whose key is present and null, which is read the same way'
  );

  -- The numbering rows are checked as well as the vouchers. They carry the
  -- same label in the same key, and a file whose vouchers were all removed
  -- but whose series were not would go on minting under the wrong scheme.
  perform pg_temp.expect_error(
    format('select public.restore_company_backup(%L::jsonb, ''new'')',
           jsonb_set(
             ((p_off - 'vouchers') - 'voucher_entries') - 'invoice_lines',
             '{company,uses_financial_years}', 'true'::jsonb)),
    'contradicts itself',
    'a file with no vouchers left is still caught by its numbering series'
  );

  -- The overwrite path refuses before it deletes anything, which is the only
  -- reason this refusal is safe to make at all: a restore that had already
  -- cleared the target and then refused would have destroyed a book to
  -- protect it.
  v_target := public.create_company('ZZ Agree Target Co', '2025-04-01', 4::smallint, 'INR');
  select id into v_group from public.account_groups where company_id = v_target and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_target, v_group, 'ZZ AT Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_target and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_target, v_group, 'ZZ AT Sales') returning id into v_sales;
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 25, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 25, 'line_order', 1));
  perform public.create_voucher(v_target, 'sales', '2026-04-05', 'the target''s own book', null, null, v_lines);
  set constraints all immediate;
  set constraints all deferred;

  select array_agg(v.voucher_number order by v.voucher_number) into v_before
  from public.vouchers v where v.company_id = v_target;

  perform pg_temp.expect_error(
    format('select public.restore_company_backup(%L::jsonb, ''overwrite'', %L::uuid)',
           jsonb_set(p_off, '{company,uses_financial_years}', 'true'::jsonb), v_target),
    'contradicts itself',
    'the overwrite path refuses the same file'
  );
  perform pg_temp.expect(
    (select array_agg(v.voucher_number order by v.voucher_number)
       from public.vouchers v where v.company_id = v_target) = v_before
    and (select c.uses_financial_years from public.companies c where c.id = v_target),
    format('and the company it would have overwritten still has its own books (%s)', v_before)
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ------------- 46. the freeze counts the numbers issued, not the rows left

\echo '46. Undoing every voucher does not unfreeze how a book is numbered'

-- The guard counted surviving public.vouchers, and revert_company_changes_since
-- hard-deletes vouchers. So a book whose every entry had been undone counted
-- zero and the setting flipped freely — even though numbers had been minted
-- and, in the guard's own words, "may be on paper".
--
-- The evidence survives the undo: 0019 rewinds voucher_number_sequences
-- rather than deleting it, precisely so the numbers can be reissued, and that
-- rewound row is the database's own record that SAL/00001 was once issued
-- under this setting. Counting it alongside the vouchers is what closes the
-- door.
--
-- A book that issued numbers and undid them is not a book that never issued
-- any, and the message has to be honest about which of the two it is looking
-- at: there is no voucher left to name, so it names the series instead.

do $$
declare
  v_user uuid;
  v_off uuid;
  v_on uuid;
  v_never uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
  v_mark timestamptz;
begin
  v_user := pg_temp.make_user('zz-freeze-after-undo@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_off := public.create_company('ZZ Undone Bahi Co', '2025-04-01', 4::smallint, 'INR', false);
  select id into v_group from public.account_groups where company_id = v_off and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ UB Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_off and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ UB Sales') returning id into v_sales;
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 45, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 45, 'line_order', 1));

  perform pg_temp.stamp_audit(v_off, now() - interval '60 minutes');
  v_mark := now() - interval '45 minutes';

  perform public.create_voucher(v_off, 'sales', '2026-04-05', 'first', null, null, v_lines);
  perform pg_temp.stamp_audit(v_off, now() - interval '40 minutes');
  perform public.create_voucher(v_off, 'sales', '2026-04-06', 'second', null, null, v_lines);
  perform pg_temp.stamp_audit(v_off, now() - interval '35 minutes');

  perform public.revert_company_changes_since(v_off, v_mark);
  set constraints all deferred;

  -- The state the old guard could not see: no vouchers, but a series that has
  -- been rewound rather than removed.
  perform pg_temp.expect(
    (select count(*) from public.vouchers v where v.company_id = v_off) = 0
    and (select s.next_number from public.voucher_number_sequences s
          where s.company_id = v_off and s.voucher_type = 'sales'
            and s.financial_year_label = 'continuous') = 1,
    'undoing the whole book leaves no vouchers and a series rewound to 1'
  );

  perform pg_temp.expect_error(
    format('update public.companies set uses_financial_years = true where id = %L', v_off),
    'two numbering schemes',
    'and the choice is still frozen, because numbers were issued under it'
  );
  perform pg_temp.expect_error(
    format('update public.companies set uses_financial_years = true where id = %L', v_off),
    'may be on paper',
    'and the refusal still says why, rather than borrowing a wording about vouchers that no longer exist'
  );
  perform pg_temp.expect_error(
    format('update public.companies set uses_financial_years = true where id = %L', v_off),
    'SAL',
    'and it names the series that issued them'
  );
  perform pg_temp.expect(
    (select not c.uses_financial_years from public.companies c where c.id = v_off),
    'the refused change left the setting alone'
  );

  -- The mirror, so that a guard fixed in one direction is not passed off as
  -- fixed in both.
  v_on := public.create_company('ZZ Undone Yearly Co', '2025-04-01', 4::smallint, 'INR');
  select id into v_group from public.account_groups where company_id = v_on and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ UY Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_on and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ UY Sales') returning id into v_sales;
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 45, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 45, 'line_order', 1));

  perform pg_temp.stamp_audit(v_on, now() - interval '60 minutes');
  v_mark := now() - interval '45 minutes';
  perform public.create_voucher(v_on, 'sales', '2026-04-05', 'first', null, null, v_lines);
  perform pg_temp.stamp_audit(v_on, now() - interval '40 minutes');

  perform public.revert_company_changes_since(v_on, v_mark);
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(*) from public.vouchers v where v.company_id = v_on) = 0,
    'the year-keeping book is empty of vouchers too'
  );
  perform pg_temp.expect_error(
    format('update public.companies set uses_financial_years = false where id = %L', v_on),
    'two numbering schemes',
    'and it is frozen for the same reason, by its own rewound series'
  );

  -- And the over-correction half. A book that has genuinely never issued a
  -- number — a chart of accounts, ledgers, opening balances, no voucher ever
  -- saved — must still be free to change, which is the whole of section 40's
  -- "why it can change before".
  v_never := public.create_company('ZZ Never Numbered Co', '2025-04-01', 4::smallint, 'INR');
  select id into v_group from public.account_groups where company_id = v_never and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_never, v_group, 'ZZ NN Cash') returning id into v_cash;

  perform pg_temp.expect(
    (select count(*) from public.voucher_number_sequences s where s.company_id = v_never) = 0,
    'a book that has never saved a voucher has no numbering series at all'
  );
  update public.companies set uses_financial_years = false where id = v_never;
  update public.companies set uses_financial_years = true where id = v_never;
  perform pg_temp.expect(
    (select c.uses_financial_years from public.companies c where c.id = v_never),
    'so it can still be switched, both ways, with ledgers already on the books'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- --------------- 47. the refusal names the first number, not the first date

\echo '47. The freeze names the first number issued, not the earliest-dated voucher'

-- The guard picked the voucher to name with `order by voucher_date`, so a
-- back-dated entry made it report "the first of them numbered SAL/00002" —
-- naming a number that is not the first. The user is being asked to accept
-- that a number is already out there; naming the wrong one undermines the
-- only evidence the message offers.
--
-- This shows up in a continuous book because there is no year fence keeping
-- entry order and date order together. A year-keeping book can do it too, and
-- the second half below pins the tie-break that settles it.

do $$
declare
  v_user uuid;
  v_off uuid;
  v_on uuid;
  v_group uuid;
  v_cash uuid;
  v_sales uuid;
  v_lines jsonb;
  v_message text;
begin
  v_user := pg_temp.make_user('zz-first-number@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_off := public.create_company('ZZ Backdated Bahi Co', '2024-01-01', 4::smallint, 'INR', false);
  select id into v_group from public.account_groups where company_id = v_off and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ BD Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_off and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_off, v_group, 'ZZ BD Sales') returning id into v_sales;
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 30, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 30, 'line_order', 1));

  -- Entered in this order, so SAL/00001 is the later date and SAL/00002 the
  -- earlier one. That is ordinary: a trader enters June's sale, then finds
  -- January's docket under the counter.
  perform public.create_voucher(v_off, 'sales', '2026-06-01', 'entered first', null, null, v_lines);
  perform public.create_voucher(v_off, 'sales', '2025-01-01', 'entered second, dated earlier', null, null, v_lines);
  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select v.voucher_number from public.vouchers v
      where v.company_id = v_off and v.voucher_date = '2026-06-01') = 'SAL/00001'
    and (select v.voucher_number from public.vouchers v
          where v.company_id = v_off and v.voucher_date = '2025-01-01') = 'SAL/00002',
    'the book numbers by the order things were entered, not by the dates on them'
  );

  v_message := null;
  begin
    update public.companies set uses_financial_years = true where id = v_off;
  exception when others then
    v_message := sqlerrm;
  end;

  perform pg_temp.expect(
    v_message is not null and position('numbered SAL/00001' in v_message) > 0,
    'the refusal names SAL/00001, the first number the book issued'
  );
  perform pg_temp.expect(
    v_message is not null and position('SAL/00002' in v_message) = 0,
    'and does not name SAL/00002, which is merely the earliest-dated voucher'
  );

  -- A year-keeping book can hold the same shape — two series, each with its
  -- own 00001 — so the ordering has to be total rather than merely correct on
  -- the common case. sequence_number first, then the date, then the number.
  v_on := public.create_company('ZZ Backdated Yearly Co', '2024-01-01', 4::smallint, 'INR');
  select id into v_group from public.account_groups where company_id = v_on and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ BY Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_on and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_on, v_group, 'ZZ BY Sales') returning id into v_sales;
  v_lines := jsonb_build_array(
    jsonb_build_object('ledger_id', v_cash,  'debit_amount', 30, 'credit_amount', 0, 'line_order', 0),
    jsonb_build_object('ledger_id', v_sales, 'debit_amount', 0, 'credit_amount', 30, 'line_order', 1));

  perform public.create_voucher(v_on, 'sales', '2026-06-01', 'entered first', null, null, v_lines);
  perform public.create_voucher(v_on, 'sales', '2025-01-01', 'entered second, dated earlier', null, null, v_lines);
  set constraints all immediate;
  set constraints all deferred;

  perform pg_temp.expect(
    (select count(distinct v.sequence_number) from public.vouchers v where v.company_id = v_on) = 1,
    'both of the year-keeping book''s vouchers are number 1 of their own year'
  );

  v_message := null;
  begin
    update public.companies set uses_financial_years = false where id = v_on;
  exception when others then
    v_message := sqlerrm;
  end;

  perform pg_temp.expect(
    v_message is not null and position('numbered SAL/2024-25/00001' in v_message) > 0,
    'and with the sequence numbers tied, the earlier-dated of the two is named'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- --------------- 48. get_ledger_statement's counterparty column

\echo '48. The Ledger Statement names the other side of each voucher'

-- The Narration column is free text someone typed by hand and doesn't
-- reliably say which ledger the money went to or came from. counterparty is
-- derived from the postings themselves: every *other* line of the same
-- voucher, comma-joined (migration 0028).
do $$
declare
  v_user uuid;
  v_company uuid;
  v_group uuid;
  v_cash uuid;
  v_supplier uuid;
  v_expense uuid;
  v_supplier_x uuid;
  v_supplier_y uuid;
  v_debtor uuid;
  v_bank uuid;
  v_payment_voucher uuid;
  v_journal_voucher uuid;
  v_unrelated_voucher uuid;
begin
  v_user := pg_temp.make_user('zz-ledger-statement-counterparty@hisab.invalid');
  perform pg_temp.act_as(v_user);

  v_company := public.create_company('ZZ Ledger Statement Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ LS Cash') returning id into v_cash;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Bank Accounts';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ LS Bank') returning id into v_bank;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ LS Supplier') returning id into v_supplier;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ LS Supplier X') returning id into v_supplier_x;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ LS Supplier Y') returning id into v_supplier_y;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ LS Debtor') returning id into v_debtor;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ LS Expense') returning id into v_expense;

  -- An ordinary two-line payment: cash goes out, the supplier's balance
  -- comes down. Querying the Cash ledger's statement, Supplier is the one
  -- and only counterparty.
  v_payment_voucher := public.create_voucher(
    v_company, 'payment', '2026-04-05', 'paid supplier', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_supplier, 'debit_amount', 200, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_cash,     'debit_amount', 0, 'credit_amount', 200, 'line_order', 1)
    )
  );

  -- A three-line journal splits one expense across two suppliers. Querying
  -- the Expense ledger's statement, both suppliers are counterparties —
  -- comma-joined, alphabetically, and with nothing to link a click to.
  v_journal_voucher := public.create_voucher(
    v_company, 'journal', '2026-04-08', 'expense split across two suppliers', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_expense,    'debit_amount', 1000, 'credit_amount', 0,   'line_order', 0),
      jsonb_build_object('ledger_id', v_supplier_y, 'debit_amount', 0,    'credit_amount', 600, 'line_order', 1),
      jsonb_build_object('ledger_id', v_supplier_x, 'debit_amount', 0,    'credit_amount', 400, 'line_order', 2)
    )
  );

  -- A voucher that never touches Cash at all — a basic tenancy sanity check
  -- that the WHERE clause on ve.ledger_id actually confines the statement to
  -- the ledger asked for.
  v_unrelated_voucher := public.create_voucher(
    v_company, 'receipt', '2026-04-10', 'advance from a debtor, nothing to do with cash', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_bank,   'debit_amount', 500, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_debtor, 'debit_amount', 0, 'credit_amount', 500, 'line_order', 1)
    )
  );

  perform pg_temp.expect(
    (select count(*) from public.get_ledger_statement(v_company, v_cash, '2026-04-01', '2026-04-30')
      where voucher_id = v_payment_voucher
        and counterparty = 'ZZ LS Supplier'
        and counterparty_ledger_id = v_supplier) = 1,
    'a two-line payment voucher shows exactly one counterparty, and it is correct'
  );

  perform pg_temp.expect(
    (select count(*) from public.get_ledger_statement(v_company, v_expense, '2026-04-01', '2026-04-30')
      where voucher_id = v_journal_voucher
        and counterparty = 'ZZ LS Supplier X, ZZ LS Supplier Y'
        and counterparty_ledger_id is null) = 1,
    'a multi-line journal lists every other ledger, comma-joined, and stays unlinked'
  );

  perform pg_temp.expect(
    (select counterparty from public.get_ledger_statement(v_company, v_cash, '2026-04-01', '2026-04-30')
      where voucher_id is null and entry_date is null) is null,
    'the synthetic Opening Balance row gains no counterparty'
  );

  perform pg_temp.expect(
    (select count(*) from public.get_ledger_statement(v_company, v_cash, '2026-04-01', '2026-04-30')
      where voucher_id = v_unrelated_voucher) = 0,
    'a voucher that never touches this ledger never appears on its statement'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- --------------------------------------------- 49. merge_ledgers()

\echo '49. Merging two ledgers moves everything and combines the balances'

-- Two duplicate customers, one voucher posted straight to the duplicate and
-- one sales invoice naming it as the party — merge_ledgers has to repoint
-- both voucher_entries.ledger_id and vouchers.party_ledger_id, and to fold
-- the two opening balances (one debit, one credit) into a single net figure
-- on the survivor. A second pair of duplicate income ledgers, with an
-- invoice line and a bank narration rule pointing at one of them, checks the
-- two references migration 0028's counterparty column never had to touch:
-- invoice_lines.revenue_ledger_id and bank_narration_rules.contra_ledger_id.
do $$
declare
  v_admin uuid;
  v_accountant uuid;
  v_company uuid;
  v_other_company uuid;
  v_group uuid;
  v_dup_customer uuid;
  v_canonical_customer uuid;
  v_cash uuid;
  v_goods uuid;
  v_sales_dup uuid;
  v_sales_canonical uuid;
  v_bank uuid;
  v_other_ledger uuid;
  v_receipt_voucher uuid;
  v_invoice_voucher uuid;
  v_invoice2_voucher uuid;
  v_rule_id uuid;
begin
  v_admin := pg_temp.make_user('zz-merge-admin@hisab.invalid');
  v_accountant := pg_temp.make_user('zz-merge-accountant@hisab.invalid');

  perform pg_temp.act_as(v_admin);
  v_company := public.create_company('ZZ Merge Co', '2025-04-01', 4::smallint, 'INR');
  v_other_company := public.create_company('ZZ Merge Other Co', '2025-04-01', 4::smallint, 'INR');

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_company, v_accountant, 'accountant', 'active', v_admin);

  select id into v_group from public.account_groups where company_id = v_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type, phone)
    values (v_company, v_group, 'ZZ Merge Dup Customer', 500, 'debit', '9999999999') returning id into v_dup_customer;
  insert into public.ledgers (company_id, group_id, name, opening_balance_amount, opening_balance_type, contact_person)
    values (v_company, v_group, 'ZZ Merge Canonical Customer', 300, 'credit', 'Existing Contact') returning id into v_canonical_customer;

  select id into v_group from public.account_groups where company_id = v_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Merge Cash') returning id into v_cash;

  select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Incomes';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Merge Goods') returning id into v_goods;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Merge Sales Dup') returning id into v_sales_dup;
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Merge Sales Canonical') returning id into v_sales_canonical;

  select id into v_group from public.account_groups where company_id = v_company and name = 'Bank Accounts';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Merge Bank') returning id into v_bank;

  select id into v_group from public.account_groups where company_id = v_other_company and name = 'Sundry Debtors';
  insert into public.ledgers (company_id, group_id, name) values (v_other_company, v_group, 'ZZ Merge Other Ledger') returning id into v_other_ledger;

  -- A plain receipt posted straight to the duplicate customer.
  v_receipt_voucher := public.create_voucher(
    v_company, 'receipt', '2026-04-05', 'from the duplicate customer', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_cash,         'debit_amount', 500, 'credit_amount', 0,   'line_order', 0),
      jsonb_build_object('ledger_id', v_dup_customer, 'debit_amount', 0,   'credit_amount', 500, 'line_order', 1)
    )
  );

  -- A sales invoice naming the duplicate as its party — exercises
  -- vouchers.party_ledger_id, not just voucher_entries.
  v_invoice_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-06', 'invoice to the duplicate customer', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_dup_customer, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Widgets', 'quantity', 1,
                         'rate', 1000, 'revenue_ledger_id', v_goods)))
  );

  -- A second invoice whose *revenue* line — not its party — is one of the
  -- duplicate income ledgers.
  v_invoice2_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-07', 'invoice booked to the duplicate income ledger', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_canonical_customer, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Consulting', 'quantity', 1,
                         'rate', 750, 'revenue_ledger_id', v_sales_dup)))
  );

  set constraints all immediate;
  set constraints all deferred;

  -- A learned narration rule whose contra side is the duplicate income
  -- ledger — "this bank narration means ZZ Merge Sales Dup".
  insert into public.bank_narration_rules (company_id, bank_ledger_id, pattern, direction, contra_ledger_id, is_manual)
    values (v_company, v_bank, 'ZZMERGEPATTERN', 'deposit', v_sales_dup, true)
    returning id into v_rule_id;

  -- --------------------------------------------------- guard rails first

  perform pg_temp.expect_error(
    format('select public.merge_ledgers(%L, %L, %L)', v_company, v_dup_customer, v_dup_customer),
    'cannot be merged into itself',
    'a ledger cannot be merged into itself'
  );

  perform pg_temp.act_as(v_accountant);
  perform pg_temp.expect_error(
    format('select public.merge_ledgers(%L, %L, %L)', v_company, v_dup_customer, v_canonical_customer),
    'Only an admin can merge ledgers',
    'an accountant cannot merge ledgers, even ones they can otherwise edit'
  );
  perform pg_temp.act_as(v_admin);

  perform pg_temp.expect_error(
    format('select public.merge_ledgers(%L, %L, %L)', v_company, v_cash, v_canonical_customer),
    'Cash and bank ledgers can''t be merged',
    'a cash/bank ledger is refused as the source'
  );
  perform pg_temp.expect_error(
    format('select public.merge_ledgers(%L, %L, %L)', v_company, v_dup_customer, v_bank),
    'Cash and bank ledgers can''t be merged',
    'a cash/bank ledger is refused as the target'
  );

  perform pg_temp.expect_error(
    format('select public.merge_ledgers(%L, %L, %L)', v_company, v_other_ledger, v_canonical_customer),
    'Both ledgers must belong to this company',
    'a ledger from another company is refused, not merged across the boundary'
  );

  -- ------------------------------------------------- the merge itself

  perform public.merge_ledgers(v_company, v_dup_customer, v_canonical_customer);

  perform pg_temp.expect(
    not exists (select 1 from public.ledgers where id = v_dup_customer),
    'the duplicate customer is gone after the merge'
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries where ledger_id = v_dup_customer) = 0
    and (select count(*) from public.voucher_entries where ledger_id = v_canonical_customer and voucher_id = v_receipt_voucher) = 1,
    'the receipt''s posting moved from the duplicate to the canonical customer'
  );

  perform pg_temp.expect(
    (select party_ledger_id from public.vouchers where id = v_invoice_voucher) = v_canonical_customer,
    'the invoice''s party moved from the duplicate to the canonical customer'
  );

  perform pg_temp.expect(
    (select opening_balance_amount from public.ledgers where id = v_canonical_customer) = 200
    and (select opening_balance_type from public.ledgers where id = v_canonical_customer) = 'debit',
    -- 500 Dr (duplicate) net against 300 Cr (canonical) leaves 200 Dr, the
    -- same net figure the two ledgers carried between them beforehand.
    'the two opening balances net to a single combined figure on the survivor'
  );

  perform pg_temp.expect(
    (select phone from public.ledgers where id = v_canonical_customer) = '9999999999'
    and (select contact_person from public.ledgers where id = v_canonical_customer) = 'Existing Contact',
    'the survivor keeps its own contact details and gains the duplicate''s blank ones, never the reverse'
  );

  -- --------------------------- the income-ledger pair: invoice_lines + bank_narration_rules

  perform public.merge_ledgers(v_company, v_sales_dup, v_sales_canonical);

  perform pg_temp.expect(
    not exists (select 1 from public.ledgers where id = v_sales_dup),
    'the duplicate income ledger is gone after the merge'
  );

  perform pg_temp.expect(
    (select revenue_ledger_id from public.invoice_lines where voucher_id = v_invoice2_voucher) = v_sales_canonical,
    'the invoice line''s revenue ledger moved to the canonical income ledger'
  );

  perform pg_temp.expect(
    (select count(*) from public.voucher_entries where ledger_id = v_sales_canonical and voucher_id = v_invoice2_voucher) = 1,
    'the posting generated from that invoice line moved with it'
  );

  perform pg_temp.expect(
    (select contra_ledger_id from public.bank_narration_rules where id = v_rule_id) = v_sales_canonical,
    'the narration rule''s contra ledger moved instead of the rule cascading away with the deleted ledger'
  );

  perform pg_temp.act_as(null);
end;
$$;

-- ------------------------------------------------ 50. bill_capture_drafts

\echo '50. A bill capture draft can only be confirmed against a real purchase voucher'

do $$
declare
  v_admin uuid;
  v_outsider uuid;
  v_company uuid;
  v_other_company uuid;
  v_group uuid;
  v_supplier uuid;
  v_goods uuid;
  v_purchase_voucher uuid;
  v_sales_voucher uuid;
  v_other_company_voucher uuid;
  v_draft uuid;
  v_message text;
begin
  v_admin := pg_temp.make_user('zz-capture-admin@hisab.invalid');
  v_outsider := pg_temp.make_user('zz-capture-outsider@hisab.invalid');

  perform pg_temp.act_as(v_admin);
  v_company := public.create_company('ZZ Capture Co', '2025-04-01', 4::smallint, 'INR');
  v_other_company := public.create_company('ZZ Capture Other Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups where company_id = v_company and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Capture Supplier') returning id into v_supplier;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Capture Goods') returning id into v_goods;

  v_purchase_voucher := public.create_voucher(
    v_company, 'purchase', '2026-04-05', 'captured bill', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_supplier, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Raw material', 'quantity', 1, 'rate', 5000, 'revenue_ledger_id', v_goods)))
  );
  v_sales_voucher := public.create_voucher(
    v_company, 'sales', '2026-04-05', 'not a purchase', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_supplier, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Wrong type', 'quantity', 1, 'rate', 5000, 'revenue_ledger_id', v_goods)))
  );
  set constraints all immediate;
  set constraints all deferred;

  select id into v_group from public.account_groups where company_id = v_other_company and name = 'Cash-in-Hand';
  insert into public.ledgers (company_id, group_id, name) values (v_other_company, v_group, 'ZZ Capture Other Cash') returning id into v_goods;
  select id into v_group from public.account_groups where company_id = v_other_company and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name) values (v_other_company, v_group, 'ZZ Capture Other Expense') returning id into v_supplier;

  v_other_company_voucher := public.create_voucher(
    v_other_company, 'purchase', '2026-04-05', 'a different company entirely', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', v_supplier, 'debit_amount', 1, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', v_goods,    'debit_amount', 0, 'credit_amount', 1, 'line_order', 1)
    )
  );
  set constraints all immediate;
  set constraints all deferred;

  insert into public.bill_capture_drafts (company_id, vendor_hint)
    values (v_company, 'looked like the usual supplier')
    returning id into v_draft;
  insert into public.bill_capture_pages (draft_id, company_id, page_no, storage_path)
    values (v_draft, v_company, 1, v_company || '/' || v_draft || '/1.jpg');

  perform pg_temp.expect(
    (select status from public.bill_capture_drafts where id = v_draft) = 'pending_review',
    'a freshly captured draft starts pending review'
  );

  perform pg_temp.expect(
    (select created_by from public.bill_capture_drafts where id = v_draft) = v_admin,
    'created_by is filled in from the session, not trusted from the client'
  );

  update public.bill_capture_drafts set status = 'confirmed' where id = v_draft;
  perform pg_temp.expect(
    (select status from public.bill_capture_drafts where id = v_draft) = 'pending_review',
    'writing the literal word confirmed does nothing — status is computed, not accepted'
  );

  perform pg_temp.expect_error(
    format('update public.bill_capture_drafts set confirmed_voucher_id = %L where id = %L', v_sales_voucher, v_draft),
    'can only be confirmed against a purchase voucher',
    'a sales voucher cannot confirm a purchase-bill capture'
  );

  perform pg_temp.expect_error(
    format('update public.bill_capture_drafts set confirmed_voucher_id = %L where id = %L', v_other_company_voucher, v_draft),
    'does not exist in this company',
    'a voucher from a different company cannot confirm this draft'
  );

  update public.bill_capture_drafts set confirmed_voucher_id = v_purchase_voucher where id = v_draft;
  perform pg_temp.expect(
    (select status from public.bill_capture_drafts where id = v_draft) = 'confirmed',
    'confirming against a real purchase voucher in the same company succeeds'
  );

  v_message := null;
  begin
    update public.bill_capture_drafts set note = 'trying to edit a confirmed draft' where id = v_draft;
  exception when others then
    v_message := sqlerrm;
  end;
  perform pg_temp.expect(
    v_message is not null and position('already confirmed' in v_message) > 0,
    'a confirmed draft is terminal — nothing about it can change further'
  );

  -- A second draft, to prove rejection needs a reason and is equally terminal.
  insert into public.bill_capture_drafts (company_id)
    values (v_company)
    returning id into v_draft;
  insert into public.bill_capture_pages (draft_id, company_id, page_no, storage_path)
    values (v_draft, v_company, 1, v_company || '/' || v_draft || '/1.jpg');

  perform pg_temp.expect_error(
    format('update public.bill_capture_drafts set rejected_at = now(), rejected_by = %L where id = %L', v_admin, v_draft),
    'A rejection needs a reason',
    'rejecting without a reason is refused'
  );

  update public.bill_capture_drafts
    set rejected_at = now(), rejected_by = v_admin, rejected_reason = 'blurry photo, please retake'
    where id = v_draft;
  perform pg_temp.expect(
    (select status from public.bill_capture_drafts where id = v_draft) = 'rejected',
    'rejecting with a reason succeeds'
  );

  -- RLS: someone outside the company cannot see or touch its captures at
  -- all. `set local role authenticated` is what actually makes the policies
  -- apply to this session — plain act_as() only sets the JWT claim
  -- functions like is_company_member() read; the connection itself stays
  -- the table-owning role otherwise, which bypasses RLS entirely.
  grant select, insert on public.bill_capture_drafts to authenticated;

  perform pg_temp.act_as(v_outsider);
  set local role authenticated;

  perform pg_temp.expect(
    (select count(*) from public.bill_capture_drafts where company_id = v_company) = 0,
    'a non-member sees no captures for a company they do not belong to'
  );
  perform pg_temp.expect_error(
    format('insert into public.bill_capture_drafts (company_id) values (%L)', v_company),
    'row-level security',
    'a non-member cannot create a capture for a company they do not belong to'
  );

  reset role;
  perform pg_temp.act_as(null);
end;
$$;

-- ------------------------------------------------ 51. bill_capture_pages

\echo '51. A bill capture can hold more than one page, only while pending review'

do $$
declare
  v_admin uuid;
  v_company uuid;
  v_draft uuid;
  v_supplier uuid;
  v_goods uuid;
  v_group uuid;
  v_voucher uuid;
  v_page1 uuid;
  v_page2 uuid;
begin
  v_admin := pg_temp.make_user('zz-capture-pages-admin@hisab.invalid');
  perform pg_temp.act_as(v_admin);
  v_company := public.create_company('ZZ Capture Pages Co', '2025-04-01', 4::smallint, 'INR');

  select id into v_group from public.account_groups where company_id = v_company and name = 'Sundry Creditors';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Pages Supplier') returning id into v_supplier;
  select id into v_group from public.account_groups where company_id = v_company and name = 'Direct Expenses';
  insert into public.ledgers (company_id, group_id, name) values (v_company, v_group, 'ZZ Pages Goods') returning id into v_goods;

  insert into public.bill_capture_drafts (company_id) values (v_company) returning id into v_draft;

  insert into public.bill_capture_pages (draft_id, company_id, page_no, storage_path)
    values (v_draft, v_company, 1, v_company || '/' || v_draft || '/1.jpg')
    returning id into v_page1;
  insert into public.bill_capture_pages (draft_id, company_id, page_no, storage_path)
    values (v_draft, v_company, 2, v_company || '/' || v_draft || '/2.jpg')
    returning id into v_page2;

  perform pg_temp.expect(
    (select count(*) from public.bill_capture_pages where draft_id = v_draft) = 2,
    'a draft can hold more than one page'
  );

  perform pg_temp.expect(
    (select array_agg(page_no order by page_no) from public.bill_capture_pages where draft_id = v_draft) = array[1, 2]::smallint[],
    'pages keep their own order'
  );

  perform pg_temp.expect_error(
    format(
      'insert into public.bill_capture_pages (draft_id, company_id, page_no, storage_path) values (%L, %L, 1, %L)',
      v_draft, v_company, v_company || '/' || v_draft || '/1-again.jpg'
    ),
    'duplicate key',
    'two pages cannot both claim the same page number on one draft'
  );

  v_voucher := public.create_voucher(
    v_company, 'purchase', '2026-04-05', 'confirms the multi-page capture', null, null, '[]'::jsonb,
    jsonb_build_object('party_ledger_id', v_supplier, 'lines', jsonb_build_array(
      jsonb_build_object('line_order', 0, 'description', 'Goods', 'quantity', 1, 'rate', 1000, 'revenue_ledger_id', v_goods)))
  );
  set constraints all immediate;
  set constraints all deferred;

  update public.bill_capture_drafts set confirmed_voucher_id = v_voucher where id = v_draft;

  -- Both remaining checks are genuine RLS (a policy re-checking the parent
  -- draft's status, not a trigger), so — same as section 50 — this needs
  -- `set local role authenticated` to actually apply; plain act_as() alone
  -- leaves the session as the table-owning role, which bypasses RLS.
  grant select, insert, delete on public.bill_capture_pages to authenticated;
  set local role authenticated;

  perform pg_temp.expect_error(
    format(
      'insert into public.bill_capture_pages (draft_id, company_id, page_no, storage_path) values (%L, %L, 3, %L)',
      v_draft, v_company, v_company || '/' || v_draft || '/3.jpg'
    ),
    'row-level security',
    'a page cannot be added to a draft that is already confirmed'
  );

  -- DELETE's policy carries a USING clause and no WITH CHECK — a visibility
  -- filter, not a veto, so a blocked delete is silent: the statement simply
  -- matches no rows. The guarantee is what's still there afterwards, not
  -- what was raised (the same shape section 43's lock-date test uses).
  delete from public.bill_capture_pages where id = v_page1;

  reset role;

  perform pg_temp.expect(
    (select count(*) from public.bill_capture_pages where draft_id = v_draft) = 2,
    'the confirmed draft''s pages survive both attempts untouched'
  );

  perform pg_temp.act_as(null);
end;
$$;

\echo ''
\echo 'ALL GUARANTEES HELD'

-- Nothing above is kept: this must be safe to run against a real database.
rollback;
