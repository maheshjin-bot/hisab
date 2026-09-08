-- BOOKS THAT ARE NEVER CLOSED
--
-- A small trader who does no taxation keeps a bahi-khata: one unbroken set of
-- books and one running bill series. He does not close a year, nobody files a
-- return for him, and nothing about April means anything to him. HISAB forced
-- a financial year on every company regardless — the numbering reset each
-- April and every sale read SAL/2025-26/00001, a year he does not keep and a
-- segment he did not ask for.
--
-- This file adds the choice, made once, when the company is created:
--
--   years on  (the default, and every company that exists today)
--             SAL/2025-26/00001, restarting each financial year
--   years off SAL/00001, SAL/00002, … one series for the life of the books
--
-- ---------------------------------------------------------------- THE SHAPE
--
-- The obvious implementation — make vouchers.financial_year_label nullable and
-- teach everything downstream to cope — would touch the primary key of
-- voucher_number_sequences, the unique index on vouchers, and every query in
-- the schema that groups by that column. NULL is not equal to NULL, so the
-- sequences' primary key would stop constraining anything at all and one
-- company could open an unbounded number of "null year" series, each free to
-- mint the same number again.
--
-- So the column keeps its NOT NULL and its shape, and only the *value*
-- changes: with years off, the label is a single constant for the whole life
-- of the books. Every key, index and grouping in the schema keeps working
-- untouched, and "one series per company per voucher type per label" turns
-- into "one series per company per voucher type" for free, because there is
-- only ever one label. The display number is the one thing that is built
-- rather than stored, and it is the one thing that changes.
--
-- ------------------------------------------------------------- THE CONSTANT
--
-- The value is the literal 'continuous', and it deserves its paragraph,
-- because it goes into the books, into the primary key of the sequences, and
-- into every backup file ever written from such a company. It cannot be
-- changed later without rewriting all three.
--
-- What it must be:
--
--   * Not year-shaped. Every value this column holds in any book a person
--     actually keeps matches ^\d{4}-\d{2}$, and anyone reading the table, a
--     backup or a support export has to be able to tell at a glance that this
--     row is not a mis-derived year. '0000-00' and '9999-99' both fail that
--     outright.
--
--     "In any book a person actually keeps" rather than "ever", because the
--     stronger claim is not true and the difference is worth a sentence. 0004
--     builds the label by concatenating the start year, not by padding it, so
--     a voucher dated before the year 1000 derives a three-digit segment:
--     0999-06-15 gives '999-00' and 0001-01-01 gives '0-01'. Nothing
--     reachable produces those — book_beginning_date would have to be in the
--     first millennium — and the thing this section actually depends on holds
--     regardless: none of them equals the constant, so no derived label can
--     ever collide with it in the key. The check constraint below is written
--     to the four-digit shape, which is very slightly stronger than the
--     derivation, and section 44 of supabase/tests/guarantees.sql says so
--     where it can be seen.
--   * Not an absence. '' and '-' and 'none' all read as "the label failed to
--     compute", which is exactly the bug the constant must not be mistaken
--     for; an empty string is indistinguishable from a NULL that got
--     coalesced somewhere on the way in.
--   * A word that says what it is to somebody who has never read this file.
--     'all' is short but says nothing about numbering; 'continuous' names the
--     thing the user chose — one continuous set of books.
--
-- It is written in one place, app_private.continuous_year_label(), so the
-- issuer, the display shape and the guard can never disagree about it.

-- ---------------------------------------------------------------- 1. the column

-- Default true: every company that exists on the day this migration runs
-- keeps today's behaviour exactly, and so does every company created by a
-- client that has not been updated to ask the question.
alter table public.companies
  add column if not exists uses_financial_years boolean not null default true;

comment on column public.companies.uses_financial_years is
  'True (the default) when this company closes its books each financial year and voucher numbering restarts: SAL/2025-26/00001. False when it keeps one continuous set of books and one series that never restarts: SAL/00001. Fixed once the first voucher is entered — see trg_guard_financial_year_mode.';

-- ------------------------------ 2. the constant, and the shape it pins down

-- The whole of the decision above, in one place. immutable and parallel safe:
-- it is a literal, and both let the planner fold it away wherever it appears
-- beside a column.
create or replace function app_private.continuous_year_label()
returns text
language sql
immutable parallel safe
set search_path = ''
as $$
  select 'continuous'::text;
$$;

comment on function app_private.continuous_year_label() is
  'The value written into financial_year_label by a company that keeps no financial years. Permanent: it is stored in vouchers, in the primary key of voucher_number_sequences, and in every backup file such a company has ever produced.';

-- 0009 grants execute on app_private to authenticated and sets a default
-- privilege for future functions, and this one is only ever reached from
-- inside security-definer functions, where privileges are the definer's. The
-- grant is restated anyway for the reason 0018 restated its own: the shape of
-- the bug 0009 exists for is a function that is only reached through an
-- invoker call path, and a default privilege recorded per granting role is not
-- something to reason about at three in the morning.
grant execute on function app_private.continuous_year_label() to authenticated;

