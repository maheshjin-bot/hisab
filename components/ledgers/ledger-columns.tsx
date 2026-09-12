import Link from "next/link";
import { Merge, MoreHorizontal, Pencil, Power, PowerOff } from "lucide-react";
import { createAppColumnHelper } from "@/components/data-table/table-features";
import type { Ledger } from "@/lib/supabase/queries/ledgers";
import { canMergeLedgerRole } from "@/lib/ledgers/merge-eligibility";
import { formatWithDrCr } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const columnHelper = createAppColumnHelper<Ledger>();

export function buildLedgerColumns({
  companyId,
  isAdmin,
  onEdit,
  onToggleActive,
  onMerge,
}: {
  companyId: string;
  /** Merging is admin-only (migration 0029) — hidden rather than shown-and-refused for anyone else. */
  isAdmin: boolean;
  onEdit: (ledger: Ledger) => void;
  onToggleActive: (ledger: Ledger) => void;
  onMerge: (ledger: Ledger) => void;
}) {
  return columnHelper.columns([
    columnHelper.accessor("name", {
      header: "Name",
      cell: (info) => (
        <Link
          href={`/${companyId}/reports/ledger-statement?ledgerId=${info.row.original.id}`}
          className="font-medium text-primary hover:underline"
        >
          {info.getValue()}
        </Link>
      ),
    }),
    columnHelper.accessor("groupName", {
      header: "Group",
      cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span>,
    }),
    columnHelper.accessor("openingBalanceAmount", {
      header: "Opening Balance",
      cell: (info) => (
        <span className="tabular-nums">
          {formatWithDrCr(info.row.original.openingBalanceType === "credit" ? -info.getValue() : info.getValue())}
        </span>
      ),
    }),
    columnHelper.accessor("contactPerson", {
      header: "Contact",
      cell: (info) => <span className="text-muted-foreground">{info.getValue() || "—"}</span>,
    }),
    columnHelper.accessor("isActive", {
      header: "Status",
      enableSorting: false,
      cell: (info) =>
        info.getValue() ? (
          <Badge variant="secondary" className="bg-success/10 text-success">
            Active
          </Badge>
        ) : (
          <Badge variant="secondary" className="bg-muted text-muted-foreground">
            Inactive
          </Badge>
        ),
    }),
    columnHelper.display({
      id: "actions",
      header: "",
      cell: (info) => {
        const ledger = info.row.original;
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label={`Actions for ${ledger.name}`}
                  />
                }
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onEdit(ledger)}>
                  <Pencil className="size-3.5" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onToggleActive(ledger)}>
                  {ledger.isActive ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                  {ledger.isActive ? "Deactivate" : "Reactivate"}
                </DropdownMenuItem>
                {isAdmin && canMergeLedgerRole(ledger.ledgerRole) && (
                  <DropdownMenuItem onClick={() => onMerge(ledger)}>
                    <Merge className="size-3.5" />
                    Merge into…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    }),
  ]);
}
