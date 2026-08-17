import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export type VoucherType = "receipt" | "payment" | "contra" | "journal" | "sales" | "purchase";

export interface VoucherLineInput {
  ledgerId: string;
  debitAmount: number;
  creditAmount: number;
  narration?: string;
  lineOrder?: number;
}

export interface VoucherFormInput {
  companyId: string;
  voucherType: VoucherType;
  voucherDate: string;
  narration?: string;
  referenceNumber?: string;
  referenceDate?: string;
  lines: VoucherLineInput[];
}

export interface VoucherListItem {
  id: string;
  voucherType: VoucherType;
  voucherNumber: string;
  voucherDate: string;
  narration: string | null;
  totalAmount: number;
}

function toRpcLines(lines: VoucherLineInput[]) {
  return lines.map((l, i) => ({
    ledger_id: l.ledgerId,
    debit_amount: l.debitAmount,
    credit_amount: l.creditAmount,
    narration: l.narration ?? null,
    line_order: l.lineOrder ?? i,
  }));
}

/**
 * The generated RPC Args types are all `string` (never `string | null`) even
 * for parameters whose underlying SQL column is nullable and genuinely meant
 * to receive NULL — Supabase's type generator doesn't model function-arg
 * nullability. Postgres accepts an explicit null at runtime regardless; this
 * just asserts past that generator gap in one named place instead of at
 * every call site.
 */
function nullable<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) return null as T;
  // An empty string is the form saying "not filled in", not a value. The
  // voucher form defaults referenceDate and referenceNumber to "", and
  // Postgres rejects '' for a date outright — `invalid input syntax for type
  // date: ""` — so saving any voucher without a reference date failed.
  if (typeof value === "string" && value.trim() === "") return null as T;
  return value;
}

/** Header + all lines, committed atomically — never build this from separate .insert() calls (see migration 0004). */
export async function createVoucher(supabase: SupabaseClient<Database>, input: VoucherFormInput): Promise<string> {
  const { data, error } = await supabase.rpc("create_voucher", {
    p_company_id: input.companyId,
    p_voucher_type: input.voucherType,
    p_voucher_date: input.voucherDate,
    p_narration: nullable(input.narration),
    p_reference_number: nullable(input.referenceNumber),
    p_reference_date: nullable(input.referenceDate),
    p_lines: toRpcLines(input.lines),
  });
  if (error) throw error;
  return data as string;
}

/** Replaces date/narration/reference + the full line set atomically. voucher_type is immutable post-creation. */
export async function updateVoucher(
  supabase: SupabaseClient<Database>,
  voucherId: string,
  input: Omit<VoucherFormInput, "companyId" | "voucherType">
): Promise<void> {
  const { error } = await supabase.rpc("update_voucher", {
    p_voucher_id: voucherId,
    p_voucher_date: input.voucherDate,
    p_narration: nullable(input.narration),
    p_reference_number: nullable(input.referenceNumber),
    p_reference_date: nullable(input.referenceDate),
    p_lines: toRpcLines(input.lines),
  });
  if (error) throw error;
}

/** The only "delete" a voucher ever gets — real DELETE is denied by RLS. */
export async function softDeleteVoucher(supabase: SupabaseClient<Database>, voucherId: string): Promise<void> {
  const { error } = await supabase.from("vouchers").update({ is_deleted: true }).eq("id", voucherId);
  if (error) throw error;
}

export interface ListVouchersParams {
  voucherType?: VoucherType;
  fromDate?: string;
  toDate?: string;
  page: number;
  pageSize: number;
}

export async function listVouchers(
  supabase: SupabaseClient<Database>,
  companyId: string,
  params: ListVouchersParams
): Promise<{ rows: VoucherListItem[]; total: number }> {
  let query = supabase
    .from("vouchers")
    .select("id, voucher_type, voucher_number, voucher_date, narration, total_amount", { count: "exact" })
    .eq("company_id", companyId)
    .eq("is_deleted", false);

  if (params.voucherType) query = query.eq("voucher_type", params.voucherType);
  if (params.fromDate) query = query.gte("voucher_date", params.fromDate);
  if (params.toDate) query = query.lte("voucher_date", params.toDate);

  query = query.order("voucher_date", { ascending: false }).order("sequence_number", { ascending: false });

  const from = params.page * params.pageSize;
  const to = from + params.pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    rows: (data ?? []).map((r) => ({
      id: r.id,
      voucherType: r.voucher_type as VoucherType,
      voucherNumber: r.voucher_number,
      voucherDate: r.voucher_date,
      narration: r.narration,
      totalAmount: r.total_amount,
    })),
    total: count ?? 0,
  };
}

