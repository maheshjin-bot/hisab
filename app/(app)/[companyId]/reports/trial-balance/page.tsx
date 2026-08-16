"use client";

import { use, useState } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { PrintButton } from "@/components/reports/PrintButton";
import { StatementFooter, StatementHeader } from "@/components/reports/StatementHeader";
import { useTrialBalanceQuery } from "@/hooks/useReportsQueries";
import { useSupabase } from "@/hooks/useSupabase";
import { getTrialBalance } from "@/lib/supabase/queries/reports";
import { formatCurrency } from "@/lib/utils/currency";
import { isoLocalDate } from "@/lib/utils/financial-year";
import { asOfPeriod } from "@/lib/utils/statement-period";

function isoToday() {
  return isoLocalDate(new Date());
}

export default function TrialBalancePage({ params }: PageProps<"/[companyId]/reports/trial-balance">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const [asOfDate, setAsOfDate] = useState(isoToday());
  const { data, isLoading } = useTrialBalanceQuery(companyId, asOfDate);

  const rows = (data ?? []).filter((r) => r.debitBalance !== 0 || r.creditBalance !== 0);
  const totalDebit = rows.reduce((sum, r) => sum + r.debitBalance, 0);
  const totalCredit = rows.reduce((sum, r) => sum + r.creditBalance, 0);
  const tallies = Math.round(totalDebit * 100) === Math.round(totalCredit * 100);

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
        <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="w-40" />
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
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
                  <td className="p-2.5 font-medium">{row.ledgerName}</td>
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
          Trial balance does not tally — debit and credit totals differ by {formatCurrency(Math.abs(totalDebit - totalCredit))}. This
          should not be possible; please report it.
        </p>
      )}

      <StatementFooter
        note={
          isLoading
            ? undefined
            : tallies
              ? "Debits and credits tally."
              : `Does not tally — difference of ${formatCurrency(Math.abs(totalDebit - totalCredit))}.`
        }
      />
    </div>
  );
}