-- THE SHAPE, WHERE THE DATABASE CAN ENFORCE IT.
--
-- Everything above is a property of one function: everything that mints a
-- number asks financial_year_label() for the label, so everything that mints
-- a number gets either the constant or a year. Nothing said that about the
-- *column*, and the column is written directly — by restore_company_backup()
-- out of a client-supplied file, by 0019's undo replaying an audit row, and
-- by anything else that ever inserts a voucher.
--
-- It matters because of the pair rather than the value. The uniqueness key is
-- (company_id, voucher_type, financial_year_label, voucher_number), so a
-- third kind of label is a third numbering series and SAL/00001 can appear
-- twice in one book without the key noticing. A malformed label is therefore
-- not a cosmetic problem, and this is where it stops being possible.
--
-- The constant is asked for rather than repeated. continuous_year_label() is
-- immutable, which is what lets it appear in a CHECK at all, so the one-place
-- rule the paragraphs above spend their time on survives into the constraint
-- instead of acquiring a second copy here. Two consequences are worth naming
-- rather than discovering: the constraint carries a dependency on the
-- function, and a later `create or replace` that changed its return value
-- would not revalidate rows already stored. Both are acceptable for a value
-- this file has just explained can never change. What it does *not* cost is a
-- privilege: a stored constraint expression is not re-checked against the
-- inserting role's ACLs, so a role with no USAGE on app_private — service_role
-- and anon both — inserts and is refused by the shape rather than by a
-- permission error. Verified rather than assumed, because the failure mode is
-- a write path that stops working for a reason nobody would look for here.
--
-- ^\d{4}-\d{2}$ is slightly stronger than 0004's derivation, per the note in
-- THE CONSTANT above: a voucher dated in the first millennium would derive
-- '999-00' and is refused here. That is a decision, not an oversight. A
-- three-digit segment reads as a mis-derived year, which is the one thing the
-- constant was chosen to be distinguishable from, and no set of books anyone
-- keeps opens before the year 1000.
--
-- Added as valid rather than NOT VALID: every row in a fully seeded database
-- satisfies it today, and a constraint that never looked at what is already
-- stored would not have been able to say so.
do $constraint$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.vouchers'::regclass
       and conname = 'vouchers_financial_year_label_shape'
  ) then
    alter table public.vouchers
      add constraint vouchers_financial_year_label_shape
      check (financial_year_label = app_private.continuous_year_label()
             or financial_year_label ~ '^\d{4}-\d{2}$');
  end if;
end
$constraint$;

-- ------------------------------------------------------------ 3. the label

