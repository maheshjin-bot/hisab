import { z } from "zod";
import { toPaise, sumPaise } from "@/lib/utils/currency";
import type { VoucherTypeConfig } from "./voucher-type-config";

export const voucherLineSchema = z
  .object({
    ledgerId: z.string().min(1, { error: "Select a ledger" }),
    debitAmount: z.number().min(0),
    creditAmount: z.number().min(0),
    narration: z.string().max(500).optional(),
  })
  .refine((line) => (line.debitAmount > 0) !== (line.creditAmount > 0), {
    error: "Enter an amount on exactly one side",
    path: ["debitAmount"],
  });

export type VoucherLineFormValues = z.infer<typeof voucherLineSchema>;

export interface VoucherFormValues {
  voucherDate: string;
  narration?: string;
  referenceNumber?: string;
  referenceDate?: string;
  lines: VoucherLineFormValues[];
}

/**
 * Builds a Zod schema for one voucher type: enforces the config's minimum
 * line counts and — the one rule that actually matters for double-entry —
 * that debit and credit totals match, compared in integer paise so float
 * rounding can never produce a false "unbalanced" error.
 */
export function buildVoucherSchema(config: VoucherTypeConfig) {
  return z
    .object({
      voucherDate: z.string().min(1, { error: "Date is required" }),
      narration: z.string().max(1000).optional(),
      referenceNumber: z.string().max(100).optional(),
      referenceDate: z.string().optional(),
      lines: z.array(voucherLineSchema).min(config.dr.minRows + config.cr.minRows, {
        error: "Add at least two line items",
      }),
    })
    .refine(
      (form) => {
        const debitPaise = sumPaise(form.lines.map((l) => toPaise(l.debitAmount)));
        const creditPaise = sumPaise(form.lines.map((l) => toPaise(l.creditAmount)));
        return debitPaise === creditPaise;
      },
      { error: "Total debit must equal total credit", path: ["lines"] }
    )
    .refine((form) => form.lines.some((l) => l.debitAmount > 0), {
      error: "At least one debit entry is required",
      path: ["lines"],
    })
    .refine((form) => form.lines.some((l) => l.creditAmount > 0), {
      error: "At least one credit entry is required",
      path: ["lines"],
    });
}

/** Live totals for the form's totals bar — same paise-safe arithmetic as the schema. */
export function computeVoucherTotals(lines: VoucherLineFormValues[]) {
  const debitPaise = sumPaise(lines.map((l) => toPaise(l.debitAmount || 0)));
  const creditPaise = sumPaise(lines.map((l) => toPaise(l.creditAmount || 0)));
  return {
    debitTotal: debitPaise / 100,
    creditTotal: creditPaise / 100,
    isBalanced: debitPaise === creditPaise,
    differencePaise: debitPaise - creditPaise,
  };
}
