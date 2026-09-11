"use client";

import { use } from "react";
import { MobileScreen } from "@/components/mobile/MobileScreen";
import { InvoiceForm } from "@/components/vouchers/InvoiceForm";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";

/**
 * The same InvoiceForm the desktop page uses, with its lines drawn as
 * stacked cards instead of the seven-column grid, and a return home after
 * saving (the printed invoice stays one tap away on the toast).
 */
export default function MobileSalePage({ params }: PageProps<"/[companyId]/m/sale">) {
  const { companyId } = use(params);
  return (
    <MobileScreen title={VOUCHER_TYPE_CONFIG.sales.label} backHref={`/${companyId}/m`}>
      <InvoiceForm companyId={companyId} voucherType="sales" layout="cards" returnTo={`/${companyId}/m`} />
    </MobileScreen>
  );
}