-- 0018's financial_year_label(), with the company's choice consulted before
-- the arithmetic. 0018 lifted this out of next_voucher_number() precisely so
-- there would be exactly one copy of the year rule that the issuer and the
-- re-dating guard both read; that is what makes this a three-line change here
-- and no change at all in the guard.
--
-- The order of the two early returns is deliberate and both are inherited:
--
--   * the company is looked up before anything else, so a missing company
--     still raises 'Company not found' exactly where 0004 raised it, whatever
--     the date is.
--   * the choice is consulted before the date is examined, because for a
--     continuous book the label genuinely does not depend on the date — that
--     is the whole point of it. A null date therefore comes back 'continuous'
--     rather than null, and falls through to the NOT NULL on
--     vouchers.voucher_date, which is the clearer complaint 0018 said it
--     wanted in the first place ("Deriving a year from NULL would only turn a
--     clear constraint violation into a confusing one"). For a year-keeping
--     company a null date still returns null, unchanged.
create or replace function app_private.financial_year_label(
  p_company_id uuid, p_date date
) returns text
language plpgsql
security definer set search_path = ''
stable
as $$
declare
  v_uses_years boolean;
  v_fy_start_month smallint;
  v_start_year int;
begin
  select uses_financial_years, financial_year_start_month
    into v_uses_years, v_fy_start_month
    from public.companies where id = p_company_id;
  if v_fy_start_month is null then
    raise exception 'Company not found';
  end if;

  -- One unbroken set of books has one label, forever.
  if not v_uses_years then
    return app_private.continuous_year_label();
  end if;

  if p_date is null then
    return null;
  end if;

  -- A date in a month before the company's start month belongs to the year
  -- that began the previous January-to-December year. April is the default
  -- and the common Indian case, but nothing here assumes it.
  v_start_year := case when extract(month from p_date)::int >= v_fy_start_month
                       then extract(year from p_date)::int
                       else extract(year from p_date)::int - 1 end;

  return v_start_year || '-' || lpad(((v_start_year + 1) % 100)::text, 2, '0');
end;
$$;

-- ------------------------------------------------------------ 4. the number

-- 0018's next_voucher_number(), with the display string built rather than
-- concatenated inline. Everything that decides *which* number is issued — the
-- prefix mapping, and the upsert on voucher_number_sequences that is the
-- actual issuer — is byte-for-byte what it was; the label is still whatever
-- financial_year_label() says and is still returned and stored verbatim.
--
-- The year segment is dropped by asking the constant, not by asking the
-- company a second time. Two reads of the same row could disagree under a
-- concurrent update; the label in hand cannot disagree with itself, so the
-- stored label and the printed number are guaranteed to describe the same
-- scheme. There is no collision to worry about: financial_year_label() only
-- ever returns ^\d{4}-\d{2}$ or the constant, and the constant is not
-- year-shaped by construction.
create or replace function app_private.next_voucher_number(
  p_company_id uuid, p_voucher_type text, p_voucher_date date
) returns table(display_number text, seq_number integer, fy_label text)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_fy_label text;
  v_prefix text;
  v_padding smallint;
  v_number int;
  v_display text;
begin
  v_fy_label := app_private.financial_year_label(p_company_id, p_voucher_date);

  v_prefix := case p_voucher_type
    when 'receipt' then 'REC'
    when 'payment' then 'PAY'
    when 'contra' then 'CON'
    when 'journal' then 'JRN'
    when 'sales' then 'SAL'
    when 'purchase' then 'PUR'
    else upper(left(p_voucher_type, 3))
  end;

  insert into public.voucher_number_sequences (company_id, voucher_type, financial_year_label, prefix, next_number)
  values (p_company_id, p_voucher_type, v_fy_label, v_prefix, 2)
  on conflict (company_id, voucher_type, financial_year_label)
  do update set next_number = voucher_number_sequences.next_number + 1
  returning (next_number - 1), padding into v_number, v_padding;

  v_display := v_prefix || '/'
    || case when v_fy_label = app_private.continuous_year_label() then '' else v_fy_label || '/' end
    || lpad(v_number::text, v_padding, '0');

  return query select v_display, v_number, v_fy_label;
end;
$$;

-- ----------------------------------------------- 5. the re-dating guard

-- Nothing to do, and that is worth stating rather than leaving to be noticed.
--
-- 0018 refuses a voucher date change that crosses a financial year, because
-- the number was minted from the year the voucher had at the time and would
-- then claim a series it is not in. Its whole test is:
--
--   v_new_year := app_private.financial_year_label(v_company_id, p_voucher_date);
--   if v_new_year is distinct from v_stored_year then ... raise ...
--
-- For a continuous book both sides are the constant on every date there is, so
-- the comparison is false and the refusal never fires — which is exactly
-- right: there is no boundary to cross and no year in the number to be made
-- wrong by crossing it. For a year-keeping company nothing about that call has
-- changed. Section 39 of supabase/tests/guarantees.sql asserts both halves,
-- because the cheap way to stop the guard firing for one is to stop it firing
-- at all.
--
-- This is the payoff for 0018 having lifted the year derivation into a
-- function of its own instead of leaving a second copy in the guard. Had there
-- been two copies, this file would have had to change both and could have
-- changed one.

-- ------------------------------------------------------- 6. the choice is fixed

-- Once a voucher exists the choice cannot change, and the database is where
-- that is said, not the dialog that stops offering it.
--
-- WHY IT CANNOT CHANGE. Flipping it leaves two numbering schemes in one book:
-- SAL/2025-26/00001 and SAL/00001 side by side, minted from two different keys
-- in voucher_number_sequences, with nothing to say which series a third
-- voucher belongs to. The alternative — retro-fitting every existing number to
-- the new scheme — means rewriting the values that
-- (company_id, voucher_type, financial_year_label, voucher_number) is unique
-- over, and two years of SAL/…/00001 collapsing onto one SAL/00001 is a
-- collision inside that key. Neither is a thing a settings page may do, and
-- the numbers may be on paper besides. That is 0018's decision about a
-- voucher's date, one level up.
--
-- WHY IT CAN CHANGE BEFORE. Nothing has been minted yet, so there is nothing
-- to be made inconsistent. Someone who picks wrong in the New Company dialog,
-- then spends an hour keying a chart of accounts and their customers, must be
-- able to say so — a ledger is not a voucher and holds no number.
--
-- This is deliberately the rule book_beginning_date already follows in
-- practice: set once at creation, never offered again anywhere in the app. It
-- is the opposite of the mistake recorded as audit finding F-17, where
-- financial_year_start_month can still be changed after posting and silently
-- re-bases every year after it — every voucher keeps the label it was minted
-- with while the boundary that produced it moves underneath. F-17 is not
-- fixed here and is not this file's to fix; the point is that this column does
-- not join it.
create or replace function app_private.guard_financial_year_mode()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_vouchers integer;
  v_series integer;
  v_first text;
  v_prefixes text;
begin
  -- `update of uses_financial_years` fires whenever the column is named in a
  -- SET list, whether or not the value moves. A whole-row rewrite restating
  -- what is already there is not a change and must not be refused: that is the
  -- shape restore_company_backup() writes, and the shape of any UPDATE that
  -- names every column.
  if new.uses_financial_years is not distinct from old.uses_financial_years then
    return new;
  end if;

  -- security definer, so this counts the company's own rows and not the
  -- caller's view of them. A user whose RLS hid every voucher would otherwise
  -- be told the book was empty and allowed to break it.
  --
  -- Soft-deleted vouchers count. `is_deleted` is what "delete" means in this
  -- application, and such a voucher still holds its number: the series is not
  -- rewound and the number is not reissued, so the scheme it was minted under
  -- is still on the books.
  select count(*) into v_vouchers
    from public.vouchers v where v.company_id = old.id;

  -- Surviving vouchers are not the whole record of what has been minted, and
  -- counting only them left this guard with a door in it.
  -- revert_company_changes_since() *hard*-deletes vouchers, so a book whose
  -- every entry has been undone counts zero of them and the setting flipped
  -- freely — although numbers had been issued and, in this function's own
  -- words below, may be on paper.
  --
  -- The evidence survives that undo by design: 0019 rewinds
  -- voucher_number_sequences rather than deleting it, precisely so the numbers
  -- can be reissued rather than lost. A row there is the database's own record
  -- that this company once minted under this setting, whatever became of the
  -- voucher afterwards.
  --
  -- The overwrite path of restore_company_backup() deletes the sequences along
  -- with the vouchers, before it writes the company row, so a restore still
  -- passes here. That ordering is stated in section 8 below and asserted by
  -- section 41's overwrite case.
  select count(*) into v_series
    from public.voucher_number_sequences s where s.company_id = old.id;

  if v_vouchers > 0 then
    -- Ordered by the number that was issued, not by the date written on the
    -- voucher. A back-dated entry carries the later sequence_number and the
    -- earlier date, so ordering by date names a voucher that is not the first
    -- one numbered — and "the first of them numbered X" is then simply wrong
    -- about the one piece of evidence it offers. A continuous book is where
    -- this shows, because it has no year fence keeping entry order and date
    -- order together; the remaining terms make the order total for a
    -- year-keeping book, where two series can each hold a number 1.
    select v.voucher_number into v_first
      from public.vouchers v
      where v.company_id = old.id
      order by v.sequence_number, v.voucher_date, v.voucher_number
      limit 1;

    raise exception
      'Cannot change how % numbers its books: % voucher(s) have already been entered, the first of them numbered %. Changing this now would leave two numbering schemes in one book, and the numbers already issued may be on paper. Start a new company with the other setting and enter those books there.',
      old.name, v_vouchers, v_first;
  end if;

  if v_series > 0 then
    -- No voucher survives, so there is no number left to name and the message
    -- above would be a lie in its first clause. A book that issued numbers and
    -- undid them is not a book that never issued any, and this says which of
    -- the two it is looking at rather than borrowing the other one's wording.
    -- The series and their prefixes are what is left to point at.
    select string_agg(distinct s.prefix, ', ' order by s.prefix) into v_prefixes
      from public.voucher_number_sequences s where s.company_id = old.id;

    raise exception
      'Cannot change how % numbers its books: its entries have all been removed, but % voucher numbering series (%) were opened under the current setting and the numbers they issued may be on paper. Changing this now would leave two numbering schemes in one book. Start a new company with the other setting and enter those books there.',
      old.name, v_series, v_prefixes;
  end if;

  return new;
end;
$$;

-- Scoped to the column, not a bare `before update`. companies is written on
-- every lock-date change, every letterhead save and every restore; a bare
-- trigger would run the count above on all of them, forever, to catch a state
-- those statements cannot produce. This is the same reasoning 0022 gives for
-- scoping its own party trigger.
--
-- BEFORE, not a deferred constraint trigger. The refusal is a statement about
-- the row being written and needs no other row to settle first, and a refusal
-- the user sees at the moment they act on is worth more than one that surfaces
-- at COMMIT with nothing to attach it to.
drop trigger if exists trg_guard_financial_year_mode on public.companies;
create trigger trg_guard_financial_year_mode
  before update of uses_financial_years on public.companies
  for each row execute function app_private.guard_financial_year_mode();

-- ------------------------------------------------------- 7. create_company()

-- The RPC grows one optional trailing argument, and is dropped and recreated
-- rather than left alongside a new overload. Two functions differing only by a
-- defaulted argument are ambiguous to PostgREST, which resolves an RPC by the
-- names of the keys posted to it: every existing call from
-- lib/supabase/queries/companies.ts posts the four names both candidates
-- accept, and would get "Could not choose the best candidate function" rather
-- than a company. That is the lesson 0021 recorded when it did the same to
-- create_voucher and update_voucher.
--
-- Unlike 0021's two, this one carries an explicit ACL: 0008 revoked it from
-- PUBLIC and granted it to authenticated, closing the hole that CREATE
-- FUNCTION's default grant to PUBLIC opens for anon. A drop takes that with
-- it, and a `create or replace` afterwards would hand the new function the
-- default PUBLIC grant again. So both statements are restated below against
-- the new signature — this is the one thing dropping actually costs here, and
-- forgetting it would silently reopen the hole 0008 exists to close.
--
-- restore_company_backup() calls this function, and is restated below to pass
-- the new argument. PL/pgSQL bodies are not dependency-tracked, so the drop
-- does not need the restore dropped first — but a restore left un-restated
-- would have gone on calling the four-argument form and quietly restored every
-- continuous book as a year-keeping one, which is section 8 below.
drop function if exists public.create_company(text, date, smallint, character);

create or replace function public.create_company(
  p_name text,
  p_book_beginning_date date,
  p_financial_year_start_month smallint default 4,
  p_base_currency char(3) default 'INR',
  -- True keeps today's behaviour, so a caller that has never heard of this
  -- argument creates exactly the company it always did.
  p_uses_financial_years boolean default true
) returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to create a company';
  end if;

  insert into public.companies (
    name, book_beginning_date, financial_year_start_month, base_currency,
    uses_financial_years, created_by
  )
  values (
    p_name, p_book_beginning_date, p_financial_year_start_month, p_base_currency,
    coalesce(p_uses_financial_years, true), auth.uid()
  )
  returning id into v_company_id;

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_company_id, auth.uid(), 'admin', 'active', auth.uid());

  perform app_private.seed_chart_of_accounts(v_company_id);

  return v_company_id;
