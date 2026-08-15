-- ACCOUNT GROUPS (hierarchical chart of accounts, tenant-scoped)
create table public.account_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  parent_group_id uuid null,
  name text not null,
  nature text not null check (nature in (
    'capital','current_asset','current_liability','fixed_asset',
    'direct_expense','direct_income','indirect_expense','indirect_income'
  )),
  normal_balance text not null check (normal_balance in ('debit','credit')),
  -- Second, finer classification (beyond `nature`) the voucher engine uses to
  -- filter/rank the ledger combobox per voucher side — e.g. Payment's
  -- Cash/Bank leg must hard-filter to just cash_bank, not all of
  -- "current_asset" which also contains debtors and loans.
  ledger_role text not null default 'other' check (ledger_role in (
    'cash_bank','debtor','creditor','income','expense','capital','loan','fixed_asset','other'
  )),
  statement text generated always as (
    case
      when nature in ('direct_income','direct_expense') then 'trading'
      when nature in ('indirect_income','indirect_expense') then 'profit_loss'
      else 'balance_sheet'
    end
  ) stored,
  is_system boolean not null default false,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (parent_group_id, company_id) references public.account_groups (id, company_id)
);

create unique index account_groups_root_name_idx on public.account_groups(company_id, name) where parent_group_id is null;
create unique index account_groups_child_name_idx on public.account_groups(company_id, parent_group_id, name) where parent_group_id is not null;
create index account_groups_nature_idx on public.account_groups(company_id, nature);

create trigger set_updated_at
  before update on public.account_groups
  for each row execute function app_private.set_updated_at();

-- A child group always inherits its parent's `nature` (a sub-group can't mix
-- classifications with its parent) and parent changes are cycle-guarded.
create or replace function app_private.enforce_account_group_nature()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_parent_nature text;
  v_ancestor uuid;
begin
  if new.parent_group_id is not null then
    select nature into v_parent_nature
      from public.account_groups
      where id = new.parent_group_id and company_id = new.company_id;

    if v_parent_nature is null then
      raise exception 'Parent group not found in this company';
    end if;

    new.nature := v_parent_nature;

    if TG_OP = 'UPDATE' then
      v_ancestor := new.parent_group_id;
      while v_ancestor is not null loop
        if v_ancestor = new.id then
          raise exception 'Cannot set parent_group_id: would create a cycle';
        end if;
        select parent_group_id into v_ancestor from public.account_groups where id = v_ancestor;
      end loop;
    end if;
  end if;

  return new;
end;
$$;

create trigger enforce_account_group_nature
  before insert or update of parent_group_id, nature on public.account_groups
  for each row execute function app_private.enforce_account_group_nature();

-- The 8 primary groups are protected from deletion/reclassification once seeded.
create or replace function app_private.protect_system_group()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if TG_OP = 'DELETE' then
    if old.is_system then
      raise exception 'Cannot delete a system account group';
    end if;
    return old;
  end if;

  if old.is_system and (
    new.nature is distinct from old.nature
    or new.parent_group_id is distinct from old.parent_group_id
    or new.is_system is distinct from old.is_system
  ) then
    raise exception 'Cannot change nature, parent, or system flag of a system account group';
  end if;
  return new;
end;
$$;

create trigger protect_system_group
  before update or delete on public.account_groups
  for each row execute function app_private.protect_system_group();

-- Pre-loads the Indian chart of accounts for a newly created company: the 8
-- primary groups (system-protected) plus the named sub-groups from the spec
-- (pre-seeded but ordinary editable/deletable rows).
create or replace function app_private.seed_chart_of_accounts(p_company_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_capital uuid;
  v_current_assets uuid;
  v_current_liabilities uuid;
  v_fixed_assets uuid;
begin
  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Capital Account', 'capital', 'credit', 'capital', true, 1)
  returning id into v_capital;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Current Assets', 'current_asset', 'debit', 'other', true, 2)
  returning id into v_current_assets;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Current Liabilities', 'current_liability', 'credit', 'other', true, 3)
  returning id into v_current_liabilities;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Fixed Assets', 'fixed_asset', 'debit', 'fixed_asset', true, 4)
  returning id into v_fixed_assets;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values
    (p_company_id, 'Direct Expenses', 'direct_expense', 'debit', 'expense', true, 5),
    (p_company_id, 'Direct Incomes', 'direct_income', 'credit', 'income', true, 6),
    (p_company_id, 'Indirect Expenses', 'indirect_expense', 'debit', 'expense', true, 7),
    (p_company_id, 'Indirect Incomes', 'indirect_income', 'credit', 'income', true, 8);

  insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values
    (p_company_id, v_current_assets, 'Bank Accounts', 'current_asset', 'debit', 'cash_bank', false, 1),
    (p_company_id, v_current_assets, 'Cash-in-Hand', 'current_asset', 'debit', 'cash_bank', false, 2),
    (p_company_id, v_current_assets, 'Sundry Debtors', 'current_asset', 'debit', 'debtor', false, 3),
    (p_company_id, v_current_assets, 'Loans & Advances', 'current_asset', 'debit', 'loan', false, 4),
    (p_company_id, v_current_liabilities, 'Sundry Creditors', 'current_liability', 'credit', 'creditor', false, 1),
    (p_company_id, v_current_liabilities, 'Provisions', 'current_liability', 'credit', 'other', false, 2),
    (p_company_id, v_current_liabilities, 'Outstanding Expenses', 'current_liability', 'credit', 'other', false, 3),
    (p_company_id, v_fixed_assets, 'Plant & Machinery', 'fixed_asset', 'debit', 'fixed_asset', false, 1),
    (p_company_id, v_fixed_assets, 'Office Equipment', 'fixed_asset', 'debit', 'fixed_asset', false, 2),
    (p_company_id, v_fixed_assets, 'Furniture', 'fixed_asset', 'debit', 'fixed_asset', false, 3);
end;
$$;

-- Now that account_groups exists, wire seeding into company creation so every
-- company always has its chart of accounts — no second app-level step to forget.
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

  perform app_private.seed_chart_of_accounts(v_company_id);

  return v_company_id;
end;
$$;

-- LEDGERS
create table public.ledgers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  group_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  opening_balance_amount numeric(18,2) not null default 0 check (opening_balance_amount >= 0),
  opening_balance_type text not null default 'debit' check (opening_balance_type in ('debit','credit')),
  contact_person text,
  phone text,
  email text check (email is null or email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  address text,
  notes text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (group_id, company_id) references public.account_groups (id, company_id)
);

create unique index ledgers_company_name_idx on public.ledgers(company_id, lower(name));
create index ledgers_company_active_idx on public.ledgers(company_id, is_active);
create index ledgers_company_group_idx on public.ledgers(company_id, group_id);

create trigger set_updated_at
  before update on public.ledgers
  for each row execute function app_private.set_updated_at();

-- Changing a ledger's opening balance or group after creation would
-- retroactively change every historical report, so it's admin-only.
create or replace function app_private.protect_ledger_financial_fields()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if (new.opening_balance_amount is distinct from old.opening_balance_amount
      or new.opening_balance_type is distinct from old.opening_balance_type
      or new.group_id is distinct from old.group_id)
     and not app_private.is_company_admin(new.company_id) then
    raise exception 'Only an admin can change a ledger''s opening balance or group';
  end if;
  return new;
end;
$$;

create trigger protect_ledger_financial_fields
  before update on public.ledgers
  for each row execute function app_private.protect_ledger_financial_fields();
