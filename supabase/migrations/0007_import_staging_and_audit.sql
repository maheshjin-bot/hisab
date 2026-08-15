-- IMPORT STAGING — an audit/history record of CSV imports, written by the
-- client alongside its commit flow. NOT a pre-commit validation gate: the
-- real dry-run validation is client-side (Zod, against live-fetched context
-- like the ledger-name index), and the database's own constraints (unique
-- ledger names, FK validity, the double-entry balance triggers) are the
-- final authoritative backstop at actual insert time either way. This is a
-- deliberate simplification from a heavier "stage then validate server-side
-- then commit" design — the DB enforces correctness regardless of which side
-- initiates the write, so a second server-side validation pass over staged
-- rows would duplicate rules already expressed once, in Zod.
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  import_type text not null check (import_type in ('ledgers','opening_balances','vouchers')),
  file_name text,
  status text not null default 'validating' check (status in ('validating','validated','committing','committed','failed','cancelled')),
  row_count integer not null default 0,
  error_count integer not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  unique (id, company_id)
);

create index import_batches_company_idx on public.import_batches(company_id);

create table public.import_batch_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  company_id uuid not null,
  row_number integer not null,
  raw_data jsonb not null,
  validation_status text not null default 'pending' check (validation_status in ('pending','valid','error')),
  validation_errors jsonb,
  resolved_entity_id uuid,
  unique (batch_id, row_number),
  foreign key (batch_id, company_id) references public.import_batches (id, company_id) on delete cascade
);

create index import_batch_rows_batch_idx on public.import_batch_rows(batch_id);

alter table public.import_batches enable row level security;
alter table public.import_batch_rows enable row level security;

create policy import_batches_select on public.import_batches for select
  using ((select app_private.is_company_member(company_id)));
create policy import_batches_insert on public.import_batches for insert
  with check ((select app_private.can_write_company(company_id)));
create policy import_batches_update on public.import_batches for update
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));
create policy import_batches_delete on public.import_batches for delete
  using ((select app_private.can_write_company(company_id)));

create policy import_batch_rows_select on public.import_batch_rows for select
  using ((select app_private.is_company_member(company_id)));
create policy import_batch_rows_insert on public.import_batch_rows for insert
  with check ((select app_private.can_write_company(company_id)));
create policy import_batch_rows_update on public.import_batch_rows for update
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));
create policy import_batch_rows_delete on public.import_batch_rows for delete
  using ((select app_private.can_write_company(company_id)));

-- AUDIT LOG — generic trigger-fed, immutable from the client (no insert/
-- update/delete policy at all; only the security-definer trigger function
-- writes to it, which bypasses RLS regardless). Readable by admin + auditor,
-- matching the spec's read-only Auditor role wanting change history.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  table_name text not null,
  record_id uuid not null,
  action text not null check (action in ('INSERT','UPDATE','DELETE')),
  old_data jsonb,
  new_data jsonb,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index audit_log_company_idx on public.audit_log(company_id, changed_at desc);
create index audit_log_record_idx on public.audit_log(table_name, record_id);

create or replace function app_private.record_audit_log()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  v_company_id := case when TG_OP = 'DELETE' then old.company_id else new.company_id end;

  insert into public.audit_log (company_id, table_name, record_id, action, old_data, new_data, changed_by)
  values (
    v_company_id,
    TG_TABLE_NAME,
    case when TG_OP = 'DELETE' then old.id else new.id end,
    TG_OP,
    case when TG_OP in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when TG_OP in ('UPDATE','INSERT') then to_jsonb(new) else null end,
    auth.uid()
  );

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger audit_vouchers
  after insert or update or delete on public.vouchers
  for each row execute function app_private.record_audit_log();

create trigger audit_voucher_entries
  after insert or update or delete on public.voucher_entries
  for each row execute function app_private.record_audit_log();

create trigger audit_ledgers
  after insert or update or delete on public.ledgers
  for each row execute function app_private.record_audit_log();

create trigger audit_company_members
  after insert or update or delete on public.company_members
  for each row execute function app_private.record_audit_log();

alter table public.audit_log enable row level security;

create policy audit_log_select on public.audit_log for select
  using ((select app_private.user_role_in_company(company_id)) in ('admin','auditor'));
