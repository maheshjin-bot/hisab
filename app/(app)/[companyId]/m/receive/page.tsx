"use client";

import { use } from "react";
import { MobileScreen } from "@/components/mobile/MobileScreen";
import { MobileMoneyForm } from "@/components/mobile/MobileMoneyForm";

/** "Money In" — a receipt voucher, asked for in four fields. */
export default function MobileReceivePage({ params }: PageProps<"/[companyId]/m/receive">) {
  const { companyId } = use(params);
  return (
    <MobileScreen title="Money In" backHref={`/${companyId}/m`}>
      <MobileMoneyForm companyId={companyId} voucherType="receipt" returnTo={`/${companyId}/m`} />
    </MobileScreen>
  );
}