end;
$$;

revoke execute on function public.create_company(text, date, smallint, character, boolean) from public;
grant execute on function public.create_company(text, date, smallint, character, boolean) to authenticated;

-- ------------------------------------------ 8. the places that lose settings

-- Four places carry a company's settings from one book to another, and each
-- was looked at. Only one of them needed changing, and saying which and why is
-- the point of this section — "it probably rides along" is exactly the
-- assumption a backup is not allowed to make quietly.
--
-- export_company_backup: NOT restated, for the reason 0022 gives for the same
--   decision. It builds the company with `select to_jsonb(c) from
--   public.companies c`, over the whole row, so the column joins the file the
--   moment it exists. Restating the function byte-for-byte to add a comment
--   would be a redeploy that changes nothing and a second copy to keep in
--   step. Section 41 of the guarantees asserts the key is actually in the file
--   rather than trusting that reasoning.
--
-- the audit trigger list: NOT changed. 0014 put audit_companies on this table
--   precisely so company-level changes leave a trace, and record_audit_log()
--   writes to_jsonb(old)/to_jsonb(new) over the whole row, so the new column
--   is captured on both sides with no edit. The one change that matters — the
--   choice being set at creation — lands in the INSERT row.
--
-- revert_company_changes_since: NOT changed, and this one is a decision rather
--   than an observation. Its replay list is
--   ('vouchers','voucher_entries','invoice_lines','ledgers','account_groups')
--   and deliberately excludes companies: "Undo is for bookkeeping mistakes;
--   silently reinstating a removed member or reopening a locked period is a
--   different decision." That reading is exactly right here too, and it is
--   also the only safe one — an undo that rewound this column would be
--   refused by the trigger above for any company that had ever minted a number,
--   failing the whole undo over a setting the user never asked to change. Its
--   numbering rewind at the end needs nothing either: it groups by whatever is
--   in financial_year_label, so a continuous book rewinds as the one series it
--   is. Section 43 asserts that.
--
-- restore_company_backup: CHANGED, below. It is the half that silently loses
--   data — it names the company's columns one at a time on the overwrite path,
--   and on the 'new' path it hands create_company() a fixed four arguments.
--   Left alone, restoring a bahi-khata would produce a company that keeps
--   financial years, carrying every voucher's 'continuous' label across intact
--   and then minting SAL/2026-27/00001 beside SAL/00001 on the very next sale
--   — a book with two numbering schemes in it, which is precisely the state
--   section 6 above exists to make unreachable.

