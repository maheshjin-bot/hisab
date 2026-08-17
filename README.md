# HISAB

A double-entry accounting application for Indian small businesses. Next.js 16
App Router on the front, Supabase (Postgres + Auth + RLS) on the back.

The accounting rules live in the database, not the client: a deferred constraint
trigger rejects any voucher whose debits and credits don't tally, row-level
security scopes every read and write to a company you're a member of, and the
five financial reports are SQL functions rather than client-side aggregation.

## Requirements

- Node.js 20 or newer
- A Supabase project dedicated to HISAB — do not point it at a project shared
  with another app; the migrations create an `app_private` schema and seed data
  into every new company.

## Setup

**1. Install dependencies**

```bash
npm install
```

**2. Create a Supabase project and apply the migrations**

Apply the eleven files in `supabase/migrations/` in filename order. They are
not idempotent and each depends on the last, so order matters.

Using the Supabase CLI against a linked project:

```bash
supabase db push
```

Or paste each file into the SQL editor in the dashboard, oldest first:

| Migration | What it establishes |
| --- | --- |
| `0001_extensions_and_helpers` | Extensions, the `app_private` helper schema |
| `0002_companies_members_invites` | Companies, membership, invites, last-admin guard |
| `0003_chart_of_accounts_and_ledgers` | Account groups, ledgers, the seeded chart of accounts |
| `0004_voucher_engine` | Vouchers, entries, numbering sequences, the balance trigger |
| `0005_rls_policies` | Row-level security across every table |
| `0006_reporting_functions` | The five reporting functions |
| `0007_import_staging_and_audit` | Import batches and the audit log |
| `0008_advisor_fixes` | Fixes flagged by the Supabase advisors |
| `0009_grant_app_private_to_authenticated` | Execute grants on the helper schema |
| `0010_dashboard_summary` | `get_dashboard_summary()` — the dashboard in one query |
| `0011_bulk_vouchers` | `create_vouchers_bulk()` — server-side CSV voucher import |

**3. Configure environment variables**

Copy `.env.example` to `.env.local` and fill in both values from the project's
API settings:

```bash
cp .env.example .env.local
```

| Variable | Where to find it |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Project Settings → API → Publishable key |

Both are public by design — every privileged operation is gated by RLS, not by
key secrecy. `.env.local` is gitignored; keep it that way.

**4. Run**

```bash
npm run dev
```

Open http://localhost:3000, sign up, and create your first company. Creating a
company seeds its chart of accounts automatically — there is no separate setup
step.

## Roles

Every membership carries one of three roles, enforced in RLS policies rather
than in the UI.

| Role | Can do |
| --- | --- |
| `admin` | Everything: company settings, the lock date, members and invites, opening balances, account group changes |
| `accountant` | Create and edit ledgers and vouchers, run and export every report. Cannot change opening balances, manage members, or post into a locked period |
| `auditor` | Read-only across the whole company, plus the change history at `/audit` — which admins can also see and accountants cannot |

A company can never be left without an active admin — a trigger raises
`Cannot remove the last active admin of a company` rather than allowing it.

## The seeded chart of accounts

Each new company gets eighteen account groups. The eight top-level groups are
system groups: they cannot be deleted, renamed into a different nature, or
reclassified.

**System groups (8)** — Capital Account, Current Assets, Current Liabilities,
Fixed Assets, Direct Expenses, Direct Incomes, Indirect Expenses, Indirect
Incomes.

**Seeded sub-groups (10)** — under Current Assets: Bank Accounts, Cash-in-Hand,
Sundry Debtors, Loans & Advances. Under Current Liabilities: Sundry Creditors,
Provisions, Outstanding Expenses. Under Fixed Assets: Plant & Machinery, Office
Equipment, Furniture.

The chart is not fixed. Account Groups (`/[companyId]/groups`) adds, renames
and re-parents sub-groups; the eight system groups can be renamed but never
moved or deleted, matching what the triggers enforce. A group's classification
always follows its parent, so it is inherited rather than chosen.

Every group carries a `ledger_role` (`cash_bank`, `debtor`, `creditor`,
`expense`, `income`, `fixed_asset`, `capital`, `loan`, `other`). This is not
decoration — it drives which ledgers appear in each voucher type's comboboxes.
A new sub-group left on the default `other` will not show up in a Payment
voucher's cash leg, which is the single most common surprise when extending
the chart.

## Vouchers and reports

Six voucher types: `receipt`, `payment`, `contra`, `journal`, `sales`,
`purchase`. Each gets its own numbering sequence per company per financial
year, with a type prefix.

Five reports, each backed by a `security invoker` SQL function: Daybook, Ledger
Statement, Trial Balance, Profit & Loss, Balance Sheet.

Financial years default to starting in April but are configurable per company
via `financial_year_start_month`, and the report date presets follow it.

Every report prints: `@media print` rules drop the app chrome and add a
statement header with the company, period and currency, so a Balance Sheet
comes out as a document rather than a screenshot. Page numbers come from the
browser's own print footer — Chrome and Edge don't implement the `@page`
margin boxes that would let the document supply them.

## Backup and restore

Settings → **Backup & restore** downloads the whole company as one JSON file —
chart of accounts, every ledger, every voucher and line, and the numbering
sequences so a restored book keeps its voucher numbers. Anyone in the company
can take one; restoring is admin-only.

It's an ordinary file, so "cloud backup" is wherever you already keep
documents — a synced Drive/Dropbox folder, or an attachment. There is no
built-in cloud integration yet.

