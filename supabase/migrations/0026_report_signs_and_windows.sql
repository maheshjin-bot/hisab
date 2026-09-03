-- FIVE REPORTING DEFECTS, ONE MISTAKE.
--
-- Every fix in this file is the same one, made in five places: a figure was
-- computed from a different rule, a different window or a different set of
-- rows than the figure it has to agree with. 0012 made this fix once already,
-- on the Balance Sheet's sides; its header is the reference for the reasoning
-- and nothing here contradicts it.
--
--   1. get_profit_and_loss reported abs(...), so a nominal ledger sitting on
--      the opposite side to its group was added to its section instead of
--      subtracted from it. The P&L and the Balance Sheet then disagreed about
--      the same books by twice the reversal.
--   2. get_balance_sheet's profit figure started at book_beginning_date while
--      its ledger lines had no lower bound, so a voucher dated before the
--      books began landed on one side of the sheet and not the other.
--   3. get_balance_sheet's profit figure read voucher_entries only while its
--      ledger lines included opening balances, so an opening balance on an
--      income or expense ledger appeared on neither side and was lost.
--   4. get_dashboard_summary split cash from bank on `g.name ilike '%cash%'`,
--      which reads "Cash Credit Accounts" — an Indian bank overdraft — as a
--      till, and reported a physical cash balance of minus a lakh of rupees.
--   5. get_dashboard_summary filtered all six of its figures by a predicate
--      about today's balance, so an account emptied this month and then
--      closed took its own history out of the change and movement tiles.
--
-- No signature changes. All three functions keep `security invoker`,
-- `set search_path = ''`, `stable` and their `returns table (...)` column
-- lists byte for byte, because lib/supabase/queries/reports.ts and
-- dashboard.ts read these columns by name and position, and because
-- `create or replace` preserves each function's existing ACL — 0010's
-- revoke-from-public / grant-to-authenticated on get_dashboard_summary
-- survives without this file restating it.


-- ============================================== 1. The Trading and P&L account

-- THE SIGN IS THE FIGURE.
--
--   abs(sum(case when g.normal_balance = 'credit' then credit - debit
--                else debit - credit end))
--
-- reported a magnitude placed by the group's nominal side. The app then reads
-- those rows and computes, in profit-loss/page.tsx:
--
--   gross = sum(direct_income) - sum(direct_expense)
--   net   = gross + sum(indirect_income) - sum(indirect_expense)
--
-- so an income ledger sitting in DEBIT — one that has reduced income — was
-- added to income. A 10,000 credit note against 6,750 of sales leaves that
-- ledger 3,250 in debit; the Trial Balance reported it correctly, the P&L
-- screen reported a net profit 6,500 above the Balance Sheet's for the same
-- books on the same date. Twice the reversal, which is the signature of a
-- subtraction that has become an addition.
--
-- This is not an exotic state. It is reached by a sales return, a rate
-- revision, a credit note or a supplier rebate, and it is *permanent* under
-- the ordinary Indian chart of accounts: "Sales Returns" is grouped under
-- Direct Incomes and carries a debit for its whole life, "Purchase Returns"
-- under Direct Expenses and carries a credit for its whole life. That is
-- Tally's arrangement and the one users bring with them.
--
-- The abs() also made the branch above it dead code — abs(cr - dr) and
-- abs(dr - cr) are the same number, so the classification the function went to
-- the trouble of computing could not affect any answer. Removing abs() brings
-- it back to life, and the branch now keys on `nature` rather than
-- `normal_balance`. They agree for every group the app can create (0003 seeds
-- them in step and createAccountGroup copies both from the parent), but
-- `nature` is the column the WHERE clause below already filters on and the
-- column the page groups these rows by, so keying on it makes the identity
--
--   P&L net profit == Balance Sheet Net Profit line
--
-- true by construction rather than by coincidence: income contributes
-- +(credit - debit) and expense contributes -(debit - credit) — the same
-- expression — so the page's income-minus-expense arithmetic collapses to one
-- uniform sum(credit - debit) over every income and expense entry in the
-- window, which is exactly what get_balance_sheet computes below.
--
-- The window, the nature filter, the `having <> 0` and the ordering are all
-- untouched. The P&L stays period-scoped and stays a report about entries.
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
    sum(
      case when g.nature in ('direct_income','indirect_income')
           then ve.credit_amount - ve.debit_amount
           else ve.debit_amount - ve.credit_amount end
    ) as amount
  from public.voucher_entries ve
  join public.vouchers v on v.id = ve.voucher_id
  join public.ledgers l on l.id = ve.ledger_id
  join public.account_groups g on g.id = l.group_id
  where v.company_id = p_company_id and v.is_deleted = false
    and v.voucher_date between p_from_date and p_to_date
    and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense')
  group by l.id, g.id
  having sum(
      case when g.nature in ('direct_income','indirect_income')
           then ve.credit_amount - ve.debit_amount
           else ve.debit_amount - ve.credit_amount end
    ) <> 0
  order by g.statement, g.sort_order, g.name, l.name;