-- 0022's restore, with the setting carried on both paths and a check that the
-- file agrees with itself before either of them runs.
--
-- ON THE FILE AGREEING WITH ITSELF. Carrying the setting is not enough on its
-- own, and saying so is the point of the block that opens the function. A
-- backup is a client-supplied document. The company's setting and the labels
-- its own vouchers carry are two statements about the same thing, read out of
-- the same file, and nothing compared them: hand-edit the flag — or supply it
-- as JSON null, which the default below reads as absent — and the restore
-- builds a company marked year-keeping whose every voucher is labelled
-- 'continuous'. The next sale then mints SAL/2026-27/00001 beside SAL/00001,
-- which is the state the paragraph above says this section exists to prevent
-- and did not.
--
-- Section 2's check constraint cannot catch it, which is why both exist. Each
-- value is individually well-formed; only their combination is wrong, and a
-- constraint on one column cannot see a combination.
--
-- The comparison is made before anything is written, so the overwrite path
-- refuses a contradictory file with the target's own books still in place. A
-- restore that had cleared the book and then refused would have destroyed one
-- to protect it.
--
-- ON ABSENT VERSUS PRESENT-AND-NULL. A file written before this column existed
-- has no such key at all, and restores as a year-keeping company — which is
-- what every company that could have produced one was. A key that is present
-- and JSON null says nothing whatever, and is not that file; it is read the
-- same way, as the documented default, and then has to survive the comparison
-- like any other value. The two cases are written out rather than left to
-- `->>` returning null for both, because they are only accidentally alike:
-- the reasoning above justifies the default for one of them and nothing at
-- all for the other, and the code used to make no distinction the comment
-- was already drawing.
--
-- ON THE ORDER OF THE OVERWRITE PATH. The company UPDATE below sets this
-- column and would be refused by section 6's trigger if the target still held
-- a voucher — or a numbering series, which the trigger now counts as well. It
-- holds neither: the deletes above it clear every voucher and then every
-- voucher_number_sequences row, in the same transaction, so by the time the
-- setting is written the book being replaced has nothing left to protect.
-- That is not a coincidence to lean on silently — the deletes are ordered
-- children-first for referential reasons and the sequences come last of all
-- for no reason connected to this, and the trigger happens to agree with
-- them, so if that block is ever reordered, section 41's overwrite case is
-- what will say so.
--
-- The format version stays at 1, for the reason 0021 gives: bumping it would
-- make an older restore refuse the very files this writes, and an older
-- restore reading a newer file is not a situation the migration chain can
-- produce.
create or replace function public.restore_company_backup(
  p_payload jsonb,
  p_mode text default 'new',              -- 'new' | 'overwrite'
  p_target_company_id uuid default null   -- required when overwriting
) returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_company uuid;
  v_row jsonb;
  v_new_id uuid;
  v_group_map jsonb := '{}'::jsonb;   -- backup id -> restored id
  v_ledger_map jsonb := '{}'::jsonb;
  v_voucher_map jsonb := '{}'::jsonb;
  v_pass int := 0;
  v_placed int;
  v_pending int;
  v_uses_years boolean;
  v_continuous text := app_private.continuous_year_label();
  v_disagreeing int;
  v_example text;
