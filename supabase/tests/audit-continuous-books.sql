-- AUDIT: books without financial years (migration 0027)
--
-- An independent survey, written without reading guarantees.sql sections
-- 38-43 and sharing none of their fixtures. It does not stop on the first
-- failure: every check records a row and the run reports the whole list at the
-- end, then exits non-zero if anything failed.
--
--   psql -d hisab_audit -v ON_ERROR_STOP=1 -f supabase/tests/audit-continuous-books.sql
--
-- Self-contained: it builds its own users, companies, ledgers and vouchers and
-- rolls the whole transaction back. The results table is a temporary table
-- created before the transaction and the summary is pulled into psql
-- variables before the rollback, so the report survives it.

\pset pager off
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- results

drop table if exists audit_results;
create temporary table audit_results (
  id       serial primary key,
  section  text not null,
  name     text not null,
  passed   boolean not null,
  expected text,
  actual   text
);

-- A NULL condition is a failure, never a pass. Most checks below compare a
-- value the database was supposed to store, and `stored = expected` is NULL
-- rather than false when nothing was stored at all.
create or replace function pg_temp.ck(
  p_section text, p_name text, p_ok boolean,
  p_expected text default null, p_actual text default null
) returns void language plpgsql as $ck$
begin
  insert into pg_temp.audit_results (section, name, passed, expected, actual)
  values (p_section, p_name, p_ok is true, p_expected, p_actual);
  if p_ok is true then
    raise notice 'ok   [%] %', p_section, p_name;
  else
    raise notice 'FAIL [%] %  expected <%>  actual <%>', p_section, p_name, p_expected, p_actual;
  end if;
end;
$ck$;

-- Text equality, NULL-safe in the direction that matters: a NULL actual
-- against a non-NULL expected is a failure and is reported as such.
create or replace function pg_temp.ck_eq(
  p_section text, p_name text, p_actual text, p_expected text
) returns void language plpgsql as $ck$
begin
  perform pg_temp.ck(p_section, p_name,
                     p_actual is not distinct from p_expected,
                     p_expected, coalesce(p_actual, '<null>'));
end;
$ck$;

-- Runs a statement in a subtransaction and hands back SQLERRM, or NULL if it
-- succeeded. Everything it wrote is rolled back either way, so a probe never
-- contaminates a later fixture.
create or replace function pg_temp.probe(p_sql text)
returns text language plpgsql as $probe$
begin
  begin
    execute p_sql;
    return null;
  exception when others then
    return sqlerrm;
  end;
end;
$probe$;

-- The statement must fail, and the message must contain p_fragment.
create or replace function pg_temp.ck_refused(
  p_section text, p_name text, p_sql text, p_fragment text
) returns void language plpgsql as $ck$
declare v_err text;
begin
  v_err := pg_temp.probe(p_sql);
  if v_err is null then
    perform pg_temp.ck(p_section, p_name, false,
                       'refused, mentioning ' || quote_literal(p_fragment),
                       'the statement was ACCEPTED');
  else
    perform pg_temp.ck(p_section, p_name,
                       position(lower(p_fragment) in lower(v_err)) > 0,
                       'refused, mentioning ' || quote_literal(p_fragment),
                       v_err);
  end if;
end;
$ck$;

-- The statement must succeed.
create or replace function pg_temp.ck_allowed(
  p_section text, p_name text, p_sql text
) returns void language plpgsql as $ck$
declare v_err text;
begin
  -- Not run through probe(): an allowed statement has to keep its effect.
  begin
    execute p_sql;
    perform pg_temp.ck(p_section, p_name, true, 'accepted', 'accepted');
  exception when others then
    perform pg_temp.ck(p_section, p_name, false, 'accepted', 'REFUSED: ' || sqlerrm);
  end;
end;
$ck$;

begin;

-- ---------------------------------------------------------------- fixtures

create or replace function pg_temp.mk_user(p_email text) returns uuid
language plpgsql as $f$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_email, now(), '{}'::jsonb,
          jsonb_build_object('full_name', p_email), now(), now());
  return v_id;
end;
$f$;

create or replace function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $f$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '', true);
  else
    perform set_config('request.jwt.claims',
      (select jsonb_build_object('sub', p_user, 'role', 'authenticated',
                                 'email', u.email)::text
         from auth.users u where u.id = p_user), true);
  end if;
end;
$f$;

-- A company plus the five ledgers every fixture below posts through.
create or replace function pg_temp.mk_company(
  p_name text, p_uses_years boolean, p_fy_start smallint default 4,
  p_beginning date default date '2024-01-01'
) returns uuid language plpgsql as $f$
declare
  v_company uuid;
  v_user uuid := auth.uid();
begin
  v_company := public.create_company(p_name, p_beginning, p_fy_start, 'INR'::char(3), p_uses_years);

  insert into public.ledgers (company_id, group_id, name, created_by)
  select v_company, g.id, l.nm, v_user
  from (values
      ('Cash-in-Hand',     'Cash'),
      ('Sundry Debtors',   'Customer'),
      ('Sundry Creditors', 'Supplier'),
      ('Direct Incomes',   'Sales'),
      ('Direct Expenses',  'Purchases')
    ) as l(grp, nm)
  join public.account_groups g
    on g.company_id = v_company and g.name = l.grp;

  return v_company;
end;
$f$;

create or replace function pg_temp.led(p_company uuid, p_name text) returns uuid
language sql stable as $f$
  select id from public.ledgers where company_id = p_company and name = p_name;
$f$;

-- A plain two-line voucher. Forces the deferred balance triggers so
-- total_amount is stamped and a bad fixture fails here rather than at a
-- COMMIT this script never reaches.
create or replace function pg_temp.post(
  p_company uuid, p_type text, p_date date, p_amount numeric,
  p_debit text, p_credit text, p_ref text default null
) returns uuid language plpgsql as $f$
declare v_id uuid;
begin
  v_id := public.create_voucher(
    p_company, p_type, p_date, 'audit fixture', p_ref, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', pg_temp.led(p_company, p_debit),
                         'debit_amount', p_amount, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', pg_temp.led(p_company, p_credit),
                         'debit_amount', 0, 'credit_amount', p_amount, 'line_order', 1)
    ),
    null);
  set constraints all immediate;
  set constraints all deferred;
  return v_id;
end;
$f$;

-- A purchase invoice against a supplier, carrying a bill number. This is the
-- only shape find_duplicate_bill can see: it matches on party_ledger_id, and
-- only an invoice sets one.
create or replace function pg_temp.post_bill(
  p_company uuid, p_date date, p_amount numeric, p_bill text
) returns uuid language plpgsql as $f$
declare v_id uuid;
begin
  v_id := public.create_voucher(
    p_company, 'purchase', p_date, 'audit bill', p_bill, null,
    '[]'::jsonb,
    jsonb_build_object(
      'party_ledger_id', pg_temp.led(p_company, 'Supplier'),
      'lines', jsonb_build_array(jsonb_build_object(
        'description', 'goods',
        'revenue_ledger_id', pg_temp.led(p_company, 'Purchases'),
        'quantity', 1, 'rate', p_amount, 'line_order', 0))));
  set constraints all immediate;
  set constraints all deferred;
  return v_id;
end;
$f$;

create or replace function pg_temp.num(p_voucher uuid) returns text
language sql stable as $f$
  select voucher_number from public.vouchers where id = p_voucher;
$f$;

create or replace function pg_temp.lbl(p_voucher uuid) returns text
language sql stable as $f$
  select financial_year_label from public.vouchers where id = p_voucher;
$f$;

-- ====================================================================== 1
-- THE CONSTANT
--
-- 'continuous' is written into vouchers, into the primary key of
-- voucher_number_sequences and into every backup such a company produces. The
-- claim it rests on is that no derived financial-year label can ever equal it.
-- ====================================================================== 1

do $s1$
declare
  v_user uuid;
  v_years uuid;
  v_cont uuid;
  m int;
  v_bad int;
  v_total int := 0;
  v_worst text;
