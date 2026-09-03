"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import { SmartDateInput } from "@/components/common/SmartDateInput";
import { VoucherPartyField } from "./VoucherPartyField";
import { VoucherLineRow } from "./VoucherLineRow";
import { DuplicateBillWarning } from "./DuplicateBillWarning";
import { VoucherTotalsBar } from "./VoucherTotalsBar";
import { UnexpectedLedgerDialog } from "./UnexpectedLedgerDialog";
import { roleMismatch, VOUCHER_TYPE_CONFIG, type LedgerRoleMismatch } from "@/lib/voucher/voucher-type-config";
import { buildVoucherSchema, type VoucherFormValues, type VoucherLineFormValues } from "@/lib/voucher/voucher-schema";
import { useKeyboardGrid } from "@/lib/keyboard/useKeyboardGrid";
import { useShortcutScopeStore } from "@/stores/useShortcutScopeStore";
import { useCreateVoucherMutation, useUpdateVoucherMutation } from "@/hooks/useVouchersQuery";
import { sumPaise, toPaise, fromPaise } from "@/lib/utils/currency";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";
import type { VoucherWithLines } from "@/lib/supabase/queries/vouchers";

function emptyLine(): VoucherLineFormValues {
  return { ledgerId: "", debitAmount: 0, creditAmount: 0, narration: "" };
}

