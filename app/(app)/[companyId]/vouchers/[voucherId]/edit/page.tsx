"use client";

import { use } from "react";
import { VoucherForm } from "@/components/vouchers/VoucherForm";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import { useVoucherQuery } from "@/hooks/useVouchersQuery";
import { Skeleton } from "@/components/ui/skeleton";

export default function EditVoucherPage({ params }: PageProps<"/[companyId]/vouchers/[voucherId]/edit">) {
  const { companyId, voucherId } = use(params);
  const { data: voucher, isLoading } = useVoucherQuery(voucherId);

  if (isLoading || !voucher) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const config = VOUCHER_TYPE_CONFIG[voucher.voucherType];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-lg font-semibold tracking-tight">
        Edit {config.label} · {voucher.voucherNumber}
      </h1>
      <VoucherForm companyId={companyId} voucherType={voucher.voucherType} voucherId={voucherId} initialValues={voucher} />
    </div>
  );
}