begin
  v_user := pg_temp.mk_user('s1@audit.test');
  perform pg_temp.act_as(v_user);
  v_years := pg_temp.mk_company('S1 year-keeping', true);
  v_cont  := pg_temp.mk_company('S1 continuous', false);

  perform pg_temp.ck_eq('1', 'the constant is the literal ''continuous''',
                        app_private.continuous_year_label(), 'continuous');

  perform pg_temp.ck('1', 'the constant is not year-shaped',
                     app_private.continuous_year_label() !~ '^[0-9]{4}-[0-9]{2}$',
                     'no match for ^\d{4}-\d{2}$', app_private.continuous_year_label());

  perform pg_temp.ck('1', 'the constant is not an absence',
                     btrim(app_private.continuous_year_label()) <> ''
                     and lower(app_private.continuous_year_label()) not in ('none','null','-','n/a'),
                     'a real word', app_private.continuous_year_label());

  -- Every start month, every month of a fifteen-year window, plus the ends of
  -- the date type. A derived label may never collide with the constant.
  for m in 1..12 loop
    update public.companies set financial_year_start_month = m::smallint where id = v_years;

    select count(*) filter (where app_private.financial_year_label(v_years, d) = app_private.continuous_year_label()),
           count(*)
      into v_bad, v_total
      from (
        select g::date as d
          from generate_series(date '2019-01-01', date '2034-12-01', interval '1 month') g
        union all select date '0001-01-01'
        union all select date '0999-06-15'
        union all select date '1000-01-01'
        union all select date '4712-12-31'
        union all select date '9999-12-31'
      ) s;

    perform pg_temp.ck('1',
      format('no derived label equals the constant, start month %s (%s dates)', m, v_total),
      v_bad = 0, '0 collisions', v_bad::text);
  end loop;

  update public.companies set financial_year_start_month = 4 where id = v_years;

  -- The stronger claim 0027 makes in prose — that every derived label matches
  -- ^\d{4}-\d{2}$ — over the same sweep, so that the report can say which half
  -- holds and which does not.
  select count(*) filter (where app_private.financial_year_label(v_years, d) !~ '^[0-9]{4}-[0-9]{2}$'),
         min(app_private.financial_year_label(v_years, d))
             filter (where app_private.financial_year_label(v_years, d) !~ '^[0-9]{4}-[0-9]{2}$')
    into v_bad, v_worst
    from (
      select g::date as d
        from generate_series(date '2019-01-01', date '2034-12-01', interval '1 month') g
      union all select date '1000-04-01'
      union all select date '9999-12-31'
    ) s;

  perform pg_temp.ck('1', 'every derived label from the first four-digit year on is year-shaped',
                     v_bad = 0, '0 non-year-shaped labels',
                     coalesce(v_bad::text || ' e.g. ' || coalesce(v_worst,''), '?'));

  -- 0027 states in prose that every value this column has ever held matches
  -- ^\d{4}-\d{2}$. Before year 1000 it does not: the year is concatenated,
  -- not padded. Recorded here so the claim is not carried further than it
  -- goes. Nothing reachable produces these -- book_beginning_date would have
  -- to be in the first millennium -- and none of them is the constant.
  perform pg_temp.ck_eq('1', 'KNOWN: a first-millennium date yields an unpadded year',
                        app_private.financial_year_label(v_years, date '0001-01-01'), '0-01');
  perform pg_temp.ck_eq('1', 'KNOWN: and a three-digit one likewise',
                        app_private.financial_year_label(v_years, date '0999-06-15'), '999-00');
  perform pg_temp.ck_eq('1', 'KNOWN: so does January of the year 1000, which derives 999',
                        app_private.financial_year_label(v_years, date '1000-01-01'), '999-00');
  perform pg_temp.ck('1', 'but neither is the constant, which is what the key depends on',
                     app_private.financial_year_label(v_years, date '0001-01-01') <> app_private.continuous_year_label()
                     and app_private.financial_year_label(v_years, date '0999-06-15') <> app_private.continuous_year_label(),
                     'both differ from ''continuous''', 'both differ');

  -- The label ignores the date entirely for a continuous book, which is the
  -- whole mechanism.
  perform pg_temp.ck_eq('1', 'continuous: label on a March date', app_private.financial_year_label(v_cont, date '2026-03-31'), 'continuous');
  perform pg_temp.ck_eq('1', 'continuous: label on an April date', app_private.financial_year_label(v_cont, date '2026-04-01'), 'continuous');
  perform pg_temp.ck_eq('1', 'continuous: label on a NULL date', app_private.financial_year_label(v_cont, null), 'continuous');
  perform pg_temp.ck_eq('1', 'year-keeping: label on a NULL date is still null', app_private.financial_year_label(v_years, null), null);
  perform pg_temp.ck_eq('1', 'year-keeping: March belongs to the previous year', app_private.financial_year_label(v_years, date '2026-03-31'), '2025-26');
  perform pg_temp.ck_eq('1', 'year-keeping: April opens a new one', app_private.financial_year_label(v_years, date '2026-04-01'), '2026-27');

  -- A missing company still complains the way 0004 complained, whatever the date.
  perform pg_temp.ck_refused('1', 'a missing company still raises Company not found',
    format('select app_private.financial_year_label(%L::uuid, date ''2026-04-01'')', gen_random_uuid()),
    'Company not found');
  perform pg_temp.ck_refused('1', 'a missing company raises before the date is looked at',
    format('select app_private.financial_year_label(%L::uuid, null::date)', gen_random_uuid()),
    'Company not found');

exception when others then
  perform pg_temp.ck('1', 'section aborted', false, 'no error', sqlerrm);
end;
$s1$;

-- ====================================================================== 2
-- NUMBERING
-- ====================================================================== 2

do $s2$
declare
  v_user uuid; v_cont uuid; v_years uuid;
  a uuid; b uuid; c uuid; d uuid; e uuid;
  v_seq_rows int;
begin
  v_user := pg_temp.mk_user('s2@audit.test');
  perform pg_temp.act_as(v_user);
  v_cont  := pg_temp.mk_company('S2 continuous', false);
  v_years := pg_temp.mk_company('S2 year-keeping', true);

  -- Straight through two year ends, on the dates a year-keeping book resets.
  a := pg_temp.post(v_cont, 'sales', date '2025-06-01', 100, 'Customer', 'Sales');
  b := pg_temp.post(v_cont, 'sales', date '2026-03-31', 100, 'Customer', 'Sales');
  c := pg_temp.post(v_cont, 'sales', date '2026-04-01', 100, 'Customer', 'Sales');
  d := pg_temp.post(v_cont, 'sales', date '2027-04-02', 100, 'Customer', 'Sales');

  perform pg_temp.ck_eq('2', 'continuous SAL 1', pg_temp.num(a), 'SAL/00001');
  perform pg_temp.ck_eq('2', 'continuous SAL 2 (last day of a year)', pg_temp.num(b), 'SAL/00002');
  perform pg_temp.ck_eq('2', 'continuous SAL 3 (first day of the next)', pg_temp.num(c), 'SAL/00003');
  perform pg_temp.ck_eq('2', 'continuous SAL 4 (a year later still)', pg_temp.num(d), 'SAL/00004');
  perform pg_temp.ck_eq('2', 'continuous: no year segment in the number',
                        (select count(*)::text from public.vouchers
                          where company_id = v_cont and voucher_number ~ '[0-9]{4}-[0-9]{2}'), '0');
  perform pg_temp.ck_eq('2', 'continuous: every label is the constant',
                        (select count(distinct financial_year_label)::text || ':' || min(financial_year_label)
                           from public.vouchers where company_id = v_cont), '1:continuous');

  -- Each voucher type is still its own series.
  e := pg_temp.post(v_cont, 'payment', date '2026-04-01', 50, 'Supplier', 'Cash');
  perform pg_temp.ck_eq('2', 'continuous: a second voucher type starts at 1', pg_temp.num(e), 'PAY/00001');

  select count(*) into v_seq_rows from public.voucher_number_sequences where company_id = v_cont;
  perform pg_temp.ck_eq('2', 'continuous: one sequence row per voucher type, ever', v_seq_rows::text, '2');
  perform pg_temp.ck_eq('2', 'continuous: the sequence key is the constant',
                        (select string_agg(distinct financial_year_label, ',')
                           from public.voucher_number_sequences where company_id = v_cont), 'continuous');

  -- And the other book still resets, on the same dates.
  a := pg_temp.post(v_years, 'sales', date '2025-06-01', 100, 'Customer', 'Sales');
  b := pg_temp.post(v_years, 'sales', date '2026-03-31', 100, 'Customer', 'Sales');
  c := pg_temp.post(v_years, 'sales', date '2026-04-01', 100, 'Customer', 'Sales');

  perform pg_temp.ck_eq('2', 'year-keeping SAL 1', pg_temp.num(a), 'SAL/2025-26/00001');
  perform pg_temp.ck_eq('2', 'year-keeping SAL 2 (same year)', pg_temp.num(b), 'SAL/2025-26/00002');
  perform pg_temp.ck_eq('2', 'year-keeping resets in April', pg_temp.num(c), 'SAL/2026-27/00001');
  perform pg_temp.ck_eq('2', 'year-keeping: two sequence rows for one type',
                        (select count(*)::text from public.voucher_number_sequences
                          where company_id = v_years and voucher_type = 'sales'), '2');

  -- The CSV importer's bulk path is the other way vouchers reach the books,
  -- and it must number them exactly as the one-at-a-time path does. It loops
  -- create_voucher server-side, so this asserts the loop rather than assuming
  -- the call is enough.
  declare
    v_cont2 uuid;
    v_bulk record;
  begin
    v_cont2 := pg_temp.mk_company('S2 continuous bulk', false);
    for v_bulk in
      select * from public.create_vouchers_bulk(v_cont2, jsonb_build_array(
        jsonb_build_object('group_key','a','voucher_type','sales','voucher_date','2026-03-31',
          'narration','bulk','lines', jsonb_build_array(
            jsonb_build_object('ledger_id', pg_temp.led(v_cont2,'Customer'),'debit_amount',10,'credit_amount',0,'line_order',0),
            jsonb_build_object('ledger_id', pg_temp.led(v_cont2,'Sales'),'debit_amount',0,'credit_amount',10,'line_order',1))),
        jsonb_build_object('group_key','b','voucher_type','sales','voucher_date','2026-04-01',
          'narration','bulk','lines', jsonb_build_array(
            jsonb_build_object('ledger_id', pg_temp.led(v_cont2,'Customer'),'debit_amount',20,'credit_amount',0,'line_order',0),
            jsonb_build_object('ledger_id', pg_temp.led(v_cont2,'Sales'),'debit_amount',0,'credit_amount',20,'line_order',1)))))
    loop
      perform pg_temp.ck_eq('2', format('the bulk importer accepted group %s', v_bulk.group_key),
                            coalesce(v_bulk.error_message, 'ok'), 'ok');
    end loop;
    set constraints all immediate; set constraints all deferred;

    perform pg_temp.ck_eq('2', 'the CSV importer numbers a continuous book straight through',
      (select string_agg(voucher_number, ',' order by voucher_date)
         from public.vouchers where company_id = v_cont2), 'SAL/00001,SAL/00002');
    perform pg_temp.ck_eq('2', 'and stamps the constant on both',
      (select string_agg(distinct financial_year_label, ',')
         from public.vouchers where company_id = v_cont2), 'continuous');
  end;

  -- The display number and the stored label describe the same scheme.
  perform pg_temp.ck_eq('2', 'continuous: the display number carries no label',
    (select count(*)::text from public.vouchers v
      where v.company_id = v_cont
        and v.voucher_number <> (case v.voucher_type
              when 'sales' then 'SAL' when 'payment' then 'PAY' end)
            || '/' || lpad(v.sequence_number::text, 5, '0')), '0');

