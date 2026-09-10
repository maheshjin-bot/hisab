import type { Ledger, LedgerRole } from "@/lib/supabase/queries/ledgers";

/**
 * Whether a ledger of this role can take part in a merge at all — as the one
 * being merged away or the one it merges into. Mirrors migration 0029's own
 * guard exactly: a cash or bank ledger carries reconciliation state (bank
 * statement imports, matched lines, one profile per ledger) the merge
 * function never touches, so the database refuses both roles outright.
 *
 * Checked here too so the picker never offers a choice the server would
 * reject — the row's own "Merge into…" action is hidden for the same reason,
 * via this same function.
 */
export function canMergeLedgerRole(role: LedgerRole | undefined): boolean {
  return role !== "cash_bank";
}

/** Every reason a merge can't proceed yet, for disabling the confirm button with an explanation instead of a failed request. */
export function mergeBlockedReason(
  source: Ledger,
  target: { id: string } | null,
  confirmText: string
): string | null {
  if (!target) return "Choose a ledger to merge into";
  if (target.id === source.id) return "Choose a different ledger — a ledger can't be merged into itself";
  if (confirmText.trim() !== source.name) return `Type "${source.name}" to confirm`;
  return null;
}
