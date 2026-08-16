import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/currency";
import type { VoucherLineFormValues } from "@/lib/voucher/voucher-schema";
import { computeVoucherTotals } from "@/lib/voucher/voucher-schema";

export function VoucherTotalsBar({ lines }: { lines: VoucherLineFormValues[] }) {
  const { debitTotal, creditTotal, isBalanced, differencePaise } = computeVoucherTotals(lines);

  return (
    <div
      className={cn(
        "flex items-center justify-end gap-6 rounded-xl border-l-2 bg-card px-4 py-2.5 text-sm shadow-sm ring-1 ring-foreground/10 transition-colors",
        isBalanced ? "border-l-success" : "border-l-destructive"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Dr</span>
        <span className="font-medium tabular-nums">{formatCurrency(debitTotal)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Cr</span>
        <span className="font-medium tabular-nums">{formatCurrency(creditTotal)}</span>
      </div>
      <div className={cn("flex items-center gap-1.5 font-medium", isBalanced ? "text-success" : "text-destructive")}>
        {isBalanced ? (
          // Keyed so the enter animation replays every time the voucher flips into balance.
          <span key="balanced" className="flex items-center gap-1.5 duration-300 animate-in fade-in zoom-in-75">
            <CheckCircle2 className="size-4" />
            Balanced
          </span>
        ) : (
          <>
            Diff <span className="tabular-nums">{formatCurrency(Math.abs(differencePaise) / 100)}</span>
          </>
        )}
      </div>
    </div>
  );
}
