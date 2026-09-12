import type { DaybookRow } from "@/lib/supabase/queries/reports";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";
import { formatCurrency } from "@/lib/utils/currency";

/**
 * An amount the way it's shown on screen ("₹1,39,725.00") and plain
 * ("139725.00"), so a search finds it however it's typed — the same
 * amount-search convention the Ledger Statement's own search box uses.
 */
function amountHaystacks(amount: number): string[] {
  if (!amount) return [];
  const shown = formatCurrency(amount);
  return [shown, shown.replace(/[^\d.]/g, "")];
}

/**
 * Whether a Daybook row matches a free-text search — checked against every
 * column a person can actually read on screen (the voucher number, both
 * ledger lists, the narration, the date, the amount, and the type's
 * plain-English label rather than the database's internal word for it), so
 * typing "sale" finds a Sale Bill even though nothing in the row literally
 * contains that word, and typing "2,00,000" or "200000" finds a ₹2,00,000
 * voucher by its amount, not just one that happens to mention that figure
 * in its narration.
 *
 * An empty query matches everything, the same convention the ledger and
 * voucher search boxes already use.
 */
export function matchesDaybookSearch(row: DaybookRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const typeLabel = VOUCHER_TYPE_CONFIG[row.voucherType as VoucherType]?.label ?? row.voucherType;
  const haystacks = [
    row.voucherNumber,
    row.narration,
    row.drLedgers,
    row.crLedgers,
    typeLabel,
    row.voucherDate,
    ...amountHaystacks(row.totalAmount),
  ];
  return haystacks.some((h) => (h ?? "").toLowerCase().includes(q));
}
