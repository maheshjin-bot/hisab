import Link from "next/link";
import { FileText, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { createAppColumnHelper } from "@/components/data-table/table-features";
import type { VoucherListItem } from "@/lib/supabase/queries/vouchers";
import { formatCurrency } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/badge";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const columnHelper = createAppColumnHelper<VoucherListItem>();

export function buildVoucherColumns(companyId: string, onDelete: (voucher: VoucherListItem) => void) {
  return columnHelper.columns([
    columnHelper.accessor("voucherDate", {
      header: "Date",
      cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span>,
    }),
    columnHelper.accessor("voucherType", {
      header: "Type",
      // The stored word ("sales", "contra") is not what the rest of the app
      // calls it, and this column used to print it raw.
      cell: (info) => <Badge variant="secondary">{VOUCHER_TYPE_CONFIG[info.getValue()].label}</Badge>,
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
    columnHelper.display({
      id: "actions",
      header: "",
      cell: (info) => {
        const voucher = info.row.original;
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label={`Actions for voucher ${voucher.voucherNumber}`}
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem render={<Link href={`/${companyId}/vouchers/${voucher.id}/edit`} />}>
                  <Pencil className="size-3.5" />
                  Edit
                </DropdownMenuItem>
                {/* Only sales and purchase carry invoice lines; whether this
                    particular one has any is decided on the page itself, since
                    the list query doesn't read them. */}
                {(voucher.voucherType === "sales" || voucher.voucherType === "purchase") && (
                  <DropdownMenuItem render={<Link href={`/${companyId}/vouchers/${voucher.id}/invoice`} />}>
                    <FileText className="size-3.5" />
                    {voucher.voucherType === "sales" ? "Invoice" : "Bill"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(voucher)}>
                  <Trash2 className="size-3.5" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    }),
  ]);
}