begin
  if v_user is null then
    raise exception 'Must be authenticated to restore a backup';
  end if;

  if p_payload->>'format' is distinct from 'hisab.company-backup' then
    raise exception 'That file is not a HISAB company backup';
  end if;
  if coalesce((p_payload->>'version')::int, 0) > 1 then
    raise exception 'That backup was written by a newer version of HISAB (format version %)', p_payload->>'version';
  end if;

  -- ---- the file has to agree with itself -------------------------------
  -- See ON THE FILE AGREEING WITH ITSELF above. Read the setting once, here,
  -- so that the comparison below and the two writes further down cannot be
  -- looking at different answers.
  if (p_payload->'company') ? 'uses_financial_years'
     and jsonb_typeof(p_payload->'company'->'uses_financial_years') <> 'null' then
    v_uses_years := (p_payload->'company'->>'uses_financial_years')::boolean;
  else
    v_uses_years := true;
  end if;

  -- Both tables that carry the label are checked, not only the vouchers. They
  -- share one key, and a file whose vouchers had been removed but whose
  -- numbering series had not would go on minting under the wrong scheme with
  -- nothing to notice.
  select count(*), min(f.label) into v_disagreeing, v_example
  from (
    select e->>'financial_year_label' as label
      from jsonb_array_elements(coalesce(p_payload->'vouchers', '[]'::jsonb)) e
    union all
    select e->>'financial_year_label'
      from jsonb_array_elements(coalesce(p_payload->'voucher_number_sequences', '[]'::jsonb)) e
  ) f
  where case when v_uses_years then f.label = v_continuous
             else f.label is distinct from v_continuous end;

  if v_disagreeing > 0 then
    if v_uses_years then
      raise exception
        'That backup contradicts itself: it says this company keeps financial years, but % of the voucher and numbering rows in it are labelled %, which is what a company that keeps no financial years writes. Restoring it would leave two numbering schemes in one book.',
        v_disagreeing, quote_literal(v_continuous);
    else
      raise exception
        'That backup contradicts itself: it says this company keeps no financial years, but % of the voucher and numbering rows in it carry a financial year label (for example %). Restoring it would leave two numbering schemes in one book.',
        v_disagreeing, quote_literal(coalesce(v_example, '(null)'));
    end if;
  end if;

  -- ---- decide where the data is going ----------------------------------
  if p_mode = 'overwrite' then
    if p_target_company_id is null then
      raise exception 'Overwriting needs a company to overwrite';
    end if;
    -- `is not true`, not `not ...`: a NULL from the permission helper would
    -- make `not NULL` -> NULL, skip the raise, and let a non-member through.
    if app_private.is_company_admin(p_target_company_id) is not true then
      raise exception 'Only an admin can replace a company from a backup';
    end if;
    v_company := p_target_company_id;

    -- Children first: invoice lines and entries reference vouchers and
    -- ledgers, ledgers reference groups. System groups stay — the trigger
    -- forbids deleting them, and they are matched by nature below rather than
    -- recreated.
    delete from public.invoice_lines where company_id = v_company;
    delete from public.voucher_entries where company_id = v_company;
    delete from public.vouchers where company_id = v_company;
    delete from public.ledgers where company_id = v_company;
    delete from public.account_groups where company_id = v_company and is_system = false;
    delete from public.voucher_number_sequences where company_id = v_company;

    update public.companies set
      name = coalesce(p_payload->'company'->>'name', name),
      book_beginning_date = (p_payload->'company'->>'book_beginning_date')::date,
      financial_year_start_month = (p_payload->'company'->>'financial_year_start_month')::smallint,
      uses_financial_years = v_uses_years,
      base_currency = p_payload->'company'->>'base_currency',
      lock_date = nullif(p_payload->'company'->>'lock_date', '')::date,
      address = p_payload->'company'->>'address',
      phone = p_payload->'company'->>'phone',
      email = p_payload->'company'->>'email'
    where id = v_company;

  elsif p_mode = 'new' then
    -- create_company seeds a fresh chart of accounts and makes the caller an
    -- admin. The seeded sub-groups are then dropped, because the backup
    -- carries its own — including any the user added or renamed. Nothing
    -- references them yet, so this is safe.
    v_company := public.create_company(
      coalesce(p_payload->'company'->>'name', 'Restored company'),
      (p_payload->'company'->>'book_beginning_date')::date,
      (p_payload->'company'->>'financial_year_start_month')::smallint,
      (p_payload->'company'->>'base_currency')::char(3),
      v_uses_years
    );

    delete from public.account_groups where company_id = v_company and is_system = false;

    update public.companies
      set lock_date = nullif(p_payload->'company'->>'lock_date', '')::date,
          address = p_payload->'company'->>'address',
          phone = p_payload->'company'->>'phone',
          email = p_payload->'company'->>'email'
      where id = v_company;
  else
    raise exception 'Unknown restore mode: %', p_mode;
  end if;

  -- ---- account groups ---------------------------------------------------
  -- The eight system groups can't be created or deleted, but there is exactly
  -- one per nature, so they are matched on that rather than on name — which
  -- keeps working even if the user renamed one.
  for v_row in select * from jsonb_array_elements(p_payload->'account_groups') loop
    if coalesce((v_row->>'is_system')::boolean, false) then
      select id into v_new_id
        from public.account_groups
        where company_id = v_company and is_system and nature = v_row->>'nature';

      if v_new_id is not null then
        update public.account_groups
          set name = v_row->>'name',
              ledger_role = v_row->>'ledger_role',
              sort_order = coalesce((v_row->>'sort_order')::smallint, 0)
          where id = v_new_id;
        v_group_map := v_group_map || jsonb_build_object(v_row->>'id', v_new_id);
      end if;
    end if;
  end loop;

  -- Sub-groups can nest arbitrarily deep, so place whichever ones have a
  -- mapped parent and repeat. A pass that places nothing while work remains
  -- means the backup references a parent it doesn't contain.
  loop
    v_pass := v_pass + 1;
    v_placed := 0;
    v_pending := 0;

    for v_row in select * from jsonb_array_elements(p_payload->'account_groups') loop
      if coalesce((v_row->>'is_system')::boolean, false) then continue; end if;
      if v_group_map ? (v_row->>'id') then continue; end if;

      if v_row->>'parent_group_id' is null then
        insert into public.account_groups
          (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
        values
          (v_company, null, v_row->>'name', v_row->>'nature', v_row->>'normal_balance',
           v_row->>'ledger_role', coalesce((v_row->>'sort_order')::smallint, 0))
        returning id into v_new_id;

        v_group_map := v_group_map || jsonb_build_object(v_row->>'id', v_new_id);
        v_placed := v_placed + 1;

      elsif v_group_map ? (v_row->>'parent_group_id') then
        insert into public.account_groups
          (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
        values
          (v_company, (v_group_map->>(v_row->>'parent_group_id'))::uuid, v_row->>'name',
           v_row->>'nature', v_row->>'normal_balance', v_row->>'ledger_role',
           coalesce((v_row->>'sort_order')::smallint, 0))
        returning id into v_new_id;

        v_group_map := v_group_map || jsonb_build_object(v_row->>'id', v_new_id);
        v_placed := v_placed + 1;
      else
        v_pending := v_pending + 1;
      end if;
    end loop;

    exit when v_pending = 0;
    if v_placed = 0 then
      raise exception 'Backup has % account group(s) whose parent group is missing from the file', v_pending;
    end if;
    if v_pass > 50 then
      raise exception 'Account groups in this backup are nested too deeply to restore';
    end if;
  end loop;

  -- ---- ledgers ----------------------------------------------------------
  for v_row in select * from jsonb_array_elements(p_payload->'ledgers') loop
    if not (v_group_map ? (v_row->>'group_id')) then
      raise exception 'Ledger "%" refers to an account group missing from the backup', v_row->>'name';
    end if;

    insert into public.ledgers (
      company_id, group_id, name, opening_balance_amount, opening_balance_type,
      contact_person, phone, email, address, notes, is_active, created_by
    ) values (
      v_company,
      (v_group_map->>(v_row->>'group_id'))::uuid,
      v_row->>'name',
      coalesce((v_row->>'opening_balance_amount')::numeric, 0),
      coalesce(v_row->>'opening_balance_type', 'debit'),
      v_row->>'contact_person',
      v_row->>'phone',
      v_row->>'email',
      v_row->>'address',
      v_row->>'notes',
      coalesce((v_row->>'is_active')::boolean, true),
      -- The original author's id belongs to whichever project made the
      -- backup, so authorship is re-stamped to whoever restored it.
      v_user
    ) returning id into v_new_id;

    v_ledger_map := v_ledger_map || jsonb_build_object(v_row->>'id', v_new_id);
  end loop;

  -- ---- vouchers ---------------------------------------------------------
  -- Numbers, dates, sequence positions and financial year labels are carried
  -- over verbatim: a restored book has to agree with whatever was printed or
  -- filed from the original. That is as true of 'continuous' as it is of
  -- '2025-26' — the label is stored, never re-derived, so a restore never
  -- renumbers and never re-labels.
  for v_row in select * from jsonb_array_elements(p_payload->'vouchers') loop
    -- The party is a ledger id, so it is remapped, never carried. Files
    -- written before the column existed have no such key at all, so the
    -- lookup is guarded rather than assumed: absent means "this voucher had
    -- no party", which is exactly what those vouchers had. Present but
    -- unmapped means the file is internally inconsistent, and is worth the
    -- same complaint an entry with a missing ledger gets — restoring it as
    -- null would lose the customer silently.
    if v_row->>'party_ledger_id' is not null
       and not (v_ledger_map ? (v_row->>'party_ledger_id')) then
      raise exception 'Backup has a voucher whose party ledger is missing from the file';
    end if;

    insert into public.vouchers (
      company_id, voucher_type, voucher_number, sequence_number, financial_year_label,
      voucher_date, narration, reference_number, reference_date, party_ledger_id, is_deleted, created_by
    ) values (
      v_company,
      v_row->>'voucher_type',
      v_row->>'voucher_number',
      (v_row->>'sequence_number')::int,
      v_row->>'financial_year_label',
      (v_row->>'voucher_date')::date,
      v_row->>'narration',
      v_row->>'reference_number',
      nullif(v_row->>'reference_date', '')::date,
      -- `->>` on an absent key is null, and `v_ledger_map->>null` is null too,
      -- so an old file lands here as null without a special case.
      (v_ledger_map->>coalesce(v_row->>'party_ledger_id', ''))::uuid,
      coalesce((v_row->>'is_deleted')::boolean, false),
      v_user
    ) returning id into v_new_id;

    v_voucher_map := v_voucher_map || jsonb_build_object(v_row->>'id', v_new_id);
  end loop;

  -- ---- voucher entries --------------------------------------------------
  for v_row in select * from jsonb_array_elements(p_payload->'voucher_entries') loop
    if not (v_voucher_map ? (v_row->>'voucher_id')) then
      raise exception 'Backup has a voucher line whose voucher is missing from the file';
    end if;
    if not (v_ledger_map ? (v_row->>'ledger_id')) then
      raise exception 'Backup has a voucher line whose ledger is missing from the file';
    end if;

    insert into public.voucher_entries (
      voucher_id, company_id, ledger_id, debit_amount, credit_amount, narration, line_order
    ) values (
      (v_voucher_map->>(v_row->>'voucher_id'))::uuid,
      v_company,
      (v_ledger_map->>(v_row->>'ledger_id'))::uuid,
      coalesce((v_row->>'debit_amount')::numeric, 0),
      coalesce((v_row->>'credit_amount')::numeric, 0),
      v_row->>'narration',
      coalesce((v_row->>'line_order')::int, 0)
    );
  end loop;

  -- ---- invoice lines ----------------------------------------------------
  -- Restored, not regenerated: the entries above are already in the file, and
  -- re-running the generator would risk a restored book disagreeing with the
  -- invoice that was actually sent. line_amount is generated and so is
  -- recomputed from the quantity, rate and discount rather than carried.
  -- Absent from files written before invoicing existed, which is why the whole
  -- array is coalesced rather than assumed.
  for v_row in select * from jsonb_array_elements(coalesce(p_payload->'invoice_lines', '[]'::jsonb)) loop
    if not (v_voucher_map ? (v_row->>'voucher_id')) then
      raise exception 'Backup has an invoice line whose voucher is missing from the file';
    end if;
    if not (v_ledger_map ? (v_row->>'revenue_ledger_id')) then
      raise exception 'Backup has an invoice line whose ledger is missing from the file';
    end if;

    insert into public.invoice_lines (
      voucher_id, company_id, revenue_ledger_id, line_order,
      description, quantity, unit, rate, discount_amount
    ) values (
      (v_voucher_map->>(v_row->>'voucher_id'))::uuid,
      v_company,
      (v_ledger_map->>(v_row->>'revenue_ledger_id'))::uuid,
      coalesce((v_row->>'line_order')::int, 0),
      v_row->>'description',
      coalesce((v_row->>'quantity')::numeric, 1),
      v_row->>'unit',
      coalesce((v_row->>'rate')::numeric, 0),
      coalesce((v_row->>'discount_amount')::numeric, 0)
    );
  end loop;

  -- ---- numbering --------------------------------------------------------
  for v_row in select * from jsonb_array_elements(coalesce(p_payload->'voucher_number_sequences', '[]'::jsonb)) loop
    insert into public.voucher_number_sequences
      (company_id, voucher_type, financial_year_label, prefix, next_number, padding)
    values (
      v_company,
      v_row->>'voucher_type',
      v_row->>'financial_year_label',
      v_row->>'prefix',
      coalesce((v_row->>'next_number')::int, 1),
      coalesce((v_row->>'padding')::int, 5)
    )
    on conflict (company_id, voucher_type, financial_year_label) do update
      set prefix = excluded.prefix,
          next_number = excluded.next_number,
          padding = excluded.padding;
  end loop;

  -- The balance triggers are `deferrable initially deferred`, so left alone
  -- they fire at COMMIT — long after this function has returned, which would
  -- surface a corrupt backup as an unattributable error on some later
  -- statement. Forcing them here means an unbalanced voucher, or an invoice
  -- whose lines do not match its postings, fails the restore with its own
  -- message, and the whole thing rolls back.
  set constraints all immediate;

  return v_company;
end;
$$;

-- ------------------------------------- 9. what else reaches for a year, and why
--
-- Two functions derive or group by financial_year_label on their own. Neither
-- needed a special case, and both were checked rather than assumed:
--
--   find_duplicate_bill (0024) scopes its search to the financial year the
--     given date falls in, deliberately, so that a supplier who restarts his
--     own numbering every April is not reported as a duplicate of himself. It
--     asks app_private.financial_year_label() for the label rather than
--     computing one, which was 0024's own decision ("A client that computed
--     the label itself would be a second copy of the year-boundary rule"), so
--     a continuous book now scopes to the whole book. That is the right answer
--     rather than a lucky one: there is no April restart to make room for, and
--     one unbroken run of inbound paper is exactly one series of bill numbers.
--     The partial index it rides on has financial_year_label as its last
--     column and is indifferent to what is in it.
--
--   revert_company_changes_since (0019) rewinds each sequence to one above the
--     highest surviving sequence_number under its key, and the key is whatever
--     is in the column. A continuous book has one key and rewinds as one
--     series.
--
-- Both are asserted in section 43 of supabase/tests/guarantees.sql.
--
-- Outside the database, the client has its own copy of the year rule in
-- lib/utils/financial-year.ts — used only to decide which period the screens
-- are drawn for, never to mint or interpret a number. A company with years off
-- gets one period there instead of a list of years, which is what
-- listBooksPeriods() in that file is for.
