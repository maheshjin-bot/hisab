import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export type LedgerRole =
  | "cash_bank" | "debtor" | "creditor" | "income" | "expense"
  | "capital" | "loan" | "fixed_asset" | "other";

export interface AccountGroup {
  id: string;
  name: string;
  parentGroupId: string | null;
  nature: string;
  ledgerRole: LedgerRole;
  statement: string;
  isSystem: boolean;
  sortOrder: number;
}

export interface Ledger {
  id: string;
  companyId: string;
  name: string;
  groupId: string;
  groupName?: string;
  openingBalanceAmount: number;
  openingBalanceType: "debit" | "credit";
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
}

export interface LedgerSearchResult {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  ledgerRole: LedgerRole;
}

function mapGroup(row: Database["public"]["Tables"]["account_groups"]["Row"]): AccountGroup {
  return {
    id: row.id,
    name: row.name,
    parentGroupId: row.parent_group_id,
    nature: row.nature,
    ledgerRole: row.ledger_role as LedgerRole,
    statement: row.statement ?? "",
    isSystem: row.is_system,
    sortOrder: row.sort_order,
  };
}

function mapLedger(
  row: Database["public"]["Tables"]["ledgers"]["Row"] & { account_groups?: { name: string } | null }
): Ledger {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    groupId: row.group_id,
    groupName: row.account_groups?.name,
    openingBalanceAmount: row.opening_balance_amount,
    openingBalanceType: row.opening_balance_type as "debit" | "credit",
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    isActive: row.is_active,
  };
}

/** Full flat group list for a company — used to build the hierarchy tree and the "New Group" parent picker. */
export async function getAllLedgerGroups(supabase: SupabaseClient<Database>, companyId: string): Promise<AccountGroup[]> {
  const { data, error } = await supabase
    .from("account_groups")
    .select("*")
    .eq("company_id", companyId)
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return (data ?? []).map(mapGroup);
}

export interface SearchLedgersParams {
  q?: string;
  groupId?: string;
  page: number;
  pageSize: number;
  sortBy?: "name" | "group";
  sortDir?: "asc" | "desc";
}

/** Server-paginated + searched — the Ledger Manager's main query, safe at "possibly thousands of ledgers" scale. */
export async function searchLedgers(
  supabase: SupabaseClient<Database>,
  companyId: string,
  params: SearchLedgersParams
): Promise<{ rows: Ledger[]; total: number }> {
  let query = supabase
    .from("ledgers")
    .select("*, account_groups(name)", { count: "exact" })
    .eq("company_id", companyId);

  if (params.q) query = query.ilike("name", `%${params.q}%`);
  if (params.groupId) query = query.eq("group_id", params.groupId);

  const sortColumn = params.sortBy === "group" ? "group_id" : "name";
  query = query.order(sortColumn, { ascending: (params.sortDir ?? "asc") === "asc" });

  const from = params.page * params.pageSize;
  const to = from + params.pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;

  return { rows: (data ?? []).map(mapLedger), total: count ?? 0 };
}

/** Async search for the voucher line grid's ledger combobox. */
export async function searchLedgersForCombobox(
  supabase: SupabaseClient<Database>,
  companyId: string,
  q: string,
  limit = 20
): Promise<LedgerSearchResult[]> {
  let query = supabase
    .from("ledgers")
    .select("id, name, group_id, account_groups(name, ledger_role)")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("name")
    .limit(limit);

  if (q) query = query.ilike("name", `%${q}%`);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    groupId: row.group_id,
    groupName: row.account_groups?.name ?? "",
    ledgerRole: (row.account_groups?.ledger_role ?? "other") as LedgerRole,
  }));
}

export async function getLedgerById(supabase: SupabaseClient<Database>, ledgerId: string): Promise<Ledger> {
  const { data, error } = await supabase
    .from("ledgers")
    .select("*, account_groups(name)")
    .eq("id", ledgerId)
    .single();
  if (error) throw error;
  return mapLedger(data);
}

export interface LedgerInput {
  name: string;
  groupId: string;
  openingBalanceAmount?: number;
  openingBalanceType?: "debit" | "credit";
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

export async function createLedger(
  supabase: SupabaseClient<Database>,
  companyId: string,
  input: LedgerInput
): Promise<string> {
  const { data, error } = await supabase
    .from("ledgers")
    .insert({
      company_id: companyId,
      name: input.name,
      group_id: input.groupId,
      opening_balance_amount: input.openingBalanceAmount ?? 0,
      opening_balance_type: input.openingBalanceType ?? "debit",
      contact_person: input.contactPerson,
      phone: input.phone,
      email: input.email,
      address: input.address,
      notes: input.notes,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateLedger(
  supabase: SupabaseClient<Database>,
  ledgerId: string,
  input: Partial<LedgerInput> & { isActive?: boolean }
): Promise<void> {
  const patch: Database["public"]["Tables"]["ledgers"]["Update"] = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.groupId !== undefined) patch.group_id = input.groupId;
  if (input.openingBalanceAmount !== undefined) patch.opening_balance_amount = input.openingBalanceAmount;
  if (input.openingBalanceType !== undefined) patch.opening_balance_type = input.openingBalanceType;
  if (input.contactPerson !== undefined) patch.contact_person = input.contactPerson;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.email !== undefined) patch.email = input.email;
  if (input.address !== undefined) patch.address = input.address;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.isActive !== undefined) patch.is_active = input.isActive;

  const { error } = await supabase.from("ledgers").update(patch).eq("id", ledgerId);
  if (error) throw error;
}

export interface BulkResult {
  insertedCount: number;
  failedCount: number;
  errors: { rowNumber: number; message: string }[];
}

/**
 * Ledger creation has no cross-row atomicity requirement (unlike vouchers),
 * so try one batched insert first; if the batch itself fails, fall back to
 * per-row inserts so a single bad row doesn't sink the whole import.
 */
export async function bulkInsertLedgers(
  supabase: SupabaseClient<Database>,
  companyId: string,
  rows: LedgerInput[]
): Promise<BulkResult> {
  const payload = rows.map((r) => ({
    company_id: companyId,
    name: r.name,
    group_id: r.groupId,
    opening_balance_amount: r.openingBalanceAmount ?? 0,
    opening_balance_type: r.openingBalanceType ?? "debit",
    contact_person: r.contactPerson,
    phone: r.phone,
    email: r.email,
    address: r.address,
    notes: r.notes,
  }));

  const { error, count } = await supabase.from("ledgers").insert(payload, { count: "exact" });
  if (!error) {
    return { insertedCount: count ?? payload.length, failedCount: 0, errors: [] };
  }

  const errors: BulkResult["errors"] = [];
  let insertedCount = 0;
  for (let i = 0; i < payload.length; i++) {
    const { error: rowError } = await supabase.from("ledgers").insert(payload[i]);
    if (rowError) errors.push({ rowNumber: i + 2, message: rowError.message });
    else insertedCount++;
  }
  return { insertedCount, failedCount: errors.length, errors };
}
