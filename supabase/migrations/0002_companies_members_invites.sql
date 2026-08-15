-- COMPANIES
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  financial_year_start_month smallint not null default 4 check (financial_year_start_month between 1 and 12),
  base_currency char(3) not null default 'INR',
  book_beginning_date date not null,
  lock_date date null,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at
  before update on public.companies
  for each row execute function app_private.set_updated_at();

-- PROFILES (mirrors auth.users so app code never needs direct auth-schema reads)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create or replace function app_private.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_private.handle_new_user();

-- COMPANY MEMBERS
create table public.company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','accountant','auditor')),
  status text not null default 'active' check (status in ('active','revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id),
  unique (id, company_id)
);

create index company_members_user_id_idx on public.company_members(user_id);

create trigger set_updated_at
  before update on public.company_members
  for each row execute function app_private.set_updated_at();

-- Guard against removing/demoting the last active admin of a company —
-- without this a company could become permanently unmanageable.
create or replace function app_private.guard_last_admin()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company_id uuid := coalesce(old.company_id, new.company_id);
  v_remaining_admins integer;
begin
  if old.role = 'admin' and old.status = 'active' then
    if (TG_OP = 'DELETE')
       or (new.role is distinct from 'admin')
       or (new.status is distinct from 'active') then
      select count(*) into v_remaining_admins
        from public.company_members
        where company_id = v_company_id
          and role = 'admin'
          and status = 'active'
          and id is distinct from old.id;
      if v_remaining_admins = 0 then
        raise exception 'Cannot remove the last active admin of a company';
      end if;
    end if;
  end if;

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger guard_last_admin
  before update or delete on public.company_members
  for each row execute function app_private.guard_last_admin();

-- COMPANY INVITES (email-based, works even before the invitee has an account).
-- Plain text + lower() for case-insensitive matching, not citext — citext's
-- type name doesn't resolve inside security-definer functions pinned to an
-- empty search_path, and this avoids that entirely.
create table public.company_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','accountant','auditor')),
  token uuid not null default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid not null references auth.users(id),
  accepted_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create unique index company_invites_token_idx on public.company_invites(token);
create unique index company_invites_pending_unique_idx
  on public.company_invites(company_id, lower(email))
  where status = 'pending';

-- RLS HELPER FUNCTIONS (security definer so they don't recurse into RLS on
-- company_members when used inside that table's own policies; wrapped in
-- `(select ...)` at call sites so Postgres treats them as an init-plan
-- evaluated once per statement, not once per row)
create or replace function app_private.is_company_member(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select exists (
    select 1 from public.company_members
    where company_id = p_company_id and user_id = auth.uid() and status = 'active'
  );
$$;

create or replace function app_private.user_role_in_company(p_company_id uuid)
returns text
language sql security definer set search_path = '' stable
as $$
  select role from public.company_members
  where company_id = p_company_id and user_id = auth.uid() and status = 'active';
$$;

create or replace function app_private.is_company_admin(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select app_private.user_role_in_company(p_company_id) = 'admin';
$$;

create or replace function app_private.can_write_company(p_company_id uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select app_private.user_role_in_company(p_company_id) in ('admin','accountant');
$$;

-- RPCs solving the "join a company you're not a member of yet" chicken-and-egg
-- problem under RLS. security definer is deliberate here (contrast with the
-- voucher RPCs later, which are security invoker).
create or replace function public.create_company(
  p_name text,
  p_book_beginning_date date,
  p_financial_year_start_month smallint default 4,
  p_base_currency char(3) default 'INR'
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

  insert into public.companies (name, book_beginning_date, financial_year_start_month, base_currency, created_by)
  values (p_name, p_book_beginning_date, p_financial_year_start_month, p_base_currency, auth.uid())
  returning id into v_company_id;

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_company_id, auth.uid(), 'admin', 'active', auth.uid());

  return v_company_id;
end;
$$;

create or replace function public.accept_company_invite(p_token uuid)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_invite public.company_invites;
  v_user_email text;
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to accept an invite';
  end if;

  select * into v_invite from public.company_invites where token = p_token for update;

  if v_invite is null then
    raise exception 'Invite not found';
  end if;
  if v_invite.status <> 'pending' then
    raise exception 'Invite is no longer pending';
  end if;
  if v_invite.expires_at < now() then
    update public.company_invites set status = 'expired' where id = v_invite.id;
    raise exception 'Invite has expired';
  end if;

  select email into v_user_email from auth.users where id = auth.uid();
  if lower(v_user_email) is distinct from lower(v_invite.email) then
    raise exception 'This invite was sent to a different email address';
  end if;

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_invite.company_id, auth.uid(), v_invite.role, 'active', v_invite.invited_by)
  on conflict (company_id, user_id) do update
    set role = excluded.role, status = 'active';

  update public.company_invites
    set status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
    where id = v_invite.id;

  return v_invite.company_id;
end;
$$;
