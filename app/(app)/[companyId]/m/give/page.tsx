"use client";

import { use } from "react";
import { MobileScreen } from "@/components/mobile/MobileScreen";
import { MobileMoneyForm } from "@/components/mobile/MobileMoneyForm";

/** "Money Out" — a payment voucher. The mirror of receive/page.tsx. */
export default function MobileGivePage({ params }: PageProps<"/[companyId]/m/give">) {
  const { companyId } = use(params);
  return (
    <MobileScreen title="Money Out" backHref={`/${companyId}/m`}>
      <MobileMoneyForm companyId={companyId} voucherType="payment" returnTo={`/${companyId}/m`} />
    </MobileScreen>
  );
}
