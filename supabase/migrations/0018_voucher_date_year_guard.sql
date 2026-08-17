-- Fix: a voucher could be re-dated into a different financial year and keep
-- the number it was issued under.
--
-- update_voucher() (0004) writes the new date straight through:
--
--   update public.vouchers
--     set voucher_date = p_voucher_date,
--         narration = p_narration,
--         ...
--     where id = p_voucher_id;
--
-- It never revisits financial_year_label, and it never revisits
-- voucher_number — both of which app_private.next_voucher_number() derived
-- from the date the voucher had when it was created. So SAL/2026-27/00001 can
-- be re-dated to 2025-12-15 and keeps its number. Three things break at once:
--
--   * the number claims one year while the date sits in another, and every
--     report filters by date, so the voucher surfaces in a year whose series
--     does not contain it;
--   * the uniqueness key is (company_id, voucher_type, financial_year_label,
--     voucher_number), so the 2025-26 sequence is still free to mint its own
--     SAL/2025-26/00001 — and now that year visibly holds two "first"
--     vouchers, one of which is numbered for a year it isn't in;
--   * the row's own financial_year_label disagrees with its own voucher_date,
--     so everything downstream that trusts the label — the numbering
--     sequences, a backup, a restore — is reasoning about the wrong year.
--
-- The decision is to refuse the edit, not to renumber. A voucher number may
-- already have been printed on an invoice or sent to a customer; quietly
-- reissuing it under a different series makes the paper and the book disagree,
-- which is a worse outcome than a refusal the user can act on. That is the
-- same call 0004 already made for voucher_type, in the comment above
-- update_voucher():
--
--   -- voucher_type is deliberately not editable post-creation
--   -- (renumbering under a different sequence mid-life doesn't make sense —
--   -- delete and re-enter instead).
--
-- A date that crosses a year boundary now gets that same answer, in those
-- same words.
--
-- What is deliberately *not* changed:
--
--   * a date change inside the same financial year is untouched. That is the
--     ordinary correction (wrong day, wrong month) and it invalidates nothing:
--     the label and the number both still describe the year the voucher is in.
--   * narration, reference_number, reference_date and the whole line set stay
--     freely editable, exactly as before.
--   * no existing row is touched. A book that already contains a mis-dated
--     voucher from before this migration stays as it is — repairing it means
--     deciding, per voucher, whether the paper or the book is right, which is
--     not a decision a migration can make. This file only stops new ones.
--   * a NULL p_voucher_date is left to fall through to the NOT NULL constraint
--     on vouchers.voucher_date, as it always has. Deriving a year from NULL
--     would only turn a clear constraint violation into a confusing one.
--   * security invoker, set search_path = '' and the exact
--     (uuid, date, text, text, date, jsonb) -> uuid signature are preserved:
--     lib/supabase/queries/vouchers.ts calls this RPC by name with those
--     argument names, and create or replace would refuse a changed return
--     type anyway.
--   * create or replace preserves the function's existing ACL, so nothing here
--     needs to restate a revoke/grant that 0004 never had to issue for
--     update_voucher in the first place.

-- ------------------------------------------ 1. one place that knows the year

-- The financial-year label was derived in exactly one place — inside
-- next_voucher_number() — and that function cannot be called merely to ask
-- the question, because asking it *mints a number*: it upserts
-- voucher_number_sequences and advances next_number as a side effect. Calling
-- it from the guard would burn a number on every edit, including the edits it
-- is about to refuse.
--
-- So the derivation is lifted out into a function of its own and
-- next_voucher_number() is re-pointed at it. There is still exactly one copy
-- of the arithmetic, and the guard can never drift from the issuer: if the
-- year boundary is ever redefined, both move together.
--
-- security definer, matching the function this was extracted from, so every
-- existing call site keeps behaving identically no matter whose RLS is in
-- force at the time. The only thing it discloses to a caller who does not
-- belong to the company is that company's financial-year start month, which
-- they would have to guess a UUID to ask about.
create or replace function app_private.financial_year_label(
  p_company_id uuid, p_date date
) returns text
language plpgsql
security definer set search_path = ''
stable
as $$
declare
  v_fy_start_month smallint;
  v_start_year int;
begin
  -- The company is looked up before the date is examined, so that a missing
  -- company still raises 'Company not found' exactly where 0004 raised it,
  -- whatever the date is.
  select financial_year_start_month into v_fy_start_month
    from public.companies where id = p_company_id;
  if v_fy_start_month is null then
    raise exception 'Company not found';
  end if;

  -- A NULL date has no year. 0004 reached the same answer by arithmetic —
  -- extract() over NULL, then a concatenation that collapses to NULL — and
  -- the NOT NULL column it feeds is what complains either way.
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

-- 0009 grants execute on app_private to authenticated and sets a default
-- privilege for future functions, so this should already be covered — but
-- default privileges are recorded per granting role, and this function is
-- reached from public.update_voucher(), which is security *invoker*. That is
-- precisely the shape of the bug 0009 was written to fix ("permission denied
-- for schema app_private", found only by an end-to-end call as a real user),
-- so the grant is restated here rather than assumed.
grant execute on function app_private.financial_year_label(uuid, date) to authenticated;

-- Byte-for-byte 0004's next_voucher_number(), with the three lines that
-- computed the label replaced by a call to the function above. Everything
-- else — the returns table (...) shape, security definer, set search_path
-- = '', the prefix mapping, and the upsert that is the actual number issuer —
-- is unchanged. The "Company not found" raise now comes from inside the
-- helper on the same condition (a company row that isn't there), so the
-- caller sees the same message it always did.
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

  return query select (v_prefix || '/' || v_fy_label || '/' || lpad(v_number::text, v_padding, '0')), v_number, v_fy_label;
end;
$$;

-- ---------------------------------------------------------- 2. the refusal

-- Body taken from 0004, with one block added ahead of the UPDATE and the
-- opening SELECT widened to fetch the two columns the message needs. The
-- guard is placed *before* any write so that the refusal costs nothing and
-- leaves nothing half-done — the line set is not deleted, the header is not
-- touched, updated_by is not stamped.
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
  v_stored_year text;
  v_stored_number text;
  v_new_year text;
  v_line jsonb;
begin
  select company_id, financial_year_label, voucher_number
    into v_company_id, v_stored_year, v_stored_number
    from public.vouchers where id = p_voucher_id;
  if v_company_id is null then
    raise exception 'Voucher not found';
  end if;

  -- The number this voucher already carries was minted from the year of the
  -- date it had at the time. If the new date lands in a different year, that
  -- number stops describing it, and the only honest repairs are renumbering
  -- (which breaks paper already issued) or refusing. Refuse.
  --
  -- NULL is left alone on purpose: the NOT NULL constraint on voucher_date is
  -- a clearer complaint than a year comparison against nothing.
  if p_voucher_date is not null then
    v_new_year := app_private.financial_year_label(v_company_id, p_voucher_date);

    if v_new_year is distinct from v_stored_year then
      raise exception
        'Cannot move voucher % from financial year % to %: its number was issued from the % series and may already have been printed or sent, so it cannot be renumbered. Delete this voucher and re-enter it in %.',
        v_stored_number, v_stored_year, v_new_year, v_stored_year, v_new_year;
    end if;
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
