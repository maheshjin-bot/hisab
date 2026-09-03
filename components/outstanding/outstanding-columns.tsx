import { createAppColumnHelper } from "@/components/data-table/table-features";
import type { OutstandingRow } from "@/lib/supabase/queries/reports";
import { formatCurrency } from "@/lib/utils/currency";
import { formatIsoDate } from "@/lib/utils/statement-period";

const columnHelper = createAppColumnHelper<OutstandingRow>();

/**
 * "How long since the last transaction", in the words someone would use out
 * loud. The exact date is shown underneath it, because "4 months ago" is what
 * tells you to worry and the date is what you quote on the phone.
 *
 * Both dates are handled as UTC calendar days, matching formatIsoDate: parsing
 * an ISO date with `new Date(iso)` and comparing it to a local `new Date()`
 * shifts the answer by a day for anyone west of Greenwich.
 */
export function daysSince(iso: string, today: Date): number {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return 0;
  const then = Date.UTC(year, month - 1, day);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((now - then) / 86_400_000);
}

export function sinceLabel(iso: string | null, today: Date): string {
  if (!iso) return "No entries yet";
  const days = daysSince(iso, today);
  // A voucher dated in the future is entered, real and owed — it just has not
  // happened yet. Saying "-3 days ago" would be nonsense.
  if (days < 0) return "Dated ahead";
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 31) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/**
 * Why a party is on the side he is on, when that side is the surprising one.
 *
 * get_outstanding_balances puts a party where the sign of his balance puts him
 * — a customer in credit is a payable — so the screen has to say why, or it
 * looks like the app has muddled its customers with its suppliers.
 */
function oddSideNote(row: OutstandingRow): string | null {
  if (row.direction === "payable" && row.partyKind === "customer") return "Advance this customer paid you";
  if (row.direction === "receivable" && row.partyKind === "supplier") return "Advance you paid this supplier";
  return null;
}

/**
 * Sorting is the server's (biggest first, migration 0025), so every column
 * here is unsortable — a header that looked clickable and re-sorted only the
 * rows already on screen would be a worse answer than none.
 */
export function buildOutstandingColumns(today: Date) {
  return columnHelper.columns([
    columnHelper.accessor("ledgerName", {
      header: "Party",
      enableSorting: false,
      cell: (info) => {
        const note = oddSideNote(info.row.original);
        return (
          <div>
            <span className="font-medium">{info.getValue()}</span>
            {note && <span className="block text-xs text-muted-foreground">{note}</span>}
          </div>
        );
      },
    }),
    columnHelper.accessor("amount", {
      header: "Amount",
      enableSorting: false,
      cell: (info) => <span className="tabular-nums">{formatCurrency(info.getValue())}</span>,
    }),
    columnHelper.accessor("lastTransactionDate", {
      header: "Last transaction",
      enableSorting: false,
      cell: (info) => {
        const iso = info.getValue();
        return (
          <div>
            <span>{sinceLabel(iso, today)}</span>
            {iso && <span className="block text-xs text-muted-foreground">{formatIsoDate(iso)}</span>}
          </div>
        );
      },
    }),
  ]);
}