exception when others then
  perform pg_temp.ck('2', 'section aborted', false, 'no error', sqlerrm);
end;
$s2$;

-- ====================================================================== 3
-- CROSS-COMPANY INTERFERENCE
--
-- voucher_number_sequences is one shared table keyed on
-- (company_id, voucher_type, financial_year_label). Two continuous companies
-- share a label; a continuous and a year-keeping one share nothing but the
-- table. Neither pair may bleed.
-- ====================================================================== 3

do $s3$
declare
  v_user uuid; c1 uuid; c2 uuid; y1 uuid; y2 uuid;
  v uuid;
  v_dates date[] := array[date '2026-03-30', date '2026-03-31', date '2026-04-01', date '2026-04-02'];
  i int;
begin
  v_user := pg_temp.mk_user('s3@audit.test');
  perform pg_temp.act_as(v_user);
  c1 := pg_temp.mk_company('S3 continuous one', false);
  c2 := pg_temp.mk_company('S3 continuous two', false);
  y1 := pg_temp.mk_company('S3 year-keeping one', true);
  y2 := pg_temp.mk_company('S3 year-keeping two', true);

  -- Interleaved, on the same dates, across the boundary one of them keeps.
  for i in 1..4 loop
    perform pg_temp.post(c1, 'sales', v_dates[i], 10, 'Customer', 'Sales');
    perform pg_temp.post(y1, 'sales', v_dates[i], 10, 'Customer', 'Sales');
    perform pg_temp.post(c2, 'sales', v_dates[i], 10, 'Customer', 'Sales');
    perform pg_temp.post(y2, 'sales', v_dates[i], 10, 'Customer', 'Sales');
  end loop;

  perform pg_temp.ck_eq('3', 'continuous one runs 1..4',
    (select string_agg(voucher_number, ',' order by sequence_number)
       from public.vouchers where company_id = c1),
    'SAL/00001,SAL/00002,SAL/00003,SAL/00004');

  perform pg_temp.ck_eq('3', 'continuous two runs 1..4 beside it, untouched',
    (select string_agg(voucher_number, ',' order by sequence_number)
       from public.vouchers where company_id = c2),
    'SAL/00001,SAL/00002,SAL/00003,SAL/00004');

  perform pg_temp.ck_eq('3', 'year-keeping one still resets on 1 April',
    (select string_agg(voucher_number, ',' order by voucher_date, sequence_number)
       from public.vouchers where company_id = y1),
    'SAL/2025-26/00001,SAL/2025-26/00002,SAL/2026-27/00001,SAL/2026-27/00002');

  perform pg_temp.ck_eq('3', 'year-keeping two the same, beside a continuous book',
    (select string_agg(voucher_number, ',' order by voucher_date, sequence_number)
       from public.vouchers where company_id = y2),
    'SAL/2025-26/00001,SAL/2025-26/00002,SAL/2026-27/00001,SAL/2026-27/00002');

  perform pg_temp.ck_eq('3', 'four companies, six sequence rows, none shared',
    (select count(*)::text from public.voucher_number_sequences
      where company_id in (c1, c2, y1, y2)), '6');

  perform pg_temp.ck_eq('3', 'the two continuous companies each own their own ''continuous'' row',
    (select string_agg(next_number::text, ',' order by company_id::text)
       from public.voucher_number_sequences
      where company_id in (c1, c2) and financial_year_label = 'continuous'), '5,5');

  -- Each of the four books holds exactly its own four vouchers.
  perform pg_temp.ck_eq('3', 'each of the four books holds exactly its own four vouchers',
    (select count(*)::text from (
       select v.company_id from public.vouchers v
        where v.company_id in (c1, c2, y1, y2)
        group by v.company_id having count(*) <> 4) q), '0');

  -- And no sequence row of one company was advanced by another's posting.
  perform pg_temp.ck_eq('3', 'every sequence row stands at exactly what its own book minted',
    (select count(*)::text from public.voucher_number_sequences s
      where s.company_id in (c1, c2, y1, y2)
        and s.next_number <> 1 + (select count(*) from public.vouchers v
                                   where v.company_id = s.company_id
                                     and v.voucher_type = s.voucher_type
                                     and v.financial_year_label = s.financial_year_label)), '0');

exception when others then
  perform pg_temp.ck('3', 'section aborted', false, 'no error', sqlerrm);
end;
$s3$;

-- ====================================================================== 4
-- THE FREEZE, THROUGH EVERY DOOR
-- ====================================================================== 4

do $s4$
declare
  v_admin uuid; v_clerk uuid;
  v_empty uuid; v_posted uuid; v_soft uuid; v_other uuid;
  v_err text; v_rows int; v_mode boolean;
