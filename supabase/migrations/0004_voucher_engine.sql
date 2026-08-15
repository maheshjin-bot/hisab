-- VOUCHER NUMBERING
create table public.voucher_number_sequences (
  company_id uuid not null references public.companies(id) on delete cascade,
  voucher_type text not null,
  financial_year_label text not null,
  prefix text not null,
  next_number integer not null default 1,
  padding smallint not null default 5,
  primary key (company_id, voucher_type, financial_year_label)
);

create or replace function app_private.next_voucher_number(
  p_company_id uuid, p_voucher_type text, p_voucher_date date
) returns table(display_number text, seq_number integer, fy_label text)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_fy_start_month smallint;
  v_fy_label text;
  v_start_year int;
  v_prefix text;
  v_padding smallint;
  v_number int;
begin
  select financial_year_start_month into v_fy_start_month from public.companies where id = p_company_id;
  if v_fy_start_month is null then
    raise exception 'Company not found';
  end if;

  v_start_year := case when extract(month from p_voucher_date)::int >= v_fy_start_month
                       then extract(year from p_voucher_date)::int
                       else extract(year from p_voucher_date)::int - 1 end;
  v_fy_label := v_start_year || '-' || lpad(((v_start_year + 1) % 100)::text, 2, '0');

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

  return query select (v_prefix || '/' || v_fy_label || '/' || lpad(v_number::text, v_padding, '0')), v_number, v_fy_label;
end;
$$;

-- VOUCHER HEADER + LINES
create table public.vouchers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  voucher_type text not null check (voucher_type in ('receipt','payment','contra','journal','sales','purchase')),
  voucher_number text not null,
  sequence_number integer not null,
  financial_year_label text not null,
  voucher_date date not null,
  narration text,
  reference_number text,
  reference_date date,
  total_amount numeric(18,2) not null default 0,
  is_deleted boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, voucher_type, financial_year_label, voucher_number)
);

create index vouchers_company_date_idx on public.vouchers(company_id, voucher_date);
create index vouchers_company_type_date_idx on public.vouchers(company_id, voucher_type, voucher_date);
create index vouchers_company_not_deleted_idx on public.vouchers(company_id, is_deleted) where is_deleted = false;

create trigger set_updated_at
  before update on public.vouchers
  for each row execute function app_private.set_updated_at();

create table public.voucher_entries (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null,
  company_id uuid not null,
  ledger_id uuid not null,
  debit_amount numeric(18,2) not null default 0 check (debit_amount >= 0),
  credit_amount numeric(18,2) not null default 0 check (credit_amount >= 0),
  narration text,
  line_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((debit_amount > 0 and credit_amount = 0) or (credit_amount > 0 and debit_amount = 0)),
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id) on delete cascade,
  foreign key (ledger_id, company_id) references public.ledgers (id, company_id)
);

create index voucher_entries_company_ledger_idx on public.voucher_entries(company_id, ledger_id);
create index voucher_entries_voucher_idx on public.voucher_entries(voucher_id);

create trigger set_updated_at
  before update on public.voucher_entries
  for each row execute function app_private.set_updated_at();

-- DOUBLE-ENTRY ENFORCEMENT — the database itself rejects any voucher whose
-- lines don't sum debit = credit, or that has fewer than 2 lines. Deferred so
-- a header + N line inserts within one transaction only get checked at COMMIT.
create or replace function app_private.check_voucher_balance(p_voucher_id uuid)
returns void language plpgsql
security definer set search_path = ''
as $$
declare
  v_exists boolean;
  v_debit numeric(18,2);
  v_credit numeric(18,2);
  v_count integer;
begin
  select exists(select 1 from public.vouchers where id = p_voucher_id) into v_exists;
  if not v_exists then
    return; -- header itself was deleted in this same transaction — nothing to validate
  end if;

  select coalesce(sum(debit_amount),0), coalesce(sum(credit_amount),0), count(*)
    into v_debit, v_credit, v_count
    from public.voucher_entries where voucher_id = p_voucher_id;

  if v_count < 2 then
    raise exception 'Voucher % must have at least two line items (has %)', p_voucher_id, v_count;
  end if;
  if v_debit <> v_credit then
    raise exception 'Voucher % is unbalanced: debit % <> credit %', p_voucher_id, v_debit, v_credit;
  end if;

  update public.vouchers set total_amount = v_debit where id = p_voucher_id and total_amount is distinct from v_debit;
