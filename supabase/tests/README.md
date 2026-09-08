# Database tests

`guarantees.sql` asserts the rules the database enforces on its own — a voucher
cannot be unbalanced, a locked period cannot be posted into, one company cannot
see another's rows, a voucher cannot be re-dated out of the financial year its
number was minted in. It creates its own fixtures and rolls the whole
transaction back, so it is safe to run against a database that holds real data.

## Running it locally

One command, from the repo root:

```
bash supabase/tests/run-local.sh
```

That drops and recreates a scratch database (`hisab_verify` by default),
applies `local-harness.sql`, applies every file in `supabase/migrations/` in
filename order, and then runs `guarantees.sql`. It exits non-zero on the first
migration that will not apply or the first guarantee that does not hold, so it
doubles as a check that the migration chain still builds a working database
from nothing.

Requires a local PostgreSQL (tested on 18.6) reachable as a superuser with no
password prompt — a `pgpass.conf` entry or `trust` in `pg_hba.conf`. Override
the target with the standard environment variables if your setup differs:

```
HISAB_TEST_DB=scratch PGUSER=postgres PGPORT=5432 bash supabase/tests/run-local.sh
```

On Windows, `psql.exe` is usually not on `PATH`; the script looks for it under
`C:\Program Files\PostgreSQL\{18,17,16}\bin` before giving up.

### Suggested `package.json` entry

Not added here to avoid colliding with other work in that file:

```json
"db:test": "bash supabase/tests/run-local.sh"
```

## Running it against a real database

