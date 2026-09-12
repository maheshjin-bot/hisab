"use client";

import { use } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { DateFieldSelects } from "@/components/reports/DateFieldSelects";
import { PrintButton } from "@/components/reports/PrintButton";
import { StatementFooter, StatementHeader } from "@/components/reports/StatementHeader";
import { useTrialBalanceQuery } from "@/hooks/useReportsQueries";
import { useSupabase } from "@/hooks/useSupabase";
import { getTrialBalance } from "@/lib/supabase/queries/reports";
import { useReportAsOfDate } from "@/components/reports/ReportDateRangeFilter";
import { formatCurrency, fromPaise, sumPaise, toPaise } from "@/lib/utils/currency";
import { asOfPeriod } from "@/lib/utils/statement-period";

export default function TrialBalancePage({ params }: PageProps<"/[companyId]/reports/trial-balance">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  // Opens on the selected financial year's closing date — today only while
  // that year is still running. The field below still takes any date.
  const { asOfDate, setAsOfDate, financialYear } = useReportAsOfDate(companyId);
  const { data, isLoading } = useTrialBalanceQuery(companyId, asOfDate);

  const rows = (data ?? []).filter((r) => r.debitBalance !== 0 || r.creditBalance !== 0);
  // Added in integer paise, not rupee floats. This is the one report whose
  // purpose is to show Dr = Cr, so it is the last place that may drift: the
  // accumulator is where a float column loses its paise, and rounding at the
  // end — as this did — cannot put them back, because the drift has already
  // happened before the multiply.
  const totalDebitPaise = sumPaise(rows.map((r) => toPaise(r.debitBalance)));
  const totalCreditPaise = sumPaise(rows.map((r) => toPaise(r.creditBalance)));
  const totalDebit = fromPaise(totalDebitPaise);
  const totalCredit = fromPaise(totalCreditPaise);
  const differencePaise = Math.abs(totalDebitPaise - totalCreditPaise);
  const tallies = differencePaise === 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <StatementHeader companyId={companyId} title="Trial Balance" period={asOfPeriod(asOfDate)} />

      <div data-print-hide className="flex items-center justify-between">
        <h1 className="text-statement">Trial Balance</h1>
        <div className="flex gap-2">
        <PrintButton />
        <CsvExportButton
          filename="trial-balance.csv"
          columns={[
            { key: "ledgerName", header: "Ledger" },
            { key: "groupName", header: "Group" },
            { key: "debitBalance", header: "Debit" },
            { key: "creditBalance", header: "Credit" },
          ]}
          fetchRows={() => getTrialBalance(supabase, companyId, asOfDate)}
        />
        </div>
      </div>

      <div data-print-hide className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">As of</span>
        <DateFieldSelects value={asOfDate} onChange={setAsOfDate} yearsAround={financialYear.startYear} />
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="p-2.5 text-left font-medium">Ledger</th>
                <th className="p-2.5 text-left font-medium">Group</th>
                <th className="p-2.5 text-right font-medium">Debit</th>
                <th className="p-2.5 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.ledgerId} className="border-t hover:bg-muted/30">
                  <td className="p-2.5 font-medium">
                    <Link href={`/${companyId}/reports/ledger-statement?ledgerId=${row.ledgerId}`} className="text-primary hover:underline">
                      {row.ledgerName}
                    </Link>
                  </td>
                  <td className="p-2.5 text-muted-foreground">{row.groupName}</td>
                  <td className="p-2.5 text-right tabular-nums">{row.debitBalance ? formatCurrency(row.debitBalance) : ""}</td>
                  <td className="p-2.5 text-right tabular-nums">{row.creditBalance ? formatCurrency(row.creditBalance) : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 font-semibold">
                <td className="p-2.5" colSpan={2}>
                  Total
                </td>
                <td className="p-2.5 text-right tabular-nums">{formatCurrency(totalDebit)}</td>
                <td className="p-2.5 text-right tabular-nums">{formatCurrency(totalCredit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!isLoading && !tallies && (
        <p data-print-hide className="text-sm text-destructive">
          Trial balance does not tally — debit and credit totals differ by {formatCurrency(fromPaise(differencePaise))}. This
          should not be possible; please report it.
        </p>
      )}

      <StatementFooter
        note={
          isLoading
            ? undefined
            : tallies
              ? "Debits and credits tally."
              : `Does not tally — difference of ${formatCurrency(fromPaise(differencePaise))}.`
        }
      />
    </div>
  );
}