end;
$$;

create or replace function app_private.trg_voucher_entries_balance() returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if TG_OP = 'DELETE' then
    perform app_private.check_voucher_balance(old.voucher_id);
    return old;
  else
    perform app_private.check_voucher_balance(new.voucher_id);
    if TG_OP = 'UPDATE' and old.voucher_id is distinct from new.voucher_id then
      perform app_private.check_voucher_balance(old.voucher_id);
    end if;
    return new;
  end if;
end;
$$;

create constraint trigger trg_voucher_entries_balance
after insert or update or delete on public.voucher_entries
deferrable initially deferred
for each row execute function app_private.trg_voucher_entries_balance();

-- Also needed on the header: a voucher saved with zero lines ever inserted
-- would never fire the trigger above at all.
create or replace function app_private.trg_voucher_header_balance() returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  perform app_private.check_voucher_balance(new.id);
  return new;
end;
$$;

create constraint trigger trg_voucher_header_balance
after insert on public.vouchers
deferrable initially deferred
for each row execute function app_private.trg_voucher_header_balance();

-- ATOMIC WRITE RPCs — mandatory: with no ORM, each separate supabase-js
-- .insert() call is its own transaction, so header+lines MUST go through one
-- of these or the deferred balance trigger fails before the lines ever land.
-- security invoker (not definer) is deliberate: RLS must still gate role +
-- lock-date checks as the calling user, exactly as a direct insert would.
create or replace function public.create_voucher(
  p_company_id uuid, p_voucher_type text, p_voucher_date date,
  p_narration text, p_reference_number text, p_reference_date date,
  p_lines jsonb -- [{"ledger_id":"...","debit_amount":100.00,"credit_amount":0,"narration":"...","line_order":0}]
) returns uuid
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_voucher_id uuid;
  v_display_number text;
  v_seq_number int;
  v_fy_label text;
  v_line jsonb;
begin
  select display_number, seq_number, fy_label
    into v_display_number, v_seq_number, v_fy_label
    from app_private.next_voucher_number(p_company_id, p_voucher_type, p_voucher_date);

  insert into public.vouchers (
    company_id, voucher_type, voucher_number, sequence_number, financial_year_label,
    voucher_date, narration, reference_number, reference_date, created_by
  )
  values (
    p_company_id, p_voucher_type, v_display_number, v_seq_number, v_fy_label,
    p_voucher_date, p_narration, p_reference_number, p_reference_date, auth.uid()
  )
  returning id into v_voucher_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.voucher_entries (voucher_id, company_id, ledger_id, debit_amount, credit_amount, narration, line_order)
    values (
      v_voucher_id, p_company_id, (v_line->>'ledger_id')::uuid,
      coalesce((v_line->>'debit_amount')::numeric, 0),
      coalesce((v_line->>'credit_amount')::numeric, 0),
      v_line->>'narration',
      coalesce((v_line->>'line_order')::int, 0)
    );
  end loop;

  return v_voucher_id;
end;
$$;

-- Replaces a voucher's date/narration/reference + its full line set
-- atomically. voucher_type is deliberately not editable post-creation
-- (renumbering under a different sequence mid-life doesn't make sense —
-- delete and re-enter instead).
create or replace function public.update_voucher(
  p_voucher_id uuid,
  p_voucher_date date,
  p_narration text,
  p_reference_number text,
  p_reference_date date,
  p_lines jsonb
) returns uuid
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_company_id uuid;
  v_line jsonb;
begin
  select company_id into v_company_id from public.vouchers where id = p_voucher_id;
  if v_company_id is null then
    raise exception 'Voucher not found';
  end if;

  update public.vouchers
    set voucher_date = p_voucher_date,
        narration = p_narration,
        reference_number = p_reference_number,
        reference_date = p_reference_date,
        updated_by = auth.uid()
    where id = p_voucher_id;

  delete from public.voucher_entries where voucher_id = p_voucher_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.voucher_entries (voucher_id, company_id, ledger_id, debit_amount, credit_amount, narration, line_order)
    values (
      p_voucher_id, v_company_id, (v_line->>'ledger_id')::uuid,
      coalesce((v_line->>'debit_amount')::numeric, 0),
      coalesce((v_line->>'credit_amount')::numeric, 0),
      v_line->>'narration',
      coalesce((v_line->>'line_order')::int, 0)
    );
  end loop;

  return p_voucher_id;
end;
$$;
