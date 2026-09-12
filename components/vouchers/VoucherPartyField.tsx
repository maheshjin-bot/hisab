"use client";

import { Controller, type Control } from "react-hook-form";
import { LedgerCombobox } from "@/components/ledgers/LedgerCombobox";
import { Field, FieldLabel } from "@/components/ui/field";
import type { VoucherSideRule } from "@/lib/voucher/voucher-type-config";
import type { VoucherFormValues } from "@/lib/voucher/voucher-schema";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";

export function VoucherPartyField({
  companyId,
  control,
  index,
  sideRule,
  triggerRef,
  onKeyDown,
  autoFocus,
  initialLedgerName,
  onLedgerPicked,
}: {
  companyId: string;
  control: Control<VoucherFormValues>;
  /**
   * Which line in the form's array is actually "the party" — identified by
   * splitVoucherLines from the real posting, not assumed to be 0. A voucher
   * saved by some route other than this form (bulk CSV import is the
   * confirmed case) can have its party line at any index.
   */
  index: number;
  sideRule: VoucherSideRule;
  triggerRef: (el: HTMLElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  autoFocus?: boolean;
  /** Label to show before the user picks — the existing ledger when editing. */
  initialLedgerName?: string;
  /** The form keeps the picked ledger's role, which the id alone doesn't carry — see F-18. */
  onLedgerPicked?: (ledger: LedgerSearchResult) => void;
}) {
  return (
    <Field>
      <FieldLabel>{sideRule.label}</FieldLabel>
      <Controller
        name={`lines.${index}.ledgerId`}
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
            sideRule={sideRule}
            triggerRef={triggerRef}
            onKeyDown={onKeyDown}
            autoFocus={autoFocus}
            placeholder={`Select ${sideRule.label.toLowerCase()}…`}
          />
        )}
      />
    </Field>
  );
}