begin
  v_admin := pg_temp.mk_user('s4-admin@audit.test');
  v_clerk := pg_temp.mk_user('s4-clerk@audit.test');
  perform pg_temp.act_as(v_admin);

  v_empty  := pg_temp.mk_company('S4 empty', true);
  v_posted := pg_temp.mk_company('S4 posted', true);
  v_soft   := pg_temp.mk_company('S4 soft deleted', false);
  v_other  := pg_temp.mk_company('S4 neighbour', true);

  -- (a) before the first voucher, with a chart of accounts and ledgers on the
  -- books already, the choice may still be made -- in both directions.
  perform pg_temp.ck_eq('4', 'the empty company already has ledgers to lose',
    (select count(*)::text from public.ledgers where company_id = v_empty), '5');
  perform pg_temp.ck_allowed('4', 'true -> false is allowed before the first voucher',
    format('update public.companies set uses_financial_years = false where id = %L', v_empty));
  perform pg_temp.ck_allowed('4', 'false -> true is allowed before the first voucher',
    format('update public.companies set uses_financial_years = true where id = %L', v_empty));

  -- (b) one voucher freezes it.
  perform pg_temp.post(v_posted, 'sales', date '2026-04-10', 100, 'Customer', 'Sales');
  perform pg_temp.ck_refused('4', 'a single voucher freezes the setting',
    format('update public.companies set uses_financial_years = false where id = %L', v_posted),
    'Cannot change how');
  perform pg_temp.ck_refused('4', 'the refusal names the first voucher''s number',
    format('update public.companies set uses_financial_years = false where id = %L', v_posted),
    'SAL/2026-27/00001');
  perform pg_temp.ck_refused('4', 'the refusal names the company',
    format('update public.companies set uses_financial_years = false where id = %L', v_posted),
    'S4 posted');

  -- (b-) the message names the first number the book issued, not the
  -- earliest-dated voucher. In a continuous book, where a voucher can be
  -- entered today for last year, those are different vouchers, and "the first
  -- of them numbered X" naming anything but the first number would be wrong
  -- about the only piece of evidence the refusal offers.
  declare v_back uuid; v_msg text;
  begin
    v_back := pg_temp.mk_company('S4 back-dated', false);
    perform pg_temp.post(v_back, 'sales', date '2026-06-01', 10, 'Customer', 'Sales');
    perform pg_temp.post(v_back, 'sales', date '2025-01-01', 10, 'Customer', 'Sales');
    perform pg_temp.ck_eq('4', 'the back-dated book numbers by entry, not by date',
      (select string_agg(voucher_number, ',' order by voucher_number)
         from public.vouchers where company_id = v_back), 'SAL/00001,SAL/00002');

    v_msg := pg_temp.probe(format(
      'update public.companies set uses_financial_years = true where id = %L', v_back));
    perform pg_temp.ck('4', 'the refusal names the first number issued, not the earliest-dated voucher',
      position('numbered SAL/00001' in coalesce(v_msg, '')) > 0
      and position('SAL/00002' in coalesce(v_msg, '')) = 0,
      'the message names SAL/00001, the first number, and not SAL/00002',
      coalesce(v_msg, 'no refusal at all'));
  end;

  -- (c) restating the value it already has is not a change.
  perform pg_temp.ck_allowed('4', 'restating the same value is allowed with vouchers on the books',
    format('update public.companies set uses_financial_years = true where id = %L', v_posted));
  perform pg_temp.ck_allowed('4', 'a whole-row rewrite naming every column is allowed',
    format($q$update public.companies set
              name = name, book_beginning_date = book_beginning_date,
              financial_year_start_month = financial_year_start_month,
              uses_financial_years = uses_financial_years,
              base_currency = base_currency, lock_date = lock_date,
              address = address, phone = phone, email = email
            where id = %L$q$, v_posted));

  -- (d) a soft-deleted voucher counts. It still holds its number.
  perform pg_temp.post(v_soft, 'sales', date '2026-04-10', 100, 'Customer', 'Sales');
  update public.vouchers set is_deleted = true where company_id = v_soft;
  perform pg_temp.ck_eq('4', 'the soft-deleted company has no live vouchers',
    (select count(*)::text from public.vouchers where company_id = v_soft and is_deleted = false), '0');
  perform pg_temp.ck_refused('4', 'a soft-deleted voucher still freezes the setting',
    format('update public.companies set uses_financial_years = true where id = %L', v_soft),
    'Cannot change how');
  perform pg_temp.ck_eq('4', 'and the soft-deleted voucher still holds its number',
    (select voucher_number from public.vouchers where company_id = v_soft), 'SAL/00001');

  -- (e-) the trigger is scoped to this one column. A bare `before update`
  -- would behave identically thanks to the early return, so this is asserted
  -- against the catalog rather than through behaviour.
  perform pg_temp.ck_eq('4', 'the trigger is scoped to uses_financial_years alone',
    (select string_agg(a.attname, ',')
       from pg_trigger t
       join lateral unnest(t.tgattr) col(attnum) on true
       join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = col.attnum
      where t.tgrelid = 'public.companies'::regclass
        and t.tgname = 'trg_guard_financial_year_mode'), 'uses_financial_years');
  perform pg_temp.ck_eq('4', 'and it fires BEFORE, FOR EACH ROW',
    (select ((t.tgtype & 2) <> 0)::text || '|' || ((t.tgtype & 1) <> 0)::text
       from pg_trigger t where t.tgrelid = 'public.companies'::regclass
        and t.tgname = 'trg_guard_financial_year_mode'), 'true|true');

  -- (e) another company's vouchers do not freeze this one.
  perform pg_temp.ck_allowed('4', 'a neighbour''s vouchers do not freeze an empty company',
    format('update public.companies set uses_financial_years = false where id = %L', v_other));
  update public.companies set uses_financial_years = true where id = v_other;

  -- (f) the count is the company's own, not the caller's view of it. A
  -- security-invoker guard would read zero for a member who cannot see the
  -- vouchers and would let the book be broken.
  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_posted, v_clerk, 'accountant', 'active', v_admin);

  grant select, insert, update, delete on public.companies, public.vouchers to authenticated;
  perform pg_temp.act_as(v_clerk);
  set local role authenticated;

  -- Nothing may touch audit_results while the role is switched: the table is
  -- the postgres user's and the insert would be denied, taking the section's
  -- results down with it.
  select count(*) into v_rows from public.companies where id = v_posted;
  v_err := pg_temp.probe(format(
    'update public.companies set uses_financial_years = false where id = %L', v_posted));

  reset role;
  perform pg_temp.act_as(v_admin);

  -- RLS narrows the row set rather than raising, so "no error" here has to be
  -- checked against the value as well.
  perform pg_temp.ck_eq('4', 'the accountant can see the company row', v_rows::text, '1');
  select uses_financial_years into v_mode from public.companies where id = v_posted;
  perform pg_temp.ck('4', 'an accountant cannot change the setting',
                     v_mode is true,
                     'unchanged (true)',
                     coalesce(v_mode::text, '<null>') || coalesce('; error: ' || v_err, '; no error raised'));

  -- The company above was frozen by its own voucher, so that check alone
  -- cannot tell RLS apart from the trigger. This one is on an empty company,
  -- where the trigger would allow the change and only the policy stands in
  -- the way.
  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_empty, v_clerk, 'accountant', 'active', v_admin);

  perform pg_temp.act_as(v_clerk);
  set local role authenticated;
  select count(*) into v_rows from public.companies where id = v_empty;
  v_err := pg_temp.probe(format(
    'update public.companies set uses_financial_years = false where id = %L', v_empty));
  reset role;
  perform pg_temp.act_as(v_admin);

  perform pg_temp.ck_eq('4', 'the accountant can see the empty company too', v_rows::text, '1');
  select uses_financial_years into v_mode from public.companies where id = v_empty;
  perform pg_temp.ck('4', 'and still cannot change the setting on a book with no vouchers',
                     v_mode is true,
                     'unchanged (true)',
                     coalesce(v_mode::text, '<null>') || coalesce('; error: ' || v_err, '; no error raised'));

exception when others then
  reset role;
  perform pg_temp.ck('4', 'section aborted', false, 'no error', sqlerrm);
end;
$s4$;

-- ====================================================================== 5
-- THE FREEZE: THE UNDO AND THE RESTORE DOORS
-- ====================================================================== 5

do $s5$
declare
  v_admin uuid; v_c uuid; v_mark timestamptz; v_reverted int;
  v_payload jsonb; v_target uuid; v_new uuid;
begin
  v_admin := pg_temp.mk_user('s5@audit.test');
  perform pg_temp.act_as(v_admin);

  -- (a) an undo never rewinds the setting, even when the audit log holds the
  -- change, and never fails because of it.
  v_c := pg_temp.mk_company('S5 undo', true);

  -- audit_log.changed_at defaults to now(), which is the transaction's start
  -- time and therefore identical for every row this script writes. The mark
  -- is made by backdating everything that must survive the undo, which is
  -- exactly what a real session's clock would have done between two saves.
  update public.audit_log set changed_at = now() - interval '1 day' where company_id = v_c;
  v_mark := now() - interval '1 minute';

  update public.companies set uses_financial_years = false where id = v_c;  -- legal, no vouchers yet
  perform pg_temp.post(v_c, 'sales', date '2026-04-10', 100, 'Customer', 'Sales');
  perform pg_temp.post(v_c, 'sales', date '2026-04-11', 100, 'Customer', 'Sales');

  perform pg_temp.ck_eq('5', 'the audit log recorded the setting change',
    (select count(*)::text from public.audit_log
      where company_id = v_c and table_name = 'companies' and action = 'UPDATE'
        and old_data->>'uses_financial_years' is distinct from new_data->>'uses_financial_years'), '1');

  v_reverted := public.revert_company_changes_since(v_c, v_mark);
  set constraints all deferred;   -- the RPC leaves them immediate; see the report
  perform pg_temp.ck('5', 'the undo ran without being refused by the freeze',
                     v_reverted > 0, '> 0 rows reverted', v_reverted::text);
  perform pg_temp.ck_eq('5', 'the undo left the setting alone',
    (select uses_financial_years::text from public.companies where id = v_c), 'false');
  perform pg_temp.ck_eq('5', 'the undo removed the vouchers',
    (select count(*)::text from public.vouchers where company_id = v_c), '0');

  -- The book is now empty of vouchers but its sequence row survives, rewound.
  perform pg_temp.ck_eq('5', 'the undo rewound the continuous series to 1',
    (select next_number::text from public.voucher_number_sequences
      where company_id = v_c and voucher_type = 'sales'), '1');
  -- That rewound row is the surviving record that a number was issued, so the
  -- freeze still holds even though no voucher is left to name.
  perform pg_temp.ck_refused('5',
    'with every voucher undone the setting is still frozen, because numbers were minted',
    format('update public.companies set uses_financial_years = true where id = %L', v_c),
    'may be on paper');

  -- (b) restore, overwrite path: the target holds vouchers, so the freeze
  -- would refuse the company UPDATE if the deletes above it were reordered.
  v_target := pg_temp.mk_company('S5 overwrite target', true);
  perform pg_temp.post(v_target, 'sales', date '2026-04-10', 100, 'Customer', 'Sales');

  v_new := pg_temp.mk_company('S5 overwrite source', false);
  perform pg_temp.post(v_new, 'sales', date '2026-04-10', 250, 'Customer', 'Sales');
  perform pg_temp.post(v_new, 'sales', date '2027-04-10', 250, 'Customer', 'Sales');
  v_payload := public.export_company_backup(v_new);

  perform pg_temp.ck_allowed('5', 'a restore may overwrite a company that still holds vouchers',
    format('select public.restore_company_backup(%L::jsonb, ''overwrite'', %L::uuid)', v_payload, v_target));
  set constraints all deferred;
  perform pg_temp.ck_eq('5', 'and the overwritten company took the file''s setting',
    (select uses_financial_years::text from public.companies where id = v_target), 'false');
  perform pg_temp.ck_eq('5', 'and its vouchers came back continuous',
    (select string_agg(voucher_number, ',' order by voucher_date)
       from public.vouchers where company_id = v_target), 'SAL/00001,SAL/00002');

