-- THE SAME SUPPLIER BILL, ENTERED TWICE (audit finding F-05)
--
-- vouchers.reference_number holds the supplier's own bill number on a
-- purchase. Nothing has ever looked at it twice: no unique constraint, no
-- index, and no warning anywhere in the entry flow. The same bill can be keyed
-- in on Monday and again on Thursday, and the books will show two payables,
-- two expenses and no sign at all that they are one delivery. It is the most
-- common accounts-payable data error there is, and the place it leads is
-- paying a supplier twice.
--
-- WHY THIS IS A LOOKUP AND NOT A CONSTRAINT.
--
-- The obvious fix — a unique index on (company_id, party_ledger_id,
-- reference_number, financial_year_label) — would be wrong, and would be
-- discovered to be wrong by a user with a correct document in their hand and
-- no way to enter it. Two suppliers genuinely do issue the same bill number;
-- one supplier genuinely does restart at 1 every April; a bill genuinely does
-- get re-issued under the same number after a correction. A constraint has no
-- way to be told any of that. So this warns, names what already exists, and
-- leaves the decision with the person who can see both pieces of paper. A
-- soft-unique, enforced by telling the truth rather than by refusing.
--
-- WHY IT IS CHEAP NOW AND WAS NOT BEFORE.
--
-- Until 0022 the party was not a column. "The supplier on this bill" meant
-- joining voucher_entries to ledgers to account_groups to find the leg whose
-- group carries ledger_role = 'creditor', per voucher, with no index that
-- could serve it. 0022 made party_ledger_id a column with a composite foreign
-- key, and the question became an ordinary indexed equality.

-- ------------------------------------------------------------- 1. the index

-- Not unique. See above — this records what has been seen, it does not decide
-- what may be written.
--
-- The expression is `upper(btrim(...))`, matching the lookup below exactly. If
-- one of the two ever changes without the other, the index silently stops
-- being used and the lookup becomes a sequential scan of every voucher in the
-- company: still correct, quietly slower every year. Both are `upper` rather
-- than `lower` for no reason beyond having to pick one; both are `btrim` and
-- neither collapses whitespace *inside* the reference, because 'INV 001' and
-- 'INV  001' are not obviously the same label and guessing wrong in that
-- direction hides a real bill behind a false match.
--
-- PARTIAL, and each condition in the predicate is one the planner can prove
-- from the lookup's own WHERE clause, which is the whole point of choosing
-- them:
--
--   voucher_type = 'purchase'     stated verbatim by the query
--   is_deleted = false            stated verbatim by the query
--   party_ledger_id is not null   implied by `party_ledger_id = $2`, since `=`
--                                 is strict
--   reference_number is not null  implied by
--                                 `upper(btrim(reference_number)) = ...`, since
--                                 upper, btrim and `=` are all strict
--
-- What is deliberately NOT in the predicate is `btrim(reference_number) <> ''`.
-- It would exclude a few more rows, and the planner cannot prove it from
-- anything the query says, so adding it would cost the index its use
-- altogether. The blank references are excluded in the function instead, where
-- exclusion is free.
--
-- The rows this leaves out are most of the table: every receipt, payment,
-- contra, journal and sale, and every purchase with no bill number on it.
create index vouchers_purchase_bill_ref_idx
  on public.vouchers (
    company_id,
    party_ledger_id,
    upper(btrim(reference_number)),
    financial_year_label
  )
  where voucher_type = 'purchase'
    and is_deleted = false
    and party_ledger_id is not null
    and reference_number is not null;

-- ------------------------------------------------------------ 2. the lookup

