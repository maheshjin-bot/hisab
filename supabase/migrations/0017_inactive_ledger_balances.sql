-- Fix: deactivating a ledger could stop the Trial Balance tallying and stop
-- the Balance Sheet's two sides agreeing.
--
-- Three of the statement functions dropped inactive ledgers outright:
--
--   where l.company_id = p_company_id and l.is_active = true
--
-- in get_trial_balance (0006), in get_balance_sheet (0012, the live version)
-- and in get_dashboard_summary's cash_bank_ledgers CTE (0010). Nothing stops
-- a ledger that still holds a balance from being deactivated:
-- app_private.protect_ledger_financial_fields() guards only
-- opening_balance_amount, opening_balance_type and group_id, and the
-- ledgers_update policy admits any accountant.
--
-- So one click on "inactive" took a real balance out of the statements while
-- leaving its other half in place:
--
--   * the Trial Balance stopped tallying, by exactly that balance;
--   * the Balance Sheet lost the line — but its Net Profit subquery has never
--     had an is_active filter (neither has get_profit_and_loss), so every
--     income and expense entry the deactivated ledger had been party to was
--     still counted. The two sides stopped agreeing, and 0012's claim that
--     they "are guaranteed to total identically as long as every voucher
--     balances" did not survive it;
--   * a deactivated bank account silently left the dashboard's cash and bank
--     tiles, so the tiles and the Trial Balance disagreed about the same
--     money.
--
-- The rule, stated once: is_active hides a ledger from the *pickers*, never
-- from the *statements*. A balance that exists must appear somewhere.
--
-- Two changes, deliberately overlapping, because either alone leaves a hole.
-- The statements stop hiding a non-zero balance whatever is_active says, so
-- books that are already in this state report correctly from the next page
-- load. And a new trigger stops a ledger being deactivated while it still
-- holds a balance, so the state stops being reachable at all — which is also
-- the answer a user actually wants ("clear it first"), rather than a ledger
-- that reappears on the Trial Balance after they thought they had retired it.
--
-- What is deliberately *not* changed:
--
--   * inactive ledgers with a zero balance stay hidden everywhere. is_active
--     still does its real job; only balances override it.
--   * get_profit_and_loss is left exactly as it is. It never had the filter,
--     which is why the Balance Sheet's profit figure and its ledger lines
--     disagreed in the first place — it was already right.
--   * security invoker, set search_path = '' and stable are preserved on all
--     three functions, and every returns table (...) signature is byte-for-
--     byte what it was: lib/supabase/queries/reports.ts and dashboard.ts read
--     these columns by name and position.
--   * create or replace preserves each function's existing ACL, so
--     get_dashboard_summary keeps 0010's revoke-from-public /
--     grant-to-authenticated without this file restating it.

-- ------------------------------------------------------- 1. Trial Balance

-- The Trial Balance lists every ledger, including ones sitting at nil, so the
-- filter cannot simply be dropped here: it becomes "active, or holding a
-- balance". An inactive ledger at nil is still hidden.
create or replace function public.get_trial_balance(
  p_company_id uuid, p_as_of_date date
) returns table (
  ledger_id uuid,
  ledger_name text,
  group_name text,
  nature text,
  debit_balance numeric,
  credit_balance numeric
)
language sql
security invoker
set search_path = ''
stable
as $$
  select
    l.id,
    l.name,
    g.name,
    g.nature,
    greatest(bal.signed_balance, 0) as debit_balance,
    greatest(-bal.signed_balance, 0) as credit_balance
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
    and (l.is_active = true or bal.signed_balance <> 0)
  order by g.sort_order, g.name, l.name;
$$;

-- -------------------------------------------------------- 2. Balance Sheet

