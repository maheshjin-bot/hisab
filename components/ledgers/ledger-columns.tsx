import { createAppColumnHelper } from "@/components/data-table/table-features";
import type { Ledger } from "@/lib/supabase/queries/ledgers";
import { formatWithDrCr } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/badge";

const columnHelper = createAppColumnHelper<Ledger>();

export const ledgerColumns = columnHelper.columns([
  columnHelper.accessor("name", {
    header: "Name",
    cell: (info) => <span className="font-medium">{info.getValue()}</span>,
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
]);
