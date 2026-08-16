"use client";

import { Controller, type Control } from "react-hook-form";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LedgerCombobox } from "@/components/ledgers/LedgerCombobox";
import type { VoucherSideRule } from "@/lib/voucher/voucher-type-config";
import type { VoucherFormValues } from "@/lib/voucher/voucher-schema";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";

export interface VoucherLineRowProps {
  companyId: string;
  control: Control<VoucherFormValues>;
  index: number;
  rowId: string;
  sideRule: VoucherSideRule;
  /** full-grid mode only: which side this row is currently on. */
  side?: "debit" | "credit";
  onToggleSide?: () => void;
  showRemove: boolean;
  onRemove: () => void;
  registerCell: (rowId: string, columnKey: string) => (el: HTMLElement | null) => void;
  onCellKeyDown: (e: React.KeyboardEvent, rowId: string, columnKey: string) => void;
  autoFocusLedger?: boolean;
}

export function VoucherLineRow({
  companyId,
  control,
  index,
  rowId,
  sideRule,
  side,
  onToggleSide,
  showRemove,
  onRemove,
  registerCell,
  onCellKeyDown,
  autoFocusLedger,
}: VoucherLineRowProps) {
  const amountField = side === "credit" ? "creditAmount" : "debitAmount";

  return (
    <div className="grid grid-cols-[1fr_7rem_1fr_2rem] items-center gap-2 py-1.5 transition-colors hover:bg-muted/30">
      <Controller
        name={`lines.${index}.ledgerId`}
        control={control}
        render={({ field }) => (
          <LedgerCombobox
            companyId={companyId}
            value={field.value}
            displayName={undefined}
            onSelect={(ledger: LedgerSearchResult) => field.onChange(ledger.id)}
            sideRule={sideRule}
            triggerRef={registerCell(rowId, "ledger")}
            onKeyDown={(e) => onCellKeyDown(e, rowId, "ledger")}
            autoFocus={autoFocusLedger}
          />
        )}
      />

      {onToggleSide ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          ref={registerCell(rowId, "side") as React.Ref<HTMLButtonElement>}
          onKeyDown={(e) => onCellKeyDown(e, rowId, "side")}
          onClick={onToggleSide}
          className="w-full"
        >
          {side === "credit" ? "Cr" : "Dr"}
        </Button>
      ) : (
        <span className="text-center text-xs text-muted-foreground">{side === "credit" ? "Cr" : "Dr"}</span>
      )}

      <Controller
        name={`lines.${index}.${amountField}`}
        control={control}
        render={({ field }) => (
          <Input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            className="text-right tabular-nums"
            ref={registerCell(rowId, "amount") as React.Ref<HTMLInputElement>}
            onKeyDown={(e) => onCellKeyDown(e, rowId, "amount")}
            value={field.value || ""}
            onChange={(e) => field.onChange(Number(e.target.value))}
          />
        )}
      />

      {showRemove ? (
        <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} className="text-muted-foreground">
          <Trash2 className="size-3.5" />
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}
