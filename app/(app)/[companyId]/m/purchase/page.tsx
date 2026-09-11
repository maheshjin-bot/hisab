"use client";

import { use } from "react";
import { MobileScreen } from "@/components/mobile/MobileScreen";
import { InvoiceForm } from "@/components/vouchers/InvoiceForm";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";

/** See sale/page.tsx. The duplicate-bill guard comes along with the form. */
export default function MobilePurchasePage({ params }: PageProps<"/[companyId]/m/purchase">) {
  const { companyId } = use(params);
  return (
    <MobileScreen title={VOUCHER_TYPE_CONFIG.purchase.label} backHref={`/${companyId}/m`}>
      <InvoiceForm companyId={companyId} voucherType="purchase" layout="cards" returnTo={`/${companyId}/m`} />
    </MobileScreen>
  );
}
