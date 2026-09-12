import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/currency";
import type { InvoiceTotals } from "@/lib/voucher/invoice-schema";

/**
 * The invoice's running total.
 *
 * Unlike VoucherTotalsBar there is no "balanced / not balanced" state to show:
 * an invoice cannot be out of balance, because the generator derives both
 * sides of the posting from the same line amounts. What can go wrong is a
 * line discounted below nothing, or an invoice that comes to nothing at all —
 * so those are what this flags.
 */
export function InvoiceTotalsBar({ totals, partyLabel }: { totals: InvoiceTotals; partyLabel: string }) {
  const hasDiscount = totals.discountPaise !== 0;
  const isValid = totals.totalPaise > 0 && totals.linePaise.every((p) => p >= 0);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-x-6 gap-y-1 rounded-xl border-l-2 bg-card px-4 py-2.5 text-sm shadow-sm ring-1 ring-foreground/10 transition-colors",
        isValid ? "border-l-success" : "border-l-destructive"
      )}
    >
      {hasDiscount && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="tabular-nums">{formatCurrency(totals.grossPaise / 100)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Discount</span>
            <span className="tabular-nums">− {formatCurrency(totals.discountPaise / 100)}</span>
          </div>
        </>
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{partyLabel}</span>
        <span className="font-medium tabular-nums">{formatCurrency(totals.totalPaise / 100)}</span>
      </div>
    </div>
  );
}
