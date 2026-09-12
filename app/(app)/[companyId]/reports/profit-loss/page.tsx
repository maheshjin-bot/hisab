"use client";

import { use } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportDateRangeFilter, useReportDateRange } from "@/components/reports/ReportDateRangeFilter";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { PrintButton } from "@/components/reports/PrintButton";
import { StatementFooter, StatementHeader } from "@/components/reports/StatementHeader";
import { useProfitAndLossQuery } from "@/hooks/useReportsQueries";
import { useSupabase } from "@/hooks/useSupabase";
import { getProfitAndLoss, type ProfitAndLossRow } from "@/lib/supabase/queries/reports";
import { formatCurrency } from "@/lib/utils/currency";
import { rangePeriod } from "@/lib/utils/statement-period";

/**
 * A row's `amount` is SIGNED, as of migration 0026: an income ledger left in
 * debit by a credit note, or a "Sales Returns" ledger that lives in debit for
 * its whole life, comes back negative because it has reduced income rather
 * than added to it. The figures below therefore say -₹3,250.00 and the column
 * adds up to what its footer claims — the footer is the plain sum of the rows
 * above it, not its magnitude, because a total a reader cannot check by
 * adding up the column is worse than a negative one.
 *
 * A negative figure is coloured, nothing more. It is unusual and worth the
 * eye, but the minus sign is what carries the meaning; the colour must not be
 * the only thing that does. The section totals carry no profit/loss colouring
 * of their own — the sign of "total direct expenses" is not good news or bad
 * news, and only the Gross and Net Profit panels below make that claim.
 */
function Section({
  companyId,
  title,
  rows,
  total,
  totalLabel,
}: {
  companyId: string;
  title: string;
  rows: ProfitAndLossRow[];
  total: number;
  totalLabel: string;
}) {
  return (
    <div data-print-group className="overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
      <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td className="p-3 text-center text-muted-foreground">No activity in this period.</td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.ledgerId} className="border-t">
              <td className="p-2.5 pl-3 text-muted-foreground">
                <Link href={`/${companyId}/reports/ledger-statement?ledgerId=${row.ledgerId}`} className="text-primary hover:underline">
                  {row.ledgerName}
                </Link>
              </td>
              <td className={cn("p-2.5 pr-3 text-right tabular-nums", row.amount < 0 && "text-destructive")}>
                {formatCurrency(row.amount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 font-semibold">
            <td className="p-2.5 pl-3">{totalLabel}</td>
            <td className={cn("p-2.5 pr-3 text-right tabular-nums", total < 0 && "text-destructive")}>
              {formatCurrency(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function ProfitAndLossPage({ params }: PageProps<"/[companyId]/reports/profit-loss">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const { range, setRange, financialYear } = useReportDateRange(companyId, "profit-and-loss");
  const { data, isLoading } = useProfitAndLossQuery(companyId, range.from, range.to);

  const rows = data ?? [];
  const directIncome = rows.filter((r) => r.nature === "direct_income");
  const directExpense = rows.filter((r) => r.nature === "direct_expense");
  const indirectIncome = rows.filter((r) => r.nature === "indirect_income");
  const indirectExpense = rows.filter((r) => r.nature === "indirect_expense");

  // Income less expense, over signed rows. This is the arithmetic migration
  // 0026 makes the Balance Sheet's Net Profit line equal by construction:
  // income contributes +(credit - debit) and expense contributes
  // -(debit - credit), which is the same expression, so this collapses to one
  // uniform sum(credit - debit) over every income and expense entry in the
  // window — exactly what get_balance_sheet computes. It held only for rows
  // whose sign was reported, which before 0026 they were not.
  const sum = (rs: ProfitAndLossRow[]) => rs.reduce((s, r) => s + r.amount, 0);
  const grossProfit = sum(directIncome) - sum(directExpense);
  const netProfit = grossProfit + sum(indirectIncome) - sum(indirectExpense);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <StatementHeader
        companyId={companyId}
        title="Trading & Profit and Loss Account"
        period={rangePeriod(range.from, range.to)}
      />

      <div data-print-hide className="flex items-center justify-between">
        <h1 className="text-statement">Trading & Profit and Loss Account</h1>
        <div className="flex gap-2">
        <PrintButton />
        {/*
          Amount is exported as the raw signed number the report holds —
          "-3250", not "(3,250.00)" and not a magnitude. A spreadsheet sums it
          without being told how to read it, and lib/csv/amount.ts reads it
          back unchanged if the file is ever imported, so the export
          round-trips. Any prettier rendering of a negative belongs on the
          screen, which is where a person reads it.
        */}
        <CsvExportButton
          filename="profit-and-loss.csv"
          columns={[
            { key: "statement", header: "Statement" },
            { key: "nature", header: "Nature" },
            { key: "ledgerName", header: "Ledger" },
            { key: "amount", header: "Amount" },
          ]}
          fetchRows={() => getProfitAndLoss(supabase, companyId, range.from, range.to)}
        />
        </div>
      </div>

      <div data-print-hide>
        <ReportDateRangeFilter value={range} onChange={setRange} financialYear={financialYear} />
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Section companyId={companyId} title="Direct Income (Sales)" rows={directIncome} total={sum(directIncome)} totalLabel="Total" />
            <Section companyId={companyId} title="Direct Expenses (incl. Purchases)" rows={directExpense} total={sum(directExpense)} totalLabel="Total" />
          </div>

          <div
            className={cn(
              "rounded-xl p-4 text-center ring-1",
              grossProfit >= 0 ? "bg-success/5 ring-success/20" : "bg-destructive/5 ring-destructive/20"
            )}
          >
            <p className="text-xs text-muted-foreground">{grossProfit >= 0 ? "Gross Profit" : "Gross Loss"}</p>
            <p className={cn("text-xl font-semibold tabular-nums", grossProfit >= 0 ? "text-success" : "text-destructive")}>
              {formatCurrency(Math.abs(grossProfit))}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Section companyId={companyId} title="Indirect Income" rows={indirectIncome} total={sum(indirectIncome)} totalLabel="Total" />
            <Section companyId={companyId} title="Indirect Expenses" rows={indirectExpense} total={sum(indirectExpense)} totalLabel="Total" />
          </div>

          <div
            className={cn(
              "rounded-xl p-4 text-center ring-1",
              netProfit >= 0 ? "bg-success/5 ring-success/20" : "bg-destructive/5 ring-destructive/20"
            )}
          >
            <p className="text-xs text-muted-foreground">{netProfit >= 0 ? "Net Profit" : "Net Loss"}</p>
            <p className={cn("text-xl font-semibold tabular-nums", netProfit >= 0 ? "text-success" : "text-destructive")}>
              {formatCurrency(Math.abs(netProfit))}
            </p>
          </div>
        </div>
      )}

      <StatementFooter
        note={
          isLoading
            ? undefined
            : `${netProfit >= 0 ? "Net Profit" : "Net Loss"} ${formatCurrency(Math.abs(netProfit))}`
        }
      />
    </div>
  );
}
