-- BANK STATEMENT IMPORT & RECONCILIATION
--
-- A bank statement is the one file in this app that arrives in a shape nobody
-- here chose. Every bank exports a different column order, a different date
-- format, and a different way of saying "money left the account". So the
-- import is built around remembering, in three separate places:
--
--   bank_statement_profiles  — how to READ this bank's file. Mapped once by
--                              hand (or accepted from detection), then reused
--                              for every later statement from that account.
--   bank_narration_rules     — what a narration MEANS in this company's books.
--                              Written every time a user posts a line, so the
--                              second "UPI/RAZORPAY/..." is proposed, not typed.
--   bank_statement_lines     — what has already been seen, so re-uploading an
--                              overlapping period is a no-op rather than a
--                              duplicated month.
--
-- The last of those three is the one that actually protects the books:
-- statements overlap constantly (a user pulls "last 90 days" twice), and
-- without a stable per-line fingerprint the second upload silently doubles
-- every transaction in the overlap.

-- ------------------------------------------------------- 1. format profiles

create table public.bank_statement_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_ledger_id uuid not null,
  -- Shown when the profile is reused: "Read using your saved ICICI Current
  -- layout". Defaults to the bank ledger's name, but stays editable because a
  -- single account can be exported from two different portals.
  label text not null,

  -- Header text of each source column. Matched case- and whitespace-
  -- insensitively at parse time, same as the generic CSV importer does.
  date_column text not null,
  value_date_column text,
  -- Banks routinely split a narration across two columns ("Description" plus
  -- "Ref No"), so this is a list that gets joined, not a single column.
  narration_columns text[] not null default '{}',
  reference_column text,
  balance_column text,

  -- How the file expresses direction and magnitude:
  --   separate_columns — a Withdrawal column and a Deposit column (most Indian banks)
  --   signed_single    — one Amount column, sign carries direction
  --   amount_with_type — one Amount column plus a Dr/Cr indicator column
  amount_mode text not null check (amount_mode in ('separate_columns','signed_single','amount_with_type')),
  withdrawal_column text,
  deposit_column text,
  amount_column text,
  type_column text,
  -- signed_single only. Almost every bank means "negative = money out", but
  -- a few export from the bank's own point of view, where it is reversed.
  negative_is_withdrawal boolean not null default true,

  -- Ambiguity that no amount of sample data can resolve: 03/04/2026 is either
  -- 3 April or 4 March, and a statement whose days all fall below 13 gives no
  -- clue. Stored rather than guessed per file.
  date_format text not null check (date_format in ('dmy','mdy','ymd')),
  -- Preamble rows above the real header (account holder, address, period).
  skip_rows integer not null default 0 check (skip_rows >= 0),

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  -- One remembered layout per bank account: re-mapping a file replaces what
  -- was learned before rather than accumulating near-identical profiles.
  unique (company_id, bank_ledger_id),
  foreign key (bank_ledger_id, company_id) references public.ledgers (id, company_id) on delete cascade,

  -- Each amount_mode needs its own columns present, and a profile missing them
  -- would fail only later, mid-parse, as an unexplained empty amount.
  constraint bank_statement_profiles_amount_columns_check check (
    case amount_mode
      when 'separate_columns' then withdrawal_column is not null and deposit_column is not null
      when 'signed_single'    then amount_column is not null
      when 'amount_with_type' then amount_column is not null and type_column is not null
    end
  )
);

create index bank_statement_profiles_company_idx on public.bank_statement_profiles(company_id);

create trigger set_updated_at
  before update on public.bank_statement_profiles
  for each row execute function app_private.set_updated_at();

-- --------------------------------------------------------- 2. one statement

create table public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_ledger_id uuid not null,
  file_name text,
  period_start date,
  period_end date,
  -- The closing balance as the bank states it. The reconciliation screen
  -- compares it against the ledger's own closing balance — the single number
  -- that says whether the books and the bank actually agree.
  closing_balance numeric(18,2),
  line_count integer not null default 0,
  -- Lines already present from an earlier upload of an overlapping period.
  duplicate_count integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (bank_ledger_id, company_id) references public.ledgers (id, company_id) on delete cascade
);