exception when others then
  perform pg_temp.ck('5', 'section aborted', false, 'no error', sqlerrm);
end;
$s5$;

-- ====================================================================== 6
-- BACKUP AND RESTORE
-- ====================================================================== 6

do $s6$
declare
  v_admin uuid; v_cont uuid; v_years uuid;
  p_cont jsonb; p_years jsonb; p_old jsonb; p_null jsonb;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; v_next uuid;
  v_target_c uuid; v_target_y uuid;
begin
  v_admin := pg_temp.mk_user('s6@audit.test');
  perform pg_temp.act_as(v_admin);

  v_cont  := pg_temp.mk_company('S6 continuous', false);
  perform pg_temp.post(v_cont, 'sales', date '2026-03-31', 100, 'Customer', 'Sales');
  perform pg_temp.post(v_cont, 'sales', date '2026-04-01', 100, 'Customer', 'Sales');
  p_cont := public.export_company_backup(v_cont);

  v_years := pg_temp.mk_company('S6 year-keeping', true);
  perform pg_temp.post(v_years, 'sales', date '2026-03-31', 100, 'Customer', 'Sales');
  perform pg_temp.post(v_years, 'sales', date '2026-04-01', 100, 'Customer', 'Sales');
  p_years := public.export_company_backup(v_years);

  perform pg_temp.ck_eq('6', 'the export carries the setting (continuous)',
    p_cont->'company'->>'uses_financial_years', 'false');
  perform pg_temp.ck_eq('6', 'the export carries the setting (year-keeping)',
    p_years->'company'->>'uses_financial_years', 'true');
  perform pg_temp.ck_eq('6', 'the export carries the continuous labels verbatim',
    (select string_agg(distinct e->>'financial_year_label', ',')
       from jsonb_array_elements(p_cont->'vouchers') e), 'continuous');

  -- 'new' path, both ways.
  r1 := public.restore_company_backup(p_cont, 'new');
  set constraints all deferred;
  perform pg_temp.ck_eq('6', 'restore new: a continuous book comes back continuous',
    (select uses_financial_years::text from public.companies where id = r1), 'false');
  perform pg_temp.ck_eq('6', 'restore new: numbers and labels are carried, not re-derived',
    (select string_agg(voucher_number || '@' || financial_year_label, ',' order by voucher_date)
       from public.vouchers where company_id = r1),
    'SAL/00001@continuous,SAL/00002@continuous');

  -- The restored book must go on numbering where the original left off.
  insert into public.ledgers (company_id, group_id, name, created_by)
  select r1, g.id, 'Audit Cash', v_admin from public.account_groups g
   where g.company_id = r1 and g.name = 'Cash-in-Hand';
  v_next := public.create_voucher(r1, 'sales', date '2027-01-01', 'after restore', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', (select id from public.ledgers where company_id = r1 and name = 'Customer'),
                         'debit_amount', 10, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', (select id from public.ledgers where company_id = r1 and name = 'Sales'),
                         'debit_amount', 0, 'credit_amount', 10, 'line_order', 1)), null);
  set constraints all immediate; set constraints all deferred;
  perform pg_temp.ck_eq('6', 'restore new: the continuous series continues rather than restarting',
    pg_temp.num(v_next), 'SAL/00003');

  r2 := public.restore_company_backup(p_years, 'new');
  set constraints all deferred;
  perform pg_temp.ck_eq('6', 'restore new: a year-keeping book comes back year-keeping',
    (select uses_financial_years::text from public.companies where id = r2), 'true');
  perform pg_temp.ck_eq('6', 'restore new: its year labels survive too',
    (select string_agg(voucher_number, ',' order by voucher_date)
       from public.vouchers where company_id = r2),
    'SAL/2025-26/00001,SAL/2026-27/00001');

  -- A file written before the column existed.
  p_old := jsonb_set(p_years, '{company}', (p_years->'company') - 'uses_financial_years');
  perform pg_temp.ck('6', 'the simulated old file really has no such key',
    not ((p_old->'company') ? 'uses_financial_years'), 'key absent', 'key absent');
  r3 := public.restore_company_backup(p_old, 'new');
  set constraints all deferred;
  perform pg_temp.ck_eq('6', 'a file with no such key restores as year-keeping',
    (select uses_financial_years::text from public.companies where id = r3), 'true');

  -- And one where the key is present but null. On a year-keeping file it is
  -- read as the documented default and restores as such.
  p_null := jsonb_set(p_years, '{company,uses_financial_years}', 'null'::jsonb);
  r4 := public.restore_company_backup(p_null, 'new');
  set constraints all deferred;
  perform pg_temp.ck_eq('6', 'a null value restores as year-keeping, not as an error',
    (select uses_financial_years::text from public.companies where id = r4), 'true');
  -- On a continuous file that same default contradicts the labels the file
  -- itself carries, and the restore refuses rather than building a book with
  -- two numbering schemes in it.
  perform pg_temp.ck_refused('6', 'but a null key on a continuous file is refused, not left mixed',
    format('select public.restore_company_backup(%L::jsonb, ''new'')',
           jsonb_set(p_cont, '{company,uses_financial_years}', 'null'::jsonb)),
    'contradicts itself');

  -- Overwrite, in both directions.
  v_target_y := pg_temp.mk_company('S6 target year-keeping', true);
  perform pg_temp.post(v_target_y, 'sales', date '2026-04-05', 100, 'Customer', 'Sales');
  perform public.restore_company_backup(p_cont, 'overwrite', v_target_y);
  set constraints all deferred;
  perform pg_temp.ck_eq('6', 'overwrite: a continuous book restored over a year-keeping one',
    (select uses_financial_years::text from public.companies where id = v_target_y), 'false');
  perform pg_temp.ck_eq('6', 'overwrite: and the old year-shaped numbers are gone',
    (select string_agg(voucher_number, ',' order by voucher_date)
       from public.vouchers where company_id = v_target_y), 'SAL/00001,SAL/00002');
  perform pg_temp.ck_eq('6', 'overwrite: and the old year-shaped sequence rows are gone',
    (select string_agg(distinct financial_year_label, ',')
       from public.voucher_number_sequences where company_id = v_target_y), 'continuous');

  v_target_c := pg_temp.mk_company('S6 target continuous', false);
  perform pg_temp.post(v_target_c, 'sales', date '2026-04-05', 100, 'Customer', 'Sales');
  perform public.restore_company_backup(p_years, 'overwrite', v_target_c);
  set constraints all deferred;
  perform pg_temp.ck_eq('6', 'overwrite: a year-keeping book restored over a continuous one',
    (select uses_financial_years::text from public.companies where id = v_target_c), 'true');
  perform pg_temp.ck_eq('6', 'overwrite: and the continuous number is gone',
    (select string_agg(voucher_number, ',' order by voucher_date)
       from public.vouchers where company_id = v_target_c),
    'SAL/2025-26/00001,SAL/2026-27/00001');

  -- An old file restored over a continuous company turns it year-keeping,
  -- which is right: the file's own vouchers are year-shaped.
  perform public.restore_company_backup(p_old, 'overwrite', v_target_y);
  set constraints all deferred;
  perform pg_temp.ck_eq('6', 'overwrite with a pre-column file leaves a year-keeping company',
    (select uses_financial_years::text from public.companies where id = v_target_y), 'true');

exception when others then
  perform pg_temp.ck('6', 'section aborted', false, 'no error', sqlerrm);
end;
$s6$;

-- ====================================================================== 7
-- RE-DATING
-- ====================================================================== 7

do $s7$
declare
  v_admin uuid; v_cont uuid; v_years uuid; v uuid; w uuid;
  v_before text; v_seq int;
