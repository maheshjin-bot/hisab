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

Sections 6 to 20 each cover a specific migration, and each has been confirmed
to fail when that migration is absent — they are not vacuous:

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

Section 19 is the one place the suite exercises RLS for real rather than
evaluating a policy predicate by hand: it becomes the `authenticated` role for
two blocks, having first granted that role the table privileges Supabase's
platform setup supplies and the local harness does not. The grants go the way
of everything else at the closing `rollback`.
