"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { format, parseISO } from "date-fns";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSupabase } from "@/hooks/useSupabase";
import { formatCurrency } from "@/lib/utils/currency";
import {
  duplicateBillProbeKey,
  findDuplicateBill,
  type DuplicateBill,
} from "@/lib/supabase/queries/vouchers";

/**
 * "This bill number is already on PUR/2026-27/00003" — shown under the bill
 * number field of a purchase, when the same supplier's number is already in
 * this financial year's books.
 *
 * It warns and never blocks. Two suppliers do issue the same number, one
 * supplier's numbering does restart every April, and a bill does get re-issued
 * after a correction — so a rule that refused the save would refuse entries
 * that are correct, with no way to say so. The person holding both documents
 * is the one who can tell, and this exists to make sure they know there is a
 * second document to look at. Migration 0024 has the longer version of that
 * argument, and is why `find_duplicate_bill` is a lookup rather than a unique
 * index.
 *
 * WHEN IT LOOKS. On blur of the bill-number field, signalled by `checkToken`
 * changing — not on every keystroke, which would ask the database once per
 * character of a number nobody has finished typing yet.
 *
 * WHEN IT SHOWS. Only while the result still describes what is on screen. The
 * answer is kept against the probe key it was fetched for, so editing the
 * number, the supplier or the date afterwards clears the warning rather than
 * leaving it standing over values it was never about. It comes back on the
 * next blur.
 */
export function DuplicateBillWarning({
  companyId,
  partyLedgerId,
  referenceNumber,
  voucherDate,
  excludeVoucherId,
  checkToken,
}: {
  companyId: string;
  partyLedgerId: string | null | undefined;
  referenceNumber: string | null | undefined;
  voucherDate: string | null | undefined;
  /** The voucher being edited, so an invoice never reports itself. */
  excludeVoucherId?: string;
  /** Incremented by the parent on blur of the bill-number field. */
  checkToken: number;
}) {
  const supabase = useSupabase();
  const [found, setFound] = useState<{ key: string; match: DuplicateBill | null } | null>(null);

  const probe = { companyId, partyLedgerId, referenceNumber, voucherDate, excludeVoucherId };
  const key = duplicateBillProbeKey(probe);

  useEffect(() => {
    if (checkToken === 0 || key === null) return;
    let cancelled = false;

    findDuplicateBill(supabase, probe)
      .then((match) => {
        if (!cancelled) setFound({ key, match });
      })
      .catch((err) => {
        // Nothing is shown if the lookup itself failed. A toast on every blur
        // of a field the user is still working in would be noise, and there is
        // no safe warning to invent from an answer that never arrived — the
        // save is unaffected either way, since this never gated it.
        if (!cancelled) setFound(null);
        console.error("Duplicate bill lookup failed", err);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- looks on blur only; `key` decides whether the answer is still shown
  }, [checkToken]);

  const match = found && found.key === key ? found.match : null;
  if (!match) return null;

  return (
    <Alert className="mt-2 border-amber-500/40 text-amber-900 dark:text-amber-200">
      <TriangleAlert className="text-amber-600 dark:text-amber-400" />
      <AlertDescription className="text-amber-900/90 dark:text-amber-200/90">
        This bill number is already on{" "}
        <Link
          href={`/${companyId}/vouchers/${match.voucherId}/edit`}
          // A new tab on purpose: this is shown while a voucher is being
          // typed, and following the link in place would throw away everything
          // entered so far to answer a question about whether to keep it.
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs font-medium underline underline-offset-2"
        >
          {match.voucherNumber}
        </Link>
        , dated {formatVoucherDate(match.voucherDate)}, for {formatCurrency(match.totalAmount)}. Saving this one
        records the same bill a second time.
      </AlertDescription>
    </Alert>
  );
}

/** "5 Apr 2026". Falls back to the stored value if it is not a date this can read. */
function formatVoucherDate(value: string): string {
  try {
    return format(parseISO(value), "d MMM yyyy");
  } catch {
    return value;
  }
}
