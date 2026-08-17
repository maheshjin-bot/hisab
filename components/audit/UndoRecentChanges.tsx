"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { History, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { useSupabase } from "@/hooks/useSupabase";
import {
  describePreviewRow,
  previewRevert,
  revertChangesSince,
  sinceFromDate,
  sinceFromHours,
  totalPreviewEntries,
  UNDO_PRESETS,
  type UndoPresetId,
} from "@/lib/supabase/queries/undo";
import { toUserMessage } from "@/lib/errors";

const CONFIRM_WORD = "UNDO";

export function UndoRecentChanges({ companyId }: { companyId: string }) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();

  const [preset, setPreset] = useState<UndoPresetId | "date">("3d");
  const [customDate, setCustomDate] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  // Recomputed per render for the presets so the window doesn't drift as the
  // page sits open; the query key below pins it per minute so it isn't
  // refetching constantly.
  const since = useMemo(() => {
    if (preset === "date") return customDate ? sinceFromDate(customDate) : null;
    const hours = UNDO_PRESETS.find((p) => p.id === preset)?.hours ?? 72;
    return sinceFromHours(hours);
  }, [preset, customDate]);

  const minuteBucket = since ? Math.floor(since.getTime() / 60000) : null;

  const preview = useQuery({
    queryKey: ["companies", companyId, "revert-preview", minuteBucket],
    queryFn: () => previewRevert(supabase, companyId, since as Date),
    enabled: !!since,
  });

  const revert = useMutation({
    mutationFn: () => revertChangesSince(supabase, companyId, since as Date),
    onSuccess: (count) => {
      // An undo can touch anything, so nothing cached is trustworthy after it.
      queryClient.invalidateQueries();
      setConfirmOpen(false);
      setConfirmText("");
      toast.success(
        count === 0 ? "Nothing to undo in that period" : `Undid ${count} recorded change${count === 1 ? "" : "s"}`
      );
    },
    onError: (err) => toast.error(toUserMessage(err, "Could not undo those changes")),
  });

  const rows = preview.data ?? [];
  const total = totalPreviewEntries(rows);

  return (
    <div className="space-y-3 rounded-xl bg-card p-4 shadow-sm ring-1 ring-foreground/10">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <History className="size-4 text-muted-foreground" />
          Undo recent changes
        </h2>
        <p className="text-sm text-muted-foreground">
          Rewinds this company&apos;s books to how they stood at a point in time, using the history
          below. Vouchers, lines, ledgers and account groups only — members and company settings are
          left alone.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {UNDO_PRESETS.map((p) => (
          <Button
            key={p.id}
            type="button"
            variant={preset === p.id ? "default" : "outline"}
            size="sm"
            onClick={() => setPreset(p.id)}
          >
            {p.label}
          </Button>
        ))}
        <Button
          type="button"
          variant={preset === "date" ? "default" : "outline"}
          size="sm"
          onClick={() => setPreset("date")}
        >
          Since a date
        </Button>
        {preset === "date" && (
          <Input
            type="date"
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            className="w-40"
            aria-label="Undo everything changed since this date"
            max={new Date().toISOString().slice(0, 10)}
          />
        )}
      </div>

      {!since ? (
        <p className="text-sm text-muted-foreground">Pick a date to see what would be undone.</p>
      ) : preview.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing has changed since {since.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">
            Since{" "}
            <b>{since.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</b>:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {rows.map((r) => (
              <Badge key={`${r.tableName}-${r.action}`} variant="secondary">
                {describePreviewRow(r)}
              </Badge>
            ))}
          </div>
          <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
            Undo these {total} change{total === 1 ? "" : "s"}
          </Button>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Undo {total} change{total === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>
              Everything recorded since{" "}
              {since?.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} will be
              rolled back.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="flex items-start gap-2 rounded-lg bg-destructive/5 p-3 text-sm text-destructive ring-1 ring-destructive/20">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                Vouchers entered in this period will be deleted and edits reversed. The undo is
                itself recorded, but there is no one-click way back — take a backup from Settings
                first if you&apos;re unsure.
              </span>
            </p>

            <Field>
              <FieldLabel htmlFor="undo-confirm">
                Type <b>{CONFIRM_WORD}</b> to confirm
              </FieldLabel>
              <Input
                id="undo-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </div>

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={revert.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={revert.isPending || confirmText.trim().toUpperCase() !== CONFIRM_WORD}
              onClick={() => revert.mutate()}
            >
              {revert.isPending ? "Undoing…" : `Undo ${total} change${total === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
