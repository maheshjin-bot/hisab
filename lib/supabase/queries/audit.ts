import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/** The four tables that carry an audit trigger (0007_import_staging_and_audit). */
export const AUDITED_TABLES = ["vouchers", "voucher_entries", "ledgers", "company_members"] as const;
export type AuditedTable = (typeof AUDITED_TABLES)[number];

export type AuditAction = "INSERT" | "UPDATE" | "DELETE";

export interface AuditEntry {
  id: string;
  tableName: string;
  recordId: string;
  action: AuditAction;
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: string;
}

export interface ListAuditParams {
  tableName?: AuditedTable;
  action?: AuditAction;
  recordId?: string;
  fromDate?: string;
  toDate?: string;
  page: number;
  pageSize: number;
}

type AuditRow = Database["public"]["Tables"]["audit_log"]["Row"];

function mapEntry(row: AuditRow, names: Map<string, string | null>): AuditEntry {
  return {
    id: row.id,
    tableName: row.table_name,
    recordId: row.record_id,
    action: row.action as AuditAction,
    oldData: row.old_data as Record<string, unknown> | null,
    newData: row.new_data as Record<string, unknown> | null,
    changedBy: row.changed_by,
    changedByName: row.changed_by ? (names.get(row.changed_by) ?? null) : null,
    changedAt: row.changed_at,
  };
}

/**
 * Looks up display names for the users who made these changes.
 *
 * audit_log.changed_by references auth.users, not public.profiles, so
 * PostgREST can't embed the profile — there is no foreign key between the two
 * for it to follow. One extra query over the distinct ids is cheaper than
 * adding a redundant FK to satisfy the query planner, and profiles_select
 * already limits this to people who share a company with the caller.
 */
async function resolveUserNames(
  supabase: SupabaseClient<Database>,
  rows: AuditRow[]
): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map((r) => r.changed_by).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", ids);
  // A missing name is cosmetic — the entry still shows what changed and when,
  // so this must not take the whole history down with it.
  if (error) return new Map();

  return new Map((data ?? []).map((p) => [p.id, p.full_name]));
}

/**
 * The company's change history, newest first.
 *
 * Only admins and auditors can read audit_log at all — audit_log_select gates
 * it on user_role_in_company — so this needs no role check of its own; an
 * accountant simply gets zero rows.
 */
export async function listAuditLog(
  supabase: SupabaseClient<Database>,
  companyId: string,
  params: ListAuditParams
): Promise<{ rows: AuditEntry[]; total: number }> {
  let query = supabase
    .from("audit_log")
    .select("*", { count: "exact" })
    .eq("company_id", companyId);

  if (params.tableName) query = query.eq("table_name", params.tableName);
  if (params.action) query = query.eq("action", params.action);
  if (params.recordId) query = query.eq("record_id", params.recordId);
  // changed_at is a timestamptz; the to-date is made inclusive of the whole day.
  if (params.fromDate) query = query.gte("changed_at", `${params.fromDate}T00:00:00Z`);
  if (params.toDate) query = query.lte("changed_at", `${params.toDate}T23:59:59.999Z`);

  query = query.order("changed_at", { ascending: false });

  const from = params.page * params.pageSize;
  query = query.range(from, from + params.pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  const names = await resolveUserNames(supabase, data ?? []);
  return { rows: (data ?? []).map((row) => mapEntry(row, names)), total: count ?? 0 };
}

/**
 * The history of one voucher — its header plus all of its lines, which are
 * audited as separate voucher_entries rows against their own record ids.
 */
export async function getVoucherHistory(
  supabase: SupabaseClient<Database>,
  companyId: string,
  voucherId: string
): Promise<AuditEntry[]> {
  // Entry rows reference the voucher through new_data/old_data rather than
  // record_id, so they can't be found by record_id alone.
  const { data, error } = await supabase
    .from("audit_log")
    .select("*")
    .eq("company_id", companyId)
    .or(
      `record_id.eq.${voucherId},` +
        `new_data->>voucher_id.eq.${voucherId},` +
        `old_data->>voucher_id.eq.${voucherId}`
    )
    .order("changed_at", { ascending: false });
  if (error) throw error;
  const names = await resolveUserNames(supabase, data ?? []);
  return (data ?? []).map((row) => mapEntry(row, names));
}

/**
 * The fields that actually changed in an UPDATE.
 *
 * The trigger stores whole-row snapshots, so showing them raw would bury one
 * edited amount in twenty unchanged columns. Bookkeeping columns are dropped:
 * they change on every write and say nothing about what the user did.
 */
const NOISE_COLUMNS = new Set(["updated_at", "created_at", "updated_by", "created_by"]);

export function changedFields(entry: AuditEntry): { field: string; from: unknown; to: unknown }[] {
  if (entry.action !== "UPDATE" || !entry.oldData || !entry.newData) return [];

  const fields: { field: string; from: unknown; to: unknown }[] = [];
  for (const key of Object.keys(entry.newData)) {
    if (NOISE_COLUMNS.has(key)) continue;
    const before = entry.oldData[key];
    const after = entry.newData[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fields.push({ field: key, from: before, to: after });
    }
  }
  return fields;
}

/**
 * Columns the database maintains itself, so a change to them alone is the
 * system talking rather than a person.
 *
 * vouchers.total_amount is written by check_voucher_balance() immediately
 * after every insert, which is why each created voucher is followed by an
 * UPDATE that touches nothing else. These rows are still shown — suppressing
 * entries from an audit log defeats the point of having one — but they are
 * labelled so an auditor isn't left reading "Edited" thirteen times for
 * thirteen vouchers nobody edited.
 */
const DERIVED_COLUMNS: Record<string, Set<string>> = {
  vouchers: new Set(["total_amount"]),
};

export function isSystemChange(entry: AuditEntry): boolean {
  if (entry.action !== "UPDATE") return false;
  const changes = changedFields(entry);
  if (changes.length === 0) return true;
  const derived = DERIVED_COLUMNS[entry.tableName];
  return !!derived && changes.every((c) => derived.has(c.field));
}
