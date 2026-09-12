"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, Check, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileField, MOBILE_CONTROL } from "./MobileField";
import { useUploadBillCaptureMutation } from "@/hooks/useBillCaptureQuery";
import { toUserMessage } from "@/lib/errors";

const SAVED_HOLD_MS = 950;

/**
 * SHOOT A BILL, SEND IT — NOTHING ELSE ON THIS SCREEN.
 *
 * Deliberately shows no ledger, no balance, no rupee amount: this is the
 * capture half of Bill Capture, for whoever is standing at the counter with
 * the paper in hand, not the half where someone reviews and posts it. That
 * happens afterward on the existing desktop Bill Capture screen — the same
 * split the feature this was adapted from makes, and for the same reason: a
 * photo taken by whoever is busiest is not the moment to also ask them to
 * pick a ledger.
 *
 * `capture="environment"` opens the phone's back camera directly rather
 * than the gallery, matching how a paper bill actually gets into this app —
 * shot at the counter, not selected from old photos.
 *
 * Nothing here calls the AI. The photos are only uploaded and turned into a
 * draft; reading them happens later, only when someone opens the draft for
 * review — the same reason the desktop upload dialog doesn't read on
 * upload either. This screen also does not queue an upload for later if the
 * connection drops — there is no offline queue anywhere in this app yet, so
 * Send needs a live connection, same as any other save in HISAB today.
 */
export function MobileScanForm({ companyId, returnTo }: { companyId: string; returnTo: string }) {
  const router = useRouter();
  const upload = useUploadBillCaptureMutation(companyId);
  const captureInputRef = useRef<HTMLInputElement>(null);

  const [pages, setPages] = useState<{ file: File; previewUrl: string }[]>([]);
  const [vendorHint, setVendorHint] = useState("");
  const [sent, setSent] = useState(false);

  // Preview URLs are created straight from the files the camera just
  // handed back, before anything is uploaded — revoked here rather than
  // left for the browser, since a shopping session can shoot several bills
  // in a row without ever unmounting this screen.
  useEffect(() => {
    return () => pages.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only, not a re-run trigger
  }, []);

  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => router.push(returnTo), SAVED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [sent, returnTo, router]);

  function handleCaptured(file: File | undefined) {
    if (!file) return;
    setPages((prev) => [...prev, { file, previewUrl: URL.createObjectURL(file) }]);
    if (captureInputRef.current) captureInputRef.current.value = "";
  }

  function removePage(index: number) {
    setPages((prev) => {
      URL.revokeObjectURL(prev[index].previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }

  async function handleSend() {
    if (pages.length === 0) return;
    try {
      await upload.mutateAsync({ files: pages.map((p) => p.file), vendorHint: vendorHint || undefined });
      setSent(true);
    } catch (err) {
      toast.error(toUserMessage(err, "Could not send this bill"));
    }
  }

  if (sent) {
    return (
      <div className="flex min-h-[55vh] flex-col items-center justify-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-success/10 text-success">
          <Check className="size-7" />
        </span>
        <p className="text-[17px] font-semibold">Sent for review</p>
        <p className="text-[13px] text-muted-foreground">
          {pages.length} page{pages.length > 1 ? "s" : ""} · someone will read and post it soon
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <input
        ref={captureInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleCaptured(e.target.files?.[0])}
      />

      {pages.length === 0 ? (
        <button
          type="button"
          onClick={() => captureInputRef.current?.click()}
          className="flex h-56 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-input text-muted-foreground transition-colors active:bg-muted"
        >
          <Camera className="size-10" />
          <span className="text-[15px] font-medium">Tap to photograph a bill</span>
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {pages.map((page, i) => (
            <div key={page.previewUrl} className="relative aspect-3/4 overflow-hidden rounded-lg border">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview of a file just picked, not a remote/Storage asset */}
              <img src={page.previewUrl} alt={`Page ${i + 1}`} className="size-full object-cover" />
              <span className="absolute top-1 left-1 rounded bg-background/90 px-1 text-[10px] font-medium">{i + 1}</span>
              <button
                type="button"
                onClick={() => removePage(i)}
                aria-label={`Remove page ${i + 1}`}
                className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-background/90 text-destructive shadow-sm"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => captureInputRef.current?.click()}
            aria-label="Add another page"
            className="flex aspect-3/4 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input text-muted-foreground transition-colors active:bg-muted"
          >
            <Plus className="size-5" />
            <span className="text-[11px]">Add page</span>
          </button>
        </div>
      )}

      {pages.length > 0 && (
        <>
          <MobileField label="Supplier (optional)" htmlFor="m-scan-hint">
            <input
              id="m-scan-hint"
              value={vendorHint}
              onChange={(e) => setVendorHint(e.target.value)}
              placeholder="A hint for whoever reviews it"
              className={MOBILE_CONTROL}
            />
          </MobileField>

          <div className="flex flex-col gap-2 pt-1">
            <Button onClick={handleSend} disabled={upload.isPending} className="h-12 rounded-xl text-[15px]">
              {upload.isPending ? "Sending…" : `Send ${pages.length > 1 ? `(${pages.length} pages)` : ""}`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push(returnTo)}
              className="h-11 rounded-xl text-[15px] text-muted-foreground"
            >
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
