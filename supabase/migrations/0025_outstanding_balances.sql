-- WHO OWES ME, AND WHO I OWE
--
-- The books can already produce a Trial Balance, a Trading & P&L and a
-- Balance Sheet. None of them answers the one question a shopkeeper asks
-- every morning: which customers still owe me money, and how much. The
-- Balance Sheet comes closest and it reports "Sundry Debtors 4,20,000" as a
-- single line — a total with no names in it.
--
-- This is that list. One row per party ledger carrying a balance, with the
-- name, the amount, which way it points, and when that party was last
-- touched.
--
-- SECURITY INVOKER, `set search_path = ''`, `stable` — the conventions of
-- 0006, and for its reasons. This is a live aggregation over voucher_entries
-- with no privilege of its own: the caller's RLS decides which company's rows
-- exist, so a wrong p_company_id returns nothing rather than somebody else's
-- debtors. There is no reporting bypass in this schema and this file does not
-- introduce one.
--
-- ----------------------------------------------------- who counts as a party
--
-- Ledgers whose *group* carries ledger_role 'debtor' or 'creditor'. Not the
-- group's name, and not its nature: 0003 seeds the roles precisely so code
-- can find these ledgers after a company has renamed "Sundry Debtors" to
-- "Customers", and get_dashboard_summary (0010) already reads cash and bank
-- the same way. Nature would be wrong twice over — 'current_asset' also holds
-- cash, bank and loans, and a customer sitting in credit is still a customer.
--
-- Loans & Advances (ledger_role 'loan') is deliberately not here. It is money
-- owed in a real sense, but it is not a trading party and putting a director's
-- loan in the same list as the customers would make the receivables total mean
-- two different things at once.
--
-- ------------------------------------------------- which way a balance points
--
-- The side follows THE SIGN OF THE BALANCE, not the role of the group. This
-- is the lesson 0012 learned on the Balance Sheet, and the reasoning carries
-- over unchanged: a debit balance is money owed to the business and a credit
-- balance is money the business owes, whatever the ledger is nominally
-- classified as.
--
-- So a customer sitting in credit — he paid an advance, or overpaid, or a
-- credit note was raised after he settled — is reported as a PAYABLE, because
-- that is what it is: the business owes him goods or a refund. A supplier
-- sitting in debit (an advance paid against an order) is reported as a
-- RECEIVABLE for the mirror reason.
--
-- The alternative — receivables mean "every debtor-role ledger", signed — was
-- rejected because it breaks the two things this screen exists to do:
--
--   * the totals stop meaning anything. "Receivables 4,20,000" would be a net
--     figure with somebody's advance quietly subtracted from it, and it would
--     no longer be the amount that is actually out there to collect.
--   * the sort stops meaning anything. Sorted by amount descending, the
--     biggest number at the top is what the user came to see; a signed list
--     puts the advances at the bottom below the settled parties and mixes two
--     kinds of number in one column.
--
-- Presented this way the two totals are each a real sum of real claims, and
-- they agree with the Balance Sheet, which puts these same ledgers on the same
-- sides for the same reason.
--
-- `party_kind` is returned alongside so the screen can still say what the
-- party *is*. A customer under Payables is unusual and is worth showing as
-- "Customer — advance received" rather than silently relabelling him a
-- supplier; the direction is the accounting fact, the kind is the relationship,
-- and the user needs both.
--
-- ------------------------------------------------------------ what is in scope
--
-- LIFE TO DATE, and no as-of date argument. Three reasons, in order of weight:
--
--   1. It is the question. "Who owes me" has one answer and it is the amount
--      standing against that party right now — the same figure the 0017
--      deactivation guard measures, and the same one lib/supabase/queries/
--      ledgers.ts reaches for by asking get_trial_balance as of 9999-12-31.
--   2. A date bound would hide a forward-dated voucher. A bill entered today
--      and dated next week is a real receivable the moment it is keyed in, and
--      an as-of-today report would omit it while the ledger card showed it.
--   3. A date picker on this screen is one more control on the one screen that
--      is meant to have none.
--
-- INACTIVE LEDGERS ARE INCLUDED whenever they carry a balance. 0017 states
-- the rule once — is_active hides a ledger from the pickers, never from the
-- statements, and a balance that exists must appear somewhere — and an
-- outstanding list that silently dropped a retired customer who still owes
-- money would be the exact defect 0017 was written to fix, in a new place. A
-- ledger at nil is excluded whatever its is_active says, which is the same
-- predicate the Balance Sheet uses.
--
-- DELETED VOUCHERS ARE EXCLUDED, as everywhere else.
--
-- last_transaction_date is the latest voucher_date on a non-deleted voucher
-- touching that ledger, and is NULL for a party whose whole balance is an
-- opening figure — nothing has been posted to it yet, and reporting the
-- opening date would be an invention. The screen reads it as "no entries yet",
-- which is exactly the state it describes.
create or replace function public.get_outstanding_balances(
  p_company_id uuid
) returns table (
  ledger_id uuid,
  ledger_name text,
  party_kind text,  -- 'customer' | 'supplier' — what the party is
  direction text,   -- 'receivable' | 'payable' — which way the money points
  amount numeric,   -- always positive; `direction` carries the sign
  last_transaction_date date
)
language sql
security invoker
set search_path = ''
stable
as $$
  select
    l.id,
    l.name,
    case when g.ledger_role = 'debtor' then 'customer' else 'supplier' end,
    case when bal.signed_balance > 0 then 'receivable' else 'payable' end,
    abs(bal.signed_balance),
    bal.last_transaction_date
  from public.ledgers l
  join public.account_groups g on g.id = l.group_id
  -- One aggregate per ledger for both the balance and the last date. The
  -- lateral is an aggregate over a possibly empty set, so it always produces
  -- exactly one row: sum() of nothing is null and is coalesced to zero, max()
  -- of nothing is null and stays null, which is the "nothing posted yet" case.
  cross join lateral (
    select
      coalesce(l.opening_balance_amount, 0)
        * case when l.opening_balance_type = 'debit' then 1 else -1 end
      + coalesce(sum(ve.debit_amount - ve.credit_amount), 0) as signed_balance,
      max(v.voucher_date) as last_transaction_date
    from public.voucher_entries ve
    join public.vouchers v on v.id = ve.voucher_id
    where ve.ledger_id = l.id
      and v.company_id = p_company_id
      and v.is_deleted = false
  ) bal
  where l.company_id = p_company_id
    and g.ledger_role in ('debtor', 'creditor')
    and bal.signed_balance <> 0
  -- Biggest first, because the biggest debtor is what the user opened the
  -- screen to see. Name breaks ties so two parties owing the same amount do
  -- not swap places between reloads.
  order by abs(bal.signed_balance) desc, l.name;
$$;

comment on function public.get_outstanding_balances(uuid) is
  'Every customer and supplier ledger carrying a balance, life to date: what it is, which way the money points, how much, and when it was last posted to. Receivable/payable follows the sign of the balance, not the group, so a customer in credit is reported as a payable.';

-- CREATE FUNCTION grants EXECUTE to PUBLIC, which anon inherits regardless of
-- anything revoked from anon specifically — the same hole 0008 closed on
-- create_company and 0024 on find_duplicate_bill. Being security invoker, an
-- anonymous caller would get an empty result rather than anyone's data; it is
-- still not a function that should be callable.
revoke execute on function public.get_outstanding_balances(uuid) from public;
grant execute on function public.get_outstanding_balances(uuid) to authenticated;
