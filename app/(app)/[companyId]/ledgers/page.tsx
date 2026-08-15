"use client";

import { use, useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, DEFAULT_PAGE_SIZE } from "@/components/data-table/DataTable";
import { ledgerColumns } from "@/components/ledgers/ledger-columns";
import { LedgerFormDialog } from "@/components/ledgers/LedgerFormDialog";
import { CsvImportModal } from "@/components/csv/CsvImportModal";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { useLedgerGroupsQuery, useLedgersQuery } from "@/hooks/useLedgersQuery";
import { useSupabase } from "@/hooks/useSupabase";
import { buildLedgerCsvImportConfig } from "@/lib/ledgers/ledger-csv-config";
import { searchLedgers } from "@/lib/supabase/queries/ledgers";

export default function LedgersPage({ params }: PageProps<"/[companyId]/ledgers">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState<string>("all");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE });
  const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const { data: groups } = useLedgerGroupsQuery(companyId);
  const { data, isLoading, isFetching } = useLedgersQuery(companyId, {
    q: search || undefined,
    groupId: groupId === "all" ? undefined : groupId,
    page: pagination.pageIndex,
    pageSize: pagination.pageSize,
    sortBy: sorting[0]?.id === "groupName" ? "group" : "name",
    sortDir: sorting[0]?.desc ? "desc" : "asc",
  });

  const importConfig = useMemo(
    () => buildLedgerCsvImportConfig(supabase, companyId, (data?.rows ?? []).map((l) => l.name)),
    [supabase, companyId, data?.rows]
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Ledgers</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
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
        columns={ledgerColumns}
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

      <LedgerFormDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} />
      <CsvImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        config={importConfig}
        onImportComplete={() => queryClient.invalidateQueries({ queryKey: ["companies", companyId, "ledgers"] })}
      />
    </div>
  );
}
