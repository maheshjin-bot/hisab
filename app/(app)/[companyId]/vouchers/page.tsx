"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, DEFAULT_PAGE_SIZE } from "@/components/data-table/DataTable";
import { buildVoucherColumns } from "@/components/vouchers/voucher-columns";
import { useDeleteVoucherMutation, useVouchersQuery } from "@/hooks/useVouchersQuery";
import { useSupabase } from "@/hooks/useSupabase";
import { CsvExportButton } from "@/components/csv/CsvExportButton";
import { CsvImportModal } from "@/components/csv/CsvImportModal";
import { buildVoucherCsvImportConfig } from "@/lib/voucher/voucher-csv-config";
import { listVouchers, type VoucherListItem, type VoucherType } from "@/lib/supabase/queries/vouchers";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toUserMessage } from "@/lib/errors";
import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export default function VouchersPage({ params }: PageProps<"/[companyId]/vouchers">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const queryClient = useQueryClient();

  const [voucherType, setVoucherType] = useState<string>("all");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE });
  const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<VoucherListItem | null>(null);

  const deleteVoucher = useDeleteVoucherMutation(companyId);

  const { data, isLoading, isFetching } = useVouchersQuery(companyId, {
    voucherType: voucherType === "all" ? undefined : (voucherType as VoucherType),
    page: pagination.pageIndex,
    pageSize: pagination.pageSize,
  });

  const columns = useMemo(() => buildVoucherColumns(companyId, setDeleting), [companyId]);
  const importConfig = useMemo(() => buildVoucherCsvImportConfig(supabase, companyId), [supabase, companyId]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Vouchers</h1>
          <p className="text-sm text-muted-foreground">Every payment, receipt, sale, purchase, contra and journal entry.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload data-icon="inline-start" />
            Import CSV
          </Button>
          <CsvExportButton
            filename="vouchers.csv"
            columns={[
              { key: "voucherDate", header: "Date" },
              { key: "voucherType", header: "Type" },
              { key: "voucherNumber", header: "Number" },
              { key: "narration", header: "Narration" },
              { key: "totalAmount", header: "Amount" },
            ]}
            fetchRows={async () => (await listVouchers(supabase, companyId, { page: 0, pageSize: 20000 })).rows}
          />
          <Button size="sm" nativeButton={false} render={<Link href={`/${companyId}/vouchers/new/${VOUCHER_TYPE_ORDER[0]}`} />}>
            <Plus data-icon="inline-start" />
            New voucher
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
        emptyState="No vouchers yet."
        toolbar={
          <Select
            value={voucherType}
            onValueChange={(v) => {
              setVoucherType(v ?? "all");
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {VOUCHER_TYPE_ORDER.map((type) => (
                <SelectItem key={type} value={type}>
                  {VOUCHER_TYPE_CONFIG[type].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this voucher?"
        description={
          <>
            <b>{deleting?.voucherNumber}</b> will stop appearing in the register and in every
            report. The record is kept, and its number is not reissued.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteVoucher.mutateAsync(deleting.id);
            toast.success(`Voucher ${deleting.voucherNumber} deleted`);
          } catch (err) {
            // Most likely a locked period: the RLS update policy refuses an
            // accountant's change to a voucher dated on or before the lock
            // date, and there is no way to know that before trying.
            toast.error(
              toUserMessage(err, "Could not delete this voucher — it may fall in a locked period.")
            );
            throw err;
          }
        }}
      />

      <CsvImportModal
        open={importOpen}
        companyId={companyId}
        onOpenChange={setImportOpen}
        config={importConfig}
        onImportComplete={() => queryClient.invalidateQueries({ queryKey: ["companies", companyId, "vouchers"] })}
      />
    </div>
  );
}
