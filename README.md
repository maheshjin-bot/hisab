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

Apply the nine files in `supabase/migrations/` in filename order. They are not
idempotent and each depends on the last, so order matters.

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
| `auditor` | Read-only across the whole company |

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

Every group carries a `ledger_role` (`cash_bank`, `debtor`, `creditor`,
`expense`, `income`, `fixed_asset`, `capital`, `loan`, `other`). This is not
decoration — it drives which ledgers appear in each voucher type's comboboxes.
A new sub-group left on the default `other` will not show up in a Payment
voucher's cash leg.

## Vouchers and reports

Six voucher types: `receipt`, `payment`, `contra`, `journal`, `sales`,
`purchase`. Each gets its own numbering sequence per company per financial
year, with a type prefix.

Five reports, each backed by a `security invoker` SQL function: Daybook, Ledger
Statement, Trial Balance, Profit & Loss, Balance Sheet.

Financial years default to starting in April but are configurable per company
via `financial_year_start_month`.

## Project layout

```
app/(auth)/            Login and signup
app/(app)/             Authenticated shell
  companies/           Company picker and creation
  [companyId]/         Everything scoped to one company
    dashboard/  ledgers/  vouchers/  reports/  settings/
components/            UI, grouped by feature
hooks/                 TanStack Query hooks — one per resource
lib/supabase/queries/  All database access
supabase/migrations/   Schema, in order
```

## Scripts

```bash
npm run dev      # development server
npm run build    # production build
npm run lint     # eslint
npx tsc --noEmit # typecheck
```

## A note on Next.js

This project is on Next.js 16, which differs from earlier versions in ways that
matter. `AGENTS.md` points at the version-specific documentation vendored in
`node_modules/next/dist/docs/` — read it there rather than relying on general
knowledge of the App Router.
