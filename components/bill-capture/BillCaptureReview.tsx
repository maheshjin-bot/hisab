"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Ban, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAddBillCapturePageMutation,
  useBillCaptureDraftQuery,
  useExtractBillCaptureMutation,
  useRemoveBillCapturePageMutation,
} from "@/hooks/useBillCaptureQuery";
import { useBillCapturePhotos } from "./useBillCapturePhoto";
import { BillCaptureForm } from "./BillCaptureForm";
import { RejectCaptureDialog } from "./RejectCaptureDialog";
import { toUserMessage } from "@/lib/errors";

/**
 * The review screen for one capture. Split from BillCaptureForm on purpose:
 * this half handles "no extraction yet" (add more pages, read the bill, or
 * reject it outright without ever spending an API call), and only mounts
 * the form once an extraction exists — so the form's own state seeds itself
 * from real values on first render instead of an effect catching up later.
 */
export function BillCaptureReview({ companyId, draftId }: { companyId: string; draftId: string }) {
  const { data: draft, isLoading, isError, error } = useBillCaptureDraftQuery(draftId);
  const extract = useExtractBillCaptureMutation(draftId);
  const addPage = useAddBillCapturePageMutation(companyId, draftId);
  const removePage = useRemoveBillCapturePageMutation(draftId);
  const photoUrls = useBillCapturePhotos(draft?.pages.map((p) => p.storagePath) ?? []);
  const [rejecting, setRejecting] = useState(false);
  const addPageInputRef = useRef<HTMLInputElement>(null);

  if (isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  // Distinct from "still loading" — a failed query left draft undefined too,
  // and showing a skeleton forever for that is just a quieter way of lying
  // than a wrong empty state is.
  if (isError || !draft) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{toUserMessage(error, "Could not load this capture")}</span>
      </div>
    );
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

  async function handleAddPage(file: File | undefined) {
    if (!file || !draft) return;
    try {
      await addPage.mutateAsync({ file, pageNo: draft.pages.length + 1 });
    } catch (err) {
      toast.error(toUserMessage(err, "Could not add that page"));
    } finally {
      if (addPageInputRef.current) addPageInputRef.current.value = "";
    }
  }

  async function handleRemovePage(pageId: string) {
    try {
      await removePage.mutateAsync(pageId);
    } catch (err) {
      toast.error(toUserMessage(err, "Could not remove that page"));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
      <div className="space-y-3">
        {draft.pages.length === 0 ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-2">
            {draft.pages.map((page, i) => (
              <div key={page.id} className="relative">
                {photoUrls[i] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a private Storage object, not something next/image's remote-loader config knows about
                  <img src={photoUrls[i]} alt={`Page ${page.pageNo}`} className="w-full rounded-lg border object-contain" />
                ) : (
                  <Skeleton className="h-64 w-full" />
                )}
                <div className="absolute top-2 left-2 rounded bg-background/90 px-1.5 py-0.5 text-xs font-medium shadow-sm">
                  Page {page.pageNo}
                </div>
                {!draft.extraction && draft.pages.length > 1 && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    className="absolute top-2 right-2 shadow-sm"
                    onClick={() => handleRemovePage(page.id)}
                    disabled={removePage.isPending}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {!draft.extraction && (
          <>
            <input
              ref={addPageInputRef}
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              onChange={(e) => handleAddPage(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => addPageInputRef.current?.click()}
              disabled={addPage.isPending}
            >
              <Plus data-icon="inline-start" />
              {addPage.isPending ? "Adding…" : "Add another page"}
            </Button>
          </>
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
              {draft.pages.length > 1
                ? `Nothing has been read from these ${draft.pages.length} pages yet. Reading them costs one AI call — happens only when you ask.`
                : "Nothing has been read from this photo yet. Reading it costs one AI call — happens only when you ask."}
            </p>
            <Button onClick={handleExtract} disabled={extract.isPending || draft.pages.length === 0}>
              {extract.isPending ? "Reading…" : "Read this bill"}
            </Button>
          </div>
        )}
      </div>

      <RejectCaptureDialog open={rejecting} onOpenChange={setRejecting} companyId={companyId} draftId={draft.id} />
    </div>
  );
}
