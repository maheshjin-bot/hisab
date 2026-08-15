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
  sideRule,
  triggerRef,
  onKeyDown,
  autoFocus,
}: {
  companyId: string;
  control: Control<VoucherFormValues>;
  sideRule: VoucherSideRule;
  triggerRef: (el: HTMLElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  autoFocus?: boolean;
}) {
  return (
    <Field>
      <FieldLabel>{sideRule.label}</FieldLabel>
      <Controller
        name="lines.0.ledgerId"
        control={control}
        render={({ field }) => (
          <LedgerCombobox
            companyId={companyId}
            value={field.value}
            onSelect={(ledger: LedgerSearchResult) => field.onChange(ledger.id)}
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
