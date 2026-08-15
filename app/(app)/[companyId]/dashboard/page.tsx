"use client";

import { use } from "react";
import Link from "next/link";
import { Landmark, ReceiptText, TrendingDown, TrendingUp, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SummaryTile } from "@/components/dashboard/SummaryTile";
import { useBalanceSheetQuery } from "@/hooks/useReportsQueries";
import { useVouchersQuery } from "@/hooks/useVouchersQuery";
import { formatCurrency } from "@/lib/utils/currency";
import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";

export default function DashboardPage({ params }: PageProps<"/[companyId]/dashboard">) {
  const { companyId } = use(params);
  const today = new Date().toISOString().slice(0, 10);

  const { data: balanceSheet, isLoading: loadingBalanceSheet } = useBalanceSheetQuery(companyId, today);
  const { data: recentVouchers, isLoading: loadingVouchers } = useVouchersQuery(companyId, { page: 0, pageSize: 8 });

  const totalAssets = balanceSheet?.filter((r) => r.side === "asset").reduce((sum, r) => sum + r.amount, 0) ?? 0;
  const totalLiabilities = balanceSheet?.filter((r) => r.side === "liability").reduce((sum, r) => sum + r.amount, 0) ?? 0;
  const netProfitRow = balanceSheet?.find((r) => r.ledgerId === null);
  const netProfit = netProfitRow ? (netProfitRow.side === "liability" ? netProfitRow.amount : -netProfitRow.amount) : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
        <div className="flex gap-1.5">
          {VOUCHER_TYPE_ORDER.slice(0, 3).map((type) => (
            <Button key={type} variant="outline" size="sm" render={<Link href={`/${companyId}/vouchers/new/${type}`} />}>
              <Plus data-icon="inline-start" />
              {VOUCHER_TYPE_CONFIG[type].label}
            </Button>
          ))}
        </div>
      </div>

      {loadingBalanceSheet ? (
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <SummaryTile label="Total Assets" value={formatCurrency(totalAssets)} icon={Landmark} />
          <SummaryTile label="Total Liabilities" value={formatCurrency(totalLiabilities)} icon={ReceiptText} />
          <SummaryTile
            label={netProfit >= 0 ? "Net Profit" : "Net Loss"}
            value={formatCurrency(Math.abs(netProfit))}
            tone={netProfit >= 0 ? "success" : "destructive"}
            icon={netProfit >= 0 ? TrendingUp : TrendingDown}
          />
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Recent vouchers</h2>
          <Link href={`/${companyId}/vouchers`} className="text-xs text-muted-foreground hover:text-foreground">
            View all
          </Link>
        </div>

        {loadingVouchers ? (
          <Skeleton className="h-48 w-full" />
        ) : recentVouchers?.rows.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            No vouchers yet — create your first one above.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full text-sm">
              <tbody>
                {recentVouchers?.rows.map((v) => (
                  <tr key={v.id} className="border-b last:border-0 hover:bg-muted/50">
                    <td className="w-28 px-3 py-2 text-muted-foreground">{v.voucherDate}</td>
                    <td className="w-28 px-3 py-2 font-medium capitalize">{v.voucherType}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{v.voucherNumber}</td>
                    <td className="px-3 py-2 text-muted-foreground">{v.narration}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(v.totalAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