export interface VoucherWithLines {
  id: string;
  voucherType: VoucherType;
  voucherNumber: string;
  voucherDate: string;
  narration: string | null;
  referenceNumber: string | null;
  referenceDate: string | null;
  lines: (VoucherLineInput & { id: string; ledgerName: string })[];
}

export async function getVoucherById(supabase: SupabaseClient<Database>, voucherId: string): Promise<VoucherWithLines> {
  const { data: voucher, error: voucherError } = await supabase
    .from("vouchers")
    .select("*")
    .eq("id", voucherId)
    .single();
  if (voucherError) throw voucherError;

  const { data: lines, error: linesError } = await supabase
    .from("voucher_entries")
    .select("id, ledger_id, debit_amount, credit_amount, narration, line_order, ledgers(name)")
    .eq("voucher_id", voucherId)
    .order("line_order");
  if (linesError) throw linesError;

  return {
    id: voucher.id,
    voucherType: voucher.voucher_type as VoucherType,
    voucherNumber: voucher.voucher_number,
    voucherDate: voucher.voucher_date,
    narration: voucher.narration,
    referenceNumber: voucher.reference_number,
    referenceDate: voucher.reference_date,
    lines: (lines ?? []).map((l) => ({
      id: l.id,
      ledgerId: l.ledger_id,
      debitAmount: l.debit_amount,
      creditAmount: l.credit_amount,
      narration: l.narration ?? undefined,
      lineOrder: l.line_order,
      ledgerName: l.ledgers?.name ?? "",
    })),
  };
}

export interface VoucherCsvLine {
  /** 1-based, header = row 1 — the number the user sees in Excel. */
  rowNumber: number;
  groupId: string;
  date: string;
  voucherType: VoucherType;
  ledgerId: string;
  drCr: "Dr" | "Cr";
  amount: number;
  narration?: string;
  /** Per-voucher, not per-line — the importer makes every row of a group agree on them. */
  referenceNumber?: string;
  referenceDate?: string;
}

/**
 * Groups CSV rows by their voucher-ref column and commits one voucher per
 * group via the same atomic createVoucher() every manual entry uses, so
 * imported vouchers get identical double-entry guarantees for free. Errors
 * are per-voucher (a whole group either commits or doesn't), not per-row.
 */
/**
 * Creates every voucher in a validated CSV in one round trip.
 *
 * This used to loop create_voucher once per voucher group, so a
 * 2,000-voucher file was 2,000 sequential requests. create_vouchers_bulk()
 * does the loop server-side and returns one row per group, so partial
 * failures are still reported per voucher rather than collapsing into
 * "the import failed" — the progress contract the modal relies on is
 * unchanged, it just advances in one step now.
 */
export async function bulkImportVouchers(
  supabase: SupabaseClient<Database>,
  companyId: string,
  rows: VoucherCsvLine[],
  onProgress?: (done: number, total: number) => void
): Promise<{ insertedCount: number; failedCount: number; errors: { rowNumber: number; message: string }[] }> {
  const groups = new Map<string, VoucherCsvLine[]>();
  for (const row of rows) {
    const existing = groups.get(row.groupId);
    if (existing) existing.push(row);
    else groups.set(row.groupId, [row]);
  }

  const total = groups.size;
  onProgress?.(0, total);

  const payload = [...groups.entries()].map(([groupId, groupRows]) => ({
    group_key: groupId,
    voucher_type: groupRows[0].voucherType,
    voucher_date: groupRows[0].date,
    narration: groupRows[0].narration ?? null,
    reference_number: groupRows[0].referenceNumber ?? null,
    reference_date: groupRows[0].referenceDate ?? null,
    lines: groupRows.map((r, i) => ({
      ledger_id: r.ledgerId,
      debit_amount: r.drCr === "Dr" ? r.amount : 0,
      credit_amount: r.drCr === "Cr" ? r.amount : 0,
      narration: r.narration ?? null,
      line_order: i,
    })),
  }));

  const { data, error } = await supabase.rpc("create_vouchers_bulk", {
    p_company_id: companyId,
    p_groups: payload,
  });
  if (error) throw error;

  const results = (data ?? []) as { group_key: string; voucher_id: string | null; error_message: string | null }[];

  let insertedCount = 0;
  const errors: { rowNumber: number; message: string }[] = [];

  for (const result of results) {
    const groupRows = groups.get(result.group_key) ?? [];
    if (result.error_message) {
      // A whole group either commits or doesn't, so there is no single
      // offending line — but the error still has to land on a row the user
      // can find, and row 0 is not one (the header is row 1).
      const rowNumber = groupRows[0]?.rowNumber ?? 0;
      errors.push({ rowNumber, message: `Voucher ${result.group_key}: ${result.error_message}` });
    } else {
      insertedCount += groupRows.length;
    }
  }

  onProgress?.(total, total);

  return { insertedCount, failedCount: errors.length, errors };
}
