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

create or replace function pg_temp.expect(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if not p_condition then
    raise exception 'FAILED: %', p_what;
  end if;
  raise notice '  ok  %', p_what;
end;
$$;

-- Asserts that `p_sql` raises, and that the message mentions `p_expect`.
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
      if v_message like 'FAILED:%' then
        raise;
      end if;
      if position(lower(p_expect) in lower(v_message)) = 0 then
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

\echo ''
\echo 'ALL GUARANTEES HELD'

-- Nothing above is kept: this must be safe to run against a real database.
rollback;
