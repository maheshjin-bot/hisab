"use client";

import { use, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportDateRangeFilter, defaultDateRange } from "@/components/reports/ReportDateRangeFilter";
import { LedgerCombobox } from "@/components/ledgers/LedgerCombobox";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { useLedgerStatementQuery } from "@/hooks/useReportsQueries";
import { useSupabase } from "@/hooks/useSupabase";
import { getLedgerStatement } from "@/lib/supabase/queries/reports";
import { formatCurrency } from "@/lib/utils/currency";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";

const ANY_SIDE_RULE = { label: "Ledger", allowedRoles: "any" as const, filterMode: "soft" as const, defaultRowCount: 1, minRows: 1 };

export default function LedgerStatementPage({ params }: PageProps<"/[companyId]/reports/ledger-statement">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const [range, setRange] = useState(defaultDateRange());
  const [ledger, setLedger] = useState<LedgerSearchResult | null>(null);

  const { data, isLoading } = useLedgerStatementQuery(companyId, ledger?.id, range.from, range.to);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Ledger Statement</h1>
        {ledger && (
          <CsvExportButton
            filename={`ledger-statement-${ledger.name}.csv`}
            columns={[
              { key: "entryDate", header: "Date" },
              { key: "voucherType", header: "Type" },
              { key: "voucherNumber", header: "Voucher No" },
              { key: "narration", header: "Narration" },
              { key: "debitAmount", header: "Debit" },
              { key: "creditAmount", header: "Credit" },
              { key: "runningBalance", header: "Balance" },
            ]}
            fetchRows={() => getLedgerStatement(supabase, companyId, ledger.id, range.from, range.to)}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-64">
          <LedgerCombobox companyId={companyId} value={ledger?.id ?? ""} displayName={ledger?.name} onSelect={setLedger} sideRule={ANY_SIDE_RULE} />
        </div>
        <ReportDateRangeFilter value={range} onChange={setRange} />
      </div>

      {!ledger ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">
          Select a ledger to view its statement.
        </div>
      ) : isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="p-2.5 text-left font-medium">Date</th>
                <th className="p-2.5 text-left font-medium">Voucher</th>
                <th className="p-2.5 text-left font-medium">Narration</th>
                <th className="p-2.5 text-right font-medium">Debit</th>
                <th className="p-2.5 text-right font-medium">Credit</th>
                <th className="p-2.5 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((row, i) => (
                <tr key={i} className={row.voucherId ? "border-t hover:bg-muted/30" : "border-t bg-muted/20 font-medium"}>
                  <td className="p-2.5 text-muted-foreground">{row.entryDate ?? ""}</td>
                  <td className="p-2.5 text-muted-foreground">
                    {row.voucherNumber ?? (row.voucherId === null && row.entryDate === null ? "Opening Balance" : "")}
                  </td>
                  <td className="p-2.5 text-muted-foreground">{row.narration}</td>
                  <td className="p-2.5 text-right tabular-nums">{row.debitAmount ? formatCurrency(row.debitAmount) : ""}</td>
                  <td className="p-2.5 text-right tabular-nums">{row.creditAmount ? formatCurrency(row.creditAmount) : ""}</td>
                  <td className="p-2.5 text-right tabular-nums font-medium">
                    {formatCurrency(Math.abs(row.runningBalance))} {row.runningBalance >= 0 ? "Dr" : "Cr"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
