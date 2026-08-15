import Link from "next/link";
import { createAppColumnHelper } from "@/components/data-table/table-features";
import type { VoucherListItem } from "@/lib/supabase/queries/vouchers";
import { formatCurrency } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/badge";

const columnHelper = createAppColumnHelper<VoucherListItem>();

export function buildVoucherColumns(companyId: string) {
  return columnHelper.columns([
    columnHelper.accessor("voucherDate", {
      header: "Date",
      cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span>,
    }),
    columnHelper.accessor("voucherType", {
      header: "Type",
      cell: (info) => (
        <Badge variant="secondary" className="capitalize">
          {info.getValue()}
        </Badge>
      ),
    }),
    columnHelper.accessor("voucherNumber", {
      header: "Number",
      cell: (info) => (
        <Link
          href={`/${companyId}/vouchers/${info.row.original.id}/edit`}
          className="font-mono text-xs text-primary hover:underline"
        >
          {info.getValue()}
        </Link>
      ),
    }),
    columnHelper.accessor("narration", {
      header: "Narration",
      enableSorting: false,
      cell: (info) => <span className="truncate text-muted-foreground">{info.getValue() || "—"}</span>,
    }),
    columnHelper.accessor("totalAmount", {
      header: "Amount",
      cell: (info) => <span className="tabular-nums">{formatCurrency(info.getValue())}</span>,
    }),
  ]);
}
