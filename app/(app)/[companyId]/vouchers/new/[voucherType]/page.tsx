"use client";

import { use } from "react";
import { notFound } from "next/navigation";
import { VoucherForm } from "@/components/vouchers/VoucherForm";
import { InvoiceForm } from "@/components/vouchers/InvoiceForm";
import { VoucherTypeTabs } from "@/components/vouchers/VoucherTypeTabs";
import { VOUCHER_TYPE_CONFIG, type VoucherTypeConfig } from "@/lib/voucher/voucher-type-config";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";

function isVoucherType(value: string): value is VoucherType {
  return value in VOUCHER_TYPE_CONFIG;
}

/**
 * Every new sale and purchase is entered as an invoice. Receipt, payment,
 * contra and journal keep the Dr/Cr grid, permanently — apply_invoice()
 * refuses them anyway.
 */
function isInvoiceType(value: VoucherType): value is "sales" | "purchase" {
  return value === "sales" || value === "purchase";
}

export default function NewVoucherPage({ params }: PageProps<"/[companyId]/vouchers/new/[voucherType]">) {
  const { companyId, voucherType } = use(params);

  if (!isVoucherType(voucherType)) {
    notFound();
  }

  const config: VoucherTypeConfig = VOUCHER_TYPE_CONFIG[voucherType];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <VoucherTypeTabs companyId={companyId} active={voucherType} />
      <h1 className="text-lg font-semibold tracking-tight">New {config.label}</h1>
      {/* key forces a full remount on type change — cleaner than morphing
          field-array state between structurally different configs */}
      {isInvoiceType(voucherType) ? (
        <InvoiceForm key={voucherType} companyId={companyId} voucherType={voucherType} />
      ) : (
        <VoucherForm key={voucherType} companyId={companyId} voucherType={voucherType} />
      )}
    </div>
  );
}
