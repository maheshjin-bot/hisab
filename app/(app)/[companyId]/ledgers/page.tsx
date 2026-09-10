"use client";

import { use, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, DEFAULT_PAGE_SIZE } from "@/components/data-table/DataTable";
import { buildLedgerColumns } from "@/components/ledgers/ledger-columns";
import { LedgerFormDialog } from "@/components/ledgers/LedgerFormDialog";
import { MergeLedgerDialog } from "@/components/ledgers/MergeLedgerDialog";
import { CsvImportModal } from "@/components/csv/CsvImportModal";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  useLedgerBalancesQuery,
  useLedgerGroupsQuery,
  useLedgersQuery,
  useUpdateLedgerMutation,
} from "@/hooks/useLedgersQuery";
import { useCompanyRole } from "@/hooks/useCompaniesQuery";
import { useSupabase } from "@/hooks/useSupabase";
import { buildLedgerCsvImportConfig } from "@/lib/ledgers/ledger-csv-config";
import { searchLedgers, type Ledger } from "@/lib/supabase/queries/ledgers";
import { formatWithDrCr } from "@/lib/utils/currency";
import { itemsWithPending, selectItems } from "@/lib/utils/select-items";
import { toUserMessage } from "@/lib/errors";

export default function LedgersPage({ params }: PageProps<"/[companyId]/ledgers">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  // Lets the Dashboard's "Add Ledger" / "CSV Import" quick actions land here
  // pre-opened instead of just parking the user on the list — read once on
  // arrival; deliberately not kept in sync afterwards, so closing either
  // dialog doesn't need to also rewrite the URL.
  const searchParams = useSearchParams();

  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState<string>("all");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE });
  const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const [createOpen, setCreateOpen] = useState(() => searchParams.get("new") === "1");
  const [importOpen, setImportOpen] = useState(() => searchParams.get("import") === "1");
  const [editing, setEditing] = useState<Ledger | null>(null);
  const [togglingActive, setTogglingActive] = useState<Ledger | null>(null);
  const [merging, setMerging] = useState<Ledger | null>(null);

  const isAdmin = useCompanyRole(companyId) === "admin";
  const updateLedger = useUpdateLedgerMutation(companyId);

  const { data: groups } = useLedgerGroupsQuery(companyId);
  const { data, isLoading, isFetching } = useLedgersQuery(companyId, {
    q: search || undefined,
    groupId: groupId === "all" ? undefined : groupId,
    page: pagination.pageIndex,
    pageSize: pagination.pageSize,
    sortBy: sorting[0]?.id === "groupName" ? "group" : "name",
    sortDir: sorting[0]?.desc ? "desc" : "asc",
  });

  // Only while a deactivation is actually being confirmed — the query sweeps
  // every entry in the company, and the answer is wanted for one ledger.
  const { data: balances } = useLedgerBalancesQuery(companyId, !!togglingActive?.isActive);

  // undefined = not known yet (still loading, or the read failed), 0 = the
  // ledger is at nil, anything else = the balance migration 0017's trigger
  // will refuse to let go inactive. Leaving it undefined on failure means a
  // bad read never blocks a deactivation the database would have allowed.
  const heldBalance = togglingActive?.isActive ? balances?.get(togglingActive.id) : undefined;

  // The group filter's trigger reads its label from here rather than from the
  // option that was clicked, so this has to cover every value the filter can
  // hold — including a group picked before the list came back.
  const groupFilterItems = useMemo(
    () =>
      itemsWithPending(
        selectItems(groups, (g) => [g.id, g.name], { all: "All groups" }),
        groupId,
        "All groups"
      ),
    [groups, groupId]
  );

  const importConfig = useMemo(
    () => buildLedgerCsvImportConfig(supabase, companyId),
    [supabase, companyId]
  );

  const columns = useMemo(
    () =>
      buildLedgerColumns({
        companyId,
        isAdmin,
        onEdit: setEditing,
        onToggleActive: setTogglingActive,
        onMerge: setMerging,
      }),
    [companyId, isAdmin]
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Parties & Ledgers</h1>
          <p className="text-sm text-muted-foreground">Every account your books post to — customers, suppliers, cash, bank, and more.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload data-icon="inline-start" />
            Import CSV
          </Button>
          <CsvExportButton
            filename="ledgers.csv"
            columns={[
              { key: "name", header: "Ledger Name" },
              { key: "groupName", header: "Group" },
              { key: "openingBalanceAmount", header: "Opening Balance" },
              { key: "openingBalanceType", header: "Dr/Cr", format: (v) => (v === "credit" ? "Cr" : "Dr") },
              { key: "contactPerson", header: "Contact Person" },
              { key: "phone", header: "Phone" },
              { key: "email", header: "Email" },
            ]}
            fetchRows={async () => (await searchLedgers(supabase, companyId, { page: 0, pageSize: 20000 })).rows}
          />
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            New ledger
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={data?.rows ?? []}
        rowCount={data?.total ?? 0}
        state={{ pagination, sorting }}
        onPaginationChange={setPagination}
        onSortingChange={setSorting}
        isLoading={isLoading || isFetching}
        emptyState="No ledgers yet — create one or import a CSV to get started."
        toolbar={
          <div className="flex gap-2">
            <div className="relative max-w-xs flex-1">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search ledgers…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
                className="pl-8"
              />
            </div>
            <Select
              value={groupId}
              // Without this the trigger shows the group's id — see the note
              // on Select. "all" needs to be in the map too, or the unfiltered
              // state reads as the literal word "all".
              items={groupFilterItems}
              onValueChange={(v) => {
                setGroupId(v ?? "all");
                setPagination((p) => ({ ...p, pageIndex: 0 }));
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All groups" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All groups</SelectItem>
                {groups?.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      <LedgerFormDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} canEditFinancials={isAdmin} />
      <LedgerFormDialog
        // Keyed so switching straight from one ledger's Edit to another's
        // remounts the form rather than leaving the first one's values in it.
        key={editing?.id ?? "none"}
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        companyId={companyId}
        ledger={editing ?? undefined}
        canEditFinancials={isAdmin}
      />
      <ConfirmDialog
        open={!!togglingActive}
        onOpenChange={(open) => !open && setTogglingActive(null)}
        title={togglingActive?.isActive ? "Deactivate this ledger?" : "Reactivate this ledger?"}
        description={
          !togglingActive?.isActive ? (
            <>
              <b>{togglingActive?.name}</b> will be selectable on vouchers again.
            </>
          ) : heldBalance ? (
            <>
              <b>{togglingActive.name}</b> still holds {formatWithDrCr(heldBalance)}, so it can&apos;t be
              deactivated yet. Clear it to nil first — transfer the balance, settle it, or write it off —
              then come back here. Its entries and history stay exactly as they are meanwhile.
            </>
          ) : (
            <>
              <b>{togglingActive.name}</b> will stop appearing when you pick a ledger on a voucher. Its
              existing entries and history are untouched, and you can reactivate it at any time.{" "}
              {heldBalance === 0
                ? "Its balance is already nil, so there is nothing left to clear."
                : "One condition: a ledger still holding a balance can’t be deactivated — clear it to nil first, by transferring, settling or writing it off."}
            </>
          )
        }
        confirmLabel={togglingActive?.isActive ? "Deactivate" : "Reactivate"}
        destructive={togglingActive?.isActive}
        confirmDisabled={!!heldBalance}
        onConfirm={async () => {
          if (!togglingActive) return;
          try {
            await updateLedger.mutateAsync({
              ledgerId: togglingActive.id,
              input: { isActive: !togglingActive.isActive },
            });
          } catch (err) {
            toast.error(toUserMessage(err, "Could not update this ledger"));
            throw err;
          }
        }}
      />
      {merging && (
        <MergeLedgerDialog
          open={!!merging}
          onOpenChange={(open) => !open && setMerging(null)}
          companyId={companyId}
          source={merging}
        />
      )}
      <CsvImportModal
        open={importOpen}
        companyId={companyId}
        onOpenChange={setImportOpen}
        config={importConfig}
        onImportComplete={() => queryClient.invalidateQueries({ queryKey: ["companies", companyId, "ledgers"] })}
      />
    </div>
  );
}
