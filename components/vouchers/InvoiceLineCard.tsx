"use client";

import { Controller } from "react-hook-form";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LedgerCombobox } from "@/components/ledgers/LedgerCombobox";
import { formatCurrency } from "@/lib/utils/currency";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";
import type { InvoiceLineRowProps } from "./InvoiceLineRow";

/**
 * One invoice line as a stacked card — InvoiceLineRow's fields, without the
 * 56rem-wide grid they normally sit in. InvoiceForm renders these when told
 * `layout="cards"` (the mobile section), and the desktop grid otherwise; the
 * form state, validation and keyboard-grid wiring are the same either way,
 * only the shape on screen forks.
 *
 * Same props as the row on purpose, so the form can hand either one the
 * same bag without a branch per prop.
 */
export function InvoiceLineCard({
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
  const label = (text: string) => (
    <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{text}</span>
  );

  return (
    <div className="space-y-2.5 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Line {index + 1}</span>
        {showRemove && (
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
        )}
      </div>

      <Controller
        name={`lines.${index}.description`}
        control={control}
        render={({ field }) => (
          <Input
            placeholder="What was sold"
            // `ref` is the keyboard grid's cell registration; react-hook-form's
            // own ref is deliberately not spread in — see InvoiceLineRow.
            ref={registerCell(rowId, "description") as React.Ref<HTMLInputElement>}
            onKeyDown={(e) => onCellKeyDown(e, rowId, "description")}
            autoFocus={autoFocusDescription}
            aria-label={`Description, line ${index + 1}`}
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

      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          {label("Qty")}
          <Controller
            name={`lines.${index}.quantity`}
            control={control}
            render={({ field }) => (
              <Input
                type="number"
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
        </div>
        <div className="space-y-1">
          {label("Unit")}
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
        </div>
        <div className="space-y-1">
          {label("Rate")}
          <Controller
            name={`lines.${index}.rate`}
            control={control}
            render={({ field }) => (
              <Input
                type="number"
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
        </div>
      </div>

      <div className="grid grid-cols-2 items-end gap-2">
        <div className="space-y-1">
          {label("Discount")}
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
        </div>
        <div className="space-y-1 text-right">
          {label("Amount")}
          <p
            className={`text-base font-semibold tabular-nums ${amountPaise < 0 ? "text-destructive" : ""}`}
            aria-label={`Amount, line ${index + 1}`}
          >
            {formatCurrency(amountPaise / 100)}
          </p>
        </div>
      </div>
    </div>
  );
}
