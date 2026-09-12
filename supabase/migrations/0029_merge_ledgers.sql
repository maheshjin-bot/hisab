-- MERGING TWO LEDGERS INTO ONE.
--
-- A CSV import, or two people entering the same customer on different days,
-- leaves duplicate ledgers behind: "AGGARWAL AMBAJI" and "Aggarwal Ambaji",
-- "Amit - Drawings & Advances" and "Amit - Drawings & Advances (review)".
-- Nothing in the app has ever let a shopkeeper collapse them back into one —
-- the only way was to re-enter every voucher by hand.
--
-- merge_ledgers(source, target) moves everything the source ledger carries
-- onto the target, combines their opening balances, and deletes the source.
-- The target survives under its own name, group and id; every report,
-- statement and voucher that used to mention the source now shows the
-- target instead, as if the two had always been one ledger.
--
-- WHAT IS DELIBERATELY OUT OF SCOPE.
--
-- Cash and bank ledgers are refused outright. A bank ledger carries state
-- this function does not touch: bank_statement_profiles has a UNIQUE
-- (company_id, bank_ledger_id) — two bank ledgers merging would try to keep
-- two reconciliation profiles under one id and collide — plus statement
-- imports, matched lines and learned narration rules, all keyed to the exact
-- ledger a bank statement was uploaded against. Reconciling a merge with all
-- of that is a feature of its own, not a special case of this one.
--
-- No cross-company merge: p_source_ledger_id and p_target_ledger_id are both
-- looked up scoped to p_company_id, so a stray id from another tenant is
-- simply "not found" rather than a merge across a boundary that is supposed
-- to be absolute everywhere else in this schema.
--
-- WHY ADMIN-ONLY.
--
-- Three separate reasons converge on the same answer:
--
--   * it moves an opening balance, which app_private.protect_ledger_financial_fields
--     already restricts to admins on an ordinary edit;
--   * it deletes a ledger, which app_private.protect_ledger_deletion already
--     restricts to admins once the ledger carries a nonzero opening balance;
--   * it can rewrite vouchers and voucher_entries from *any* date, including
--     ones before the company's lock_date — the vouchers_update and
--     voucher_entries_update policies let an accountant touch only rows
--     dated after lock_date, which would make a merge silently incomplete
--     (the old ledger's pre-lock entries left behind, still pointing at a
--     row about to be deleted) rather than failing loudly.
--
-- Checked explicitly here rather than left to RLS, matching 0003's and
-- 0020's own guards: an explicit raise names the reason, where a policy
-- would just make rows disappear from an UPDATE with no error at all.
create or replace function public.merge_ledgers(
  p_company_id uuid,
  p_source_ledger_id uuid,
  p_target_ledger_id uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source public.ledgers;
  v_target public.ledgers;
  v_source_role text;
  v_target_role text;
  v_signed_opening numeric(18,2);
begin
  if p_source_ledger_id = p_target_ledger_id then
    raise exception 'A ledger cannot be merged into itself';
  end if;

  if app_private.is_company_admin(p_company_id) is not true then
    raise exception 'Only an admin can merge ledgers — it moves an opening balance and permanently deletes one of the two, and cannot be undone.';
  end if;

  -- Locked for the duration: nothing else may change either row (an edit, a
  -- second concurrent merge naming one of the same two ledgers) while their
  -- opening balances are being read and combined.
  select * into v_source from public.ledgers where id = p_source_ledger_id and company_id = p_company_id for update;
  select * into v_target from public.ledgers where id = p_target_ledger_id and company_id = p_company_id for update;

  if v_source is null or v_target is null then
    raise exception 'Both ledgers must belong to this company';
  end if;

  -- ledger_role lives on the group, not the ledger itself.
  select g.ledger_role into v_source_role from public.account_groups g where g.id = v_source.group_id;
  select g.ledger_role into v_target_role from public.account_groups g where g.id = v_target.group_id;

  if v_source_role = 'cash_bank' or v_target_role = 'cash_bank' then
    raise exception 'Cash and bank ledgers can''t be merged yet — they carry reconciliation history (statement imports, matching rules) this doesn''t move.';
  end if;

  -- Every posted transaction, and every place a voucher records this ledger
  -- as its party or its revenue/expense line, moves to the target. What is
  -- *not* touched: bank_statement_profiles/_imports/_lines and
  -- bank_narration_rules.bank_ledger_id all key off a *bank* ledger, which
  -- the check above already ruled out for both source and target.
  update public.voucher_entries set ledger_id = p_target_ledger_id
    where ledger_id = p_source_ledger_id and company_id = p_company_id;

  update public.vouchers set party_ledger_id = p_target_ledger_id
    where party_ledger_id = p_source_ledger_id and company_id = p_company_id;

  update public.invoice_lines set revenue_ledger_id = p_target_ledger_id
    where revenue_ledger_id = p_source_ledger_id and company_id = p_company_id;

  -- A narration rule's contra_ledger_id is the non-bank side of a bank
  -- transaction — "SWIGGY withdrawals mean Food Expenses" — and that side is
  -- exactly as mergeable as any other non-bank ledger. Repointed rather than
  -- left to cascade-delete with the source row, so a learned or hand-written
  -- rule survives the merge instead of silently vanishing.
  update public.bank_narration_rules set contra_ledger_id = p_target_ledger_id
    where contra_ledger_id = p_source_ledger_id and company_id = p_company_id;

  -- Both balances collapsed onto one signed number — debit positive, credit
  -- negative — added, then split back into amount + side. This is the
  -- combined balance the two ledgers carried in, and the postings just moved
  -- above are exactly what happened *since* the two opening figures, so the
  -- target's life-to-date balance after this is identical to what the two
  -- ledgers summed to before it.
  v_signed_opening :=
    (v_target.opening_balance_amount * case when v_target.opening_balance_type = 'debit' then 1 else -1 end)
    + (v_source.opening_balance_amount * case when v_source.opening_balance_type = 'debit' then 1 else -1 end);

  -- Contact fields fill in the target's blanks from the source rather than
  -- overwrite anything the target already has — the point is not to lose the
  -- one copy of a phone number or address that existed, not to decide which
  -- ledger's paperwork was more current.
  update public.ledgers
  set opening_balance_amount = abs(v_signed_opening),
      opening_balance_type = case when v_signed_opening >= 0 then 'debit' else 'credit' end,
      contact_person = coalesce(v_target.contact_person, v_source.contact_person),
      phone = coalesce(v_target.phone, v_source.phone),
      email = coalesce(v_target.email, v_source.email),
      address = coalesce(v_target.address, v_source.address)
  where id = p_target_ledger_id and company_id = p_company_id;

  delete from public.ledgers where id = p_source_ledger_id and company_id = p_company_id;
end;
$$;

revoke execute on function public.merge_ledgers(uuid, uuid, uuid) from public;
grant execute on function public.merge_ledgers(uuid, uuid, uuid) to authenticated;
