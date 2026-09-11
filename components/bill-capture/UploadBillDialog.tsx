"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { useUploadBillCaptureMutation } from "@/hooks/useBillCaptureQuery";
import { toUserMessage } from "@/lib/errors";

export function UploadBillDialog({
  open,
  onOpenChange,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [vendorHint, setVendorHint] = useState("");
  const upload = useUploadBillCaptureMutation(companyId);

  function reset() {
    setFile(null);
    setVendorHint("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleUpload() {
    if (!file) return;
    try {
      const draftId = await upload.mutateAsync({ file, vendorHint: vendorHint || undefined });
      reset();
      onOpenChange(false);
      router.push(`/${companyId}/bill-captures/${draftId}`);
    } catch (err) {
      toast.error(toUserMessage(err, "Could not upload this photo"));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Upload a purchase bill</DialogTitle>
          <DialogDescription>
            A photo or scan of a supplier&apos;s bill. Nothing is read from it until you open it for review.
          </DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor="bill-capture-file">Photo</FieldLabel>
          <Input
            id="bill-capture-file"
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="bill-capture-hint">Supplier (optional)</FieldLabel>
          <Input
            id="bill-capture-hint"
            value={vendorHint}
            onChange={(e) => setVendorHint(e.target.value)}
            placeholder="A hint for whoever reviews it"
          />
        </Field>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={upload.isPending}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || upload.isPending}>
            {upload.isPending ? "Uploading…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
