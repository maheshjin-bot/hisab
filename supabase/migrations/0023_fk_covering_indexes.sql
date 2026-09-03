-- Second pass of the work 0008 did: covering indexes for the foreign keys the
-- performance advisor flagged, this time for everything added since.
--
-- An unindexed foreign key costs nothing until the parent row is touched. Then
-- Postgres has to prove no child references it — `select 1 from child where
-- fk_cols = (...) for key share` — and with no usable index that is a
-- sequential scan of the child table, taken while holding a lock on the parent.
-- Deleting one bank ledger would read every statement line in the company; the
-- undo path in 0014 hard-deletes vouchers one at a time, and each of those
-- deletes has to clear bank_statement_lines.matched_voucher_id and
-- .posted_voucher_id.
--
-- WHAT COUNTS AS COVERAGE. The FK's own columns, in the FK's own order, as the
-- leading columns of a plain non-partial index. Two near misses do not count:
--
--   * an index over the same columns in a different order. Postgres will in
--     fact use one for the equality probe above, since every FK column is
--     compared with `=` and a btree does not care about the order of equality
--     keys. It is the advisor's rule that is strict here, not the planner's,
--     and three of the indexes below buy a clean advisor report and
--     independence from that accident rather than a new plan. Said plainly
--     because a future reader comparing this file against `explain` deserves to
--     know which is which.
--
--   * a partial index. `where party_ledger_id is not null` happens to be
--     provable against `party_ledger_id = $1`, but `where status = 'pending'`
--     (company_invites) is not provable against anything, and an index that
--     covers a foreign key only for some of the rows referencing it is not
--     cover. None of these are relied on.
--
-- The list was produced by asking the local database directly rather than by
-- reading the migrations, which is how the thirteenth entry turned up:
--
--   select c.conrelid::regclass, c.conname
--   from pg_constraint c
--   where c.contype = 'f' and c.connamespace = 'public'::regnamespace
--     and not exists (
--       select 1 from pg_index i
--       where i.indrelid = c.conrelid and i.indpred is null
--         and (i.indkey::smallint[])[0:cardinality(c.conkey)-1] = c.conkey
--     );
--
-- It returns nothing once this migration is applied. It is worth re-running
-- after any migration that adds a table or a reference.

-- ------------------------------------------------- 1. the party of a voucher

-- 0022 created
--
--   vouchers_company_party_idx on vouchers(company_id, party_ledger_id)
--     where party_ledger_id is not null
--
-- for "every invoice for this customer", and it is the one genuine mistake in
-- the set: right columns, wrong order for the foreign key, and partial on top.
--
-- REPLACED RATHER THAN JOINED. The two candidate indexes answer two questions:
--
--   the foreign key      party_ledger_id = $1 and company_id = $2
--   the customer's ledger  company_id = $1 and party_ledger_id = $2
--
-- which are the same question with the terms swapped. Both are equality on
-- both columns, so a btree on (party_ledger_id, company_id) descends to the
-- matching entries for either in the same number of page reads: the order of
-- equality keys changes nothing, and neither query has a range or a sort for
-- the order to matter to. There is no read the partial index serves better.
--
-- What it does have is a size advantage — it holds no entry for a payment, a
-- receipt, a journal, a contra or any of the 57 legacy vouchers, which is most
-- of the table — and keeping both would mean the full index's cost plus the
-- partial one's on every invoice written, to buy a plan that is already
-- available. So the small one goes and the correct one stands alone. If the
-- vouchers table ever grows to where the null rows in this index are a real
-- cost, the answer is a second *partial* index with more columns in it for
-- whatever query needs them, not this one back.
--
-- The duplicate-bill guard of 0024 is not an argument for keeping it either:
-- that index leads with (company_id, party_ledger_id) but is partial on the
-- reference number, so it covers neither this foreign key nor the full
-- customer-invoice list.
drop index if exists public.vouchers_company_party_idx;

create index vouchers_party_company_idx
  on public.vouchers(party_ledger_id, company_id);

-- ------------------------------------------------------ 2. the bank tables

-- 0016 was written before it could be advisor-checked — it had never been
-- applied anywhere — so every foreign key it introduced arrived uncovered
-- except where an index built for a query happened to sit over the right
-- columns. These are the eleven.