create index bank_statement_imports_company_ledger_idx
  on public.bank_statement_imports(company_id, bank_ledger_id, created_at desc);

-- ------------------------------------------------------------- 3. the lines

create table public.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  import_id uuid not null,
  bank_ledger_id uuid not null,
  -- Row number in the source file, so an error can point at something the
  -- user can actually find by opening the file.
  line_number integer not null,

  txn_date date not null,
  value_date date,
  narration text not null default '',
  reference text,

  -- Same shape as voucher_entries: exactly one side is non-zero. Direction is
  -- from the account holder's point of view — a withdrawal reduces the bank
  -- ledger, which is a credit to it.
  withdrawal_amount numeric(18,2) not null default 0 check (withdrawal_amount >= 0),
  deposit_amount numeric(18,2) not null default 0 check (deposit_amount >= 0),
  running_balance numeric(18,2),

  status text not null default 'unmatched'
    check (status in ('unmatched','matched','posted','ignored')),
  -- matched: this line is an existing voucher, already in the books.
  matched_voucher_id uuid references public.vouchers(id) on delete set null,
  -- posted: this line created a voucher that did not exist before.
  posted_voucher_id uuid references public.vouchers(id) on delete set null,

  -- No suggested_ledger_id column on purpose. The proposed account is derived
  -- from bank_narration_rules on every load rather than frozen onto the line,
  -- so a rule learned this morning immediately improves lines imported last
  -- week — a stored suggestion would keep showing the worse answer it had at
  -- import time.

  -- Stable identity of the transaction itself, computed by the client from
  -- date + direction + amount + normalized narration + its occurrence index
  -- among otherwise-identical siblings. Two uploads of the same transaction
  -- produce the same fingerprint; two genuinely repeated identical charges on
  -- one day produce different ones, because of the occurrence index.
  fingerprint text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((withdrawal_amount > 0 and deposit_amount = 0)
      or (deposit_amount > 0 and withdrawal_amount = 0)),
  unique (id, company_id),
  foreign key (import_id, company_id) references public.bank_statement_imports (id, company_id) on delete cascade,
  foreign key (bank_ledger_id, company_id) references public.ledgers (id, company_id) on delete cascade
);

-- The duplicate guard. Scoped to the bank account, not the import, so the
-- overlap between two separate uploads is what it catches.
create unique index bank_statement_lines_fingerprint_idx
  on public.bank_statement_lines(company_id, bank_ledger_id, fingerprint);

-- A voucher can only be the explanation for one statement line. Without this,
-- two similar lines can both be reconciled against the same payment and the
-- rec appears to balance while one real transaction is missing from the books.
create unique index bank_statement_lines_matched_voucher_idx
  on public.bank_statement_lines(company_id, matched_voucher_id)
  where matched_voucher_id is not null;

create index bank_statement_lines_workspace_idx
  on public.bank_statement_lines(company_id, bank_ledger_id, status, txn_date);
create index bank_statement_lines_import_idx on public.bank_statement_lines(import_id);

create trigger set_updated_at
  before update on public.bank_statement_lines
  for each row execute function app_private.set_updated_at();

-- Undo (0014) hard-deletes vouchers it created, and both voucher references
-- above are `on delete set null`. Left alone that produces a line still
-- claiming to be posted while pointing at nothing — reconciled in the UI,
-- absent from the books. Sending it back to unmatched is the honest state.
create or replace function app_private.trg_bank_line_voucher_gone()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if new.status = 'posted' and new.posted_voucher_id is null then
    new.status := 'unmatched';
  elsif new.status = 'matched' and new.matched_voucher_id is null then
    new.status := 'unmatched';
  end if;
  return new;
end;
$$;

