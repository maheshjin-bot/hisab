"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useRejectBillCaptureMutation } from "@/hooks/useBillCaptureQuery";
import { toUserMessage } from "@/lib/errors";

/** A rejection is terminal (migration 0030's trigger) and needs a reason — shown to whoever captured it, so "blurry, retake" is worth more than a bare click. */
export function RejectCaptureDialog({
  open,
  onOpenChange,
  companyId,
  draftId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  draftId: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const reject = useRejectBillCaptureMutation(companyId);

  async function handleReject() {
    if (!reason.trim()) return;
    try {
      await reject.mutateAsync({ draftId, reason });
      toast.success("Capture rejected");
      onOpenChange(false);
      router.push(`/${companyId}/bill-captures`);
    } catch (err) {
      toast.error(toUserMessage(err, "Could not reject this capture"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reject this capture?</DialogTitle>
          <DialogDescription>
            The photo is kept as a record, but this capture can no longer be read or posted. Say why, for whoever
            captured it.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Blurry photo, please retake"
          rows={3}
          autoFocus
        />
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={reject.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleReject} disabled={!reason.trim() || reject.isPending}>
            {reject.isPending ? "Rejecting…" : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
