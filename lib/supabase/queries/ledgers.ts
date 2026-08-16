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

export interface AccountGroupInput {
  name: string;
  parentGroupId: string | null;
  ledgerRole: LedgerRole;
  sortOrder?: number;
}

/**
 * `nature` and `normal_balance` are deliberately absent from the insert: the
 * enforce_account_group_nature trigger overwrites nature with the parent's,
 * so sending one would only be a lie that the database silently corrects.
 * Every group created here is a sub-group — a new root would have no nature
 * to inherit, and the eight roots are seeded, system-owned and fixed.
 */
export async function createAccountGroup(
  supabase: SupabaseClient<Database>,
  companyId: string,
  input: AccountGroupInput & { parentGroupId: string }
): Promise<string> {
  const parent = await getAccountGroupById(supabase, input.parentGroupId);

  const { data, error } = await supabase
    .from("account_groups")
    .insert({
      company_id: companyId,
      parent_group_id: input.parentGroupId,
      name: input.name,
      // Both are NOT NULL with no default, so they have to be supplied even
      // though the trigger then replaces nature with the parent's.
      nature: parent.nature,
      normal_balance: parent.normalBalance,
      ledger_role: input.ledgerRole,
      sort_order: input.sortOrder ?? 0,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateAccountGroup(
  supabase: SupabaseClient<Database>,
  groupId: string,
  input: Partial<AccountGroupInput>
): Promise<void> {
  const patch: Database["public"]["Tables"]["account_groups"]["Update"] = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.parentGroupId !== undefined) patch.parent_group_id = input.parentGroupId;
  if (input.ledgerRole !== undefined) patch.ledger_role = input.ledgerRole;
  if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;

  const { error } = await supabase.from("account_groups").update(patch).eq("id", groupId);
  if (error) throw error;
}

export async function deleteAccountGroup(
  supabase: SupabaseClient<Database>,
  groupId: string
): Promise<void> {
  const { error } = await supabase.from("account_groups").delete().eq("id", groupId);
  if (error) throw error;
}

export async function getAccountGroupById(
  supabase: SupabaseClient<Database>,
  groupId: string
): Promise<AccountGroup & { normalBalance: "debit" | "credit" }> {
  const { data, error } = await supabase
    .from("account_groups")
    .select("*")
    .eq("id", groupId)
    .single();
  if (error) throw error;
  return { ...mapGroup(data), normalBalance: data.normal_balance as "debit" | "credit" };
}

/** How many ledgers sit in each group — a group with ledgers can't be deleted. */
export async function getLedgerCountsByGroup(
  supabase: SupabaseClient<Database>,
  companyId: string
): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("ledgers")
    .select("group_id")
    .eq("company_id", companyId);
  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data ?? []) counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1);
  return counts;
}

export interface SearchLedgersParams {
  q?: string;
  groupId?: string;
  page: number;
  pageSize: number;
  sortBy?: "name" | "group";
  sortDir?: "asc" | "desc";
}

/**
 * Every ledger name in the company, for the CSV importer's duplicate check.
 *
 * Names only, and no pagination: the check has to see the whole company or it
 * waves through a duplicate that the unique index then rejects mid-commit as
 * a raw Postgres error.
 */
export async function getAllLedgerNames(
  supabase: SupabaseClient<Database>,
  companyId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("ledgers")
    .select("name")
    .eq("company_id", companyId);
  if (error) throw error;
  return (data ?? []).map((r) => r.name);
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

  // Sorting by "group" has to order on the joined group's name — group_id is
  // a UUID, so ordering by it produces an arbitrary sequence that merely looks
  // deterministic.
  //
  // The column is spelled "account_groups(name)", which is PostgREST's syntax
  // for ordering parent rows by a to-one embedded column. Not `referencedTable`
  // — that emits `account_groups.order=`, which orders rows *within* an
  // embedded collection and leaves the parent ordering untouched, so it would
  // have quietly sorted by ledger name instead.
  const ascending = (params.sortDir ?? "asc") === "asc";
  if (params.sortBy === "group") {
    // Ledger name breaks ties so pagination stays stable within a group.
    query = query.order("account_groups(name)", { ascending }).order("name", { ascending: true });
  } else {
    query = query.order("name", { ascending });
  }

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

/**
 * Empty string -> null for optional text columns.
 *
 * The ledger form and the CSV importer both default blank optional fields to
 * "" rather than undefined, and `ledgers_email_check` is
 * `email IS NULL OR email ~* '<address>'` — which "" satisfies neither way.
 * The result was that creating a ledger without an email failed outright,
 * with a 23514 the user saw only as "Those values aren't valid for this
 * record".
 *
 * Normalising here rather than in each form keeps the rule in one place: a
 * blank optional field means "not provided", which in SQL is null.
 */
export function nullIfBlank(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
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
      contact_person: nullIfBlank(input.contactPerson),
      phone: nullIfBlank(input.phone),
      email: nullIfBlank(input.email),
      address: nullIfBlank(input.address),
      notes: nullIfBlank(input.notes),
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
  if (input.contactPerson !== undefined) patch.contact_person = nullIfBlank(input.contactPerson);
  if (input.phone !== undefined) patch.phone = nullIfBlank(input.phone);
  if (input.email !== undefined) patch.email = nullIfBlank(input.email);
  if (input.address !== undefined) patch.address = nullIfBlank(input.address);
  if (input.notes !== undefined) patch.notes = nullIfBlank(input.notes);
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
    contact_person: nullIfBlank(r.contactPerson),
    phone: nullIfBlank(r.phone),
    email: nullIfBlank(r.email),
    address: nullIfBlank(r.address),
    notes: nullIfBlank(r.notes),
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
