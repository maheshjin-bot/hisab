"use client";

import { use } from "react";
import { useSearchParams } from "next/navigation";
import { VoucherForm } from "@/components/vouchers/VoucherForm";
import { InvoiceForm } from "@/components/vouchers/InvoiceForm";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import { useVoucherQuery } from "@/hooks/useVouchersQuery";
import { readReturnTo } from "@/lib/utils/return-to";
import { Skeleton } from "@/components/ui/skeleton";

export default function EditVoucherPage({ params }: PageProps<"/[companyId]/vouchers/[voucherId]/edit">) {
  const { companyId, voucherId } = use(params);
  const { data: voucher, isLoading } = useVoucherQuery(voucherId);
  // Whoever linked here (a report, a ledger's own statement, the register
  // itself) says where Cancel and a successful save should go — the register
  // is only the default for a link that never named one.
  const returnTo = readReturnTo(useSearchParams(), `/${companyId}/vouchers`);

  if (isLoading || !voucher) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const config = VOUCHER_TYPE_CONFIG[voucher.voucherType];

  /**
   * The rule, and the whole of it: a voucher that *has* invoice lines edits as
   * an invoice; one that does not keeps the Dr/Cr grid it was entered on.
   *
   * The voucher type is not the test. There are 57 sales and purchase vouchers
   * in the books with no invoice lines, and 0021 is explicit that a voucher
   * with no invoice lines is a valid voucher permanently — so they must keep
   * opening and saving exactly as before, and they do, because this branch
   * never fires for them.
   *
   * The other direction is enforced by the database rather than trusted to the
   * UI: update_voucher() refuses a plain-lines save of a voucher that has
   * invoice lines, so an invoice can only ever be saved back through
   * InvoiceForm. It stops being one by being deleted and re-entered.
   */
  const isInvoice = voucher.invoiceLines.length > 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-lg font-semibold tracking-tight">
        Edit {config.label} · {voucher.voucherNumber}
      </h1>
      {isInvoice && (voucher.voucherType === "sales" || voucher.voucherType === "purchase") ? (
        <InvoiceForm
          companyId={companyId}
          voucherType={voucher.voucherType}
          voucherId={voucherId}
          initialValues={voucher}
          returnTo={returnTo}
        />
      ) : (
        <VoucherForm
          companyId={companyId}
          voucherType={voucher.voucherType}
          voucherId={voucherId}
          initialValues={voucher}
          returnTo={returnTo}
        />
      )}
    </div>
  );
}
