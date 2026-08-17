"use client";

import { useRef, useState } from "react";
import { Download, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { useExportBackupMutation, useRestoreBackupMutation } from "@/hooks/useBackupQuery";
import {
  backupFileName,
  summariseBackup,
  type BackupSummary,
  type RestoreMode,
} from "@/lib/supabase/queries/backup";
import { downloadTextFile, readFileAsText } from "@/lib/utils/download";
import { toUserMessage } from "@/lib/errors";

export function BackupRestoreSection({
  companyId,
  companyName,
  isAdmin,
}: {
  companyId: string;
  companyName: string;
  isAdmin: boolean;
}) {
  const exportBackup = useExportBackupMutation(companyId);
  const restoreBackup = useRestoreBackupMutation();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ payload: unknown; summary: BackupSummary } | null>(null);
  const [mode, setMode] = useState<RestoreMode>("new");
  const [confirmText, setConfirmText] = useState("");

  async function handleBackup() {
    try {
      const payload = await exportBackup.mutateAsync();
      downloadTextFile(backupFileName(companyName), JSON.stringify(payload, null, 2));
      toast.success("Backup downloaded");
    } catch (err) {
      toast.error(toUserMessage(err, "Could not create a backup"));
    }
  }

  async function handleFilePicked(file: File | undefined) {
    if (!file) return;
    try {
      const payload = JSON.parse(await readFileAsText(file));
      // Rejected here rather than at the database, so an obviously wrong file
      // costs a round trip and gets a sentence the user can act on.
      const summary = summariseBackup(payload);
      setMode("new");
      setConfirmText("");
      setPending({ payload, summary });
    } catch (err) {
      toast.error(
        err instanceof SyntaxError
          ? "That file isn't valid JSON, so it can't be a HISAB backup."
          : toUserMessage(err, "Could not read that backup")
      );
    } finally {
      // Cleared so picking the same file twice still fires a change event.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const overwriteConfirmed = mode !== "overwrite" || confirmText.trim() === companyName;

  async function handleRestore() {
    if (!pending || !overwriteConfirmed) return;
    try {
      const restoredId = await restoreBackup.mutateAsync({
        payload: pending.payload,
        mode,
        targetCompanyId: mode === "overwrite" ? companyId : undefined,
      });
      setPending(null);
      toast.success(
        mode === "overwrite" ? "This company was replaced from the backup" : "Backup restored as a new company",
        { description: mode === "new" ? "Switch to it from the company picker." : undefined }
      );
      if (mode === "overwrite" && restoredId) window.location.reload();
    } catch (err) {
      toast.error(toUserMessage(err, "Could not restore that backup"));
    }
  }

  return (
    <section className="space-y-3 rounded-xl bg-card p-4 shadow-sm ring-1 ring-foreground/10">
      <div>
        <h2 className="text-sm font-medium">Backup &amp; restore</h2>
        <p className="text-sm text-muted-foreground">
          A backup is one file holding this company&apos;s whole chart of accounts, every ledger and
          every voucher. Keep it somewhere safe — a drive, a cloud folder, anywhere you keep
          documents.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleBackup} disabled={exportBackup.isPending}>
          <Download data-icon="inline-start" />
          {exportBackup.isPending ? "Preparing…" : "Back up this company"}
        </Button>

        {isAdmin && (
          <>
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload data-icon="inline-start" />
              Restore from a backup
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => handleFilePicked(e.target.files?.[0])}
            />
          </>
        )}
      </div>

      {!isAdmin && (
        <p className="text-xs text-muted-foreground">
          Anyone in the company can take a backup. Restoring is admin-only.
        </p>
      )}

      <Dialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogDescription>
              {pending && (
                <>
                  <b>{pending.summary.companyName}</b>
                  {pending.summary.exportedAt && (
                    <> — backed up {new Date(pending.summary.exportedAt).toLocaleString("en-IN", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}</>
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {pending && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">{pending.summary.accountGroups} groups</Badge>
                <Badge variant="secondary">{pending.summary.ledgers} ledgers</Badge>
                <Badge variant="secondary">{pending.summary.vouchers} vouchers</Badge>
                <Badge variant="secondary">{pending.summary.voucherEntries} lines</Badge>
              </div>

              <RadioGroup value={mode} onValueChange={(v) => v && setMode(v as RestoreMode)}>
                <Field orientation="horizontal">
                  <RadioGroupItem value="new" id="restore-new" />
                  <div>
                    <FieldLabel htmlFor="restore-new">Restore as a new company</FieldLabel>
                    <FieldDescription>
                      Leaves everything you have now untouched. You can compare the two and delete
                      whichever you don&apos;t want.
                    </FieldDescription>
                  </div>
                </Field>

                <Field orientation="horizontal">
                  <RadioGroupItem value="overwrite" id="restore-overwrite" />
                  <div>
                    <FieldLabel htmlFor="restore-overwrite">Replace {companyName}</FieldLabel>
                    <FieldDescription>
                      Deletes this company&apos;s ledgers and vouchers and puts the backup in their
                      place. Members and invites are kept.
                    </FieldDescription>
                  </div>
                </Field>
              </RadioGroup>

              {mode === "overwrite" && (
                <div className="space-y-2 rounded-lg bg-destructive/5 p-3 ring-1 ring-destructive/20">
                  <p className="flex items-start gap-2 text-sm text-destructive">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>
                      This permanently deletes the vouchers currently in {companyName}. There is no
                      undo — take a backup of it first if you might want it back.
                    </span>
                  </p>
                  <Field>
                    <FieldLabel htmlFor="confirm-name">
                      Type <b>{companyName}</b> to confirm
                    </FieldLabel>
                    <Input
                      id="confirm-name"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      autoComplete="off"
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setPending(null)} disabled={restoreBackup.isPending}>
              Cancel
            </Button>
            <Button
              variant={mode === "overwrite" ? "destructive" : "default"}
              onClick={handleRestore}
              disabled={restoreBackup.isPending || !overwriteConfirmed}
            >
              {restoreBackup.isPending
                ? "Restoring…"
                : mode === "overwrite"
                  ? "Replace this company"
                  : "Restore as new company"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
