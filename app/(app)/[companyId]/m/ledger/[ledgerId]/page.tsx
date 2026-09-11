"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { MobileScreen } from "@/components/mobile/MobileScreen";
import { useLedgerStatementQuery } from "@/hooks/useReportsQueries";
import { useLedgerGroupsQuery } from "@/hooks/useLedgersQuery";
import { useSupabase } from "@/hooks/useSupabase";
import { getLedgerById } from "@/lib/supabase/queries/ledgers";
import { queryKeys } from "@/lib/query-keys";
import { balancePhrase } from "@/lib/ledgers/balance-phrase";
import { formatCurrency } from "@/lib/utils/currency";
import { useReportDateRange } from "@/components/reports/ReportDateRangeFilter";
import { cn } from "@/lib/utils";

/**
 * One ledger's statement as a list of entries rather than the six-column
 * table the report page draws — on a phone, the description and date on one
 * line with the movement and running balance beside them reads better than a
 * table scrolled sideways. Same query as reports/ledger-statement.
 *
 * The period is the financial year to date, with no picker: on a phone the
 * question is "what has happened with this party", and a date-range control
 * is two more taps before the answer. The full statement with its own range
 * is on the desktop report.
 */
export default function MobileLedgerStatementPage({ params }: PageProps<"/[companyId]/m/ledger/[ledgerId]">) {
  const { companyId, ledgerId } = use(params);
  const supabase = useSupabase();
  const { range } = useReportDateRange(companyId);

  const { data: ledger } = useQuery({
    queryKey: queryKeys.ledger(ledgerId),
    queryFn: () => getLedgerById(supabase, ledgerId),
  });
  const { data: groups } = useLedgerGroupsQuery(companyId);
  const { data, isLoading } = useLedgerStatementQuery(companyId, ledgerId, range.from, range.to);

  const closing = data?.length ? data[data.length - 1].runningBalance : undefined;
  // Same rule as the list: what the closing balance *means* depends on the
  // kind of ledger, not just its sign.
  const role = groups?.find((g) => g.id === ledger?.groupId)?.ledgerRole ?? "other";
  const phrase = closing === undefined ? null : balancePhrase(closing, role);

  return (
    <MobileScreen title={ledger?.name ?? "Ledger"} backHref={`/${companyId}/m/ledger`}>
      {phrase && (
        <div className="pb-5">
          <p className="text-[13px] text-muted-foreground">{phrase.caption ?? "Balance"}</p>
          <p
            className={cn(
              "text-[32px] leading-tight font-semibold tabular-nums",
              phrase.isLiability && "text-destructive"
            )}
          >
            {formatCurrency(phrase.amount)}
          </p>
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !data?.length ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">Nothing in this period.</p>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {data.map((row, i) => {
            const isOpening = row.voucherId === null && row.entryDate === null;
            return (
              <li key={i} className="flex items-baseline justify-between gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px]">
                    {isOpening ? "Opening balance" : row.narration || row.voucherNumber || "—"}
                  </span>
                  {!isOpening && (
                    <span className="block truncate text-[13px] text-muted-foreground">{row.entryDate}</span>
                  )}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[15px] font-medium tabular-nums">
                    {row.debitAmount ? (
                      <span className="text-success">+{formatCurrency(row.debitAmount)}</span>
                    ) : row.creditAmount ? (
                      <span className="text-destructive">−{formatCurrency(row.creditAmount)}</span>
                    ) : null}
                  </span>
                  <span className="block text-[11px] text-muted-foreground tabular-nums">
                    {formatCurrency(Math.abs(row.runningBalance))}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </MobileScreen>
  );
}