Restoring asks which you want:

- **As a new company** — leaves your existing books untouched, so you can
  compare the two. This is the safe default.
- **Replace this company** — deletes its ledgers and vouchers and puts the
  backup in their place. Gated behind typing the company name, because there
  is no undo. Members and invites are kept either way.

The restore runs as a single database transaction: a backup that turns out to
be inconsistent — an unbalanced voucher, a ledger whose group is missing —
fails and leaves nothing behind, rather than importing half a set of books.

Membership, invites and the audit log are deliberately **not** in the file.
They reference users and history that mean nothing outside the project that
produced them, and a backup shouldn't be a way to move accounts between
companies.

## Change history

Every change to vouchers, voucher lines, ledgers, account groups, members and
company settings is recorded with full before/after snapshots by a database
trigger, and shown at `/[companyId]/audit` for admins and auditors.

One thing worth knowing when reading it: each created voucher is followed by
an update that touches only `total_amount`. That is `check_voucher_balance()`
writing the derived total, not a person editing. Those entries are shown —
hiding rows from an audit log defeats the purpose — but labelled
"Recalculated" so they don't read as edits.

### Undoing recent changes

Admins get an **Undo recent changes** panel on that page: pick *last hour*,
*24 hours*, *3 days*, *7 days*, or a date, see exactly what would be rolled
back ("6 ledgers created, 12 voucher lines created…"), and confirm by typing
`UNDO`.

It rewinds vouchers, voucher lines, ledgers and account groups. Members and
company settings are deliberately left alone — silently reinstating a removed
member or reopening a locked period is a different decision with different
consequences.

Two properties worth relying on:

- **It's a tail, not a window.** You can undo *since* a point, never *between*
  two dates. Undoing a slice from the middle of a history is incoherent: a
  voucher created inside the window and edited after it would have its
  creation undone while the edit survives.
- **It's idempotent.** Running the same undo twice leaves the same result —
  the second run re-asserts the old values rather than unwinding the first.
  Entries written by an undo are flagged and skipped by later ones.

The whole undo is one transaction ending in `set constraints all immediate`,
so an undo that would leave a voucher unbalanced fails and rolls back rather
than corrupting the books. There is no one-click redo, so take a backup first
if you're unsure.


## Project layout

```
app/(auth)/            Login and signup
app/(app)/             Authenticated shell
  companies/           Company picker and creation
  invite/[token]/      Redeems an invite link
  [companyId]/         Everything scoped to one company
    dashboard/  ledgers/  groups/  vouchers/
    reports/  audit/  settings/
components/            UI, grouped by feature
hooks/                 TanStack Query hooks — one per resource
lib/supabase/queries/  All database access
supabase/migrations/   Schema, in order
supabase/tests/        What the database guarantees, as a SQL script
tests/                 Vitest unit tests
e2e/                   Playwright end-to-end flow
```

## Scripts

```bash
npm run dev        # development server
npm run build      # production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # vitest, unit tests
npm run test:e2e   # playwright, end-to-end (see below)
```

## Demo data

`supabase/seeds/demo_company.sql` builds a company that exercises the whole
app in one place — a three-level group tree, a group left on `ledger_role`
`other`, a deactivated ledger, one voucher of each of the six types across two
months, and a lock date. It is on a **July** financial year on purpose: an
April one hides the most common class of date bug, because April is also the
default.

Opening balances are chosen to balance, so the Trial Balance tallies from the
first screen. It assigns the company to an existing auth user and does not
create accounts.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/demo_company.sql
```

## Tests

Three layers, covering three different kinds of mistake.

**Unit** (`npm test`) — the arithmetic and parsing that must never be wrong:
paise sums, the per-type voucher schema, CSV three-stage validation,
financial-year boundaries, and the account-group tree. No DOM, so the suite
runs in well under a second and is safe to run on every save.

**Database** (`supabase/tests/guarantees.sql`) — the promises that hold no
matter what the client does: a voucher cannot be unbalanced or single-line,
system account groups cannot be deleted or reclassified, a sub-group inherits
its parent's nature, cycles are refused, and nothing can reference another
company's rows. It builds its own fixtures and rolls back, so it is safe to
run against a database with real data in it.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/guarantees.sql
```

**End to end** (`npm run test:e2e`) — sign up, create a company, add ledgers,
post one voucher of each type, and confirm the Trial Balance tallies. It runs
against a production build, not `next dev`.

It needs an account it can sign in with. If your Supabase project has strict
email validation enabled, sign-up from a test will always be rejected — the
validator checks deliverability, and every address a test can safely invent
(a `.test` TLD, `example.com`) has no MX record. Create one confirmed account
and point the suite at it:

```bash
E2E_EMAIL=you@example.org E2E_PASSWORD=... npm run test:e2e
```

Without that, the spec skips itself with the reason rather than failing, so
CI stays honest on a checkout that isn't configured for it.

## Continuous integration

`.github/workflows/ci.yml` runs route typegen, typecheck, lint, the unit
tests and a production build on every push. Set
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as
repository *variables* (Settings → Secrets and variables → Actions) — the
build reads them at module scope, and falls back to placeholders that compile
but point nowhere.

The typegen step is not optional: Next generates route types rather than
committing them, so `PageProps<"...">` will not resolve without it.

## A note on Next.js

This project is on Next.js 16, which differs from earlier versions in ways that
matter. `AGENTS.md` points at the version-specific documentation vendored in
`node_modules/next/dist/docs/` — read it there rather than relying on general
knowledge of the App Router.
