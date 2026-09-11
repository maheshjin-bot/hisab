"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBillCaptureDraftQuery, useExtractBillCaptureMutation } from "@/hooks/useBillCaptureQuery";
import { useBillCapturePhoto } from "./useBillCapturePhoto";
import { BillCaptureForm } from "./BillCaptureForm";
import { RejectCaptureDialog } from "./RejectCaptureDialog";
import { toUserMessage } from "@/lib/errors";

/**
 * The review screen for one capture. Split from BillCaptureForm on purpose:
 * this half handles "no extraction yet" (read the bill, or reject it
 * outright without ever spending an API call), and only mounts the form
 * once an extraction exists — so the form's own state seeds itself from
 * real values on first render instead of an effect catching up later.
 */
export function BillCaptureReview({ companyId, draftId }: { companyId: string; draftId: string }) {
  const { data: draft, isLoading } = useBillCaptureDraftQuery(draftId);
  const extract = useExtractBillCaptureMutation(draftId);
  const photoUrl = useBillCapturePhoto(draft?.storagePath ?? "");
  const [rejecting, setRejecting] = useState(false);

  if (isLoading || !draft) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (draft.status !== "pending_review") {
    return (
      <div className="rounded-lg border bg-muted/30 p-6 text-sm text-muted-foreground">
        This capture is already <strong>{draft.status}</strong>
        {draft.status === "rejected" && draft.rejectedReason && <> — &ldquo;{draft.rejectedReason}&rdquo;</>}.
      </div>
    );
  }

  async function handleExtract() {
    try {
      await extract.mutateAsync();
    } catch (err) {
      toast.error(toUserMessage(err, "Could not read this bill"));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
      <div className="space-y-3">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a private Storage object, not something next/image's remote-loader config knows about
          <img src={photoUrl} alt="Captured bill" className="w-full rounded-lg border object-contain" />
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
        <Button variant="outline" size="sm" className="w-full text-destructive" onClick={() => setRejecting(true)}>
          <Ban data-icon="inline-start" />
          Reject this capture
        </Button>
      </div>

      <div>
        {draft.extraction ? (
          <BillCaptureForm companyId={companyId} draft={draft} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing has been read from this photo yet. Reading it costs one AI call — happens only when you ask.
            </p>
            <Button onClick={handleExtract} disabled={extract.isPending}>
              {extract.isPending ? "Reading…" : "Read this bill"}
            </Button>
          </div>
        )}
      </div>

      <RejectCaptureDialog open={rejecting} onOpenChange={setRejecting} companyId={companyId} draftId={draft.id} />
    </div>
  );
}
