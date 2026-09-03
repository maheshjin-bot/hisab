"use client";

import { Fragment, use, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { PrintButton } from "@/components/reports/PrintButton";
import { StatementFooter, StatementHeader } from "@/components/reports/StatementHeader";
import { useBalanceSheetQuery } from "@/hooks/useReportsQueries";
import { useSupabase } from "@/hooks/useSupabase";
import { getBalanceSheet, type BalanceSheetRow } from "@/lib/supabase/queries/reports";
import { formatCurrency } from "@/lib/utils/currency";
import { isoLocalDate } from "@/lib/utils/financial-year";
import { asOfPeriod } from "@/lib/utils/statement-period";

function isoToday() {
  return isoLocalDate(new Date());
}

function Column({ title, rows, total }: { title: string; rows: BalanceSheetRow[]; total: number }) {
  const byGroup = new Map<string, BalanceSheetRow[]>();
  for (const row of rows) {
    const key = row.groupName;
    const existing = byGroup.get(key);
    if (existing) existing.push(row);
    else byGroup.set(key, [row]);
  }

  return (
    <div data-print-group className="overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
      <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td className="p-3 text-center text-muted-foreground">Nothing to show.</td>
            </tr>
          )}
          {[...byGroup.entries()].map(([groupName, groupRows]) => (
            <Fragment key={groupName}>
              {groupRows.length > 1 && (
                <tr className="border-t bg-muted/10">
                  <td className="p-2 pl-3 text-xs font-medium text-muted-foreground" colSpan={2}>
                    {groupName}
                  </td>
                </tr>
              )}
              {groupRows.map((row) => (
                <tr key={row.ledgerId ?? row.ledgerName} className="border-t">
                  <td className={cn("p-2.5 text-muted-foreground", groupRows.length > 1 ? "pl-6" : "pl-3")}>
                    {/*
                      A group holding one line is collapsed onto its own name,
                      so "Cash-in-Hand" is not shown above an indented "Till".
                      The synthetic lines (ledgerId null — Net Profit/Loss, and
                      the trading result brought forward that 0026 adds) are the
                      exception: their name IS the label, and collapsing one of
                      them puts "Capital Account" on the asset side of the sheet
                      with no clue what it is.
                    */}
                    {groupRows.length === 1 && row.ledgerId !== null ? row.groupName : row.ledgerName}
                  </td>
                  <td className="p-2.5 pr-3 text-right tabular-nums">{formatCurrency(row.amount)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 font-semibold">
            <td className="p-2.5 pl-3">Total</td>
            <td className="p-2.5 pr-3 text-right tabular-nums">{formatCurrency(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function BalanceSheetPage({ params }: PageProps<"/[companyId]/reports/balance-sheet">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const [asOfDate, setAsOfDate] = useState(isoToday());
  const { data, isLoading } = useBalanceSheetQuery(companyId, asOfDate);

  const liabilities = (data ?? []).filter((r) => r.side === "liability");
  const assets = (data ?? []).filter((r) => r.side === "asset");
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const tallies = !isLoading && Math.round(totalLiabilities * 100) === Math.round(totalAssets * 100);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <StatementHeader companyId={companyId} title="Balance Sheet" period={asOfPeriod(asOfDate)} />

      <div data-print-hide className="flex items-center justify-between">
        <h1 className="text-statement">Balance Sheet</h1>
        <div className="flex gap-2">
        <PrintButton />
        <CsvExportButton
          filename="balance-sheet.csv"
          columns={[
            { key: "side", header: "Side" },
            { key: "groupName", header: "Group" },
            { key: "ledgerName", header: "Ledger" },
            { key: "amount", header: "Amount" },
          ]}
          fetchRows={() => getBalanceSheet(supabase, companyId, asOfDate)}
        />
        </div>
      </div>

      <div data-print-hide className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">As of</span>
        <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="w-40" />
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Column title="Liabilities" rows={liabilities} total={totalLiabilities} />
            <Column title="Assets" rows={assets} total={totalAssets} />
          </div>
          <p data-print-hide className={cn("text-center text-sm font-medium", tallies ? "text-success" : "text-destructive")}>
            {tallies
              ? "Balance sheet tallies."
              : `Does not tally — off by ${formatCurrency(Math.abs(totalLiabilities - totalAssets))}. This should not be possible; please report it.`}
          </p>
        </>
      )}

      <StatementFooter
        note={
          isLoading
            ? undefined
            : tallies
              ? "Balance sheet tallies."
              : `Does not tally — off by ${formatCurrency(Math.abs(totalLiabilities - totalAssets))}.`
        }
      />
    </div>
  );
}
