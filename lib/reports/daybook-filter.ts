import type { DaybookRow } from "@/lib/supabase/queries/reports";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";

/**
 * Whether a Daybook row matches a free-text search — checked against every
 * column a person can actually read on screen (the voucher number, both
 * ledger lists, the narration, the date, and the type's plain-English label
 * rather than the database's internal word for it), so typing "sale" finds
 * a Sale Bill even though nothing in the row literally contains that word.
 *
 * An empty query matches everything, the same convention the ledger and
 * voucher search boxes already use.
 */
export function matchesDaybookSearch(row: DaybookRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const typeLabel = VOUCHER_TYPE_CONFIG[row.voucherType as VoucherType]?.label ?? row.voucherType;
  const haystacks = [row.voucherNumber, row.narration, row.drLedgers, row.crLedgers, typeLabel, row.voucherDate];
  return haystacks.some((h) => (h ?? "").toLowerCase().includes(q));
}