-- Body taken from 0012, not 0006: the side-follows-the-sign-of-the-balance
-- logic and its reasoning are unchanged, and so are the nature filter, the
-- book-beginning window and the synthetic Net Profit/Loss line.
--
-- The only edit is the removal of `l.is_active = true` from the WHERE. No
-- "or holding a balance" clause is needed to replace it, because the
-- `bal.signed_balance <> 0` line two rows below already says exactly that:
-- the Balance Sheet has never listed a ledger sitting at nil, active or not.
-- With the is_active test gone, the surviving predicate is precisely the rule
-- — every non-zero balance-sheet balance, and nothing else.
create or replace function public.get_balance_sheet(
  p_company_id uuid, p_as_of_date date
) returns table (
  side text, -- 'liability' | 'asset'
  ledger_id uuid, -- null for the synthetic Net Profit/Loss line
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
  v_book_beginning_date date;
  v_net_profit numeric(18,2);
begin
  select book_beginning_date into v_book_beginning_date from public.companies where id = p_company_id;

  -- Net profit = total income - total expense. Per entry, income contributes
  -- +(credit-debit); expense contributes -(debit-credit), which is the same
  -- expression, +(credit-debit) — the subtraction and the sign flip cancel.
  --
  -- This subquery has never filtered on l.is_active and still does not. That
  -- is correct, and now the ledger lines below agree with it.
  select coalesce(sum(ve.credit_amount - ve.debit_amount), 0)
  into v_net_profit
  from public.voucher_entries ve
  join public.vouchers v on v.id = ve.voucher_id
  join public.ledgers l on l.id = ve.ledger_id
  join public.account_groups g on g.id = l.group_id
  where v.company_id = p_company_id and v.is_deleted = false
    and v.voucher_date between v_book_beginning_date and p_as_of_date
    and g.nature in ('direct_income','direct_expense','indirect_income','indirect_expense');

  return query
  select
    -- A debit balance is an asset, a credit balance is a claim on the
    -- business, whatever the group is nominally classified as.
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
  where v_net_profit < 0;
end;
$$;

-- ----------------------------------------------------- 3. Dashboard tiles

-- Same treatment, so a tile and the Trial Balance cannot disagree about the
-- same bank account. The test has to move, though: cash_bank_ledgers is the
-- CTE that picks the ledgers and it has no balance to test yet, so is_active
-- is carried through it and the decision is made in `included`, one step
-- later, against the balance the `balances` CTE has just computed.
--
-- `included` uses balance_now, i.e. the balance as of p_as_of_date, which is
-- the same figure and the same date get_trial_balance now tests. A bank
-- account deactivated after being emptied therefore drops out of both at the
-- same moment, and one holding money stays in both.
--
-- Month Inflow/Outflow moves to the same set for the same reason — gross
-- movement through a ledger the tiles above are still counting has to be
-- counted too.
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
  -- Cash and bank ledgers are found via account_groups.ledger_role rather
  -- than by group name, so a company that renames its seeded "Cash-in-Hand"
  -- or "Bank Accounts" group keeps working. The cash/bank split is then a
  -- name test, which is what the client did too.
  cash_bank_ledgers as (
    select
      l.id,
      l.opening_balance_amount,
      l.opening_balance_type,
      l.is_active,
      (g.name ilike '%cash%') as is_cash
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
      cbl.is_active,
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
    group by cbl.id, cbl.is_active, cbl.is_cash, cbl.opening_balance_amount, cbl.opening_balance_type
  ),
  -- Active, or holding money. An inactive account emptied to nil is hidden,
  -- exactly as it is on the Trial Balance.
  included as (
    select * from balances
    where is_active = true or balance_now <> 0
  ),
  -- Gross movement for the month to date: every debit and every credit, not
  -- the net change, so money that went out and came back counts on both
  -- sides — which is how a cash-flow tile should read.
  movement as (
    select
      coalesce(sum(ve.debit_amount), 0) as inflow,
      coalesce(sum(ve.credit_amount), 0) as outflow
    from included i
    join public.voucher_entries ve on ve.ledger_id = i.id
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
  from included;
$$;

-- ------------------------------------------------- 4. The deactivation guard

-- Reporting a balance that was hidden is the repair; this is the prevention.
-- A ledger holding money is not finished with, and "inactive" is the wrong
-- word for it — the honest workflow is to clear the balance (transfer it,
-- settle it, write it off) and then retire the ledger.
--
-- Scope, deliberately narrow:
--
--   * BEFORE UPDATE only, never INSERT. restore_company_backup() inserts
--     ledgers with their saved is_active *before* it inserts the vouchers
--     that give them a balance, so an INSERT-time check would either reject
--     a legitimate restore or pass vacuously depending on ordering. The
--     statements handle whatever a restore produces regardless.
--   * only on the true -> false transition. Editing an already-inactive
--     ledger's name or notes is untouched, and so is reactivating one — the
--     rule is one-directional, and a ledger you can never re-open would be a
--     worse trap than the bug.
--   * balance is life to date, not period-scoped, and ignores the lock date:
--     opening balance plus every entry on every non-deleted voucher. A
--     balance parked before the lock date is exactly the kind that must not
--     silently vanish.
--
-- One known consequence, accepted rather than special-cased:
-- revert_company_changes_since() replays a ledger's previous is_active, so an
-- undo that would put a *reactivation* back — a ledger reopened, posted to,
-- and now holding a balance — is refused, and the whole undo rolls back with
-- this message. It is a narrow case (it needs a true -> false step whose
-- ledger has since acquired a balance) and it fails loudly with no data lost.
-- The alternative, exempting the undo path via hisab.is_revert, would quietly
-- recreate the very state this file exists to eliminate, so the guard is left
-- unconditional.
--
-- security definer for the same reason protect_ledger_financial_fields() is:
-- the check has to see the whole ledger, not the subset of vouchers the
-- caller's RLS happens to expose.
create or replace function app_private.protect_ledger_deactivation()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_balance numeric(18,2);
begin
  if old.is_active = true and new.is_active = false then
    select
      coalesce(new.opening_balance_amount, 0)
        * case when new.opening_balance_type = 'debit' then 1 else -1 end
      + coalesce((
          select sum(ve.debit_amount - ve.credit_amount)
          from public.voucher_entries ve
          join public.vouchers v on v.id = ve.voucher_id
          where ve.ledger_id = new.id
            and v.company_id = new.company_id
            and v.is_deleted = false
        ), 0)
    into v_balance;

    if v_balance <> 0 then
      raise exception
        'Cannot deactivate ledger "%": it still holds a balance of % %. Clear it to nil first — transfer it, settle it, or write it off — then deactivate.',
        new.name,
        abs(v_balance),
        case when v_balance > 0 then 'Dr' else 'Cr' end;
    end if;
  end if;

  return new;
end;
$$;

-- `update of is_active` keeps the balance query off every ordinary ledger
-- edit. It cannot be dodged: is_active can only change if the UPDATE names
-- it, and naming it is what arms the trigger.
drop trigger if exists protect_ledger_deactivation on public.ledgers;

create trigger protect_ledger_deactivation
  before update of is_active on public.ledgers
  for each row execute function app_private.protect_ledger_deactivation();
