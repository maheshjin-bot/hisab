"use client";

import { use } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { BillCaptureReview } from "@/components/bill-capture/BillCaptureReview";

export default function BillCaptureReviewPage({ params }: PageProps<"/[companyId]/bill-captures/[draftId]">) {
  const { companyId, draftId } = use(params);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <Link href={`/${companyId}/bill-captures`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-3.5" />
        Back to captures
      </Link>
      <h1 className="text-lg font-semibold tracking-tight">Review this bill</h1>
      <BillCaptureReview companyId={companyId} draftId={draftId} />
    </div>
  );
}