-- bank_statement_profiles. The composite is a different order from the
-- `unique (company_id, bank_ledger_id)` that enforces one layout per account;
-- created_by has nothing over it at all.
create index bank_statement_profiles_ledger_company_idx
  on public.bank_statement_profiles(bank_ledger_id, company_id);
create index bank_statement_profiles_created_by_idx
  on public.bank_statement_profiles(created_by);

-- bank_statement_imports. Same shape: the composite is the reverse of the
-- leading pair of bank_statement_imports_company_ledger_idx.
create index bank_statement_imports_ledger_company_idx
  on public.bank_statement_imports(bank_ledger_id, company_id);
create index bank_statement_imports_created_by_idx
  on public.bank_statement_imports(created_by);

-- bank_statement_lines, the table where this actually costs something: one
-- statement is hundreds of rows and a company accumulates every statement it
-- has ever uploaded.
create index bank_statement_lines_ledger_company_idx
  on public.bank_statement_lines(bank_ledger_id, company_id);

-- The import reference is the one place a duplicate would have been added
-- rather than a gap filled. bank_statement_lines_import_idx is on (import_id)
-- alone — the leading column of the foreign key but not all of it — and a
-- second index on (import_id, company_id) would contain it entirely. So the
-- narrower one is dropped and the covering one takes its place: same number of
-- indexes to maintain on the busiest table here, and every read that used the
-- old one still has its prefix.
drop index if exists public.bank_statement_lines_import_idx;

create index bank_statement_lines_import_company_idx
  on public.bank_statement_lines(import_id, company_id);

-- The two voucher references are the ones with a live cost today, and neither
-- is cosmetic.
--
-- Both are `on delete set null`, so every voucher deletion probes this table
-- by voucher id. 0014's undo hard-deletes the vouchers it is rewinding, one
-- row at a time. The existing matched-voucher index is
-- (company_id, matched_voucher_id) and partial, so it leads with the wrong
-- column and the probe cannot use it; posted_voucher_id has no index at all.
--
-- get_bank_match_candidates() gains from them too. Its anti-join —
-- `not exists (select 1 from bank_statement_lines l where l.matched_voucher_id
-- = v.id or l.posted_voucher_id = v.id)` — has been a sequential scan per
-- candidate voucher; with an index on each side the planner can reach it with
-- a BitmapOr instead.
--
-- Non-partial, though most rows have both columns null. `where
-- matched_voucher_id is not null` would in fact be usable for the probe, but
-- it would leave the advisor reporting the same finding forever, and the
-- reason to accept a warning has to be better than saving a few pages on a
-- table that is already indexed four other ways.
create index bank_statement_lines_matched_voucher_fk_idx
  on public.bank_statement_lines(matched_voucher_id);
create index bank_statement_lines_posted_voucher_fk_idx
  on public.bank_statement_lines(posted_voucher_id);

-- bank_narration_rules. Both composites and created_by. The two unique indexes
-- over bank_ledger_id are partial by design (a rule scoped to one account and
-- a rule that applies to all of them are the two halves of a nullable column),
-- so neither can serve as cover; contra_ledger_id has nothing over it.
create index bank_narration_rules_bank_ledger_company_idx
  on public.bank_narration_rules(bank_ledger_id, company_id);
create index bank_narration_rules_contra_ledger_company_idx
  on public.bank_narration_rules(contra_ledger_id, company_id);
create index bank_narration_rules_created_by_idx
  on public.bank_narration_rules(created_by);

-- --------------------------------------------------- 3. one the list missed

-- company_invites.company_id, from 0002, has never been covered and was not on
-- the advisor report this migration was written from. The only index over the
-- column is
--
--   company_invites_pending_unique_idx on (company_id, lower(email))
--     where status = 'pending'
--
-- which is partial, and partial on a column the foreign key says nothing
-- about: it holds no entry for an invite that was accepted, revoked or
-- expired, which is every invite that has stopped being interesting and so
-- most of the table over time. Deleting a company therefore scans them.
--
-- Included here because it is the same defect from the same cause and the fix
-- is one line, not because the advisor asked for it. It is the reason the
-- pg_constraint query at the top of this file is worth re-running by hand: an
-- advisor pass only reports what it was pointed at, and this one had been sat
-- in the schema since 0002.
create index company_invites_company_idx
  on public.company_invites(company_id);
