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
 * A row nobody has touched yet: no ledger chosen and nothing on either
 * amount, exactly what emptyLine() produces and exactly the shape the grid's
 * own `defaultRowCount` pre-fills a full-grid voucher type with. Dropped
 * before validation runs — a full-grid type opens with more starter rows
 * than most vouchers actually need (Adjustment's is 2+2), and requiring a
 * ledger on every one of them would refuse a perfectly balanced, complete
 * voucher for the crime of leaving unused rows unused rather than deleting
 * them. A row with only *some* of it filled in — a ledger picked but no
 * amount, say — is not blank and still fails validation normally.
 */
function isBlankVoucherLine(line: unknown): boolean {
  if (typeof line !== "object" || line === null) return false;
  const l = line as Record<string, unknown>;
  return (!l.ledgerId || l.ledgerId === "") && !l.debitAmount && !l.creditAmount;
}

function dropBlankLines(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("lines" in raw)) return raw;
  const form = raw as { lines: unknown };
  if (!Array.isArray(form.lines)) return raw;
  return { ...form, lines: form.lines.filter((l) => !isBlankVoucherLine(l)) };
}

/**
 * Builds a Zod schema for one voucher type: enforces the config's minimum
 * line counts and — the one rule that actually matters for double-entry —
 * that debit and credit totals match, compared in integer paise so float
 * rounding can never produce a false "unbalanced" error.
 *
 * `z.preprocess` drops untouched blank rows *before* per-line validation
 * sees them — filtering after the fact would be too late, since
 * `z.array(voucherLineSchema)` already rejects a blank row's empty ledgerId
 * on the way in.
 */
export function buildVoucherSchema(config: VoucherTypeConfig) {
  const withoutBlankRows = z
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

  // z.preprocess's own input type is always `unknown` by design (it has to
  // accept whatever runs through it before any shape is known), which would
  // otherwise widen zodResolver's inferred generic away from
  // VoucherFormValues and break every typed `Control<VoucherFormValues>`
  // prop downstream. The cast asserts back to the contract this schema has
  // always actually had — VoucherFormValues in, VoucherFormValues out —
  // which dropBlankLines' own typing already guarantees at runtime.
  return z.preprocess(dropBlankLines, withoutBlankRows) as unknown as typeof withoutBlankRows;
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
