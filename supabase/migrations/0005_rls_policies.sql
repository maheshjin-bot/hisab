alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.company_members enable row level security;
alter table public.company_invites enable row level security;
alter table public.account_groups enable row level security;
alter table public.ledgers enable row level security;
alter table public.vouchers enable row level security;
alter table public.voucher_entries enable row level security;
alter table public.voucher_number_sequences enable row level security;
-- voucher_number_sequences gets no policies at all: it's only ever touched by
-- the security-definer next_voucher_number() function, which bypasses RLS
-- for its own reads/writes. Direct client access is fully denied by default.

-- COMPANIES — creation only via create_company() (security definer), so no
-- insert policy. No delete policy: soft-deactivate via the update policy.
create policy companies_select on public.companies for select
  using ((select app_private.is_company_member(id)));

create policy companies_update on public.companies for update
  using ((select app_private.is_company_admin(id)))
  with check ((select app_private.is_company_admin(id)));

-- PROFILES — visible to yourself, and to anyone who shares a company with
-- you (so member lists / "created by" attributions can show real names).
create policy profiles_select on public.profiles for select
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.company_members cm1
      join public.company_members cm2 on cm1.company_id = cm2.company_id
      where cm1.user_id = (select auth.uid()) and cm1.status = 'active'
        and cm2.user_id = profiles.id and cm2.status = 'active'
    )
  );

create policy profiles_update on public.profiles for update
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- COMPANY MEMBERS
create policy company_members_select on public.company_members for select
  using (
    user_id = (select auth.uid())
    or (select app_private.is_company_admin(company_id))
  );

create policy company_members_insert on public.company_members for insert
  with check ((select app_private.is_company_admin(company_id)));

create policy company_members_update on public.company_members for update
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

create policy company_members_delete on public.company_members for delete
  using ((select app_private.is_company_admin(company_id)));

-- COMPANY INVITES — auth.jwt() for the caller's own email, not auth.users
-- (the authenticated role has no SELECT grant on auth.users).
create policy company_invites_select on public.company_invites for select
  using (
    (select app_private.is_company_admin(company_id))
    or lower(email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
  );

create policy company_invites_insert on public.company_invites for insert
  with check ((select app_private.is_company_admin(company_id)) and invited_by = (select auth.uid()));

create policy company_invites_update on public.company_invites for update
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

create policy company_invites_delete on public.company_invites for delete
  using ((select app_private.is_company_admin(company_id)));

-- ACCOUNT GROUPS — is_system=true is also blocked at the trigger level
-- (app_private.protect_system_group); blocking it here too via WITH CHECK is
-- defense in depth. The seed function is security definer and bypasses RLS
-- entirely, so this doesn't affect seeding.
create policy account_groups_select on public.account_groups for select
  using ((select app_private.is_company_member(company_id)));

create policy account_groups_insert on public.account_groups for insert
  with check ((select app_private.can_write_company(company_id)) and is_system = false);

create policy account_groups_update on public.account_groups for update
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

create policy account_groups_delete on public.account_groups for delete
  using ((select app_private.can_write_company(company_id)));

-- LEDGERS — financial-field lock (opening balance / group) is admin-only via
-- the app_private.protect_ledger_financial_fields trigger, not RLS, since RLS
-- can't distinguish which columns changed within one UPDATE policy.
create policy ledgers_select on public.ledgers for select
  using ((select app_private.is_company_member(company_id)));

create policy ledgers_insert on public.ledgers for insert
  with check ((select app_private.can_write_company(company_id)));

create policy ledgers_update on public.ledgers for update
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

create policy ledgers_delete on public.ledgers for delete
  using ((select app_private.can_write_company(company_id)));

-- VOUCHERS — no delete policy: real DELETE is always denied, "delete" in the
-- app is UPDATE is_deleted=true, itself governed by the same lock-date rule.
create policy vouchers_select on public.vouchers for select
  using ((select app_private.is_company_member(company_id)));

create policy vouchers_insert on public.vouchers for insert
  with check (
    (select app_private.can_write_company(company_id))
    and (
      (select app_private.is_company_admin(company_id))
      or voucher_date > coalesce((select lock_date from public.companies where id = vouchers.company_id), '1900-01-01')
    )
  );

create policy vouchers_update on public.vouchers for update
  using (
    (select app_private.can_write_company(company_id))
    and (
      (select app_private.is_company_admin(company_id))
      or voucher_date > coalesce((select lock_date from public.companies where id = vouchers.company_id), '1900-01-01')
    )
  )
  with check (
    (select app_private.can_write_company(company_id))
    and (
      (select app_private.is_company_admin(company_id))
      or voucher_date > coalesce((select lock_date from public.companies where id = vouchers.company_id), '1900-01-01')
    )
  );

-- VOUCHER ENTRIES — mirrors the parent voucher's lock-date rule. DELETE is
-- allowed (unlike vouchers) because update_voucher()'s atomic "replace all
-- lines" flow needs it; the voucher header itself is still never hard-deleted.
create policy voucher_entries_select on public.voucher_entries for select
  using ((select app_private.is_company_member(company_id)));

create policy voucher_entries_insert on public.voucher_entries for insert
  with check (
    (select app_private.can_write_company(company_id))
    and exists (
      select 1 from public.vouchers v
      where v.id = voucher_entries.voucher_id and v.company_id = voucher_entries.company_id
        and (
          (select app_private.is_company_admin(v.company_id))
          or v.voucher_date > coalesce((select lock_date from public.companies where id = v.company_id), '1900-01-01')
        )
    )
  );

create policy voucher_entries_update on public.voucher_entries for update
  using (
    (select app_private.can_write_company(company_id))
    and exists (
      select 1 from public.vouchers v
      where v.id = voucher_entries.voucher_id and v.company_id = voucher_entries.company_id
        and (
          (select app_private.is_company_admin(v.company_id))
          or v.voucher_date > coalesce((select lock_date from public.companies where id = v.company_id), '1900-01-01')
        )
    )
  );

create policy voucher_entries_delete on public.voucher_entries for delete
  using (
    (select app_private.can_write_company(company_id))
    and exists (
      select 1 from public.vouchers v
      where v.id = voucher_entries.voucher_id and v.company_id = voucher_entries.company_id
        and (
          (select app_private.is_company_admin(v.company_id))
          or v.voucher_date > coalesce((select lock_date from public.companies where id = v.company_id), '1900-01-01')
        )
    )
  );
