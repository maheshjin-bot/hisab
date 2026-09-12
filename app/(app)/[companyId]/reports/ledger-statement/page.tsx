"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportDateRangeFilter, useReportDateRange } from "@/components/reports/ReportDateRangeFilter";
import { LedgerCombobox } from "@/components/ledgers/LedgerCombobox";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { PrintButton } from "@/components/reports/PrintButton";
import { StatementFooter, StatementHeader } from "@/components/reports/StatementHeader";
import { useLedgerStatementQuery } from "@/hooks/useReportsQueries";
import { useSupabase } from "@/hooks/useSupabase";
import { getLedgerStatement } from "@/lib/supabase/queries/reports";
import { getLedgerById } from "@/lib/supabase/queries/ledgers";
import { queryKeys } from "@/lib/query-keys";
import { readLedgerIdParam, withLedgerIdParam } from "@/lib/reports/ledger-statement-url";
import { withReturnTo } from "@/lib/utils/return-to";
import { ledgerStatementCounterpartyLinkId } from "@/lib/reports/ledger-statement-links";
import { formatCurrency } from "@/lib/utils/currency";
import { rangePeriod } from "@/lib/utils/statement-period";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";

const ANY_SIDE_RULE = { label: "Ledger", allowedRoles: "any" as const, filterMode: "soft" as const, defaultRowCount: 1, minRows: 1 };

/**
 * All the combobox and the page itself need — a full LedgerSearchResult also
 * fits here, so a selection made through the combobox can be stored as-is.
 */
type SelectedLedger = { id: string; name: string };

export default function LedgerStatementPage({ params }: PageProps<"/[companyId]/reports/ledger-statement">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ledgerIdParam = readLedgerIdParam(searchParams);

  const { range, setRange, financialYear } = useReportDateRange(companyId, "ledger-statement");
  // Where a voucher's edit page should send Cancel and a successful save
  // back to — this exact ledger, date range, search and sort, not just the
  // bare report with none of it.
  const currentUrl = searchParams.toString() ? `${pathname}?${searchParams.toString()}` : pathname;

  // What a selection through the combobox looks like *before* the URL and
  // this hook's own lookup have caught up to it — read only when it still
  // names the ledger the URL currently holds, so it can never go stale and
  // paper over a real navigation (typing a URL, following a link, back/
  // forward) with the previous screen's ledger.
  const [justSelected, setJustSelected] = useState<SelectedLedger | null>(null);

  // Deep-link support: a `?ledgerId=` in the URL (arriving from a link on
  // another report, or restored by the browser on back/forward) has to be
  // resolved to a name before it can seed the combobox and the page's own
  // state — the URL only ever carries the id.
  const { data: paramLedger } = useQuery({
    queryKey: queryKeys.ledger(ledgerIdParam ?? ""),
    queryFn: () => getLedgerById(supabase, ledgerIdParam as string),
    enabled: !!ledgerIdParam,
  });

  const ledger: SelectedLedger | null = !ledgerIdParam
    ? null
    : justSelected?.id === ledgerIdParam
      ? justSelected
      : paramLedger?.id === ledgerIdParam
        ? { id: paramLedger.id, name: paramLedger.name }
        : null;

  const { data, isLoading } = useLedgerStatementQuery(companyId, ledger?.id, range.from, range.to);

  // A filter, not a new page — `replace` so picking through ten ledgers
  // doesn't leave ten stops behind the Back button, matching how
  // ledgers/page.tsx treats its own URL params.
  function handleSelect(selected: LedgerSearchResult) {
    setJustSelected(selected);
    router.replace(`${pathname}?${withLedgerIdParam(searchParams.toString(), selected.id)}`, { scroll: false });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      {ledger && (
        <StatementHeader
          companyId={companyId}
          title={`Ledger Statement — ${ledger.name}`}
          period={rangePeriod(range.from, range.to)}
        />
      )}

      <div data-print-hide className="flex items-center justify-between">
        <h1 className="text-statement">Ledger Statement</h1>
        {ledger && (
          <div className="flex gap-2">
          <PrintButton />
          <CsvExportButton
            filename={`ledger-statement-${ledger.name}.csv`}
            columns={[
              { key: "entryDate", header: "Date" },
              { key: "voucherType", header: "Type" },
              { key: "voucherNumber", header: "Voucher No" },
              { key: "narration", header: "Narration" },
              { key: "counterparty", header: "Particulars" },
              { key: "debitAmount", header: "Debit" },
              { key: "creditAmount", header: "Credit" },
              { key: "runningBalance", header: "Balance" },
            ]}
            fetchRows={() => getLedgerStatement(supabase, companyId, ledger.id, range.from, range.to)}
          />
          </div>
        )}
      </div>

      <div data-print-hide className="flex flex-wrap items-center gap-2">
        <div className="w-64">
          <LedgerCombobox companyId={companyId} value={ledger?.id ?? ""} displayName={ledger?.name} onSelect={handleSelect} sideRule={ANY_SIDE_RULE} />
        </div>
        <ReportDateRangeFilter value={range} onChange={setRange} financialYear={financialYear} />
      </div>

      {!ledger ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">
          Select a ledger to view its statement.
        </div>
      ) : isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="p-2.5 text-left font-medium">Date</th>
                <th className="p-2.5 text-left font-medium">Voucher</th>
                <th className="p-2.5 text-left font-medium">Narration</th>
                <th className="p-2.5 text-left font-medium">Particulars</th>
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
                    {row.voucherId ? (
                      <Link
                        href={withReturnTo(`/${companyId}/vouchers/${row.voucherId}/edit`, currentUrl)}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {row.voucherNumber}
                      </Link>
                    ) : (
                      row.voucherNumber ?? (row.voucherId === null && row.entryDate === null ? "Opening Balance" : "")
                    )}
                  </td>
                  <td className="p-2.5 text-muted-foreground">{row.narration}</td>
                  <td className="p-2.5 text-muted-foreground">
                    {(() => {
                      const linkId = ledgerStatementCounterpartyLinkId(row);
                      return linkId ? (
                        <Link href={`/${companyId}/reports/ledger-statement?ledgerId=${linkId}`} className="text-primary hover:underline">
                          {row.counterparty}
                        </Link>
                      ) : (
                        row.counterparty
                      );
                    })()}
                  </td>
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

      <StatementFooter />
    </div>
  );
}
