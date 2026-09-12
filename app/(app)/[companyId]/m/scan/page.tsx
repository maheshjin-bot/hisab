"use client";

import { use } from "react";
import { MobileScreen } from "@/components/mobile/MobileScreen";
import { MobileScanForm } from "@/components/mobile/MobileScanForm";

/** Shoot a purchase bill and send it — the shop-floor half of Bill Capture. Reviewing and posting stays on the desktop screen. */
export default function MobileScanPage({ params }: PageProps<"/[companyId]/m/scan">) {
  const { companyId } = use(params);
  return (
    <MobileScreen title="Scan a Bill" backHref={`/${companyId}/m`}>
      <MobileScanForm companyId={companyId} returnTo={`/${companyId}/m`} />
    </MobileScreen>
  );
}
