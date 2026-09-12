"use client";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { describeExpectedRoles, describeRole, type LedgerRoleMismatch } from "@/lib/voucher/voucher-type-config";

/**
 * F-18. The consequence attached to a soft-filtered side.
 *
 * The permissiveness itself is load-bearing and stays: a rounding line, a
 * freight line or a discount account has to be pickable on a bill in a product
 * with no tax layer, and a hard block would forbid entries that are genuinely
 * correct. What was missing was any cost to getting it wrong — the only thing
 * standing between a mis-clicked asset account and a quietly wrong Profit &
 * Loss was a warning triangle in a dropdown, and the resulting voucher balances
 * perfectly, so nothing later in the books ever contradicts it.
 *
 * One extra click on the rare deliberate path; the mis-click on the common path
 * gets read back by name before it is written.
 */
export function UnexpectedLedgerDialog({
  open,
  onOpenChange,
  voucherLabel,
  mismatches,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The voucher type in the words the screen uses — "Sale Bill", "Purchase Bill". */
  voucherLabel: string;
  mismatches: LedgerRoleMismatch[];
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Is this the right account?"
      confirmLabel="Save anyway"
      onConfirm={onConfirm}
      description={
        <>
          {mismatches.map((m, i) => (
            // Spans, not paragraphs: this lands inside the dialog's own <p>.
            <span key={`${m.ledgerName}-${i}`} className="mb-2 block">
              {m.lineNumber !== undefined && <>Line {m.lineNumber}: </>}
              <b className="text-foreground">{m.ledgerName}</b> is {describeRole(m.ledgerRole)}, but a{" "}
              {voucherLabel} normally puts {describeExpectedRoles(m.rule)} here.
            </span>
          ))}
          <span className="block">
            You can still save it — a rounding or freight line often sits here on purpose. But if it was a
            slip, this amount will land in the wrong place on your Profit &amp; Loss and Balance Sheet, and
            the entry will still add up, so nothing later will point it out.
          </span>
        </>
      }
    />
  );
}
