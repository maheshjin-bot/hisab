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

\echo ''
\echo 'ALL GUARANTEES HELD'

-- Nothing above is kept: this must be safe to run against a real database.
rollback;
