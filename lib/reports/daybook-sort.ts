import type { DaybookRow } from "@/lib/supabase/queries/reports";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";

export type DaybookSortColumn =
  | "voucherDate"
  | "voucherType"
  | "voucherNumber"
  | "drLedgers"
  | "crLedgers"
  | "narration"
  | "totalAmount";

export interface DaybookSort {
  column: DaybookSortColumn;
  direction: "asc" | "desc";
}

/**
 * Clicking a column header cycles ascending → descending → back to the
 * report's own order (chronological, as the RPC returns it) rather than
 * getting stuck sorted forever — the third click is how you get back to
 * "the order the books were actually written in".
 */
export function nextDaybookSort(current: DaybookSort | null, column: DaybookSortColumn): DaybookSort | null {
  if (current?.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

function daybookSortValue(row: DaybookRow, column: DaybookSortColumn): string | number {
  if (column === "totalAmount") return row.totalAmount;
  // Sorted by what the column actually displays — Type shows "Sale Bill",
  // not the database's "sales" — so rows group the way they look on screen.
  if (column === "voucherType") return VOUCHER_TYPE_CONFIG[row.voucherType as VoucherType]?.label ?? row.voucherType;
  return row[column] ?? "";
}

/** Not mutating: DataTable-free tables like this one hold `data` straight from the query cache, and sorting it in place would corrupt that cache. */
export function sortDaybookRows(rows: DaybookRow[], sort: DaybookSort | null): DaybookRow[] {
  if (!sort) return rows;
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = daybookSortValue(a, sort.column);
    const bv = daybookSortValue(b, sort.column);
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
    return String(av).localeCompare(String(bv)) * factor;
  });
}
