"use client";

import { use } from "react";
import Link from "next/link";
import { format, isToday, isYesterday, startOfMonth } from "date-fns";
import { ArrowDownToLine, ArrowUpFromLine, BookText, Landmark, ShoppingBag, ShoppingCart, UploadCloud, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SummaryTile } from "@/components/dashboard/SummaryTile";
import { QuickActionButton } from "@/components/dashboard/QuickActionButton";
import { useCashFlowSummaryQuery } from "@/hooks/useDashboardQuery";
import { useFinancialYear } from "@/hooks/useFinancialYear";
import { useVouchersQuery } from "@/hooks/useVouchersQuery";
import { formatCurrency } from "@/lib/utils/currency";
import { parseIsoLocalDate } from "@/lib/utils/financial-year";
import { formatIsoDate } from "@/lib/utils/statement-period";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import { cn } from "@/lib/utils";

/** "Today" / "Yesterday" / "16 Aug 2026" — voucher_date is a plain calendar date, never a time-of-day, so this never fabricates a clock time. */
function formatActivityDate(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00`);
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "d MMM yyyy");
}

const FLOW_BADGE_CLASS: Record<"in" | "out" | "neutral", string> = {
  in: "bg-success/10 text-success",
  out: "bg-destructive/10 text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

const FLOW_AMOUNT_CLASS: Record<"in" | "out" | "neutral", string> = {
  in: "text-success",
  out: "text-destructive",
  neutral: "text-foreground",
};

export default function DashboardPage({ params }: PageProps<"/[companyId]/dashboard">) {
  const { companyId } = use(params);

  /*
   * The dashboard is drawn as of the selected financial year — the year's
   * closing date, or today while that year is still running.
   *
   * Today was hardcoded here, which is why a company whose books stop in
   * March showed ₹0.00 inflows in September: literally true of this month,
   * and no use to anyone. Pinning a closed year to its last day instead
   * answers the question actually being asked — what the position was when
   * the year closed.
   *
   * The tiles then mean different things and must say so. get_dashboard_summary
   * measures inflow/outflow from the first of the as-of date's month, so with
   * a closed year selected these are the closing month's figures, not "this
   * month's" — and the balances are the year's closing balances rather than
   * live ones.
   */
  const { selected, asOfDate, isCurrent } = useFinancialYear(companyId);
  const monthStart = startOfMonth(parseIsoLocalDate(asOfDate));
  const monthStartLabel = format(monthStart, "d MMM");
  const flowMonthLabel = format(monthStart, "MMM yyyy");

  const { data: cashFlow, isLoading: loadingCashFlow } = useCashFlowSummaryQuery(companyId, asOfDate);
  const { data: recentVouchers, isLoading: loadingVouchers } = useVouchersQuery(companyId, { page: 0, pageSize: 10 });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {isCurrent
            ? format(new Date(), "EEEE, d MMMM yyyy")
            : `${selected.label} — closed year, as of ${formatIsoDate(selected.end)}`}
        </p>
      </div>

      {loadingCashFlow ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px]" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryTile
            label={isCurrent ? "Cash-in-Hand" : "Closing Cash-in-Hand"}
            value={formatCurrency(cashFlow?.cashInHand ?? 0)}
            icon={Wallet}
            trend={cashFlow ? { amount: cashFlow.cashInHandChange, caption: `since ${monthStartLabel}` } : undefined}
          />
          <SummaryTile
            label={isCurrent ? "Bank Balance" : "Closing Bank Balance"}
            value={formatCurrency(cashFlow?.bankBalance ?? 0)}
            icon={Landmark}
            trend={cashFlow ? { amount: cashFlow.bankBalanceChange, caption: `since ${monthStartLabel}` } : undefined}
          />
          <SummaryTile
            label={isCurrent ? "Month's Inflows" : `Inflows, ${flowMonthLabel}`}
            value={formatCurrency(cashFlow?.monthInflow ?? 0)}
            tone="success"
            icon={ArrowDownToLine}
          />
          <SummaryTile
            label={isCurrent ? "Month's Outflows" : `Outflows, ${flowMonthLabel}`}
            value={formatCurrency(cashFlow?.monthOutflow ?? 0)}
            tone="destructive"
            icon={ArrowUpFromLine}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <QuickActionButton href={`/${companyId}/vouchers/new/sales`} icon={ShoppingCart} label="New Sale Bill" />
        <QuickActionButton href={`/${companyId}/vouchers/new/purchase`} icon={ShoppingBag} label="New Purchase Bill" />
        <QuickActionButton href={`/${companyId}/ledgers?new=1`} icon={BookText} label="Add Ledger" />
        <QuickActionButton href={`/${companyId}/ledgers?import=1`} icon={UploadCloud} label="CSV Import / Export" />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          {/* The books themselves are never filtered by the year selector —
              this is the last ten vouchers entered, whenever they fall. With a
              closed year selected that will be entries from outside it, so the
              heading says so rather than letting them read as the year's. */}
          <h2 className="text-sm font-medium">
            Recent activity
            {!isCurrent && <span className="ml-1.5 font-normal text-muted-foreground">(latest entries, all years)</span>}
          </h2>
          <Link href={`/${companyId}/vouchers`} className="text-xs text-muted-foreground hover:text-foreground">
            View all
          </Link>
        </div>

        {loadingVouchers ? (
          <Skeleton className="h-72 w-full" />
        ) : recentVouchers?.rows.length === 0 ? (
          <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
            No vouchers yet — use Quick Actions above to record your first one.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Voucher No.</th>
                  <th className="px-3 py-2 text-left font-medium">Narration</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {recentVouchers?.rows.map((v) => {
                  const config = VOUCHER_TYPE_CONFIG[v.voucherType];
                  return (
                    <tr key={v.id} className="border-b last:border-0 odd:bg-muted/20 hover:bg-muted/40">
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatActivityDate(v.voucherDate)}</td>
                      <td className="px-3 py-2">
                        <Badge variant="secondary" className={FLOW_BADGE_CLASS[config.flow]}>
                          {config.label}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/${companyId}/vouchers/${v.id}/edit`} className="font-mono text-xs text-primary hover:underline">
                          {v.voucherNumber}
                        </Link>
                      </td>
                      <td className="max-w-64 truncate px-3 py-2 text-muted-foreground">{v.narration || "—"}</td>
                      <td className={cn("px-3 py-2 text-right font-medium tabular-nums", FLOW_AMOUNT_CLASS[config.flow])}>
                        {formatCurrency(v.totalAmount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