`guarantees.sql` needs no harness on Supabase — the platform already provides
everything `local-harness.sql` stands in for. Run it directly, against a
branch or a staging project:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/guarantees.sql
```

It also pastes straight into the Supabase SQL editor.

## What `local-harness.sql` is

A compatibility shim, **not part of the schema**. The migrations are written
against Supabase and assume things the platform creates before any project
migration runs: the `auth` schema, `auth.users`, `auth.uid()`, `auth.jwt()`,
and the `anon` / `authenticated` / `service_role` roles. A stock PostgreSQL has
none of them, and migration `0002` fails on its first foreign key without them.

The harness supplies the minimum those files actually reference. It must never
be applied to a Supabase project and must never be turned into a migration. Its
`auth.uid()` reproduces Supabase's own claim resolution exactly —
`request.jwt.claim.sub`, falling back to the `sub` key of
`request.jwt.claims` — because `guarantees.sql` switches identity by setting
those GUCs, and every permission assertion in sections 9 to 11 depends on it
behaving identically to the real thing.

## Reading a failure

Every assertion prints `ok <what>` as a notice. A failure raises, which aborts
the script, so the last line before the error is the assertion just before the
one that broke. A run that reaches the end prints `ALL GUARANTEES HELD`.

Sections 6 to 47 each cover a specific migration, and each has been confirmed
to fail when that migration is absent, or when the one line of it that section
exists for is mutated away — they are not vacuous:

| Section | Covers | Guarantee |
| --- | --- | --- |
| 1–5 | 0002–0005 | double entry, system groups, nature inheritance, tenant scoping, lock date |
| 6, 7 | 0017 | inactive ledgers with a balance still reach the statements; a ledger holding a balance cannot be deactivated |
| 8 | 0018 | a voucher date change crossing a financial year is refused, on any start month |
| 9 | 0019 | undo rewinds `voucher_number_sequences` so numbers are reissued, not lost |
| 10 | 0020 | a revoked member cannot redeem a pending invite |
| 11 | 0020 | an accountant cannot delete a ledger carrying an opening balance |
| 12 | 0021 | an invoice posts as ordinary grouped double entry, tallies on the Trial Balance, and settles the paise once per line |
| 13 | 0021 | a purchase invoice posts the mirror image of a sales one |
| 14 | 0021 | a voucher with no invoice lines behaves exactly as before, including through the CSV importer's bulk path |
| 15 | 0021 | editing an invoice replaces its lines and its entries together, and a refused edit replaces neither |
| 16 | 0021 | backup and restore round-trip invoice lines, remapped, along with the company's own address |
| 17 | 0021 | undo rewinds invoice lines with their entries, both a creation and an edit |
| 18 | 0021 | an invoice line cannot reference another company's ledger |
| 19 | 0021 | the lock date governs invoice lines exactly as it governs `voucher_entries` |
| 20 | 0021 | a discount reduces the posting, not just the printed line |
| 21 | 0022 | an invoice stores the party it is made out to, on both sides of the books |
| 22 | 0022 | the party is required of a voucher with invoice lines, and of no other |
| 23 | 0022 | backup and restore carry the party, remapped to the restored ledger |
| 24 | 0022 | undoing an invoice edit puts the original party back |
| 25 | 0022 | a plain voucher cannot be turned into an invoice by an edit |
| 26 | 0022 | an invoice cannot be made out to another company's ledger |
| 27 | 0022 | an invoice's party cannot be removed by a bare `update` on the header |
| 28 | 0024 | the same supplier's bill number, entered again in the same year, is found — whatever its case or surrounding spaces — and finding it stops nothing |
| 29 | 0024 | and nothing else is: another supplier, another financial year, a blank or absent reference, another company, a sales voucher, a deleted one |
| 30 | 0025 | the outstanding list names every party carrying a balance, which way it points, how much, and when it was last posted to |
| 31 | 0025 | and nothing that is not money owed by a party: a settled account, an inactive one at nil, cash, sales, purchases, another company's debtor |
| 32 | 0026 | the P&L reports a nominal ledger with the sign it carries: income left in debit reduces income, expense left in credit reduces expense |
| 33 | 0026 | and the P&L's net profit is the Balance Sheet's Net Profit line, on the same date, with and without a reversal on the books |
| 34 | 0026 | the Balance Sheet's profit figure covers the same books its ledger lines do — a voucher predating the book beginning, an opening balance on a nominal ledger |
| 35 | 0026 | a bank overdraft in a group whose name contains "cash" is reported as bank |
| 36 | 0026 | and a real till is still cash, including in a renamed group, and the two tiles still sum to the Trial Balance |
| 37 | 0026 | the dashboard's change and movement figures count every ledger that had activity in the period, not only those holding a balance today |
| 38 | 0027 | a company that keeps no financial years numbers straight through the year end, and one that keeps them still resets |
| 39 | 0027 | the re-dating guard fires for a year-keeping book and not for a continuous one |
| 40 | 0027 | how a company numbers its books cannot change once a voucher exists, and can before |
| 41 | 0027 | backup and restore carry the choice, in both modes, and a file written before the column existed still restores |
| 42 | 0027 | a continuous book and a year-keeping one, side by side, do not touch each other |
| 43 | 0027 | the duplicate-bill warning and the undo's numbering rewind both follow the book they are in |
| 44 | 0027 | a voucher's financial year label is either the constant or a year, and the database says so |
| 45 | 0027 | a backup whose setting contradicts its own labels is refused, before it writes anything |
| 46 | 0027 | undoing every voucher does not unfreeze how a book is numbered |
| 47 | 0027 | and the refusal names the first number the book issued, not its earliest-dated voucher |

Sections 22 and 27 both cover 0022's party rule and are not duplicates: 22 is
the rule as `check_invoice_lines_match()` enforces it, on the `invoice_lines`
and `voucher_entries` writes, and its last case deliberately rewrites the
postings to trigger the catch. 27 is the same corruption with that second
statement taken away — the header edited on its own, which reaches neither
watched table — and is the section `trg_voucher_party_required` exists for.

`pg_temp.expect` treats a NULL condition as a failure, not a pass. Most of
these assertions compare a value the database is supposed to have stored, and
`v_party = v_debtor` is NULL — not false — when nothing was stored, so a
plain `not p_condition` would have reported `ok` for an assertion that never
held. Section 21 was written before migration 0022 and passed vacuously until
the helper was tightened.

`pg_temp.expect_error` is written the same way for the same reason:
`position(lower(p_expect) in lower(sqlerrm)) = 0` is NULL, not false, if
either operand is null, and a NULL condition would have skipped the raise and
printed `ok`. No call site can reach it today — every `p_expect` in this file
is a literal — but the guard fails closed regardless, because the direction of
that bug is a green test that checked nothing.

Sections 28 and 29 are the two halves of one guarantee and neither is
optional. `find_duplicate_bill` is a warning rather than a constraint, so the
only thing that makes it worth anything is that it is right in both
directions: 28 is everything it must find, and that finding it does not stop
the save; 29 is everything that merely looks like a duplicate and must not be
reported as one. A guard that cries wolf is dismissed on sight, and then it is
dismissed on the day it was right — so the false-positive half carries at
least as much weight as the true-positive one. Every case in 29 first asserts
that the near-miss voucher really is on the books, because a filter test
against a fixture that was never created passes for the wrong reason.

Section 29's last case is the only one that asks a question the application
cannot ask: a company id and a party ledger belonging to two different
companies. Migration 0022's composite foreign key makes that pair
unrepresentable in a voucher, so the arguments always agree in real use — but
the block runs as the table owner with RLS bypassed, so it is the function's
own `company_id` filter being tested rather than the policy behind it, and
removing that filter is a mutation nothing else in the suite catches.

Sections 30 and 31 are the same pairing one migration later, and 31 carries
the decision rather than the arithmetic. `get_outstanding_balances` reports a
party's side from the sign of its balance and not from the role of its group —
0012's lesson, in a new report — so a customer in credit is a payable and a
supplier holding our advance is a receivable. Reporting those by role instead
leaves both totals wrong while every individual row still looks plausible,
which is why the totals are asserted as well as the rows. Section 31 also
asserts that cash, sales and purchases hold balances before asserting that they
are absent from the list, for the same reason section 29 does: a filter test
against a fixture that was never created passes for the wrong reason.

Sections 32 to 37 cover 0026, and three of the six are there to stop a fix
from being an over-correction rather than to catch the defect. 32 asserts an
ordinary book *before* it asserts a reversed one, because "report the sign"
is satisfied by a function that negates everything and a fixture with only
awkward rows would not notice. 36 asserts that a genuine till — and a till in
a group a company renamed "Petty Cash" — is still counted as cash, because the
cheap way to stop reading "Cash Credit Accounts" as a drawer is to stop
reading anything as a drawer; it also pins the sum of the two tiles, which was
the one thing the old split got right and the thing any new split must not
break. 37 asserts that the two *balance* tiles are unchanged, which is what
makes removing 0017's filter a repair of four figures rather than a silent
change to six.

Sections 33 and 34 are one guarantee in two halves. 33 is the identity — the
P&L's net profit is the Balance Sheet's Net Profit line — asserted over the
arithmetic the page actually performs on those rows, not over the function's
output, because the defect it exists for was invisible row by row and only
appeared once the page added them up. 34 is the identity's preconditions: the
sheet can only balance if its profit figure is drawn from the same window and
the same balances as the ledger lines it balances against, and it was drawn
from neither. Both halves are needed. A suite with only 33 passes on books
that have no opening balances and no voucher predating the book beginning,
which is most books and not all of them.

Section 34 also states the true relationship between the two reports rather
than only the happy case: the P&L is period-scoped, so a window that starts
after an early voucher does not count it, and only a window reaching back past
everything on the books reproduces the Balance Sheet's life-to-date figure.
Asserting the equality without also asserting the inequality would have let a
P&L that quietly ignored its own `p_from_date` pass.

Sections 38 to 43 cover 0027, and the pairing 29 and 31 established runs
through them: every one of them asserts the *other* company as well. 38 pins a
year-keeping book still resetting each April, 39 pins the re-dating guard still
refusing, 40 pins a year-keeping book being equally frozen, and 42 exists only
to state that the two schemes do not reach into each other. The cheap way to
make a continuous book number straight through is to stop deriving years at
all, and a suite that only looked at the bahi-khata would pass on it.

Section 38 asserts the literal string `'continuous'` rather than deriving it
the way the code does. That value is written into `vouchers`, into the primary
key of `voucher_number_sequences`, and into every backup file such a company
has ever produced, so it can never change; a test that computed it would agree
with any value the code happened to hold, including a later change to one.

Section 40's last case is the one that is easy to leave out: an UPDATE that
restates the setting it already has must go through. `before update of` fires
whenever the column is named in a SET list, whether or not the value moves, and
`restore_company_backup` names every column — so a guard without that early
return refuses the overwrite path outright. That is the same reasoning section
7 gives for a whole-row rewrite of an already-inactive ledger.

Sections 44 to 47 close four findings from `audit-continuous-books.sql`, the
independent survey of 0027 that sits beside this file. That audit does not
stop on the first failure — it records every check and reports the list at the
end — and it is the regression asset for this feature, so it is run alongside
the guarantees:

```
psql -d "$HISAB_TEST_DB" -v ON_ERROR_STOP=1 -f supabase/tests/audit-continuous-books.sql
```

44 and 45 are two halves of one hole and neither is optional, for the reason
28 and 29 give about the duplicate-bill guard. 44 is a constraint on one
column: a label is the constant or a year, and nothing else. 45 is a
comparison between two columns in two tables: the company's setting and the
labels its own vouchers carry, which are two statements about the same thing
that a backup file used to be able to make differently. A constraint cannot
catch that — both values are individually well-formed and only the
combination is wrong — and a comparison inside one function is not a
constraint. The state they exist to prevent is one book holding SAL/00001 and
SAL/2026-27/00001 at once, which the uniqueness key permits because it
protects the *(label, number)* pair rather than the printed number.

45 also asserts the two files that must keep restoring: the honest one, in
both modes, and one written before the column existed. Section 41's
pre-column case was rebuilt on a year-keeping company's export for the same
reason — a backup taken before 0027 could only have come from a company that
kept financial years, so the old fixture, which stripped the key from a
continuous book's file, was asserting behaviour on a file that cannot exist
and that 45 now refuses.

46 and 47 are both about the freeze in section 40 telling the truth. 46 is the
door it had: the guard counted surviving vouchers and the undo hard-deletes
them, so a whole book could be undone and the setting then flipped, although
numbers had been issued. `voucher_number_sequences` is rewound rather than
deleted, so the evidence is still there to count. 47 is the refusal's own
accuracy — it named the earliest-dated voucher rather than the first number
issued, which in a continuous book, where nothing keeps entry order and date
order together, is usually a different one.

Section 19 is the one place the suite exercises RLS for real rather than
evaluating a policy predicate by hand: it becomes the `authenticated` role for
two blocks, having first granted that role the table privileges Supabase's
platform setup supplies and the local harness does not. The grants go the way
of everything else at the closing `rollback`.