create trigger bank_line_voucher_gone
  before update of matched_voucher_id, posted_voucher_id on public.bank_statement_lines
  for each row execute function app_private.trg_bank_line_voucher_gone();

-- ------------------------------------------------- 4. what narrations mean

create table public.bank_narration_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- null applies the rule to every bank account. A learned rule starts scoped
  -- to the account it was learned on; a user can widen it.
  bank_ledger_id uuid,
  -- The normalized narration key produced by lib/bank/suggest.ts. The
  -- normalizer lives in TypeScript, is unit-tested there, and is the only
  -- thing that writes this column — SQL never re-derives it, so the two can't
  -- drift into disagreeing about what a narration reduces to.
  pattern text not null,
  -- Direction matters: ₹5,000 to "RAJESH KUMAR" going out is a payment to a
  -- creditor; the same name coming in is a receipt from a debtor.
  direction text not null check (direction in ('withdrawal','deposit')),
  contra_ledger_id uuid not null,
  hit_count integer not null default 1 check (hit_count > 0),
  last_used_at timestamptz not null default now(),
  -- Hand-written rules outrank learned ones of equal specificity.
  is_manual boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (contra_ledger_id, company_id) references public.ledgers (id, company_id) on delete cascade,
  foreign key (bank_ledger_id, company_id) references public.ledgers (id, company_id) on delete cascade
);

-- Two partial indexes rather than one over a nullable column, matching how
-- account_groups handles root vs child names: a plain unique index treats
-- NULLs as distinct, so the all-accounts rule could be inserted repeatedly.
create unique index bank_narration_rules_global_idx
  on public.bank_narration_rules(company_id, pattern, direction)
  where bank_ledger_id is null;
create unique index bank_narration_rules_scoped_idx
  on public.bank_narration_rules(company_id, bank_ledger_id, pattern, direction)
  where bank_ledger_id is not null;

create index bank_narration_rules_lookup_idx
  on public.bank_narration_rules(company_id, direction, pattern);

create trigger set_updated_at
  before update on public.bank_narration_rules
  for each row execute function app_private.set_updated_at();

-- --------------------------------------------------------------- 5. RLS

alter table public.bank_statement_profiles enable row level security;
alter table public.bank_statement_imports enable row level security;
alter table public.bank_statement_lines enable row level security;
alter table public.bank_narration_rules enable row level security;

create policy bank_statement_profiles_select on public.bank_statement_profiles for select
  using ((select app_private.is_company_member(company_id)));
create policy bank_statement_profiles_insert on public.bank_statement_profiles for insert
  with check ((select app_private.can_write_company(company_id)));
create policy bank_statement_profiles_update on public.bank_statement_profiles for update
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));
create policy bank_statement_profiles_delete on public.bank_statement_profiles for delete
  using ((select app_private.can_write_company(company_id)));

create policy bank_statement_imports_select on public.bank_statement_imports for select
  using ((select app_private.is_company_member(company_id)));
create policy bank_statement_imports_insert on public.bank_statement_imports for insert
  with check ((select app_private.can_write_company(company_id)));
create policy bank_statement_imports_update on public.bank_statement_imports for update
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));
create policy bank_statement_imports_delete on public.bank_statement_imports for delete
  using ((select app_private.can_write_company(company_id)));

create policy bank_statement_lines_select on public.bank_statement_lines for select
  using ((select app_private.is_company_member(company_id)));
create policy bank_statement_lines_insert on public.bank_statement_lines for insert
  with check ((select app_private.can_write_company(company_id)));
create policy bank_statement_lines_update on public.bank_statement_lines for update
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));
create policy bank_statement_lines_delete on public.bank_statement_lines for delete
  using ((select app_private.can_write_company(company_id)));

create policy bank_narration_rules_select on public.bank_narration_rules for select
  using ((select app_private.is_company_member(company_id)));
create policy bank_narration_rules_insert on public.bank_narration_rules for insert
  with check ((select app_private.can_write_company(company_id)));
