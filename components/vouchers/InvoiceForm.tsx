"use client";

import { useMemo } from "react";
import { useForm, useFieldArray, useWatch, Controller, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import { SmartDateInput } from "@/components/common/SmartDateInput";
import { LedgerCombobox } from "@/components/ledgers/LedgerCombobox";
import { InvoiceLineRow, INVOICE_GRID_COLUMNS } from "./InvoiceLineRow";
import { InvoiceTotalsBar } from "./InvoiceTotalsBar";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";
import {
  buildInvoiceSchema,
  computeInvoiceTotals,
  type InvoiceFormValues,
  type InvoiceLineFormValues,
} from "@/lib/voucher/invoice-schema";
import { useKeyboardGrid } from "@/lib/keyboard/useKeyboardGrid";
import { useShortcutScopeStore } from "@/stores/useShortcutScopeStore";
import { useCreateVoucherMutation, useUpdateVoucherMutation } from "@/hooks/useVouchersQuery";
import { toUserMessage } from "@/lib/errors";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";
import type { VoucherType, VoucherWithLines } from "@/lib/supabase/queries/vouchers";

function emptyLine(): InvoiceLineFormValues {
  // quantity 1 is both the column's default and what most lines actually are.
  return { description: "", revenueLedgerId: "", quantity: 1, unit: "", rate: 0, discountAmount: 0 };
}

/**
 * The itemised entry form for a sales invoice or a purchase bill.
 *
 * A sibling of VoucherForm rather than a mode inside it. The two grids have
 * nothing in common below the header fields — this one has no Dr/Cr side, no
 * per-row amount to balance, and a ledger per line rather than a ledger per
 * posting — and the 57 sales and purchase vouchers already in the books still
 * open in VoucherForm. Keeping them apart is what makes that possible without
 * either form growing a branch in every hook.
 *
 * Only reachable for `sales` and `purchase`: `apply_invoice()` refuses any
 * other type, and the pages never route one here.
 */
export function InvoiceForm({
  companyId,
  voucherType,
  voucherId,
  initialValues,
}: {
  companyId: string;
  voucherType: Extract<VoucherType, "sales" | "purchase">;
  voucherId?: string;
  initialValues?: VoucherWithLines;
}) {
  const router = useRouter();
  const config = VOUCHER_TYPE_CONFIG[voucherType];
  const schema = useMemo(() => buildInvoiceSchema(), []);
  const createVoucher = useCreateVoucherMutation(companyId);
  const updateVoucher = useUpdateVoucherMutation(companyId);
  const setShortcutScope = useShortcutScopeStore((s) => s.setScope);

  // The same derivation VoucherForm makes, so the invoice grid filters ledgers
  // by exactly the rule the Dr/Cr grid did: income for a sale, expense for a
  // purchase, and the party combobox keeps its own harder role filter.
  const partyIsDr = config.dr.isPrimaryParty === true;
  const partyRule = partyIsDr ? config.dr : config.cr;
  const revenueRule = partyIsDr ? config.cr : config.dr;

  // Read from vouchers.party_ledger_id, which is where the party is actually
  // recorded. It used to be inferred from the line_order 0 posting, on the
  // strength of generate_invoice_entries() writing the party leg first — but
  // nothing enforced that, so an invoice whose postings had been reordered
  // would have opened for editing against the wrong customer and then saved
  // that as the truth. Migration 0022 made it a column.
  const defaultLines: InvoiceLineFormValues[] = initialValues?.invoiceLines.length
    ? initialValues.invoiceLines.map((l) => ({
        description: l.description,
        revenueLedgerId: l.revenueLedgerId,
        quantity: l.quantity,
        unit: l.unit ?? "",
        rate: l.rate,
        discountAmount: l.discountAmount,
      }))
    : [emptyLine()];

  const {
    control,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<InvoiceFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      voucherDate: initialValues?.voucherDate ?? new Date().toISOString().slice(0, 10),
      narration: initialValues?.narration ?? "",
      referenceNumber: initialValues?.referenceNumber ?? "",
      referenceDate: initialValues?.referenceDate ?? "",
      partyLedgerId: initialValues?.partyLedgerId ?? "",
      lines: defaultLines,
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const watchedLines = (useWatch({ control, name: "lines" }) ?? []) as InvoiceLineFormValues[];

  // The combobox only stores an id, so it needs a name to show until the user
  // picks one. Keyed by ledger id rather than by row position: rows can be
  // removed and reordered, and looking the label up by index would leave a row
  // labelled with the ledger that used to be above it.
  const knownLedgerNames = useMemo(
    () => new Map((initialValues?.invoiceLines ?? []).map((l) => [l.revenueLedgerId, l.revenueLedgerName])),
    [initialValues]
  );

  // Every figure below is a preview of what the generated `line_amount` column
  // will hold, computed in integer paise so three lines at 33.333 show 99.99
  // rather than 100.00 — the same settlement the database performs.
  const totals = computeInvoiceTotals(watchedLines);

  function isRowFilled(rowId: string) {
    const index = fields.findIndex((f) => f.id === rowId);
    if (index === -1) return false;
    const line = getValues(`lines.${index}`);
    return !!line.description.trim() && !!line.revenueLedgerId;
  }

  const { registerCell, handleCellKeyDown } = useKeyboardGrid({
    rowIds: fields.map((f) => f.id),
    columns: [
      { key: "description", focusable: true },
      { key: "ledger", focusable: true },
      { key: "quantity", focusable: true },
      { key: "unit", focusable: true },
      { key: "rate", focusable: true },
      { key: "discount", focusable: true },
    ],
    minRows: 1,
    onAppendRow: () => append(emptyLine()),
    onRemoveRow: (rowId) => {
      const index = fields.findIndex((f) => f.id === rowId);
      if (index !== -1) remove(index);
    },
    isRowFilled,
  });

  async function onSubmit(values: InvoiceFormValues) {
    // `lines: []` and an invoice payload, never both — apply_invoice() refuses
    // a save carrying hand-entered lines as well.
    const invoice = {
      partyLedgerId: values.partyLedgerId,
      lines: values.lines.map((l, i) => ({
        description: l.description,
        revenueLedgerId: l.revenueLedgerId,
        quantity: l.quantity,
        unit: l.unit,
        rate: l.rate,
        discountAmount: l.discountAmount,
        lineOrder: i,
      })),
    };
    const header = {
      voucherDate: values.voucherDate,
      narration: values.narration,
      referenceNumber: values.referenceNumber,
      referenceDate: values.referenceDate,
    };

    try {
      // Straight to the printed document, which shows the `line_amount` the
      // database settled rather than the preview this form was computing.
      if (voucherId) {
        await updateVoucher.mutateAsync({ voucherId, input: { ...header, lines: [], invoice } });
        toast.success(`${config.label} updated`);
        router.push(`/${companyId}/vouchers/${voucherId}/invoice`);
      } else {
        const newId = await createVoucher.mutateAsync({
          companyId,
          voucherType,
          ...header,
          lines: [],
          invoice,
        });
        toast.success(`${config.label} saved`);
        router.push(`/${companyId}/vouchers/${newId}/invoice`);
      }
    } catch (err) {
      toast.error(toUserMessage(err, "Could not save invoice"));
    }
  }

  function handleFormKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!isSubmitting) void handleSubmit(onSubmit)();
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      onKeyDown={handleFormKeyDown}
      className="space-y-4"
      onFocus={() => setShortcutScope("grid")}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="invoice-date">Date</FieldLabel>
          <Controller
            name="voucherDate"
            control={control}
            render={({ field }) => <SmartDateInput id="invoice-date" value={field.value} onChange={field.onChange} autoFocus />}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="invoice-ref-number">Reference No.</FieldLabel>
          <MetaField control={control} name="referenceNumber" id="invoice-ref-number" />
        </Field>
        <Field>
          <FieldLabel htmlFor="invoice-ref-date">Reference Date</FieldLabel>
          <MetaField control={control} name="referenceDate" id="invoice-ref-date" type="date" />
        </Field>
      </div>

      <Field>
        <FieldLabel>{partyRule.label}</FieldLabel>
        <Controller
          name="partyLedgerId"
          control={control}
          render={({ field }) => (
            <LedgerCombobox
              companyId={companyId}
              value={field.value}
              displayName={initialValues?.partyLedgerName ?? undefined}
              onSelect={(ledger: LedgerSearchResult) => field.onChange(ledger.id)}
              sideRule={partyRule}
              placeholder={`Select ${partyRule.label.toLowerCase()}…`}
            />
          )}
        />
        {errors.partyLedgerId?.message && <p className="text-sm text-destructive">{errors.partyLedgerId.message}</p>}
      </Field>

      <div className="rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
        {/* Seven columns don't fit a narrow window, and the page body must not
            scroll sideways because of it — so the grid carries its own
            horizontal scroller and the rest of the form stays put. */}
        <div className="overflow-x-auto">
          <div className="min-w-[56rem]">
            <div
              className={`grid ${INVOICE_GRID_COLUMNS} gap-2 border-b px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase`}
            >
              <span>Description</span>
              <span>{revenueRule.label}</span>
              <span className="text-right">Qty</span>
              <span className="text-center">Unit</span>
              <span className="text-right">Rate</span>
              <span className="text-right">Discount</span>
              <span className="text-right">Amount</span>
              <span />
            </div>
            <div className="divide-y px-3">
              {fields.map((field, index) => (
                <InvoiceLineRow
                  key={field.id}
                  companyId={companyId}
                  control={control}
                  index={index}
                  rowId={field.id}
                  revenueRule={revenueRule}
                  amountPaise={totals.linePaise[index] ?? 0}
                  showRemove={fields.length > 1}
                  onRemove={() => remove(index)}
                  initialLedgerName={knownLedgerNames.get(watchedLines[index]?.revenueLedgerId ?? "")}
                  registerCell={registerCell}
                  onCellKeyDown={handleCellKeyDown}
                />
              ))}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => append(emptyLine())}
          className="flex w-full items-center gap-1.5 rounded-b-xl border-t px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          Add line (Tab/Enter on the last line also adds one)
        </button>
      </div>

      <InvoiceTotalsBar totals={totals} partyLabel={partyIsDr ? "Total receivable" : "Total payable"} />

      {errors.lines && typeof errors.lines.message === "string" && (
        <p className="text-sm text-destructive">{errors.lines.message}</p>
      )}
      {Array.isArray(errors.lines) &&
        errors.lines.map((lineError, i) =>
          lineError
            ? Object.values(lineError)
                .filter((e): e is { message?: string } => !!e && typeof e === "object")
                .map((e, j) =>
                  e.message ? (
                    <p key={`${i}-${j}`} className="text-sm text-destructive">
                      Line {i + 1}: {e.message}
                    </p>
                  ) : null
                )
            : null
        )}

      <Field>
        <FieldLabel htmlFor="invoice-narration">Narration</FieldLabel>
        <MetaField control={control} name="narration" id="invoice-narration" as="textarea" placeholder={config.narrationPlaceholder} />
      </Field>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push(`/${companyId}/vouchers`)}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : `Save ${config.label}`}
        </Button>
      </div>
    </form>
  );
}

/** Single-use Controller wrapper for the header fields, mirroring VoucherForm's. */
function MetaField({
  control,
  name,
  id,
  type,
  as,
  placeholder,
}: {
  control: Control<InvoiceFormValues>;
  name: "referenceNumber" | "referenceDate" | "narration";
  id: string;
  type?: string;
  as?: "textarea";
  placeholder?: string;
}) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field }) =>
        as === "textarea" ? (
          <Textarea id={id} rows={2} placeholder={placeholder} {...field} value={field.value ?? ""} />
        ) : (
          <Input id={id} type={type} {...field} value={field.value ?? ""} />
        )
      }
    />
  );
}