-- Every purchase already on the books that carries this supplier's bill
-- number, in the financial year this one would land in.
--
-- SECURITY INVOKER, like every other read in this schema. A duplicate-bill
-- warning is a report about the caller's own books and must be exactly as
-- visible as the vouchers it names — no more. RLS on public.vouchers is what
-- makes that true, and a security definer function would quietly have made the
-- warning a way to confirm the existence of another company's purchase by
-- probing bill numbers at it.
--
-- THE YEAR IS DERIVED, NOT PASSED. The caller has a date on the form in front
-- of it; financial_year_label is a company setting applied to that date, and
-- app_private.financial_year_label() is the one place that rule lives (0018).
-- A client that computed the label itself would be a second copy of the
-- year-boundary rule, in TypeScript, which would be right until a company
-- whose year starts in July used it. It is stable and security definer, so
-- this can call it.
--
-- THE EXCLUSION. p_exclude_voucher_id is the voucher being edited. Without it,
-- opening any purchase that has a bill number and blurring the field reports
-- the voucher itself as its own duplicate, which teaches the user within a day
-- that this warning means nothing.
--
-- Null and blank references are not duplicates of each other. Most vouchers
-- have no reference at all, and two of them are two vouchers nobody wrote a
-- number on, not one bill entered twice. Both the argument and the stored
-- column are guarded: the stored side falls out for free (`upper(btrim(null))`
-- is null, and null never equals anything), and the argument side needs the
-- explicit blank check, because a field spacebarred by the user would
-- otherwise normalise to '' and match a stored '' exactly.
create or replace function public.find_duplicate_bill(
  p_company_id uuid,
  p_party_ledger_id uuid,
  p_reference_number text,
  p_voucher_date date,
  p_exclude_voucher_id uuid default null
) returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  total_amount numeric(18,2),
  reference_number text
)
language sql
security invoker set search_path = ''
stable
as $$
  select v.id, v.voucher_number, v.voucher_date, v.total_amount, v.reference_number
  from public.vouchers v
  where btrim(coalesce(p_reference_number, '')) <> ''
    and v.company_id = p_company_id
    and v.voucher_type = 'purchase'
    and v.is_deleted = false
    and v.party_ledger_id = p_party_ledger_id
    and upper(btrim(v.reference_number)) = upper(btrim(p_reference_number))
    and v.financial_year_label = app_private.financial_year_label(p_company_id, p_voucher_date)
    and v.id is distinct from p_exclude_voucher_id
  order by v.voucher_date, v.voucher_number;
$$;

comment on function public.find_duplicate_bill(uuid, uuid, text, date, uuid) is
  'Purchases already entered against this supplier with this bill number, in the financial year the given date falls in. A warning, not a rule: the caller shows what it returns and saves anyway if the user says to.';

-- CREATE FUNCTION grants EXECUTE to PUBLIC, which anon inherits regardless of
-- anything revoked from anon specifically — the same hole 0008 closed on
-- create_company. Revoking from PUBLIC is what actually closes it. Being
-- security invoker, an anonymous caller would have got an empty result rather
-- than anyone's data; it is still not a function that should be callable.
revoke execute on function public.find_duplicate_bill(uuid, uuid, text, date, uuid) from public;
grant execute on function public.find_duplicate_bill(uuid, uuid, text, date, uuid) to authenticated;

-- ------------------------------------------------------ 3. what this is not
--
-- It does not look at the 57 legacy purchase vouchers, and cannot. They have
-- no party_ledger_id — they predate 0022, they have no invoice lines, and the
-- rule that requires a party applies only to vouchers that do — so there is
-- nothing to match a supplier against. A bill re-entered today against a
-- supplier who also appears on one of those 57 will not be flagged by it. The
-- alternative is the join through account_groups this migration exists to
-- avoid, run against a set of vouchers that stopped growing when invoicing
-- landed, and it would still only be a guess at which leg was the supplier's.
--
-- It does not look across companies, which needs no filter of its own beyond
-- the company_id above: party_ledger_id carries a composite foreign key into
-- (ledgers.id, company_id), so a party from another company's books cannot be
-- named by a voucher in this one at all.
--
-- It does not fire on sales. HISAB mints its own invoice numbers and the
-- unique constraint from 0004 already makes a repeat impossible; the risk here
-- is entirely inbound paper.
