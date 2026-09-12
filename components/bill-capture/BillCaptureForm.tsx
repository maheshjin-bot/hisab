"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { SmartDateInput } from "@/components/common/SmartDateInput";
import { LedgerCombobox } from "@/components/ledgers/LedgerCombobox";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import { useLedgerSearchQuery } from "@/hooks/useLedgersQuery";
import { useCreateVoucherMutation } from "@/hooks/useVouchersQuery";
import { useConfirmBillCaptureMutation } from "@/hooks/useBillCaptureQuery";
import { discountPercentToAmount, matchLedgersByName, toInvoiceLineInput } from "@/lib/bill-capture/match";
import type { BillCaptureDraft } from "@/lib/supabase/queries/bill-capture";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";
import { formatCurrency } from "@/lib/utils/currency";
import { toUserMessage } from "@/lib/errors";

const PARTY_RULE = VOUCHER_TYPE_CONFIG.purchase.cr;
const LEDGER_RULE = VOUCHER_TYPE_CONFIG.purchase.dr;

interface LineDraft {
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  discountPercent: number;
  revenueLedgerId: string;
  revenueLedgerName?: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The actual review form — mounted only once a draft has an extraction, so
 * every piece of local state below seeds itself from real values on mount
 * rather than needing an effect to catch up when the extraction arrives
 * later. The same pattern LedgerFormDialog already uses for the same reason.
 */
export function BillCaptureForm({ companyId, draft }: { companyId: string; draft: BillCaptureDraft }) {
  const router = useRouter();
  const extraction = draft.extraction!;

  const [party, setParty] = useState<LedgerSearchResult | null>(null);
  const [billNumber, setBillNumber] = useState(extraction.billNumber ?? "");
  const [billDate, setBillDate] = useState(extraction.billDate ?? today());
  const [narration, setNarration] = useState(draft.vendorHint ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    extraction.lineItems.length
      ? extraction.lineItems.map((l) => ({
          description: l.description,
          unit: l.unit ?? "",
          quantity: l.quantity ?? 1,
          rate: l.rate ?? 0,
          discountPercent: l.discountPercent ?? 0,
          revenueLedgerId: "",
        }))
      : [{ description: "", unit: "", quantity: 1, rate: 0, discountPercent: 0, revenueLedgerId: "" }]
  );

  // Suggestions only — HISAB ledgers carry no GSTIN, so a name match is the
  // strongest signal available and it is never auto-selected, only offered.
  const { data: candidateLedgers } = useLedgerSearchQuery(companyId, extraction.vendorName ?? "");
  const suggestions = useMemo(
    () => matchLedgersByName(candidateLedgers ?? [], extraction.vendorName),
    [candidateLedgers, extraction.vendorName]
  );
  const topSuggestion = suggestions[0];

  const createVoucher = useCreateVoucherMutation(companyId);
  const confirmDraft = useConfirmBillCaptureMutation(companyId);

  function updateLine(index: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }
  function addLine() {
    setLines((prev) => [...prev, { description: "", unit: "", quantity: 1, rate: 0, discountPercent: 0, revenueLedgerId: "" }]);
  }

  const total = lines.reduce((sum, l) => sum + (l.quantity * l.rate - discountPercentToAmount(l.quantity, l.rate, l.discountPercent)), 0);
  const amountMismatch =
    extraction.totalAmount !== null && Math.abs(extraction.totalAmount - total) > 1 ? extraction.totalAmount : null;

  const canPost = !!party && lines.length > 0 && lines.every((l) => l.description.trim() && l.revenueLedgerId);

  async function handlePost() {
    if (!party || !canPost) return;
    try {
      const voucherId = await createVoucher.mutateAsync({
        companyId,
        voucherType: "purchase",
        voucherDate: billDate,
        narration: narration || undefined,
        referenceNumber: billNumber || undefined,
        lines: [],
        invoice: {
          partyLedgerId: party.id,
          lines: lines.map((l, i) =>
            toInvoiceLineInput(
              { description: l.description, unit: l.unit || null, quantity: l.quantity, rate: l.rate, discountPercent: l.discountPercent, amount: null },
              l.revenueLedgerId,
              i
            )
          ),
        },
      });
      await confirmDraft.mutateAsync({ draftId: draft.id, voucherId });
      toast.success("Bill posted");
      router.push(`/${companyId}/vouchers/${voucherId}/invoice`);
    } catch (err) {
      toast.error(toUserMessage(err, "Could not post this bill"));
    }
  }

  const pending = createVoucher.isPending || confirmDraft.isPending;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
        <Badge variant="secondary" className={extraction.confidence === "high" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}>
          {extraction.confidence} confidence
        </Badge>
        {!extraction.looksLikePurchaseBill && (
          <Badge variant="secondary" className="bg-destructive/10 text-destructive">
            <TriangleAlert className="size-3.5" />
            Doesn&apos;t look like a purchase bill
          </Badge>
        )}
        <span className="text-muted-foreground">{extraction.note}</span>
      </div>

      <Field>
        <FieldLabel>Supplier</FieldLabel>
        <LedgerCombobox
          companyId={companyId}
          value={party?.id ?? ""}
          displayName={party?.name}
          onSelect={setParty}
          sideRule={PARTY_RULE}
          placeholder="Search suppliers…"
        />
        {!party && extraction.vendorName && (
          <FieldDescription>
            AI read &ldquo;{extraction.vendorName}&rdquo;
            {topSuggestion && topSuggestion.score >= 0.85 && (
              <>
                {" — likely "}
                <button type="button" className="text-primary hover:underline" onClick={() => setParty({ id: topSuggestion.id, name: topSuggestion.name, groupId: "", groupName: "", ledgerRole: "creditor" })}>
                  {topSuggestion.name}
                </button>
              </>
            )}
            . Pick the matching supplier above, or add a new one if this is their first bill.
          </FieldDescription>
        )}
        {(extraction.vendorAddress || extraction.vendorPhone || extraction.vendorEmail) && (
          <FieldDescription>
            {[extraction.vendorAddress, extraction.vendorPhone, extraction.vendorEmail].filter(Boolean).join(" · ")}
          </FieldDescription>
        )}
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel>Bill number</FieldLabel>
          <Input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel>Bill date</FieldLabel>
          <SmartDateInput value={billDate} onChange={setBillDate} />
        </Field>
      </div>

      <Field>
        <FieldLabel>Narration</FieldLabel>
        <Textarea value={narration} onChange={(e) => setNarration(e.target.value)} rows={2} />
      </Field>

      <div className="space-y-2">
        <p className="text-sm font-medium">Line items</p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground uppercase">
              <tr>
                <th className="p-2 text-left">Description</th>
                <th className="p-2 text-left">Ledger</th>
                <th className="p-2 text-right">Qty</th>
                <th className="p-2 text-left">Unit</th>
                <th className="p-2 text-right">Rate</th>
                <th className="p-2 text-right">Disc %</th>
                <th className="p-2 text-right">Amount</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => {
                const amount = line.quantity * line.rate - discountPercentToAmount(line.quantity, line.rate, line.discountPercent);
                return (
                  <tr key={i} className="border-t">
                    <td className="p-2">
                      <Input value={line.description} onChange={(e) => updateLine(i, { description: e.target.value })} className="min-w-40" />
                    </td>
                    <td className="p-2">
                      <LedgerCombobox
                        companyId={companyId}
                        value={line.revenueLedgerId}
                        displayName={line.revenueLedgerName}
                        onSelect={(l) => updateLine(i, { revenueLedgerId: l.id, revenueLedgerName: l.name })}
                        sideRule={LEDGER_RULE}
                        className="min-w-40"
                        placeholder="Purchase account…"
                      />
                    </td>
                    <td className="p-2">
                      <Input type="number" value={line.quantity} onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })} className="w-20 text-right" />
                    </td>
                    <td className="p-2">
                      <Input value={line.unit} onChange={(e) => updateLine(i, { unit: e.target.value })} className="w-16" />
                    </td>
                    <td className="p-2">
                      <Input type="number" value={line.rate} onChange={(e) => updateLine(i, { rate: Number(e.target.value) })} className="w-24 text-right" />
                    </td>
                    <td className="p-2">
                      <Input type="number" value={line.discountPercent} onChange={(e) => updateLine(i, { discountPercent: Number(e.target.value) })} className="w-16 text-right" />
                    </td>
                    <td className="p-2 text-right tabular-nums">{formatCurrency(amount)}</td>
                    <td className="p-2">
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeLine(i)} disabled={lines.length === 1}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addLine}>
          <Plus data-icon="inline-start" />
          Add line
        </Button>
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
        <span className="text-sm text-muted-foreground">Total</span>
        <span className="font-medium tabular-nums">{formatCurrency(total)}</span>
      </div>
      {amountMismatch !== null && (
        <FieldDescription className="text-warning">
          The bill printed a total of {formatCurrency(amountMismatch)}, which doesn&apos;t match the lines above — worth checking
          before posting.
        </FieldDescription>
      )}

      <div className="flex justify-end">
        <Button onClick={handlePost} disabled={!canPost || pending}>
          {pending ? "Posting…" : "Post as Purchase Bill"}
        </Button>
      </div>
    </div>
  );
}
