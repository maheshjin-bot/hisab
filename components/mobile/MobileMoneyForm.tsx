"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LedgerCombobox } from "@/components/ledgers/LedgerCombobox";
import { MobileField, MOBILE_CONTROL } from "./MobileField";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import { useCreateVoucherMutation } from "@/hooks/useVouchersQuery";
import { formatCurrency, toPaise } from "@/lib/utils/currency";
import { toUserMessage } from "@/lib/errors";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";

/** How long the "Saved" beat stays up before handing off to returnTo. Long
 *  enough to read as confirmation, short enough not to feel like a wait. */
const SAVED_HOLD_MS = 950;

/**
 * MONEY IN AND MONEY OUT, AS ONE SCREEN A SHOPKEEPER CAN FILL STANDING UP.
 *
 * VoucherForm is the desktop instrument: a Dr/Cr grid, a reference pair, a
 * running totals bar, keyboard-grid navigation. All of it is right for
 * someone entering fifty vouchers with two hands, and all of it is noise for
 * someone entering one with a thumb. This asks the four things that
 * *change* — how much, who, which cash or bank account, and what for — and
 * derives the rest.
 *
 * WHAT IT POSTS IS IDENTICAL. Two lines, cash/bank first, exactly as
 * VoucherForm lays them out for a single-party voucher, through the same
 * create_voucher RPC. So an entry made here opens for editing on the desktop
 * with the party in the party box, and no report can tell the two apart.
 *
 * Receipt puts the cash/bank leg on debit and the party on credit; payment
 * is the mirror. That comes from the type's own config rather than being
 * written out twice here.
 */
export function MobileMoneyForm({
  companyId,
  voucherType,
  returnTo,
}: {
  companyId: string;
  voucherType: "receipt" | "payment";
  returnTo: string;
}) {
  const router = useRouter();
  const config = VOUCHER_TYPE_CONFIG[voucherType];
  const createVoucher = useCreateVoucherMutation(companyId);

  // Which side the cash/bank leg sits on. Receipt debits it (money arrived);
  // payment credits it.
  const cashOnDebit = config.dr.isPrimaryParty === true;
  const cashRule = cashOnDebit ? config.dr : config.cr;
  const partyRule = cashOnDebit ? config.cr : config.dr;

  const [amount, setAmount] = useState("");
  const [partyId, setPartyId] = useState("");
  const [cashId, setCashId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [errors, setErrors] = useState<{ amount?: string; party?: string; cash?: string }>({});
  // Set on a successful save, in place of the toast: a beat the user can
  // actually read before the screen moves on, not a strip that a phone
  // keyboard usually has half-covered anyway.
  const [saved, setSaved] = useState<{ amount: number } | null>(null);

  const rupees = Number(amount);
  const isIn = voucherType === "receipt";

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => router.push(returnTo), SAVED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [saved, returnTo, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const next: typeof errors = {};
    if (!amount.trim() || !Number.isFinite(rupees) || rupees <= 0) next.amount = "Enter how much";
    if (!partyId) next.party = `Choose ${partyRule.label.toLowerCase()}`;
    if (!cashId) next.cash = "Choose cash or bank";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    // Integer paise for the comparison the database will make, then back to
    // rupees for the column — the same boundary conversion VoucherForm does.
    const value = toPaise(rupees) / 100;

    try {
      await createVoucher.mutateAsync({
        companyId,
        voucherType,
        voucherDate: date,
        narration: note,
        referenceNumber: reference,
        lines: [
          {
            ledgerId: cashId,
            debitAmount: cashOnDebit ? value : 0,
            creditAmount: cashOnDebit ? 0 : value,
            lineOrder: 0,
          },
          {
            ledgerId: partyId,
            debitAmount: cashOnDebit ? 0 : value,
            creditAmount: cashOnDebit ? value : 0,
            lineOrder: 1,
          },
        ],
      });
      setSaved({ amount: rupees });
    } catch (err) {
      toast.error(toUserMessage(err, "Could not save"));
    }
  }

  if (saved) {
    return (
      <div className="flex min-h-[55vh] flex-col items-center justify-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-success/10 text-success">
          <Check className="size-7" />
        </span>
        <p className="text-[17px] font-semibold">Saved</p>
        <p className="font-mono text-[13px] tabular-nums text-muted-foreground">
          {formatCurrency(saved.amount)} · {config.label}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <MobileField label="Amount" htmlFor="m-amount" error={errors.amount}>
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-2xl text-muted-foreground">
            ₹
          </span>
          <input
            id="m-amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            placeholder="0"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-16 w-full rounded-xl border border-input bg-background pr-4 pl-10 text-3xl font-semibold tabular-nums outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          />
        </div>
      </MobileField>

      {/* Whose money it is comes before which drawer it went into: the person
          is what the user is thinking about, the account is bookkeeping. */}
      <MobileField label={isIn ? "Received from" : "Paid to"} error={errors.party}>
        <LedgerCombobox
          companyId={companyId}
          value={partyId}
          onSelect={(l: LedgerSearchResult) => setPartyId(l.id)}
          sideRule={partyRule}
          placeholder={isIn ? "Customer or account…" : "Supplier, expense or account…"}
          className={MOBILE_CONTROL}
        />
      </MobileField>

      <MobileField label={isIn ? "Received into" : "Paid from"} error={errors.cash}>
        <LedgerCombobox
          companyId={companyId}
          value={cashId}
          onSelect={(l: LedgerSearchResult) => setCashId(l.id)}
          sideRule={cashRule}
          placeholder="Cash or bank…"
          className={MOBILE_CONTROL}
        />
      </MobileField>

      {/* No hint under this one: the placeholder already asks the question,
          and saying it twice is the kind of clutter this screen exists to
          get rid of. */}
      <MobileField label="Note" htmlFor="m-note">
        <input
          id="m-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={config.narrationPlaceholder}
          className={MOBILE_CONTROL}
        />
      </MobileField>

      {/* Date defaults to today and is right almost every time; the bill
          number is a desktop concern. Both stay reachable, neither is in the
          way. */}
      <div>
        <button
          type="button"
          onClick={() => setShowMore(!showMore)}
          aria-expanded={showMore}
          className="flex items-center gap-1 py-1 text-[13px] text-muted-foreground"
        >
          {showMore ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Date &amp; bill number
        </button>
        {showMore && (
          <div className="space-y-4 pt-3">
            <MobileField label="Date" htmlFor="m-date">
              <input
                id="m-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={MOBILE_CONTROL}
              />
            </MobileField>
            <MobileField label="Bill / reference number" htmlFor="m-ref">
              <input
                id="m-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className={MOBILE_CONTROL}
              />
            </MobileField>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <Button type="submit" disabled={createVoucher.isPending} className="h-12 rounded-xl text-[15px]">
          {createVoucher.isPending ? "Saving…" : `Save ${config.label}`}
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
    </form>
  );
}
