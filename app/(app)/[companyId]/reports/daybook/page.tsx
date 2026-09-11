"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, ChevronsUpDown, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportDateRangeFilter, useReportDateRange } from "@/components/reports/ReportDateRangeFilter";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { PrintButton } from "@/components/reports/PrintButton";
import { StatementFooter, StatementHeader } from "@/components/reports/StatementHeader";
import { useDaybookQuery } from "@/hooks/useReportsQueries";
import { useSupabase } from "@/hooks/useSupabase";
import { getDaybook } from "@/lib/supabase/queries/reports";
import { matchesDaybookSearch } from "@/lib/reports/daybook-filter";
import { nextDaybookSort, sortDaybookRows, type DaybookSort, type DaybookSortColumn } from "@/lib/reports/daybook-sort";
import { formatCurrency } from "@/lib/utils/currency";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";
import { rangePeriod } from "@/lib/utils/statement-period";
import { cn } from "@/lib/utils";

/** A clickable column header with the same asc/desc/unsorted chevron DataTable's own registers use, so every sortable table in the app reads the same way. */
function SortableHeader({
  column,
  sort,
  onSort,
  align = "left",
  children,
}: {
  column: DaybookSortColumn;
  sort: DaybookSort | null;
  onSort: (column: DaybookSortColumn) => void;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const direction = sort?.column === column ? sort.direction : null;
  return (
    <th className={cn("p-2.5 font-medium", align === "right" ? "text-right" : "text-left")}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "flex items-center gap-1 select-none hover:text-foreground",
          align === "right" && "ml-auto"
        )}
      >
        {children}
        {direction === "asc" && <ChevronUp className="size-3.5" />}
        {direction === "desc" && <ChevronDown className="size-3.5" />}
        {!direction && <ChevronsUpDown className="size-3.5 text-muted-foreground/50" />}
      </button>
    </th>
  );
}

export default function DaybookPage({ params }: PageProps<"/[companyId]/reports/daybook">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const { range, setRange, financialYear } = useReportDateRange(companyId);
  const { data, isLoading } = useDaybookQuery(companyId, range.from, range.to);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<DaybookSort | null>(null);

  const rows = useMemo(() => {
    const filtered = (data ?? []).filter((row) => matchesDaybookSearch(row, search));
    return sortDaybookRows(filtered, sort);
  }, [data, search, sort]);

  function toggleSort(column: DaybookSortColumn) {
    setSort((current) => nextDaybookSort(current, column));
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <StatementHeader companyId={companyId} title="Daybook" period={rangePeriod(range.from, range.to)} />

      <div data-print-hide className="flex items-center justify-between">
        <h1 className="text-statement">Daybook</h1>
        <div className="flex gap-2">
        <PrintButton />
        <CsvExportButton
          filename="daybook.csv"
          columns={[
            { key: "voucherDate", header: "Date" },
            { key: "voucherType", header: "Type" },
            { key: "voucherNumber", header: "Voucher No" },
            { key: "drLedgers", header: "Debit Ledgers" },
            { key: "crLedgers", header: "Credit Ledgers" },
            { key: "narration", header: "Narration" },
            { key: "totalAmount", header: "Amount" },
          ]}
          fetchRows={() => getDaybook(supabase, companyId, range.from, range.to)}
        />
        </div>
      </div>

      <div data-print-hide className="flex flex-wrap items-center justify-between gap-2">
        <ReportDateRangeFilter value={range} onChange={setRange} financialYear={financialYear} />
        <div className="relative w-full max-w-xs sm:w-auto sm:flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <tr>
                <SortableHeader column="voucherDate" sort={sort} onSort={toggleSort}>Date</SortableHeader>
                <SortableHeader column="voucherType" sort={sort} onSort={toggleSort}>Type</SortableHeader>
                <SortableHeader column="voucherNumber" sort={sort} onSort={toggleSort}>No.</SortableHeader>
                <SortableHeader column="drLedgers" sort={sort} onSort={toggleSort}>Dr</SortableHeader>
                <SortableHeader column="crLedgers" sort={sort} onSort={toggleSort}>Cr</SortableHeader>
                <SortableHeader column="narration" sort={sort} onSort={toggleSort}>Narration</SortableHeader>
                <SortableHeader column="totalAmount" sort={sort} onSort={toggleSort} align="right">Amount</SortableHeader>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="h-32 text-center text-muted-foreground">
                    {search ? "No entries match your search." : "No entries in this period."}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.voucherId} className="border-t hover:bg-muted/30">
                  <td className="p-2.5 text-muted-foreground">{row.voucherDate}</td>
                  <td className="p-2.5">{VOUCHER_TYPE_CONFIG[row.voucherType as VoucherType]?.label ?? row.voucherType}</td>
                  <td className="p-2.5">
                    <Link href={`/${companyId}/vouchers/${row.voucherId}/edit`} className="font-mono text-xs text-primary hover:underline">
                      {row.voucherNumber}
                    </Link>
                  </td>
                  <td className="p-2.5 text-muted-foreground">{row.drLedgers}</td>
                  <td className="p-2.5 text-muted-foreground">{row.crLedgers}</td>
                  <td className="p-2.5 text-muted-foreground">{row.narration}</td>
                  <td className="p-2.5 text-right tabular-nums">{formatCurrency(row.totalAmount)}</td>
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
