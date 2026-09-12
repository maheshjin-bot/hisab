"use client";

import { Controller, type Control } from "react-hook-form";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LedgerCombobox } from "@/components/ledgers/LedgerCombobox";
import { formatCurrency } from "@/lib/utils/currency";
import type { VoucherSideRule } from "@/lib/voucher/voucher-type-config";
import type { InvoiceFormValues } from "@/lib/voucher/invoice-schema";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";

/**
 * Shared with the header row in InvoiceForm so the two cannot drift. Wider
 * than the Dr/Cr grid by four columns, which is why the whole thing lives
 * inside its own horizontal scroller rather than widening the page.
 */
export const INVOICE_GRID_COLUMNS =
  "grid-cols-[minmax(13rem,2.5fr)_minmax(10rem,1.5fr)_5.5rem_4.5rem_7rem_7rem_8rem_2rem]";

export interface InvoiceLineRowProps {
  companyId: string;
  control: Control<InvoiceFormValues>;
  index: number;
  rowId: string;
  /** The income (sales) or expense (purchase) rule from the voucher type config. */
  revenueRule: VoucherSideRule;
  /** Previewed here, settled by the database — see lib/voucher/invoice-schema.ts. */
  amountPaise: number;
  showRemove: boolean;
  onRemove: () => void;
  registerCell: (rowId: string, columnKey: string) => (el: HTMLElement | null) => void;
  onCellKeyDown: (e: React.KeyboardEvent, rowId: string, columnKey: string) => void;
  autoFocusDescription?: boolean;
  /** Label to show before the user picks — the existing ledger when editing. */
  initialLedgerName?: string;
  /** The form keeps the picked ledger's role, which the id alone doesn't carry — see F-18. */
  onLedgerPicked?: (ledger: LedgerSearchResult) => void;
}

export function InvoiceLineRow({
  companyId,
  control,
  index,
  rowId,
  revenueRule,
  amountPaise,
  showRemove,
  onRemove,
  registerCell,
  onCellKeyDown,
  autoFocusDescription,
  initialLedgerName,
  onLedgerPicked,
}: InvoiceLineRowProps) {
  return (
    <div className={`grid ${INVOICE_GRID_COLUMNS} items-center gap-2 py-1.5 transition-colors hover:bg-muted/30`}>
      <Controller
        name={`lines.${index}.description`}
        control={control}
        render={({ field }) => (
          <Input
            placeholder="What was sold"
            // `ref` is this grid's cell registration, so react-hook-form's own
            // ref is deliberately not spread in — spreading `field` would
            // silently overwrite it and break keyboard navigation.
            ref={registerCell(rowId, "description") as React.Ref<HTMLInputElement>}
            onKeyDown={(e) => onCellKeyDown(e, rowId, "description")}
            autoFocus={autoFocusDescription}
            name={field.name}
            value={field.value ?? ""}
            onChange={field.onChange}
            onBlur={field.onBlur}
          />
        )}
      />

      <Controller
        name={`lines.${index}.revenueLedgerId`}
        control={control}
        render={({ field }) => (
          <LedgerCombobox
            companyId={companyId}
            value={field.value}
            displayName={initialLedgerName}
            onSelect={(ledger: LedgerSearchResult) => {
              onLedgerPicked?.(ledger);
              field.onChange(ledger.id);
            }}
            sideRule={revenueRule}
            triggerRef={registerCell(rowId, "ledger")}
            onKeyDown={(e) => onCellKeyDown(e, rowId, "ledger")}
            placeholder={revenueRule.label}
          />
        )}
      />

      <Controller
        name={`lines.${index}.quantity`}
        control={control}
        render={({ field }) => (
          <Input
            type="number"
            // numeric(18,3): goods are sold by the gram and the millilitre.
            step="0.001"
            min="0"
            inputMode="decimal"
            className="text-right tabular-nums"
            ref={registerCell(rowId, "quantity") as React.Ref<HTMLInputElement>}
            onKeyDown={(e) => onCellKeyDown(e, rowId, "quantity")}
            aria-label={`Quantity, line ${index + 1}`}
            value={field.value === 0 ? "" : field.value}
            onChange={(e) => field.onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          />
        )}
      />

      <Controller
        name={`lines.${index}.unit`}
        control={control}
        render={({ field }) => (
          <Input
            placeholder="nos"
            className="text-center"
            ref={registerCell(rowId, "unit") as React.Ref<HTMLInputElement>}
            onKeyDown={(e) => onCellKeyDown(e, rowId, "unit")}
            aria-label={`Unit, line ${index + 1}`}
            name={field.name}
            value={field.value ?? ""}
            onChange={field.onChange}
            onBlur={field.onBlur}
          />
        )}
      />

      <Controller
        name={`lines.${index}.rate`}
        control={control}
        render={({ field }) => (
          <Input
            type="number"
            // numeric(18,4): a rate is a unit price, and 0.0850 per unit is a
            // real quotation that 2dp would misprice by 6%.
            step="0.0001"
            min="0"
            inputMode="decimal"
            className="text-right tabular-nums"
            ref={registerCell(rowId, "rate") as React.Ref<HTMLInputElement>}
            onKeyDown={(e) => onCellKeyDown(e, rowId, "rate")}
            aria-label={`Rate, line ${index + 1}`}
            value={field.value === 0 ? "" : field.value}
            onChange={(e) => field.onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          />
        )}
      />

      <Controller
        name={`lines.${index}.discountAmount`}
        control={control}
        render={({ field }) => (
          <Input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            className="text-right tabular-nums"
            ref={registerCell(rowId, "discount") as React.Ref<HTMLInputElement>}
            onKeyDown={(e) => onCellKeyDown(e, rowId, "discount")}
            aria-label={`Discount, line ${index + 1}`}
            value={field.value === 0 ? "" : field.value}
            onChange={(e) => field.onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          />
        )}
      />

      <span
        className={`text-right text-sm tabular-nums ${amountPaise < 0 ? "text-destructive" : "text-muted-foreground"}`}
        aria-label={`Amount, line ${index + 1}`}
      >
        {formatCurrency(amountPaise / 100)}
      </span>

      {showRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={`Remove line ${index + 1}`}
          title={`Remove line ${index + 1}`}
          className="text-muted-foreground"
        >
          <Trash2 className="size-3.5" />
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}
