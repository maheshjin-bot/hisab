import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/currency";
import type { VoucherLineFormValues } from "@/lib/voucher/voucher-schema";
import { computeVoucherTotals } from "@/lib/voucher/voucher-schema";

export function VoucherTotalsBar({ lines }: { lines: VoucherLineFormValues[] }) {
  const { debitTotal, creditTotal, isBalanced, differencePaise } = computeVoucherTotals(lines);

  return (
    <div className="flex items-center justify-end gap-6 rounded-lg border bg-muted/30 px-4 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Dr</span>
        <span className="tabular-nums font-medium">{formatCurrency(debitTotal)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Cr</span>
        <span className="tabular-nums font-medium">{formatCurrency(creditTotal)}</span>
      </div>
      <div className={cn("flex items-center gap-1.5 font-medium", isBalanced ? "text-success" : "text-destructive")}>
        {isBalanced ? (
          "Balanced"
        ) : (
          <>
            Diff <span className="tabular-nums">{formatCurrency(Math.abs(differencePaise) / 100)}</span>
          </>
        )}
      </div>
    </div>
  );
}
