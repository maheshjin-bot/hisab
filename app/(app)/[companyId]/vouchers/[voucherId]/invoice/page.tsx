"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PrintButton } from "@/components/reports/PrintButton";
import { InvoiceDocument } from "@/components/vouchers/InvoiceDocument";
import { useInvoiceDocumentQuery } from "@/hooks/useVouchersQuery";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";

export default function InvoicePage({ params }: PageProps<"/[companyId]/vouchers/[voucherId]/invoice">) {
  const { companyId, voucherId } = use(params);
  const { data, isLoading, error } = useInvoiceDocumentQuery(companyId, voucherId);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-destructive">That voucher could not be loaded.</p>
      </div>
    );
  }

  const { voucher } = data;
  const isInvoiceable = voucher.voucherType === "sales" || voucher.voucherType === "purchase";

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div data-print-hide className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" render={<Link href={`/${companyId}/vouchers`} />}>
          <ArrowLeft data-icon="inline-start" />
          Vouchers
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" render={<Link href={`/${companyId}/vouchers/${voucher.id}/edit`} />}>
            <Pencil data-icon="inline-start" />
            Edit
          </Button>
          {voucher.invoiceLines.length > 0 && <PrintButton />}
        </div>
      </div>

      {voucher.invoiceLines.length > 0 ? (
        <InvoiceDocument data={data} />
      ) : (
        // The 57 sales and purchase vouchers entered before invoicing existed
        // hold a total and two ledgers, and nothing that could be itemised on a
        // document — no descriptions, no quantities, no rates. Inventing them
        // to fill a page would put figures in front of a customer that the
        // books never recorded, so this says what is actually missing.
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {voucher.voucherNumber} has no itemised lines, so there is nothing to print.
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {isInvoiceable
              ? "It was entered as a plain voucher — a total against two ledgers, with no descriptions, quantities or rates. Delete it and re-enter it to get a printable invoice."
              : `A ${VOUCHER_TYPE_CONFIG[voucher.voucherType].label} entry is not a bill. Only sale bills and purchase bills carry itemised lines.`}
          </p>
        </div>
      )}
    </div>
  );
}