create policy bank_narration_rules_update on public.bank_narration_rules for update
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));
create policy bank_narration_rules_delete on public.bank_narration_rules for delete
  using ((select app_private.can_write_company(company_id)));

-- Deliberately no audit trigger on bank_statement_lines: one statement is
-- hundreds of rows, each touched two or three times on its way to posted, and
-- that would bury real bookkeeping changes in History. The vouchers these
-- lines produce are audited already, which is the part that affects the books.

-- ------------------------------------------------ 6. record the import type

alter table public.import_batches drop constraint if exists import_batches_import_type_check;
alter table public.import_batches add constraint import_batches_import_type_check
  check (import_type in ('ledgers','opening_balances','vouchers','bank_statement'));

-- ------------------------------------------------------- 7. posting the lines

-- Turns reviewed statement lines into real vouchers, and records what it
-- learned while doing so.
--
-- security invoker, like every other write RPC here: importing a statement is
-- not a way to post vouchers into a period you couldn't post to by hand, and
-- RLS plus the lock-date policies still apply as the calling user.
create or replace function public.post_bank_statement_lines(
  p_company_id uuid,
  -- [{"line_id":"...","contra_ledger_id":"...","voucher_type":"payment",
  --   "narration":"...","pattern":"upi razorpay","learn":true}]
  p_lines jsonb
) returns table (
  line_id uuid,
  voucher_id uuid,
  error_message text
)
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_item jsonb;
  v_line public.bank_statement_lines;
  v_contra_ledger_id uuid;
  v_voucher_type text;
  v_narration text;
  v_pattern text;
  v_direction text;
  v_amount numeric(18,2);
  v_voucher_id uuid;
  v_lines jsonb;
begin
  for v_item in select * from jsonb_array_elements(p_lines) loop
    line_id := null;
    voucher_id := null;
    error_message := null;

    begin
      line_id := (v_item->>'line_id')::uuid;

      select * into v_line
        from public.bank_statement_lines
        where id = line_id and company_id = p_company_id
        for update;

      if v_line.id is null then
        raise exception 'Statement line not found';
      end if;
      if v_line.status = 'posted' then
        raise exception 'Already posted';
      end if;

      v_contra_ledger_id := (v_item->>'contra_ledger_id')::uuid;
      if v_contra_ledger_id is null then
        raise exception 'No account chosen for this line';
      end if;
      if v_contra_ledger_id = v_line.bank_ledger_id then
        raise exception 'The other side of the entry cannot be the bank account itself';
      end if;

      v_direction := case when v_line.withdrawal_amount > 0 then 'withdrawal' else 'deposit' end;
      v_amount := case when v_direction = 'withdrawal' then v_line.withdrawal_amount else v_line.deposit_amount end;

      -- Money in is a receipt, money out a payment — unless the caller says
      -- otherwise, which it does for transfers between two own accounts
      -- (contra) and for anything the user reclassifies as a journal.
      v_voucher_type := coalesce(
        nullif(v_item->>'voucher_type', ''),
        case when v_direction = 'withdrawal' then 'payment' else 'receipt' end
      );

      v_narration := coalesce(nullif(v_item->>'narration', ''), v_line.narration);

      -- A withdrawal takes money out of the bank: credit the bank, debit
      -- wherever it went. A deposit is the mirror image.
      if v_direction = 'withdrawal' then
        v_lines := jsonb_build_array(
          jsonb_build_object('ledger_id', v_contra_ledger_id, 'debit_amount', v_amount, 'credit_amount', 0, 'narration', v_narration, 'line_order', 0),
          jsonb_build_object('ledger_id', v_line.bank_ledger_id, 'debit_amount', 0, 'credit_amount', v_amount, 'narration', v_narration, 'line_order', 1)
        );
      else
        v_lines := jsonb_build_array(
          jsonb_build_object('ledger_id', v_line.bank_ledger_id, 'debit_amount', v_amount, 'credit_amount', 0, 'narration', v_narration, 'line_order', 0),
          jsonb_build_object('ledger_id', v_contra_ledger_id, 'debit_amount', 0, 'credit_amount', v_amount, 'narration', v_narration, 'line_order', 1)
        );
      end if;

      v_voucher_id := public.create_voucher(
        p_company_id,
        v_voucher_type,
        v_line.txn_date,
        v_narration,
        v_line.reference,
        null,
        v_lines
      );

      -- Same reason as create_vouchers_bulk: the balance triggers are
      -- deferred, so without forcing them here one bad line would abort every
      -- other line in the batch at COMMIT instead of being reported as itself.
      set constraints all immediate;
      set constraints all deferred;

      update public.bank_statement_lines
        set status = 'posted', posted_voucher_id = v_voucher_id
        where id = v_line.id;

      -- The learning step. Skipped when the caller passes learn:false, which
      -- the UI does for one-off narrations the user has said not to remember.
      v_pattern := nullif(v_item->>'pattern', '');
      if v_pattern is not null and coalesce((v_item->>'learn')::boolean, true) then
        insert into public.bank_narration_rules
          (company_id, bank_ledger_id, pattern, direction, contra_ledger_id, created_by)
        values
          (p_company_id, v_line.bank_ledger_id, v_pattern, v_direction, v_contra_ledger_id, auth.uid())
        on conflict (company_id, bank_ledger_id, pattern, direction)
          where bank_ledger_id is not null
        do update set
          -- A narration that now means a different account replaces the old
          -- answer rather than averaging with it, but keeps the hit count so
          -- an established rule isn't outranked by a brand-new one.
          contra_ledger_id = excluded.contra_ledger_id,
          hit_count = case
            when bank_narration_rules.contra_ledger_id = excluded.contra_ledger_id
            then bank_narration_rules.hit_count + 1
            else 1
          end,
          last_used_at = now();
      end if;

      voucher_id := v_voucher_id;
    exception when others then
      -- Rolls back this line only; the rest of the batch continues.
      error_message := sqlerrm;
    end;

    return next;
  end loop;
