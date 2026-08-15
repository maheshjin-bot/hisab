"use client";

import { use, useState } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportDateRangeFilter, defaultDateRange } from "@/components/reports/ReportDateRangeFilter";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { useDaybookQuery } from "@/hooks/useReportsQueries";
import { useSupabase } from "@/hooks/useSupabase";
import { getDaybook } from "@/lib/supabase/queries/reports";
import { formatCurrency } from "@/lib/utils/currency";

export default function DaybookPage({ params }: PageProps<"/[companyId]/reports/daybook">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const [range, setRange] = useState(defaultDateRange());
  const { data, isLoading } = useDaybookQuery(companyId, range.from, range.to);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Daybook</h1>
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

      <ReportDateRangeFilter value={range} onChange={setRange} />

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-2.5 text-left font-medium">Date</th>
                <th className="p-2.5 text-left font-medium">Type</th>
                <th className="p-2.5 text-left font-medium">No.</th>
                <th className="p-2.5 text-left font-medium">Dr</th>
                <th className="p-2.5 text-left font-medium">Cr</th>
                <th className="p-2.5 text-left font-medium">Narration</th>
                <th className="p-2.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data?.length === 0 && (
                <tr>
                  <td colSpan={7} className="h-32 text-center text-muted-foreground">
                    No entries in this period.
                  </td>
                </tr>
              )}
              {data?.map((row) => (
                <tr key={row.voucherId} className="border-t hover:bg-muted/30">
                  <td className="p-2.5 text-muted-foreground">{row.voucherDate}</td>
                  <td className="p-2.5 capitalize">{row.voucherType}</td>
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
    </div>
  );
}
