"use client";

import { useState } from "react";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { LedgerCombobox } from "./LedgerCombobox";
import { useMergeLedgerMutation } from "@/hooks/useLedgersQuery";
import { mergeBlockedReason } from "@/lib/ledgers/merge-eligibility";
import type { Ledger, LedgerSearchResult } from "@/lib/supabase/queries/ledgers";
import { toUserMessage } from "@/lib/errors";

// Every role except cash_bank — merge_ledgers() (migration 0029) refuses a
// cash or bank ledger on either side, so the picker never offers one. Not
// built from LedgerRole's members at runtime (a union type has none to
// enumerate); mirrors canMergeLedgerRole()'s rule by hand instead.
const MERGEABLE_ROLES = ["debtor", "creditor", "income", "expense", "capital", "loan", "fixed_asset", "other"] as const;

/**
 * Collapses `source` into another ledger the admin picks. "Merge into…" on a
 * ledger row opens this with that row as the source — the one that will stop
 * existing when this is done.
 */
export function MergeLedgerDialog({
  open,
  onOpenChange,
  companyId,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  source: Ledger;
}) {
  const [target, setTarget] = useState<LedgerSearchResult | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const merge = useMergeLedgerMutation(companyId);

  const blockedReason = mergeBlockedReason(source, target, confirmText);

  function reset() {
    setTarget(null);
    setConfirmText("");
  }

  async function handleMerge() {
    if (blockedReason || !target) return;
    try {
      await merge.mutateAsync({ sourceLedgerId: source.id, targetLedgerId: target.id });
      toast.success(`"${source.name}" was merged into "${target.name}"`);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(toUserMessage(err, "Could not merge these ledgers"));
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge &ldquo;{source.name}&rdquo; into…</DialogTitle>
          <DialogDescription>
            Every transaction posted to <b>{source.name}</b> moves to the ledger you pick below, their
            opening balances are combined, and <b>{source.name}</b> is then permanently deleted. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field>
            <FieldLabel>Merge into</FieldLabel>
            <LedgerCombobox
              companyId={companyId}
              value={target?.id ?? ""}
              displayName={target?.name}
              onSelect={setTarget}
              excludeId={source.id}
              allowCreate={false}
              placeholder="Search ledgers…"
              sideRule={{ label: "ledger to merge into", allowedRoles: [...MERGEABLE_ROLES], filterMode: "hard" }}
            />
            <FieldDescription>
              Cash and bank ledgers can&apos;t be merged yet — they carry reconciliation history this
              doesn&apos;t move.
            </FieldDescription>
          </Field>

          {target && (
            <Field>
              <FieldLabel htmlFor="merge-confirm-text">
                Type <b>{source.name}</b> to confirm
              </FieldLabel>
              <Input
                id="merge-confirm-text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              &ldquo;{source.name}&rdquo; will be gone from every list, report and voucher picker once this
              is done.
            </span>
          </div>
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={merge.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleMerge} disabled={!!blockedReason || merge.isPending}>
            {merge.isPending ? "Merging…" : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
