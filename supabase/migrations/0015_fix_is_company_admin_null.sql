-- Security fix: app_private.is_company_admin() returned NULL, not false, for
-- a user who is not a member of the company at all.
--
--   select app_private.user_role_in_company(p_company_id) = 'admin'
--
-- user_role_in_company() returns NULL when there is no active membership row,
-- and `NULL = 'admin'` is NULL rather than false.
--
-- In an RLS policy that is harmless — a NULL USING/WITH CHECK qualifier is
-- treated as "no rows" — which is why every policy written against this
-- helper has always been safe.
--
-- In PL/pgSQL it is not harmless. The natural guard
--
--   if not app_private.is_company_admin(p_company_id) then
--     raise exception '...';
--   end if;
--
-- evaluates `not NULL` -> NULL, the branch is not taken, and the function
-- carries on as though the caller were an admin. A non-member could therefore
-- reach restore_company_backup()'s overwrite path and
-- revert_company_changes_since(), both of which destroy data.
--
-- Found by testing the guard with a real non-member rather than assuming it
-- held.
--
-- Two changes, deliberately overlapping: the helper now answers false instead
-- of NULL, and both callers test `is not true` so they stay correct even if
-- some future helper reintroduces a NULL.

create or replace function app_private.is_company_admin(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select coalesce(app_private.user_role_in_company(p_company_id) = 'admin', false);
$$;

-- can_write_company has the same shape and the same latent problem, even
-- though nothing calls it from PL/pgSQL today.
create or replace function app_private.can_write_company(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select coalesce(app_private.user_role_in_company(p_company_id) in ('admin','accountant'), false);
$$;
