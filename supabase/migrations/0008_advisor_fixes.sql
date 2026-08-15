-- Follow-up pass after running the Supabase security + performance advisors
-- post-migration. voucher_number_sequences having RLS-enabled-no-policy is
-- intentional (only the security-definer next_voucher_number() ever touches
-- it) and isn't addressed here; likewise the two remaining
-- authenticated_security_definer_function_executable warnings on
-- create_company/accept_company_invite are by design — those RPCs exist
-- specifically to be called by authenticated users to solve the
-- "join a company you're not a member of yet" bootstrapping problem.

-- Covering indexes for FKs the performance advisor flagged.
create index account_groups_parent_company_idx on public.account_groups(parent_group_id, company_id);
create index audit_log_changed_by_idx on public.audit_log(changed_by);
create index companies_created_by_idx on public.companies(created_by);
create index company_invites_accepted_by_idx on public.company_invites(accepted_by);
create index company_invites_invited_by_idx on public.company_invites(invited_by);
create index company_members_invited_by_idx on public.company_members(invited_by);
create index import_batch_rows_batch_company_idx on public.import_batch_rows(batch_id, company_id);
create index import_batches_created_by_idx on public.import_batches(created_by);
create index ledgers_created_by_idx on public.ledgers(created_by);
create index ledgers_group_company_idx on public.ledgers(group_id, company_id);
create index voucher_entries_ledger_company_idx on public.voucher_entries(ledger_id, company_id);
create index voucher_entries_voucher_company_idx on public.voucher_entries(voucher_id, company_id);
create index vouchers_created_by_idx on public.vouchers(created_by);
create index vouchers_updated_by_idx on public.vouchers(updated_by);

-- Pin search_path on the one function that was missed earlier (low actual
-- risk — security invoker, only touches NEW.updated_at — but consistent
-- hygiene, and clears the advisor warning).
create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Both RPCs already self-guard with "if auth.uid() is null then raise
-- exception", so unauthenticated callers got a clean error either way — but
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, which anon inherits
-- regardless of anything revoked from anon specifically. Revoking from
-- PUBLIC actually closes it; authenticated gets it back explicitly.
revoke execute on function public.create_company(text, date, smallint, character) from public;
revoke execute on function public.accept_company_invite(uuid) from public;
grant execute on function public.create_company(text, date, smallint, character) to authenticated;
grant execute on function public.accept_company_invite(uuid) to authenticated;

-- Restructured to the unambiguous "(select auth.<fn>())" shape so the RLS
-- initplan optimization is guaranteed to apply (functionally identical to
-- the original, just a form the linter's pattern-match is certain to catch).
drop policy company_invites_select on public.company_invites;
create policy company_invites_select on public.company_invites for select
  using (
    (select app_private.is_company_admin(company_id))
    or lower(email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  );
