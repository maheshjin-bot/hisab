"use client";

import { use, useState } from "react";
import Link from "next/link";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { UploadBillDialog } from "@/components/bill-capture/UploadBillDialog";
import { useBillCaptureDraftsQuery } from "@/hooks/useBillCaptureQuery";
import type { BillCaptureStatus } from "@/lib/supabase/queries/bill-capture";

const STATUS_STYLE: Record<BillCaptureStatus, string> = {
  pending_review: "bg-warning/10 text-warning",
  confirmed: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
};

const STATUS_LABEL: Record<BillCaptureStatus, string> = {
  pending_review: "Pending review",
  confirmed: "Posted",
  rejected: "Rejected",
};

export default function BillCapturesPage({ params }: PageProps<"/[companyId]/bill-captures">) {
  const { companyId } = use(params);
  const [uploadOpen, setUploadOpen] = useState(false);
  const { data: drafts, isLoading } = useBillCaptureDraftsQuery(companyId);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Bill Capture</h1>
          <p className="text-sm text-muted-foreground">
            Photograph a supplier&apos;s bill and let AI read it — you always review and confirm before anything
            posts.
          </p>
        </div>
        <Button size="sm" onClick={() => setUploadOpen(true)}>
          <Camera data-icon="inline-start" />
          Upload a bill
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !drafts?.length ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
          No bills captured yet — upload a photo to get started.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {drafts.map((draft) => (
            <Link
              key={draft.id}
              href={`/${companyId}/bill-captures/${draft.id}`}
              className="flex items-center justify-between gap-3 border-b p-3 text-sm last:border-b-0 hover:bg-muted/30"
            >
              <div>
                <div className="font-medium">{draft.extraction?.vendorName ?? draft.vendorHint ?? "Untitled capture"}</div>
                <div className="text-xs text-muted-foreground">{new Date(draft.createdAt).toLocaleString("en-IN")}</div>
              </div>
              <Badge variant="secondary" className={STATUS_STYLE[draft.status]}>
                {STATUS_LABEL[draft.status]}
              </Badge>
            </Link>
          ))}
        </div>
      )}

      <UploadBillDialog open={uploadOpen} onOpenChange={setUploadOpen} companyId={companyId} />
    </div>
  );
}