end;
$$;

revoke execute on function public.post_bank_statement_lines(uuid, jsonb) from public;
grant execute on function public.post_bank_statement_lines(uuid, jsonb) to authenticated;

-- --------------------------------------- 8. candidate vouchers for matching

-- Vouchers that touch the bank ledger in a date window and are not already
-- claimed by another statement line.
--
-- This exists as SQL rather than a client-side filter because "not already
-- matched" is an anti-join against bank_statement_lines, and doing it in the
-- client means fetching every voucher in the window to throw most of them
-- away — on a busy current account that is the whole daybook.
create or replace function public.get_bank_match_candidates(
  p_company_id uuid,
  p_bank_ledger_id uuid,
  p_from_date date,
  p_to_date date
) returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_type text,
  voucher_date date,
  narration text,
  -- Signed from the bank account's point of view: positive is money in.
  bank_amount numeric(18,2)
)
language sql
security invoker set search_path = ''
stable
as $$
  select v.id, v.voucher_number, v.voucher_type, v.voucher_date, v.narration,
         sum(e.debit_amount - e.credit_amount)
  from public.vouchers v
  join public.voucher_entries e
    on e.voucher_id = v.id and e.ledger_id = p_bank_ledger_id
  where v.company_id = p_company_id
    and v.is_deleted = false
    and v.voucher_date between p_from_date and p_to_date
    and not exists (
      select 1 from public.bank_statement_lines l
      where l.matched_voucher_id = v.id or l.posted_voucher_id = v.id
    )
  group by v.id, v.voucher_number, v.voucher_type, v.voucher_date, v.narration
  having sum(e.debit_amount - e.credit_amount) <> 0
  order by v.voucher_date, v.voucher_number;
$$;

revoke execute on function public.get_bank_match_candidates(uuid, uuid, date, date) from public;
grant execute on function public.get_bank_match_candidates(uuid, uuid, date, date) to authenticated;
