/**
 * Turns Gemini's raw JSON into something safe to show a reviewer and safe to
 * prefill into a Purchase Bill form. The model's output is never trusted
 * as-is: a value the destination field wouldn't accept is worse than no
 * value at all, because the alternative is a reviewer hitting a validation
 * error on a field they never typed.
 */

export interface BillCaptureLineItem {
  description: string;
  unit: string | null;
  quantity: number | null;
  rate: number | null;
  /** 0–100. Converted to a rupee discountAmount only once a real rate and quantity are known (see toInvoiceLine in match.ts) — HISAB stores the amount, not the percent. */
  discountPercent: number | null;
  /** The line's own printed total, kept only to cross-check against quantity*rate-discount — never written anywhere. */
  amount: number | null;
}

export interface BillCaptureExtraction {
  looksLikePurchaseBill: boolean;
  vendorName: string | null;
  vendorAddress: string | null;
  vendorPhone: string | null;
  vendorEmail: string | null;
  billNumber: string | null;
  billDate: string | null;
  lineItems: BillCaptureLineItem[];
  totalAmount: number | null;
  confidence: "high" | "medium" | "low";
  note: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function toStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * ISO shape AND a real calendar day — `new Date("2026-02-31")` silently
 * rolls forward to March 3rd in JavaScript rather than rejecting it, which
 * would post a bill under a date nobody actually wrote on it.
 */
export function toIsoDateOrNull(v: unknown): string | null {
  const s = toStringOrNull(v);
  if (!s) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as unknown as [never, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const isReal = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return isReal ? s : null;
}

export function toDiscountPercentOrNull(v: unknown): number | null {
  const n = toNumberOrNull(v);
  if (n === null) return null;
  return n >= 0 && n <= 100 ? n : null;
}

export function toEmailOrNull(v: unknown): string | null {
  const s = toStringOrNull(v);
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

const NOTE_FALLBACK = "Could not read anything usable from this response.";

/** A line survives if it has a legible description at all — the three numeric fields are independently coerced, never used to drop the whole line. */
function normalizeLineItem(raw: unknown): BillCaptureLineItem | null {
  if (!isRecord(raw)) return null;
  const description = toStringOrNull(raw.description);
  if (!description) return null;
  return {
    description,
    unit: toStringOrNull(raw.unit),
    quantity: toNumberOrNull(raw.quantity),
    rate: toNumberOrNull(raw.rate),
    discountPercent: toDiscountPercentOrNull(raw.discount_percent),
    amount: toNumberOrNull(raw.amount),
  };
}

export function normalizeBillCaptureExtraction(raw: unknown): BillCaptureExtraction {
  if (!isRecord(raw)) {
    return {
      looksLikePurchaseBill: false,
      vendorName: null,
      vendorAddress: null,
      vendorPhone: null,
      vendorEmail: null,
      billNumber: null,
      billDate: null,
      lineItems: [],
      totalAmount: null,
      confidence: "low",
      note: NOTE_FALLBACK,
    };
  }

  const lineItemsRaw = Array.isArray(raw.line_items) ? raw.line_items : [];
  const confidence = raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low" ? raw.confidence : "low";

  return {
    looksLikePurchaseBill: raw.looks_like_purchase_bill === true,
    vendorName: toStringOrNull(raw.vendor_name),
    vendorAddress: toStringOrNull(raw.vendor_address),
    vendorPhone: toStringOrNull(raw.vendor_phone),
    vendorEmail: toEmailOrNull(raw.vendor_email),
    billNumber: toStringOrNull(raw.bill_number),
    billDate: toIsoDateOrNull(raw.bill_date),
    lineItems: lineItemsRaw.map(normalizeLineItem).filter((l): l is BillCaptureLineItem => l !== null),
    totalAmount: toNumberOrNull(raw.total_amount),
    confidence,
    note: toStringOrNull(raw.note) ?? NOTE_FALLBACK,
  };
}