export function VoucherForm({
  companyId,
  voucherType,
  voucherId,
  initialValues,
}: {
  companyId: string;
  voucherType: VoucherType;
  voucherId?: string;
  initialValues?: VoucherWithLines;
}) {
  const router = useRouter();
  const config = VOUCHER_TYPE_CONFIG[voucherType];
  const schema = useMemo(() => buildVoucherSchema(config), [config]);
  const createVoucher = useCreateVoucherMutation(companyId);
  const updateVoucher = useUpdateVoucherMutation(companyId);
  const setShortcutScope = useShortcutScopeStore((s) => s.setScope);

  const partyIsDr = config.dr.isPrimaryParty === true;
  const isSingleParty = partyIsDr || config.cr.isPrimaryParty === true;
  const partyRule = partyIsDr ? config.dr : config.cr;
  const gridRule = partyIsDr ? config.cr : config.dr;
  const gridSide: "debit" | "credit" = partyIsDr ? "credit" : "debit";

  const defaultLines: VoucherLineFormValues[] = initialValues
    ? initialValues.lines.map((l) => ({ ledgerId: l.ledgerId, debitAmount: l.debitAmount, creditAmount: l.creditAmount, narration: l.narration }))
    : isSingleParty
      ? [emptyLine(), ...Array.from({ length: gridRule.defaultRowCount }, emptyLine)]
      : [
          ...Array.from({ length: config.dr.defaultRowCount }, emptyLine),
          ...Array.from({ length: config.cr.defaultRowCount }, emptyLine),
        ];

  const {
    control,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<VoucherFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      voucherDate: initialValues?.voucherDate ?? new Date().toISOString().slice(0, 10),
      narration: initialValues?.narration ?? "",
      referenceNumber: initialValues?.referenceNumber ?? "",
      referenceDate: initialValues?.referenceDate ?? "",
      lines: defaultLines,
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const watchedLines = useWatch({ control, name: "lines" }) ?? [];

  // F-18. The form stores a ledger id; the *role* that decides whether the pick
  // makes sense only comes back on the combobox selection, so it is kept here
  // as it is chosen. Keyed by id rather than by row, since rows move.
  //
  // A line left untouched while editing an old voucher therefore has no role
  // here and cannot be judged — which is the right answer: the confirmation is
  // for a choice being made now, not a re-interrogation of the books.
  const [pickedLedgers, setPickedLedgers] = useState<Record<string, LedgerSearchResult>>({});
  const rememberLedger = useCallback((ledger: LedgerSearchResult) => {
    setPickedLedgers((prev) => (prev[ledger.id] === ledger ? prev : { ...prev, [ledger.id]: ledger }));
  }, []);
  const [pendingSave, setPendingSave] = useState<{ values: VoucherFormValues; mismatches: LedgerRoleMismatch[] } | null>(null);

  // The other path to a purchase bill number. New purchases go to InvoiceForm,
  // but the 57 vouchers entered before invoicing existed still open here and
  // are still editable, and the reference on one of those is the same
  // supplier's bill number it always was.
  //
  // The supplier is line 0's ledger, not vouchers.party_ledger_id: these
  // vouchers have no party column value — the column arrived in 0022 and the
  // rule that requires one applies only to vouchers with invoice lines, which
  // these have none of. The fixed party row is where their supplier actually
  // is, and it is what the lookup is given. Note the consequence, which is
  // real and is documented in 0024: because those 57 store no party, they can
  // never be *found* as the duplicate, only be the entry doing the finding.
  const isPurchase = voucherType === "purchase";
  const [billCheckToken, setBillCheckToken] = useState(0);
  const watchedReference = useWatch({ control, name: "referenceNumber" });
  const watchedDate = useWatch({ control, name: "voucherDate" });
  const partyLedgerId = isSingleParty ? watchedLines[0]?.ledgerId : undefined;

  // Grid rows are every line except the fixed party line (index 0) in
  // single-party mode; all lines in full-grid mode.
  const gridStartIndex = isSingleParty ? 1 : 0;
  const gridRowIds = fields.slice(gridStartIndex).map((f) => f.id);

  // The party line's amount isn't independently editable — it must always
  // equal the sum of the grid lines' amounts on the opposite side, or the
  // voucher can never balance. Kept in sync here rather than computed only
  // at submit time, so the totals bar reflects it live too.
  useEffect(() => {
    if (!isSingleParty) return;
    const gridLines = watchedLines.slice(1);
    const sumPaiseTotal = sumPaise(gridLines.map((l) => toPaise((gridSide === "debit" ? l?.debitAmount : l?.creditAmount) || 0)));
    const field = gridSide === "debit" ? "creditAmount" : "debitAmount";
    const current = getValues(`lines.0.${field}`);
    const next = fromPaise(sumPaiseTotal);
    if (current !== next) setValue(`lines.0.${field}`, next, { shouldValidate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when the grid amounts actually change
  }, [JSON.stringify(watchedLines.slice(1).map((l) => [l?.debitAmount, l?.creditAmount]))]);

  function isRowFilled(rowId: string) {
    const index = fields.findIndex((f) => f.id === rowId);
    if (index === -1) return false;
    const line = getValues(`lines.${index}`);
    return !!line.ledgerId && (line.debitAmount > 0 || line.creditAmount > 0);
  }

  const { registerCell, handleCellKeyDown } = useKeyboardGrid({
    rowIds: gridRowIds,
    columns: isSingleParty
      ? [{ key: "ledger", focusable: true }, { key: "amount", focusable: true }]
      : [{ key: "ledger", focusable: true }, { key: "side", focusable: true }, { key: "amount", focusable: true }],
    minRows: gridRule.minRows,
    onAppendRow: () => {
      append(emptyLine());
    },
    onRemoveRow: (rowId) => {
      const index = fields.findIndex((f) => f.id === rowId);
      if (index !== -1) remove(index);
    },
    isRowFilled,
  });

  function toggleRowSide(index: number) {
    const current = getValues(`lines.${index}`);
    const wasCredit = current.creditAmount > 0;
    if (wasCredit) {
      setValue(`lines.${index}.debitAmount`, current.creditAmount);
      setValue(`lines.${index}.creditAmount`, 0);
    } else {
      setValue(`lines.${index}.creditAmount`, current.debitAmount);
      setValue(`lines.${index}.debitAmount`, 0);
    }
  }

  /**
   * Every line's applicable side rule, derived exactly as the grid renders it —
   * the party rule for the fixed row, the grid rule for the rest in
   * single-party mode, and the row's own current side in full-grid mode.
   */
  function ruleForLine(values: VoucherFormValues, index: number) {
    if (isSingleParty) return index === 0 ? partyRule : gridRule;
    return (values.lines[index]?.creditAmount ?? 0) > 0 ? config.cr : config.dr;
  }

  function findRoleMismatches(values: VoucherFormValues): LedgerRoleMismatch[] {
    return values.lines
      .map((line, index) =>
        roleMismatch(
          ruleForLine(values, index),
          pickedLedgers[line.ledgerId],
          // The fixed party box isn't a numbered row; the grid starts at 1.
          isSingleParty ? (index === 0 ? undefined : index) : index + 1
        )
      )
      .filter((m): m is LedgerRoleMismatch => m !== null);
  }

  /** Throws on failure, so a confirmation dialog driving it stays open. */
  async function save(values: VoucherFormValues) {
    const lines = values.lines.map((l, i) => ({ ...l, lineOrder: i }));
    try {
      if (voucherId) {
        await updateVoucher.mutateAsync({
          voucherId,
          input: { voucherDate: values.voucherDate, narration: values.narration, referenceNumber: values.referenceNumber, referenceDate: values.referenceDate, lines },
        });
        toast.success("Voucher updated");
      } else {
        await createVoucher.mutateAsync({
          companyId,
          voucherType,
          voucherDate: values.voucherDate,
          narration: values.narration,
          referenceNumber: values.referenceNumber,
          referenceDate: values.referenceDate,
          lines,
        });
        toast.success(`${config.label} saved`);
      }
      router.push(`/${companyId}/vouchers`);
    } catch (err) {
      toast.error(toUserMessage(err, "Could not save voucher"));
      throw err;
    }
  }

  async function onSubmit(values: VoucherFormValues) {
    // F-18: a soft-filtered side still accepts any ledger — that stays — but a
    // pick outside the expected roles now has to be confirmed by name first.
    const mismatches = findRoleMismatches(values);
    if (mismatches.length > 0) {
      setPendingSave({ values, mismatches });
      return;
    }
    await save(values).catch(() => {});
  }

  // Ctrl+Enter to save. Bound on the form rather than through
  // useGlobalShortcuts because the grid's own Enter handling already runs on
  // keydown inside these fields, and this needs to win over it — and because
  // the shortcut should only exist while a voucher form is on screen.
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
          <FieldLabel htmlFor="voucher-date">Date</FieldLabel>
          <SmartFieldDate control={control} />
        </Field>
        <Field>
          <FieldLabel htmlFor="voucher-ref-number">Reference No.</FieldLabel>
          <input type="hidden" />
          <RefField
            control={control}
            name="referenceNumber"
            id="voucher-ref-number"
            // On blur rather than on change: a bill number is looked up once
            // the user has finished typing it, not once per character of one.
            onBlur={isPurchase ? () => setBillCheckToken((n) => n + 1) : undefined}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="voucher-ref-date">Reference Date</FieldLabel>
          <RefField control={control} name="referenceDate" id="voucher-ref-date" type="date" />
        </Field>
      </div>

      {isPurchase && (
        <DuplicateBillWarning
          companyId={companyId}
          partyLedgerId={partyLedgerId}
          referenceNumber={watchedReference}
          voucherDate={watchedDate}
          excludeVoucherId={voucherId}
          checkToken={billCheckToken}
        />
      )}

      {isSingleParty && (
        <VoucherPartyField
          companyId={companyId}
          control={control}
          sideRule={partyRule}
          triggerRef={registerCell(fields[0]?.id ?? "party", "party-ledger")}
          onKeyDown={() => {}}
          autoFocus
          initialLedgerName={initialValues?.lines[0]?.ledgerName}
          onLedgerPicked={rememberLedger}
        />
      )}

      <div className="rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
        <div className="grid grid-cols-[1fr_7rem_1fr_2rem] gap-2 border-b px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <span>{isSingleParty ? gridRule.label : "Account"}</span>
          <span className="text-center">Dr/Cr</span>
          <span className="text-right">Amount</span>
          <span />
        </div>
        <div className="divide-y px-3">
          {fields.slice(gridStartIndex).map((field, i) => {
            const index = gridStartIndex + i;
            return (
              <VoucherLineRow
                key={field.id}
                companyId={companyId}
                control={control}
                index={index}
                rowId={field.id}
                sideRule={isSingleParty ? gridRule : watchedLines[index]?.creditAmount > 0 ? config.cr : config.dr}
                side={isSingleParty ? gridSide : watchedLines[index]?.creditAmount > 0 ? "credit" : "debit"}
                onToggleSide={isSingleParty ? undefined : () => toggleRowSide(index)}
                showRemove={fields.length - gridStartIndex > gridRule.minRows}
                onRemove={() => remove(index)}
                initialLedgerName={initialValues?.lines[index]?.ledgerName}
                registerCell={registerCell}
                onCellKeyDown={handleCellKeyDown}
                onLedgerPicked={rememberLedger}
                autoFocusLedger={!isSingleParty && i === 0}
              />
            );
          })}
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

      <VoucherTotalsBar lines={watchedLines as VoucherLineFormValues[]} />
      {errors.lines && typeof errors.lines.message === "string" && (
        <p className="text-sm text-destructive">{errors.lines.message}</p>
      )}

      <Field>
        <FieldLabel htmlFor="voucher-narration">Narration</FieldLabel>
        <RefField control={control} name="narration" id="voucher-narration" as="textarea" placeholder={config.narrationPlaceholder} />
      </Field>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push(`/${companyId}/vouchers`)}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : `Save ${config.label}`}
        </Button>
      </div>

      <UnexpectedLedgerDialog
        open={!!pendingSave}
        onOpenChange={(open) => !open && setPendingSave(null)}
        voucherLabel={config.label}
        mismatches={pendingSave?.mismatches ?? []}
        onConfirm={async () => {
          if (pendingSave) await save(pendingSave.values);
        }}
      />
    </form>
  );
}

// Small inline field helpers kept local to this file since they're
// single-use wrappers around Controller, not reused elsewhere.
import { Controller, type Control } from "react-hook-form";
import { toUserMessage } from "@/lib/errors";

function SmartFieldDate({ control }: { control: Control<VoucherFormValues> }) {
  return (
    <Controller
      name="voucherDate"
      control={control}
      render={({ field }) => <SmartDateInput id="voucher-date" value={field.value} onChange={field.onChange} autoFocus />}
    />
  );
}

function RefField({
  control,
  name,
  id,
  type,
  as,
  placeholder,
  onBlur,
}: {
  control: Control<VoucherFormValues>;
  name: "referenceNumber" | "referenceDate" | "narration";
  id: string;
  type?: string;
  as?: "textarea";
  placeholder?: string;
  /** Runs in addition to react-hook-form's own blur handling, never instead of it. */
  onBlur?: () => void;
}) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field }) =>
        as === "textarea" ? (
          <Textarea id={id} rows={2} placeholder={placeholder} {...field} />
        ) : (
          <Input
            id={id}
            type={type}
            {...field}
            onBlur={() => {
              field.onBlur();
              onBlur?.();
            }}
          />
        )
      }
    />
  );
}
