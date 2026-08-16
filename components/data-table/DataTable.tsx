"use client";

import {
  useTable,
  stockFeatures,
  flexRender,
  type ColumnDef,
  type SortingState,
  type PaginationState,
  type OnChangeFn,
  type RowData,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUiPreferencesStore } from "@/stores/useUiPreferencesStore";
import type { AppTableFeatures } from "./table-features";

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<AppTableFeatures, TData, unknown>[];
  data: TData[];
  rowCount: number;
  state: { pagination: PaginationState; sorting: SortingState };
  onPaginationChange: OnChangeFn<PaginationState>;
  onSortingChange: OnChangeFn<SortingState>;
  isLoading?: boolean;
  toolbar?: React.ReactNode;
  emptyState?: React.ReactNode;
}

/**
 * Generic dense table used by the Ledger Manager, Voucher register, Trial
 * Balance, and CSV preview. Always server-paginated/sorted (manualPagination
 * + manualSorting) — it renders whatever page the server returned and never
 * re-sorts/re-filters a partial client-side slice.
 */
export function DataTable<TData extends RowData>({
  columns,
  data,
  rowCount,
  state,
  onPaginationChange,
  onSortingChange,
  isLoading,
  toolbar,
  emptyState,
}: DataTableProps<TData>) {
  const table = useTable({
    features: stockFeatures,
    columns,
    data,
    state,
    onPaginationChange,
    onSortingChange,
    manualPagination: true,
    manualSorting: true,
    rowCount,
  });

  const pageCount = table.getPageCount();
  const { pageIndex } = state.pagination;
  // Persisted per browser; the CSS that reads it lives in globals.css.
  const density = useUiPreferencesStore((s) => s.tableDensity);

  return (
    <div className="space-y-3">
      {toolbar}
      {/* Registers are wide; scroll the table inside its own container so the
          page body never scrolls sideways. */}
      <div className="overflow-x-auto overflow-y-hidden rounded-xl border" data-density={density}>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          className="flex items-center gap-1 select-none hover:text-foreground"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === "asc" && <ChevronUp className="size-3.5" />}
                          {sorted === "desc" && <ChevronDown className="size-3.5" />}
                          {!sorted && <ChevronsUpDown className="size-3.5 text-muted-foreground/50" />}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {columns.map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="h-32 text-center text-sm text-muted-foreground">
                  {emptyState ?? "No results"}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {pageIndex + 1} of {pageCount} · {rowCount} total
          </span>
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={pageIndex === 0}
              onClick={() => onPaginationChange((s) => ({ ...s, pageIndex: s.pageIndex - 1 }))}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={pageIndex >= pageCount - 1}
              onClick={() => onPaginationChange((s) => ({ ...s, pageIndex: s.pageIndex + 1 }))}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export { flexRender };
export { createAppColumnHelper } from "./table-features";
export type { AppTableFeatures } from "./table-features";
export const DEFAULT_PAGE_SIZE = 25;
