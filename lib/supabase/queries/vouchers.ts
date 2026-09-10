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

/**
 * One row of an itemised sales or purchase invoice.
 *
 * There is no `lineAmount`: `invoice_lines.line_amount` is
 * `generated always as (round(quantity * rate, 2) - discount_amount) stored`,
 * so supplying one is not merely redundant, it is rejected by Postgres. The
 * form previews the figure (see lib/voucher/invoice-schema.ts) and reads the
 * real one back after saving.
 */
export interface InvoiceLineInput {
  description: string;
  revenueLedgerId: string;
  quantity: number;
  unit?: string | null;
  rate: number;
  discountAmount: number;
  lineOrder?: number;
}

/** The party is debited on a sale and credited on a purchase, for the whole invoice. */
export interface InvoiceInput {
  partyLedgerId: string;
  lines: InvoiceLineInput[];
}

export interface VoucherFormInput {
  companyId: string;
  voucherType: VoucherType;
  voucherDate: string;
  narration?: string;
  referenceNumber?: string;
  referenceDate?: string;
  lines: VoucherLineInput[];
  /**
   * When present the voucher is posted from these instead of `lines`, which
   * must then be empty — create_voucher/update_voucher refuse a payload
   * carrying both, since that would be asking the database which of the two
   * the books should believe.
   */
  invoice?: InvoiceInput;
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
 * Builds the `p_invoice` payload.
 *
 * Two things this deliberately does not do. It never emits `line_amount` —
 * that column is generated, and a client-computed money figure is precisely
 * what migration 0021 exists to keep out of the books. And it doesn't round
 * `quantity` or `rate`: they go over as typed and Postgres settles them into
 * numeric(18,3) and numeric(18,4) exactly, which is a better rounding than
 * anything this can do to a value that is already a binary float.
 *
 * A blank unit becomes null rather than "": "1 nos" of consulting is noise on
 * a printed invoice, and the column's check constraint rejects a blank string
 * anyway.
 */
export function toRpcInvoice(invoice: InvoiceInput) {
  return {
    party_ledger_id: invoice.partyLedgerId,
    lines: invoice.lines.map((l, i) => ({
      line_order: l.lineOrder ?? i,
      description: l.description.trim(),
      revenue_ledger_id: l.revenueLedgerId,
      quantity: l.quantity,
      unit: l.unit?.trim() ? l.unit.trim() : null,
      rate: l.rate,
      discount_amount: l.discountAmount,
    })),
  };
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
    // One write path, not two: apply_invoice() raises if both arrive.
    p_lines: input.invoice ? [] : toRpcLines(input.lines),
    p_invoice: input.invoice ? toRpcInvoice(input.invoice) : null,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Replaces date/narration/reference + the full line set atomically.
 * voucher_type is immutable post-creation.
 *
 * `update_voucher` refuses a plain-lines save of a voucher that already has
 * invoice lines, rather than silently discarding its descriptions, quantities
 * and rates — so an invoice must always be saved back through `input.invoice`.
 * A voucher stops being an invoice only by being deleted and re-entered.
 */
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
    p_lines: input.invoice ? [] : toRpcLines(input.lines),
    p_invoice: input.invoice ? toRpcInvoice(input.invoice) : null,
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
  /** Matches narration or voucher number — see buildVoucherSearchFilter. */
  q?: string;
  page: number;
  pageSize: number;
}

/**
 * `,` is the clause separator in PostgREST's embedded-filter grammar —
 * `.or()` sends its argument straight onto the URL with no escaping of its
 * own (postgrest-js says so explicitly: "you need to make sure they are
 * properly sanitized"). An ordinary accounting narration ("Rent for Jan,
 * Feb, Mar", a pasted "1,00,000") contains exactly that character, so a raw
 * comma splits one intended condition into pieces PostgREST can't parse and
 * the request comes back 400.
 *
 * Verified against the live project rather than assumed: an unescaped comma
 * in the search box fails the whole query (400); the percent-encoded form
 * (`%2C`) succeeds (200). A period or parentheses in the same position —
 * `Q1.2026`, `Rent (Jan)`, even an unbalanced single paren — do not break
 * it, alone or together, so they are deliberately left unescaped rather
 * than mangled on the strength of what "looks like" filter syntax.
 *
 * `%` and `_` are left alone too — they are ordinary `ilike` wildcards, and
 * every other search box in this app (searchLedgers included) already
 * leaves them live, so a user who types `%` gets the same wildcard
 * behaviour here as everywhere else rather than a new, inconsistent rule.
 */
function escapeForOrFilter(value: string): string {
  return value.replaceAll(",", "%2C");
}

/**
 * The `.or()` filter string behind the Vouchers register's search box.
 *
 * Narration alone would mirror searchLedgers's single-column `ilike`, but a
 * voucher search earns its keep far more by also matching voucher_number —
 * the one other thing printed on every row of the register and the daybook,
 * and the more specific of the two things someone is actually likely to type
 * in ("INV-042" beats guessing which words appear in the narration). Party
 * name is deliberately left out of this pass: vouchers carries no ledger name
 * column, matching one would need a join this table doesn't have, and that is
 * a bigger change than "add a search box" asked for.
 *
 * Pulled out as a pure string builder — rather than inlined into the query
 * chain — so the filter it produces can be checked without a query builder in
 * the loop.
 */
export function buildVoucherSearchFilter(q: string): string {
  const escaped = escapeForOrFilter(q);
  return `narration.ilike.%${escaped}%,voucher_number.ilike.%${escaped}%`;
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
  if (params.q) query = query.or(buildVoucherSearchFilter(params.q));

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

/** An invoice line as stored, including the amount the database settled for it. */
export interface VoucherInvoiceLine {
  id: string;
  description: string;
  revenueLedgerId: string;
  revenueLedgerName: string;
  quantity: number;
  unit: string | null;
  rate: number;
  discountAmount: number;
  /** Read back from the generated column — never recomputed here. */
  lineAmount: number;
  lineOrder: number;
}

export interface VoucherWithLines {
  id: string;
  companyId: string;
  voucherType: VoucherType;
  voucherNumber: string;
  voucherDate: string;
  narration: string | null;
  referenceNumber: string | null;
  referenceDate: string | null;
  lines: (VoucherLineInput & { id: string; ledgerName: string })[];
  /**
   * Who the invoice is made out to — the customer debited on a sale, the
   * supplier credited on a bill — read from `vouchers.party_ledger_id`.
   *
   * Null for journals and contras, which have no counterparty, and for every
   * voucher entered before invoicing existed. That is permanent, not a gap
   * waiting to be filled: a voucher with no invoice lines has no party, and
   * migration 0022's trigger requires one only of vouchers that do.
   */
  partyLedgerId: string | null;
  /** Display only, for the combobox — resolved from the postings, never authoritative. */
  partyLedgerName: string | null;
  /**
   * Empty for every voucher entered before invoicing existed, and for every
   * receipt, payment, contra and journal — permanently. A voucher with no
   * invoice lines is a valid voucher; this array being empty is what the form
   * reads to decide whether it is looking at an invoice or at plain Dr/Cr
   * lines.
   */
  invoiceLines: VoucherInvoiceLine[];
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

  const { data: invoiceLines, error: invoiceError } = await supabase
    .from("invoice_lines")
    .select("id, description, revenue_ledger_id, quantity, unit, rate, discount_amount, line_amount, line_order, ledgers(name)")
    .eq("voucher_id", voucherId)
    .order("line_order");
  if (invoiceError) throw invoiceError;

  // The party itself comes from the column. Its *name* is taken from whichever
  // posting happens to be against that ledger, which costs no extra round trip
  // and is not the old convention in disguise: the match is on the stored id,
  // not on a line's position, so reordering the postings cannot change who the
  // invoice says it is for.
  const partyLedgerId = voucher.party_ledger_id;
  const partyEntry = partyLedgerId ? (lines ?? []).find((l) => l.ledger_id === partyLedgerId) : undefined;

  return {
    id: voucher.id,
    companyId: voucher.company_id,
    voucherType: voucher.voucher_type as VoucherType,
    voucherNumber: voucher.voucher_number,
    voucherDate: voucher.voucher_date,
    narration: voucher.narration,
    referenceNumber: voucher.reference_number,
    referenceDate: voucher.reference_date,
    partyLedgerId,
    partyLedgerName: partyEntry?.ledgers?.name ?? null,
    lines: (lines ?? []).map((l) => ({
      id: l.id,
      ledgerId: l.ledger_id,
      debitAmount: l.debit_amount,
      creditAmount: l.credit_amount,
      narration: l.narration ?? undefined,
      lineOrder: l.line_order,
      ledgerName: l.ledgers?.name ?? "",
    })),
    invoiceLines: (invoiceLines ?? []).map((l) => ({
      id: l.id,
      description: l.description,
      revenueLedgerId: l.revenue_ledger_id,
      revenueLedgerName: l.ledgers?.name ?? "",
      quantity: l.quantity,
      unit: l.unit,
      rate: l.rate,
      discountAmount: l.discount_amount,
      // Generated and stored, so it is never null in practice; the generated
      // types mark it nullable because Postgres allows a generated expression
      // to evaluate to null.
      lineAmount: l.line_amount ?? 0,
      lineOrder: l.line_order,
    })),
  };
}

/** Whoever the invoice is to or from — the customer debited, or the supplier credited. */
export interface InvoiceParty {
  id: string;
  name: string;
  contactPerson: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
}

export interface InvoiceDocument {
  voucher: VoucherWithLines;
  company: {
    name: string;
    address: string | null;
    phone: string | null;
    email: string | null;
    baseCurrency: string;
  };
  /**
   * Null exactly when the voucher has no `party_ledger_id` — which means it is
   * not an invoice, and the invoice page renders its "nothing to print" state
   * rather than this document.
   */
  party: InvoiceParty | null;
}

/**
 * Everything a printed invoice puts on paper.
 *
 * The party comes from `vouchers.party_ledger_id`. It used to be read back
 * from the voucher's `line_order = 0` posting, on the strength of
 * `generate_invoice_entries()` writing the party leg first — a convention no
 * constraint enforced, so a reordered posting would have printed one
 * customer's name over another customer's goods with nothing anywhere
 * complaining. Migration 0022 made the party a column with a composite foreign
 * key, and this reads that column. Nothing infers it from line order any more.
 */
export async function getInvoiceDocument(
  supabase: SupabaseClient<Database>,
  companyId: string,
  voucherId: string
): Promise<InvoiceDocument> {
  const voucher = await getVoucherById(supabase, voucherId);

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("name, address, phone, email, base_currency")
    .eq("id", companyId)
    .single();
  if (companyError) throw companyError;

  let party: InvoiceParty | null = null;
  if (voucher.partyLedgerId) {
    const { data: ledger, error: ledgerError } = await supabase
      .from("ledgers")
      .select("id, name, contact_person, address, phone, email")
      .eq("id", voucher.partyLedgerId)
      .single();
    if (ledgerError) throw ledgerError;
    party = {
      id: ledger.id,
      name: ledger.name,
      contactPerson: ledger.contact_person,
      address: ledger.address,
      phone: ledger.phone,
      email: ledger.email,
    };
  }

  return {
    voucher,
    company: {
      name: company.name,
      address: company.address,
      phone: company.phone,
      email: company.email,
      baseCurrency: company.base_currency,
    },
    party,
  };
}

/* ------------------------------------------------ the duplicate-bill guard */

/**
 * Everything the lookup needs to know about the purchase being entered.
 *
 * `partyLedgerId` is the supplier, and it is the form's live value rather than
 * anything stored: on a new bill nothing is stored yet, and on an edit the
 * user may have just changed who the bill is from.
 */
export interface DuplicateBillProbe {
  companyId: string;
  partyLedgerId: string | null | undefined;
  referenceNumber: string | null | undefined;
  voucherDate: string | null | undefined;
  /** The voucher being edited, so an invoice does not report itself. */
  excludeVoucherId?: string | null;
}

/** A purchase already on the books carrying this supplier's bill number. */
export interface DuplicateBill {
  voucherId: string;
  voucherNumber: string;
  voucherDate: string;
  totalAmount: number;
  referenceNumber: string | null;
}

/**
 * `INV-001`, `inv-001` and ` INV-001 ` are one bill.
 *
 * This is the client's copy of the migration's `upper(btrim(...))`, and it
 * exists only to decide whether two things the *form* holds are the same
 * question — never to normalise anything sent to the database, which does its
 * own and is the single definition of what "the same bill" means.
 *
 * Whitespace inside the number is kept. 'INV 001' and 'INV  001' are not
 * obviously one label, and collapsing them would hide a real bill behind a
 * false match — the one direction this feature must not fail in.
 */
export function normalizeBillReference(reference: string | null | undefined): string {
  return (reference ?? "").trim().toUpperCase();
}

/**
 * A stable identity for one duplicate-bill question, or null when there is no
 * question worth asking.
 *
 * Null for a missing supplier, a missing date and a blank bill number: most
 * purchases carry no reference at all, and two vouchers nobody wrote a number
 * on are two vouchers, not one bill entered twice. The database ignores them
 * as well (see 0024) — this is what keeps the round trip from being made in
 * the first place.
 *
 * The key is also what the warning is held against, so that typing on after a
 * lookup clears a warning that no longer describes what is on screen.
 */
export function duplicateBillProbeKey(probe: DuplicateBillProbe): string | null {
  const reference = normalizeBillReference(probe.referenceNumber);
  if (!probe.companyId || !probe.partyLedgerId || !probe.voucherDate || !reference) return null;
  return [probe.companyId, probe.partyLedgerId, reference, probe.voucherDate, probe.excludeVoucherId ?? ""].join(" ");
}

/**
 * The purchase this bill number is already on, if there is one.
 *
 * A warning and not a rule: nothing here refuses a save, and the caller is
 * expected to show what comes back and then let the user save anyway. Two
 * suppliers do issue the same number, and the person with both documents in
 * front of them is the one who can tell.
 *
 * Returns the earliest match — `find_duplicate_bill` orders by date — because
 * the entry the books have had longest is the one a user is most likely to
 * recognise.
 *
 * An error is thrown, never swallowed into "no duplicate found": a lookup that
 * failed and a bill that is genuinely new must not look the same, or a broken
 * guard becomes a silent all-clear.
 */
export async function findDuplicateBill(
  supabase: SupabaseClient<Database>,
  probe: DuplicateBillProbe
): Promise<DuplicateBill | null> {
  if (duplicateBillProbeKey(probe) === null) return null;

  const { data, error } = await supabase.rpc("find_duplicate_bill", {
    p_company_id: probe.companyId,
    p_party_ledger_id: probe.partyLedgerId as string,
    // Sent as typed. The normalisation is the migration's, on the index and
    // the lookup together; doing it again here would be a second definition to
    // keep in step.
    p_reference_number: probe.referenceNumber as string,
    p_voucher_date: probe.voucherDate as string,
    p_exclude_voucher_id: nullable(probe.excludeVoucherId),
  });
  if (error) throw error;

  const first = (data ?? [])[0];
  if (!first) return null;

  return {
    voucherId: first.voucher_id,
    voucherNumber: first.voucher_number,
    voucherDate: first.voucher_date,
    totalAmount: first.total_amount,
    referenceNumber: first.reference_number,
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