$$;


-- ==================================================== 2. The Balance Sheet

-- ONE WINDOW, ONE SET OF BALANCES.
--
-- The sheet tallies by construction, and the construction is short enough to
-- state: every voucher balances, so summing (debit - credit) over ALL entries
-- gives nil; split that sum by nature and the balance-sheet half is the exact
-- negative of the income-and-expense half. The Net Profit line is that second
-- half, put on the other side. Assets minus liabilities is then the sum of the
-- opening balances, and the sheet tallies whenever those tally — which is the
-- same precondition the Trial Balance has, and the honest one.
--
-- That argument only holds if the profit figure is drawn from the same rows,
-- over the same window, as the ledger lines it balances against. It was drawn
-- from neither.
--
-- THE LOWER BOUND. `between v_book_beginning_date and p_as_of_date` bounded
-- the profit at the book beginning; `bal.signed_balance` two dozen lines below
-- has never had a lower bound at all. A voucher dated before the books began
-- therefore counted in the ledger lines and not in the profit, and the sheet
-- went out by exactly that voucher. Nothing forbids one: no check constraint,
-- no trigger, no `min` on the voucher form's date input, and both the CSV
-- importer and restore_company_backup take whatever date they are handed.
--
-- The bound is gone, not added to the other side. The asymmetry was the defect
-- whichever end you fix, but an opening balance already IS the pre-history and
-- is included with no lower bound — so treating book_beginning_date as "the
-- start of everything" was already false, and the moment one voucher predates
-- it the claim collapses.
--
-- WHAT "LIFE TO DATE" NOW MEANS. 0006 and 0012 both use that phrase, and both
-- gloss it as "book_beginning_date -> as_of_date". It now means what it says:
-- everything on the books up to p_as_of_date, with no lower bound, plus every
-- opening balance. book_beginning_date is no longer read by this function.
-- Nothing about the intent changes — 0006's comment already said the figure
-- was meant to be life-to-date, and this is that figure; only the phrase's
-- second half, which was never accurate, is withdrawn.
--
-- OPENING BALANCES ON NOMINAL LEDGERS. The profit subquery read
-- voucher_entries; the ledger lines read opening balance plus entries. So an
-- opening balance on an income or expense ledger — 9,000 credited to "Sales
-- Brought Forward" by somebody migrating mid-year, which is exactly what the
-- ledger form permits, its opening-amount field not being conditional on the
-- kind of ledger and its Advanced disclosure offering every group — appeared
-- on neither side of the sheet. Not misplaced: absent. The Trial Balance
-- tallied at 9,000 both ways while the Balance Sheet reported assets 9,000
-- against liabilities nil.
--
-- The sheet accounts for it; the schema does not refuse it. Refusing it would
-- have been the tidier rule and it is the wrong one here:
--
--   * it cannot repair a book that already contains one, and losing money
--     silently is the part that matters;
--   * restore_company_backup must accept any backup this application has ever
--     produced, and a check constraint would make one unrestorable;
--   * 0012's lesson is that a report must be right about a balance it did not
--     choose. A nominal ledger carrying an opening balance is the same shape
--     of awkwardness as an overdrawn bank account or a customer in credit, and
--     those are reported, not forbidden;
--   * and the figure is meaningful. A year-to-date trading result carried in
--     from older books is "Profit & Loss A/c brought forward" — an ordinary
--     line under Capital Account in any Indian balance sheet.
--
-- So it is reported as its own synthetic line, netted across every nominal
-- ledger, on the side its sign puts it, and only when it is not nil — a book
-- with nothing brought forward grows no new line. It is deliberately NOT
-- folded into the Net Profit line: that line is this period's trading result
-- and must stay equal to what the P&L reports, and get_profit_and_loss is a
-- report about entries in a window, which an opening balance is not.
create or replace function public.get_balance_sheet(
  p_company_id uuid, p_as_of_date date
) returns table (
  side text, -- 'liability' | 'asset'
  ledger_id uuid, -- null for the two synthetic lines
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
  v_net_profit numeric(18,2);
  v_opening_result numeric(18,2);
begin
  -- This period's result. Per entry, income contributes +(credit - debit) and
  -- expense contributes -(debit - credit), which is the same expression — the
  -- subtraction and the sign flip cancel — so one uniform sum needs no
  -- per-nature branching. Unchanged from 0012 except for the lower bound,
  -- which is gone: the window is now every entry up to p_as_of_date, exactly
  -- the window the ledger lines below use.
  --
  -- This subquery has never filtered on l.is_active and still does not (0017).
  select coalesce(sum(ve.credit_amount - ve.debit_amount), 0)
  into v_net_profit
  from public.voucher_entries ve
  join public.vouchers v on v.id = ve.voucher_id
  join public.ledgers l on l.id = ve.ledger_id
  join public.account_groups g on g.id = l.group_id
  where v.company_id = p_company_id and v.is_deleted = false
    and v.voucher_date <= p_as_of_date
    and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense');

  -- The trading result carried in from before the books began: every opening
  -- balance on a nominal ledger, signed the same way as the figure above —
  -- credit positive, because a credit on an income or expense ledger is a
  -- profit. Netted across all four nominal natures, so 9,000 of income and
  -- 4,000 of expense brought forward come across as one 5,000 profit.
  select coalesce(sum(
           case when l.opening_balance_type = 'credit' then 1 else -1 end
           * coalesce(l.opening_balance_amount, 0)
         ), 0)
  into v_opening_result
  from public.ledgers l
  join public.account_groups g on g.id = l.group_id
  where l.company_id = p_company_id
    and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense');

  return query
  -- The ledger lines, unchanged since 0017: a debit balance is an asset and a
  -- credit balance is a claim on the business, whatever the group is nominally
  -- classified as (0012); is_active is not consulted, because the
  -- `signed_balance <> 0` below already says the only thing it was there to
  -- say (0017).
  select
    case when bal.signed_balance > 0 then 'asset' else 'liability' end as side,
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
  where l.company_id = p_company_id
    and g.nature in ('current_asset','current_liability','fixed_asset','capital')
    and bal.signed_balance <> 0

  union all

  select 'liability', null::uuid, 'Net Profit (Current Period)', 'Capital Account', 'capital', v_net_profit
  where v_net_profit >= 0

  union all

  select 'asset', null::uuid, 'Net Loss (Current Period)', 'Capital Account', 'capital', abs(v_net_profit)
  where v_net_profit < 0

  union all

  select 'liability', null::uuid, 'Opening Profit (Brought Forward)', 'Capital Account', 'capital', v_opening_result
  where v_opening_result > 0

  union all

  select 'asset', null::uuid, 'Opening Loss (Brought Forward)', 'Capital Account', 'capital', abs(v_opening_result)
  where v_opening_result < 0;
end;
$$;


-- ================================================= 3. Cash is not the word

-- TELLING A TILL FROM A BANK.
--
-- account_groups.ledger_role finds cash and bank ledgers together and is right
-- to: the role exists so a Payment voucher's money leg can be hard-filtered,
-- and for that purpose cash and bank are one thing. Splitting them was then a
-- name test, `g.name ilike '%cash%'`, and 0010's own comment conceded it was
-- "a name test, which is what the client did too".
--
-- It is wrong in India specifically. A **Cash Credit** account is a bank
-- overdraft facility, "Cash Credit Accounts" is the standard name for the
-- group holding them, and `%cash%` reads it as a till. With an ICICI cash
-- credit account 1,83,240 overdrawn the dashboard reported **Cash in Hand:
-- -95,028.01** — a drawer containing minus a lakh of rupees. The two tiles
-- summed correctly, which is why nothing else caught it. Renaming the group
-- and changing nothing else corrected both tiles, which is what proved the
-- name was the cause. Audit finding F-16.
--
-- WHAT IS FIXED, AND WHY NOT MORE. The test is narrowed rather than patched:
-- physical cash is the small, well-defined case and bank is the residue.
-- "Cash" is a word banks use — cash credit, cash management — while nothing
-- that is not a till is called petty cash or cash-in-hand. So a bank word wins
-- first, then a cash word, then bank. The ordering carries the whole meaning.
--
-- The structural alternative — a column on account_groups saying which a group
-- is — was considered and rejected. Without a question on the group form to
-- fill it in, its value could only be derived from the name, so it would move
-- the guess rather than remove it, and it would then go stale the moment
-- somebody renamed the group. With such a question it stops being this task:
-- a new column, a check constraint, the group form, backup and restore, undo,
-- and a migration-time backfill for the 18 seeded groups of every existing
-- company — all to ask a user a question the name already answers in every
-- case anyone has hit. If that question is ever worth asking, this function
-- and the helper below are the two places that change.
--
-- THE HELPER EXISTS SO THE RULE HAS ONE STATEMENT. lib/ledgers/party-type.ts
-- already made this exact call, correctly, in cashBankFlavour() — bank, then
-- cash credit, then overdraft, then cash, then bank — because it needed it to
-- decide which group a new ledger is filed in. It said get_dashboard_summary
-- was "deliberately left alone"; that was a defensible line when the two
-- answered different questions, and it is not one now. If the client files a
-- cash credit ledger as a bank account and the database reports it as cash,
-- the app has told the user two different things about the same money.
--
-- strpos(lower(...)) rather than ilike: it is the same test TypeScript's
-- .toLowerCase().includes() performs, it is immutable, and a group name
-- containing % or _ cannot mean anything unexpected to it.
create or replace function public.is_cash_group_name(p_group_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    -- A bank word first, including the bank products that have "cash" in them.
    when strpos(lower(coalesce(p_group_name, '')), 'bank') > 0 then false
    when strpos(lower(coalesce(p_group_name, '')), 'cash credit') > 0 then false
    when strpos(lower(coalesce(p_group_name, '')), 'overdraft') > 0 then false
    -- Of what is left, anything naming cash is a till.
    when strpos(lower(coalesce(p_group_name, '')), 'cash') > 0 then true
    -- And anything else: the seeded pair is "Bank Accounts" and "Cash-in-Hand",
    -- so an unnamed third group is far likelier to be another bank.
    else false
  end;
$$;

revoke execute on function public.is_cash_group_name(text) from public;
grant execute on function public.is_cash_group_name(text) to authenticated;


-- ===================================== 4. The dashboard's six figures again

-- A FIGURE ABOUT A PERIOD COUNTS EVERYTHING THAT PERIOD HAD IN IT.
--
-- 0017 taught this function that a ledger is included if it is active or
-- holds money, tested against `balance_now`, and hung all six figures off the
-- resulting `included` CTE. That is the right rule for the two balance tiles
-- and the wrong one for the other four, because `*_change` is a difference
-- between two dates and month inflow/outflow is gross movement through a
-- period — neither is a fact about today.
--
-- A bank account that held 50,000 at the end of last month, was emptied into
-- the till on the 5th and then closed has no balance today, so it dropped out
-- of `included` and took its history with it. The change tile read +700 on a
-- month in which the banks went down 49,300 — the tile that exists to say
-- "the banks are down" said they were up. Worse, the outflow figure lost the
-- 50,000 leaving the bank while the inflow figure kept the same 50,000
-- arriving in cash, so the month appeared to have created money out of a
-- contra entry. 0017's note that such an account "drops out of both at the
-- same moment" held for the balance pair and for nothing else.
--
-- The predicate is REMOVED rather than moved. It never affected the two tiles
-- it was written for: a ledger it excludes is inactive AND at nil on the
-- as-of date, so it contributes zero to a balance whether it is summed or not.
-- Its only effect was on the four figures it was wrong for. So this function
-- goes back to 0010's shape — every cash and bank ledger, is_active never
-- consulted — and 0017's reporting rule ("is_active hides a ledger from the
-- pickers, never from the statements") holds here more completely than before,
-- not less. get_trial_balance and get_balance_sheet still keep their own
-- versions of that test, and must: they list rows, and a row at nil is noise.
create or replace function public.get_dashboard_summary(
  p_company_id uuid, p_as_of_date date
) returns table (
  cash_in_hand numeric,
  cash_in_hand_change numeric,
  bank_balance numeric,
  bank_balance_change numeric,
  month_inflow numeric,
  month_outflow numeric
)
language sql
security invoker
set search_path = ''
stable
as $$
  with bounds as (
    select
      date_trunc('month', p_as_of_date::timestamp)::date as month_start,
      (date_trunc('month', p_as_of_date::timestamp)::date - 1) as prev_month_end
  ),
  -- Cash and bank ledgers are found via account_groups.ledger_role rather than
  -- by group name, so a company that renames its seeded "Cash-in-Hand" or
  -- "Bank Accounts" group keeps working. Which of the two a group is, is the
  -- one question the name still answers — see is_cash_group_name above, and
  -- cashBankFlavour() in lib/ledgers/party-type.ts, which is the same rule.
  cash_bank_ledgers as (
    select
      l.id,
      l.opening_balance_amount,
      l.opening_balance_type,
      public.is_cash_group_name(g.name) as is_cash
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
    where l.company_id = p_company_id
      and g.ledger_role = 'cash_bank'
  ),
  -- Signed balance per ledger at both dates, in one pass over the entries
  -- rather than two full trial balances.
  balances as (
    select
      cbl.id,
      cbl.is_cash,
      coalesce(cbl.opening_balance_amount, 0)
        * case when cbl.opening_balance_type = 'debit' then 1 else -1 end
        + coalesce(sum(ve.debit_amount - ve.credit_amount)
            filter (where v.voucher_date <= p_as_of_date), 0) as balance_now,
      coalesce(cbl.opening_balance_amount, 0)
        * case when cbl.opening_balance_type = 'debit' then 1 else -1 end
        + coalesce(sum(ve.debit_amount - ve.credit_amount)
            filter (where v.voucher_date <= (select prev_month_end from bounds)), 0) as balance_prev
    from cash_bank_ledgers cbl
    left join public.voucher_entries ve on ve.ledger_id = cbl.id
    left join public.vouchers v
      on v.id = ve.voucher_id
     and v.company_id = p_company_id
     and v.is_deleted = false
    group by cbl.id, cbl.is_cash, cbl.opening_balance_amount, cbl.opening_balance_type
  ),
  -- Gross movement for the month to date: every debit and every credit, not
  -- the net change, so money that went out and came back counts on both sides
  -- — which is how a cash-flow tile should read. Over every cash and bank
  -- ledger, because money that left is money that left whatever the account's
  -- status is today.
  movement as (
    select
      coalesce(sum(ve.debit_amount), 0) as inflow,
      coalesce(sum(ve.credit_amount), 0) as outflow
    from cash_bank_ledgers cbl
    join public.voucher_entries ve on ve.ledger_id = cbl.id
    join public.vouchers v on v.id = ve.voucher_id
    where v.company_id = p_company_id
      and v.is_deleted = false
      and v.voucher_date between (select month_start from bounds) and p_as_of_date
  )
  select
    coalesce(sum(balance_now) filter (where is_cash), 0),
    coalesce(sum(balance_now - balance_prev) filter (where is_cash), 0),
    coalesce(sum(balance_now) filter (where not is_cash), 0),
    coalesce(sum(balance_now - balance_prev) filter (where not is_cash), 0),
    (select inflow from movement),
    (select outflow from movement)
  from balances;
$$;