begin
  v_admin := pg_temp.mk_user('s7@audit.test');
  perform pg_temp.act_as(v_admin);
  v_cont  := pg_temp.mk_company('S7 continuous', false);
  v_years := pg_temp.mk_company('S7 year-keeping', true);

  v := pg_temp.post(v_cont, 'sales', date '2026-03-31', 100, 'Customer', 'Sales');
  v_before := pg_temp.num(v);
  select next_number into v_seq from public.voucher_number_sequences
    where company_id = v_cont and voucher_type = 'sales';

  perform pg_temp.ck_allowed('7', 'a continuous voucher may be re-dated across 1 April',
    format($q$select public.update_voucher(%L::uuid, date '2026-04-01', 'moved', null, null,
      jsonb_build_array(
        jsonb_build_object('ledger_id', %L::uuid, 'debit_amount', 100, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', %L::uuid, 'debit_amount', 0, 'credit_amount', 100, 'line_order', 1)))$q$,
      v, pg_temp.led(v_cont, 'Customer'), pg_temp.led(v_cont, 'Sales')));

  perform pg_temp.ck_eq('7', 'the re-dated voucher moved', (select voucher_date::text from public.vouchers where id = v), '2026-04-01');
  perform pg_temp.ck_eq('7', 'and kept its number', pg_temp.num(v), v_before);
  perform pg_temp.ck_eq('7', 'and kept its label', pg_temp.lbl(v), 'continuous');
  perform pg_temp.ck_eq('7', 'and the label still agrees with the new date',
    pg_temp.lbl(v), app_private.financial_year_label(v_cont, date '2026-04-01'));
  perform pg_temp.ck_eq('7', 'and the series was not advanced by the edit',
    (select next_number::text from public.voucher_number_sequences
      where company_id = v_cont and voucher_type = 'sales'), v_seq::text);

  -- The next voucher after a re-dating still follows on.
  w := pg_temp.post(v_cont, 'sales', date '2025-01-01', 100, 'Customer', 'Sales');
  perform pg_temp.ck_eq('7', 'the next number follows on regardless of the date', pg_temp.num(w), 'SAL/00002');
  perform pg_temp.ck_eq('7', 'and the two numbers are still distinct in one book',
    (select count(distinct voucher_number)::text from public.vouchers where company_id = v_cont), '2');

  -- The guard still refuses for a year-keeping book, on the same move.
  v := pg_temp.post(v_years, 'sales', date '2026-03-31', 100, 'Customer', 'Sales');
  perform pg_temp.ck_refused('7', 'a year-keeping voucher may not be re-dated across 1 April',
    format($q$select public.update_voucher(%L::uuid, date '2026-04-01', 'moved', null, null,
      jsonb_build_array(
        jsonb_build_object('ledger_id', %L::uuid, 'debit_amount', 100, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', %L::uuid, 'debit_amount', 0, 'credit_amount', 100, 'line_order', 1)))$q$,
      v, pg_temp.led(v_years, 'Customer'), pg_temp.led(v_years, 'Sales')),
    'Cannot move voucher');

  perform pg_temp.ck_eq('7', 'and the refused edit changed nothing',
    (select voucher_date::text || '|' || narration from public.vouchers where id = v),
    '2026-03-31|audit fixture');

  -- Within the same year it is still an ordinary correction.
  perform pg_temp.ck_allowed('7', 'a year-keeping voucher may still be re-dated inside its year',
    format($q$select public.update_voucher(%L::uuid, date '2026-02-01', 'moved', null, null,
      jsonb_build_array(
        jsonb_build_object('ledger_id', %L::uuid, 'debit_amount', 100, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', %L::uuid, 'debit_amount', 0, 'credit_amount', 100, 'line_order', 1)))$q$,
      v, pg_temp.led(v_years, 'Customer'), pg_temp.led(v_years, 'Sales')));

  -- A NULL date is still the NOT NULL column's complaint, in both books.
  perform pg_temp.ck_refused('7', 'a NULL date is still refused by the column, continuous',
    format($q$select public.update_voucher(%L::uuid, null::date, 'x', null, null,
      jsonb_build_array(
        jsonb_build_object('ledger_id', %L::uuid, 'debit_amount', 100, 'credit_amount', 0, 'line_order', 0),
        jsonb_build_object('ledger_id', %L::uuid, 'debit_amount', 0, 'credit_amount', 100, 'line_order', 1)))$q$,
      w, pg_temp.led(v_cont, 'Customer'), pg_temp.led(v_cont, 'Sales')),
    'voucher_date');

exception when others then
  perform pg_temp.ck('7', 'section aborted', false, 'no error', sqlerrm);
end;
$s7$;

-- ====================================================================== 8
-- WHAT ELSE READS THE LABEL
-- ====================================================================== 8

do $s8$
declare
  v_admin uuid; v_cont uuid; v_years uuid;
  a uuid; b uuid; v_mark timestamptz; v_next uuid;
  v_hits int;
begin
  v_admin := pg_temp.mk_user('s8@audit.test');
  perform pg_temp.act_as(v_admin);
  v_cont  := pg_temp.mk_company('S8 continuous', false);
  v_years := pg_temp.mk_company('S8 year-keeping', true);

  -- find_duplicate_bill scopes to the financial year of the given date. A
  -- continuous book has one, so the whole book is one run of inbound paper.
  a := pg_temp.post_bill(v_cont, date '2026-03-20', 500, 'BILL-9');
  perform pg_temp.ck_eq('8', 'the continuous bill really is on the books',
    (select count(*)::text from public.vouchers where id = a and reference_number = 'BILL-9'), '1');

  select count(*) into v_hits from public.find_duplicate_bill(
    v_cont, pg_temp.led(v_cont, 'Supplier'), 'BILL-9', date '2026-03-25');
  perform pg_temp.ck_eq('8', 'continuous: the same bill on a nearby date is found', v_hits::text, '1');

  select count(*) into v_hits from public.find_duplicate_bill(
    v_cont, pg_temp.led(v_cont, 'Supplier'), 'BILL-9', date '2027-09-01');
  perform pg_temp.ck_eq('8', 'continuous: and is still found a year and a half later', v_hits::text, '1');

  select count(*) into v_hits from public.find_duplicate_bill(
    v_cont, pg_temp.led(v_cont, 'Supplier'), '  bill-9 ', date '2027-09-01');
  perform pg_temp.ck_eq('8', 'continuous: case and spaces still do not matter', v_hits::text, '1');

  select count(*) into v_hits from public.find_duplicate_bill(
    v_cont, pg_temp.led(v_cont, 'Supplier'), 'BILL-9', date '2026-03-25', a);
  perform pg_temp.ck_eq('8', 'continuous: a voucher is not its own duplicate', v_hits::text, '0');

  select count(*) into v_hits from public.find_duplicate_bill(
    v_cont, pg_temp.led(v_cont, 'Customer'), 'BILL-9', date '2026-03-25');
  perform pg_temp.ck_eq('8', 'continuous: another party is not a duplicate', v_hits::text, '0');

  -- The year-keeping book keeps its April fence, which is what the continuous
  -- book must not have inherited by accident.
  b := pg_temp.post_bill(v_years, date '2026-03-20', 500, 'BILL-9');
  select count(*) into v_hits from public.find_duplicate_bill(
    v_years, pg_temp.led(v_years, 'Supplier'), 'BILL-9', date '2026-03-25');
  perform pg_temp.ck_eq('8', 'year-keeping: found inside the same year', v_hits::text, '1');
  select count(*) into v_hits from public.find_duplicate_bill(
    v_years, pg_temp.led(v_years, 'Supplier'), 'BILL-9', date '2026-04-01');
  perform pg_temp.ck_eq('8', 'year-keeping: not found across the year end', v_hits::text, '0');

  -- Cross-company: one company's bill is never the other's duplicate. The
  -- neighbour has to be continuous as well, or the year scope would do the
  -- filtering for free and the company_id predicate would never be exercised.
  declare v_nbr uuid;
  begin
    v_nbr := pg_temp.mk_company('S8 continuous neighbour', false);
    perform pg_temp.post_bill(v_nbr, date '2026-03-20', 500, 'BILL-9');

    select count(*) into v_hits from public.find_duplicate_bill(
      v_nbr, pg_temp.led(v_nbr, 'Supplier'), 'BILL-9', date '2026-03-25');
    perform pg_temp.ck_eq('8', 'the continuous neighbour finds its own bill', v_hits::text, '1');

    select count(*) into v_hits from public.find_duplicate_bill(
      v_cont, pg_temp.led(v_nbr, 'Supplier'), 'BILL-9', date '2026-03-25');
    perform pg_temp.ck_eq('8', 'but one continuous book never sees another''s bill', v_hits::text, '0');
  end;

  select count(*) into v_hits from public.find_duplicate_bill(
    v_cont, pg_temp.led(v_years, 'Supplier'), 'BILL-9', date '2026-03-25');
  perform pg_temp.ck_eq('8', 'nor a year-keeping neighbour''s', v_hits::text, '0');

  -- The undo's numbering rewind follows the book it is in.
  perform pg_temp.post(v_cont, 'sales', date '2026-04-01', 100, 'Customer', 'Sales');
  -- See section 5 on why the mark is made by backdating.
  update public.audit_log set changed_at = now() - interval '1 day' where company_id = v_cont;
  v_mark := now() - interval '1 minute';
  perform pg_temp.post(v_cont, 'sales', date '2026-04-02', 100, 'Customer', 'Sales');
  perform pg_temp.post(v_cont, 'sales', date '2026-04-03', 100, 'Customer', 'Sales');
  perform pg_temp.ck_eq('8', 'three sales in the continuous book before the undo',
    (select count(*)::text from public.vouchers where company_id = v_cont and voucher_type = 'sales'), '3');

  perform public.revert_company_changes_since(v_cont, v_mark);
  set constraints all deferred;
  perform pg_temp.ck_eq('8', 'the undo left the first sale alone',
    (select string_agg(voucher_number, ',') from public.vouchers
      where company_id = v_cont and voucher_type = 'sales'), 'SAL/00001');
  perform pg_temp.ck_eq('8', 'and rewound the one continuous series to 2',
    (select next_number::text from public.voucher_number_sequences
      where company_id = v_cont and voucher_type = 'sales'), '2');

  v_next := pg_temp.post(v_cont, 'sales', date '2026-04-04', 100, 'Customer', 'Sales');
  perform pg_temp.ck_eq('8', 'so the next sale reissues SAL/00002 rather than skipping to 4',
    pg_temp.num(v_next), 'SAL/00002');

  -- Nothing else in the schema groups by the label. Two identical books
  -- differing only in numbering scheme must report identically.
  declare
    va uuid; vb uuid; v_diff int;
  begin
    va := pg_temp.mk_company('S8 twin continuous', false);
    vb := pg_temp.mk_company('S8 twin year-keeping', true);
    perform pg_temp.post(va, 'sales',    date '2026-03-31', 700, 'Customer', 'Sales');
    perform pg_temp.post(vb, 'sales',    date '2026-03-31', 700, 'Customer', 'Sales');
    perform pg_temp.post(va, 'receipt',  date '2026-04-02', 300, 'Cash', 'Customer');
    perform pg_temp.post(vb, 'receipt',  date '2026-04-02', 300, 'Cash', 'Customer');
    perform pg_temp.post(va, 'purchase', date '2026-05-02', 200, 'Purchases', 'Supplier');
    perform pg_temp.post(vb, 'purchase', date '2026-05-02', 200, 'Purchases', 'Supplier');

    select count(*) into v_diff from (
      (select ledger_name, debit_balance, credit_balance from public.get_trial_balance(va, date '2026-12-31')
       except all
       select ledger_name, debit_balance, credit_balance from public.get_trial_balance(vb, date '2026-12-31'))
      union all
      (select ledger_name, debit_balance, credit_balance from public.get_trial_balance(vb, date '2026-12-31')
       except all
       select ledger_name, debit_balance, credit_balance from public.get_trial_balance(va, date '2026-12-31'))
    ) q;
    perform pg_temp.ck_eq('8', 'the Trial Balance is identical in both schemes', v_diff::text, '0');

    select count(*) into v_diff from (
      (select voucher_date, voucher_type, narration, total_amount, dr_ledgers, cr_ledgers
         from public.get_daybook(va, date '2026-01-01', date '2026-12-31')
       except all
       select voucher_date, voucher_type, narration, total_amount, dr_ledgers, cr_ledgers
         from public.get_daybook(vb, date '2026-01-01', date '2026-12-31'))
      union all
      (select voucher_date, voucher_type, narration, total_amount, dr_ledgers, cr_ledgers
         from public.get_daybook(vb, date '2026-01-01', date '2026-12-31')
       except all
       select voucher_date, voucher_type, narration, total_amount, dr_ledgers, cr_ledgers
         from public.get_daybook(va, date '2026-01-01', date '2026-12-31'))
    ) q;
    perform pg_temp.ck_eq('8', 'the Daybook is identical in both schemes (numbers aside)', v_diff::text, '0');

    -- One row per voucher: three vouchers spanning 31 March to 2 May, all of
    -- them inside one window a year-keeping book would have had to split.
    perform pg_temp.ck_eq('8', 'the Daybook shows a continuous book''s vouchers across the year end',
      (select count(*)::text from public.get_daybook(va, date '2026-01-01', date '2026-12-31')), '3');
    perform pg_temp.ck_eq('8', 'and their numbers run straight through it',
      (select string_agg(voucher_number, ',' order by voucher_date)
         from public.get_daybook(va, date '2026-01-01', date '2026-12-31')),
      'SAL/00001,REC/00001,PUR/00001');
    perform pg_temp.ck_eq('8', 'where the year-keeping twin''s carry two different years',
      (select string_agg(voucher_number, ',' order by voucher_date)
         from public.get_daybook(vb, date '2026-01-01', date '2026-12-31')),
      'SAL/2025-26/00001,REC/2026-27/00001,PUR/2026-27/00001');

    select count(*) into v_diff from (
      (select entry_date, debit_amount, credit_amount, running_balance from public.get_ledger_statement(va, pg_temp.led(va,'Customer'), date '2026-01-01', date '2026-12-31')
       except all
       select entry_date, debit_amount, credit_amount, running_balance from public.get_ledger_statement(vb, pg_temp.led(vb,'Customer'), date '2026-01-01', date '2026-12-31'))
      union all
      (select entry_date, debit_amount, credit_amount, running_balance from public.get_ledger_statement(vb, pg_temp.led(vb,'Customer'), date '2026-01-01', date '2026-12-31')
       except all
       select entry_date, debit_amount, credit_amount, running_balance from public.get_ledger_statement(va, pg_temp.led(va,'Customer'), date '2026-01-01', date '2026-12-31'))
    ) q;
    perform pg_temp.ck_eq('8', 'the Ledger Statement is identical in both schemes', v_diff::text, '0');

    select count(*) into v_diff from (
      (select ledger_name, amount from public.get_profit_and_loss(va, date '2026-01-01', date '2026-12-31')
       except all
       select ledger_name, amount from public.get_profit_and_loss(vb, date '2026-01-01', date '2026-12-31'))
      union all
      (select ledger_name, amount from public.get_profit_and_loss(vb, date '2026-01-01', date '2026-12-31')
       except all
       select ledger_name, amount from public.get_profit_and_loss(va, date '2026-01-01', date '2026-12-31'))
    ) q;
    perform pg_temp.ck_eq('8', 'the P&L is identical in both schemes', v_diff::text, '0');

    perform pg_temp.ck_eq('8', 'the dashboard is identical in both schemes',
      (select (a.cash_in_hand = b.cash_in_hand and a.bank_balance = b.bank_balance
               and a.cash_in_hand_change = b.cash_in_hand_change
               and a.month_inflow = b.month_inflow and a.month_outflow = b.month_outflow)::text
         from public.get_dashboard_summary(va, date '2026-12-31') a,
              public.get_dashboard_summary(vb, date '2026-12-31') b), 'true');

    perform pg_temp.ck_eq('8', 'the outstanding list is identical in both schemes',
      (select (count(*) = 0)::text from (
        (select ledger_name, amount, direction, party_kind, last_transaction_date from public.get_outstanding_balances(va)
         except all
         select ledger_name, amount, direction, party_kind, last_transaction_date from public.get_outstanding_balances(vb))
        union all
        (select ledger_name, amount, direction, party_kind, last_transaction_date from public.get_outstanding_balances(vb)
         except all
         select ledger_name, amount, direction, party_kind, last_transaction_date from public.get_outstanding_balances(va))) q), 'true');
  end;

exception when others then
  perform pg_temp.ck('8', 'section aborted', false, 'no error', sqlerrm);
end;
$s8$;

-- ====================================================================== 9
-- EXISTING COMPANIES
-- ====================================================================== 9

do $s9$
declare
  v_admin uuid; v_direct uuid; v_rpc4 uuid; v_rpcnull uuid;
  a uuid; b uuid; c uuid;
begin
  v_admin := pg_temp.mk_user('s9@audit.test');
  perform pg_temp.act_as(v_admin);

  perform pg_temp.ck_eq('9', 'the column is NOT NULL with default true',
    (select (is_nullable = 'NO')::text || '|' || column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = 'companies'
        and column_name = 'uses_financial_years'), 'true|true');

  -- A row written without naming the column -- which is every company that
  -- existed the moment the migration ran.
  insert into public.companies (name, book_beginning_date, created_by)
  values ('S9 pre-existing', date '2020-01-01', v_admin) returning id into v_direct;
  perform pg_temp.ck_eq('9', 'a company row that never names the column keeps financial years',
    (select uses_financial_years::text from public.companies where id = v_direct), 'true');

  -- The RPC called the way every client called it before 0027, by argument
  -- name, which is how PostgREST resolves it.
  v_rpc4 := public.create_company(
    p_name => 'S9 four-argument call',
    p_book_beginning_date => date '2020-01-01',
    p_financial_year_start_month => 4::smallint,
    p_base_currency => 'INR'::char(3));
  perform pg_temp.ck_eq('9', 'the four-argument call still makes a year-keeping company',
    (select uses_financial_years::text from public.companies where id = v_rpc4), 'true');

  v_rpcnull := public.create_company('S9 explicit null', date '2020-01-01', 4::smallint, 'INR'::char(3), null);
  perform pg_temp.ck_eq('9', 'an explicit null argument still makes a year-keeping company',
    (select uses_financial_years::text from public.companies where id = v_rpcnull), 'true');

  perform pg_temp.ck_eq('9', 'there is exactly one create_company, so PostgREST cannot be ambiguous',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'create_company'), '1');
  perform pg_temp.ck_eq('9', 'and it is not executable by PUBLIC',
    (select has_function_privilege('public', p.oid, 'execute')::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'create_company'), 'false');
  perform pg_temp.ck_eq('9', 'and it is executable by authenticated',
    (select has_function_privilege('authenticated', p.oid, 'execute')::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'create_company'), 'true');

  -- And such a company numbers exactly as it always did.
  insert into public.ledgers (company_id, group_id, name, created_by)
  select v_rpc4, g.id, l.nm, v_admin
  from (values ('Sundry Debtors','Customer'), ('Direct Incomes','Sales')) l(grp, nm)
  join public.account_groups g on g.company_id = v_rpc4 and g.name = l.grp;

  a := pg_temp.post(v_rpc4, 'sales', date '2026-03-31', 100, 'Customer', 'Sales');
  b := pg_temp.post(v_rpc4, 'sales', date '2026-04-01', 100, 'Customer', 'Sales');
  perform pg_temp.ck_eq('9', 'a pre-existing company still numbers with the year segment', pg_temp.num(a), 'SAL/2025-26/00001');
  perform pg_temp.ck_eq('9', 'and still resets in April', pg_temp.num(b), 'SAL/2026-27/00001');

  -- Nothing in the schema stores the constant unless a company asked for it.
  -- No exclusion any more: the two files that used to produce a mixed book --
  -- section 6's null-key restore and section 10's doctored one -- are both
  -- refused, so there is no corrupted book left for this to step around.
  perform pg_temp.ck_eq('9', 'no year-keeping company holds a ''continuous'' voucher',
    (select count(*)::text from public.vouchers v join public.companies c on c.id = v.company_id
      where c.uses_financial_years and v.financial_year_label = 'continuous'), '0');
  perform pg_temp.ck_eq('9', 'no continuous company holds a year-shaped voucher',
    (select count(*)::text from public.vouchers v join public.companies c on c.id = v.company_id
      where not c.uses_financial_years and v.financial_year_label <> 'continuous'), '0');

exception when others then
  perform pg_temp.ck('9', 'section aborted', false, 'no error', sqlerrm);
end;
$s9$;

-- ====================================================================== 10
-- MIXED BOOKS: WHAT THE UNIQUENESS KEY ACTUALLY GUARANTEES
--
-- The key is (company_id, voucher_type, financial_year_label, voucher_number).
-- In a book with one scheme that is the same thing as "the printed number is
-- unique". In a book with two it is not, and this section is about how close
-- a supported operation can get to producing one.
-- ====================================================================== 10

do $s10$
declare
  v_admin uuid; v_cont uuid; p jsonb; v_err text; v_next uuid;
begin
  v_admin := pg_temp.mk_user('s10@audit.test');
  perform pg_temp.act_as(v_admin);
  v_cont := pg_temp.mk_company('S10 continuous', false);
  perform pg_temp.post(v_cont, 'sales', date '2026-04-01', 100, 'Customer', 'Sales');

  -- Within one scheme the printed number cannot repeat.
  perform pg_temp.ck_refused('10', 'a continuous book cannot hold the same number twice',
    format($q$insert into public.vouchers
      (company_id, voucher_type, voucher_number, sequence_number, financial_year_label, voucher_date)
      values (%L, 'sales', 'SAL/00001', 1, 'continuous', date '2026-05-01')$q$, v_cont),
    'duplicate key');

  -- But the key does not protect the printed number across labels.
  perform pg_temp.ck_allowed('10',
    'GAP: the same printed number is accepted twice if the labels differ',
    format($q$insert into public.vouchers
      (company_id, voucher_type, voucher_number, sequence_number, financial_year_label, voucher_date)
      values (%L, 'sales', 'SAL/00001', 1, '2025-26', date '2026-05-01')$q$, v_cont));
  perform pg_temp.ck_eq('10', 'so one book now shows SAL/00001 twice',
    (select count(*)::text from public.vouchers
      where company_id = v_cont and voucher_number = 'SAL/00001'), '2');
  delete from public.vouchers where company_id = v_cont and financial_year_label = '2025-26';

  -- Is that state reachable from a supported operation? A backup file is a
  -- client-supplied document, and the restore does not check that the
  -- company's setting agrees with the labels in the file.
  p := public.export_company_backup(v_cont);
  p := jsonb_set(p, '{company,uses_financial_years}', 'true'::jsonb);

  v_err := pg_temp.probe(format('select public.restore_company_backup(%L::jsonb, ''new'')', p));
  set constraints all deferred;
  perform pg_temp.ck('10',
    'a file whose setting disagrees with its own labels is refused as inconsistent',
    v_err is not null and position('contradicts itself' in v_err) > 0,
    'refused as internally inconsistent',
    coalesce('refused: ' || v_err, 'ACCEPTED'));

  -- And the refusal comes before anything is written, so there is no
  -- half-built company left behind to go looking for.
  perform pg_temp.ck_eq('10', 'and no company was built from the doctored file',
    (select count(*)::text from public.companies where name = 'S10 continuous'), '1');
  perform pg_temp.ck_eq('10', 'the book the file came from still has one scheme in it',
    (select coalesce(string_agg(distinct financial_year_label, ','), 'none')
       from public.vouchers where company_id = v_cont), 'continuous');

  v_next := public.create_voucher(v_cont, 'sales', date '2026-05-01', 'next', null, null,
    jsonb_build_array(
      jsonb_build_object('ledger_id', pg_temp.led(v_cont, 'Customer'),
                         'debit_amount', 10, 'credit_amount', 0, 'line_order', 0),
      jsonb_build_object('ledger_id', pg_temp.led(v_cont, 'Sales'),
                         'debit_amount', 0, 'credit_amount', 10, 'line_order', 1)), null);
  set constraints all immediate; set constraints all deferred;

  perform pg_temp.ck_eq('10', 'and its next sale follows the one scheme it has',
    pg_temp.num(v_next), 'SAL/00002');
  perform pg_temp.ck_eq('10', 'leaving one numbering scheme in one book',
    (select count(distinct financial_year_label)::text from public.vouchers where company_id = v_cont), '1');

exception when others then
  perform pg_temp.ck('10', 'section aborted', false, 'no error', sqlerrm);
end;
$s10$;

-- ====================================================================== 11
-- THE UNDO'S NUMBERING REWIND, IN BOTH SCHEMES
--
-- The rewind recomputes each sequence from the vouchers that survived, keyed
-- on (company_id, voucher_type, financial_year_label). A continuous book has
-- one key and section 8 covers it; this is the other half - that a
-- year-keeping book still rewinds year by year, and that neither reaches into
-- a neighbour.
-- ====================================================================== 11

do $s11$
declare
  v_admin uuid; v_years uuid; v_nbr uuid; v_mark timestamptz;
begin
  v_admin := pg_temp.mk_user('s11@audit.test');
  perform pg_temp.act_as(v_admin);
  v_years := pg_temp.mk_company('S11 year-keeping', true);
  v_nbr   := pg_temp.mk_company('S11 neighbour', false);

  -- Two vouchers in one year and one in the next, all three of which survive.
  perform pg_temp.post(v_years, 'sales', date '2026-01-10', 100, 'Customer', 'Sales');
  perform pg_temp.post(v_years, 'sales', date '2026-02-10', 100, 'Customer', 'Sales');
  perform pg_temp.post(v_years, 'sales', date '2026-05-10', 100, 'Customer', 'Sales');

  -- A neighbour whose series is deliberately ahead of its vouchers, which is
  -- the state 0019 exists for: a save that minted a number and rolled back.
  perform pg_temp.post(v_nbr, 'sales', date '2026-05-10', 100, 'Customer', 'Sales');
  update public.voucher_number_sequences set next_number = 99
    where company_id = v_nbr and voucher_type = 'sales';

  update public.audit_log set changed_at = now() - interval '1 day'
    where company_id in (v_years, v_nbr);
  v_mark := now() - interval '1 minute';

  perform pg_temp.post(v_years, 'sales', date '2026-06-10', 100, 'Customer', 'Sales');

  perform pg_temp.ck_eq('11', 'before the undo, the second year stands at 3',
    (select next_number::text from public.voucher_number_sequences
      where company_id = v_years and financial_year_label = '2026-27'), '3');

  perform public.revert_company_changes_since(v_years, v_mark);
  set constraints all deferred;

  perform pg_temp.ck_eq('11', 'the undo removed only the last voucher',
    (select string_agg(voucher_number, ',' order by voucher_date)
       from public.vouchers where company_id = v_years),
    'SAL/2025-26/00001,SAL/2025-26/00002,SAL/2026-27/00001');

  perform pg_temp.ck_eq('11', 'the first year''s series is untouched by the second year''s undo',
    (select next_number::text from public.voucher_number_sequences
      where company_id = v_years and financial_year_label = '2025-26'), '3');
  perform pg_temp.ck_eq('11', 'and the second year''s is rewound to reissue 2',
    (select next_number::text from public.voucher_number_sequences
      where company_id = v_years and financial_year_label = '2026-27'), '2');

  perform pg_temp.ck_eq('11', 'a neighbour''s series is not touched by another company''s undo',
    (select next_number::text from public.voucher_number_sequences
      where company_id = v_nbr and voucher_type = 'sales'), '99');

exception when others then
  perform pg_temp.ck('11', 'section aborted', false, 'no error', sqlerrm);
end;
$s11$;

-- ---------------------------------------------------------------- report

\echo ''
\echo '================ FAILURES ================'
select section, name, expected, actual from audit_results where not passed order by id;

\echo ''
\echo '================ SUMMARY ================='
select section,
       count(*) as checks,
       count(*) filter (where not passed) as failures
  from audit_results group by section order by section::int;

select count(*)::text                            as total_checks,
       count(*) filter (where not passed)::text  as total_failures,
       (count(*) filter (where not passed) > 0)::text as any_fail
  from audit_results \gset

rollback;

\echo ''
\echo :total_checks 'checks,' :total_failures 'failures'
\if :any_fail
do $$ begin raise exception 'audit-continuous-books: assertions failed'; end $$;
\endif
\echo 'AUDIT COMPLETE'
