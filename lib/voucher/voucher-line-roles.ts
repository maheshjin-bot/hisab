import type { VoucherTypeConfig } from "./voucher-type-config";
import { sumPaise, toPaise, fromPaise } from "@/lib/utils/currency";

/**
 * The two fields every voucher line stores an amount on. Exactly one is ever
 * nonzero on a real posting (see `voucherLineSchema`'s refine in
 * voucher-schema.ts) — which is what makes "which field is populated" a
 * reliable way to identify a line's side, unlike its position in the array.
 */
export interface VoucherLineAmounts {
  debitAmount: number;
  creditAmount: number;
}

export interface VoucherLineSplit<T extends VoucherLineAmounts> {
  /**
   * The line playing "the party" — the one rendered in the fixed field above
   * the grid ("Paid From", "Received Into", "Customer", "Supplier").
   *
   * Identified by which line's amount actually sits on the structural side
   * `config` marks `isPrimaryParty` for (see VOUCHER_TYPE_CONFIG), never by
   * array position — a voucher that reached the database by a route other
   * than this form (bulk CSV import is the confirmed case: PAY/02867) can
   * store that line at any index.
   *
   * `null` only when `lines` is empty — the form itself never actually calls
   * this with an empty array, since every single-party voucher type keeps at
   * least one party row and one grid row (`minRows` on both sides). When no
   * *populated* line matches the primary side yet — a brand-new voucher, or
   * an existing one mid-edit with every amount blanked — this falls back to
   * index 0, exactly the position the form has always put an empty party row
   * at, so the fixed field never crashes or disappears while someone is
   * mid-entry; it just doesn't mean anything yet.
   */
  partyIndex: number | null;
  /** `lines[partyIndex]`, or `undefined` when `partyIndex` is null. */
  partyLine: T | undefined;
  /** Every other index, in original order — what the grid renders. */
  gridIndices: number[];
  /** `gridIndices.map(i => lines[i])`. */
  gridLines: T[];
}

/**
 * Splits a single-party voucher's lines into "the party" and "the grid" by
 * looking at what each line's amount actually is, not where it sits in the
 * array. Do not call this for `contra`/`journal` — neither side of those has
 * `isPrimaryParty`, so there is no single party line to find.
 *
 * Exactly one side of `config` (`dr` or `cr`) is ever marked
 * `isPrimaryParty`. If more than one line genuinely has a nonzero amount on
 * that side — which should never happen for a real single-party voucher,
 * since there is exactly one party, but malformed or oddly-imported data
 * might produce it — the first such line by index wins and every other line,
 * including the extra one(s) on the primary side, becomes a grid line.
 * Nothing is dropped and nothing throws.
 */
export function splitVoucherLines<T extends VoucherLineAmounts>(
  lines: T[],
  config: Pick<VoucherTypeConfig, "dr" | "cr">
): VoucherLineSplit<T> {
  const field: keyof VoucherLineAmounts = config.dr.isPrimaryParty === true ? "debitAmount" : "creditAmount";
  const found = lines.findIndex((l) => (l[field] || 0) > 0);
  const partyIndex = found !== -1 ? found : lines.length > 0 ? 0 : null;
  const gridIndices = lines.map((_, i) => i).filter((i) => i !== partyIndex);
  return {
    partyIndex,
    partyLine: partyIndex !== null ? lines[partyIndex] : undefined,
    gridIndices,
    gridLines: gridIndices.map((i) => lines[i]),
  };
}

/**
 * Which side (and therefore which amount field) a grid row's own data is
 * actually on. Structurally every grid row sits on the voucher type's
 * non-party side, but this reads the line's real populated field instead of
 * assuming it — the same defensive read `splitVoucherLines` uses to find the
 * party — so a line saved on the "wrong" field (case 4's malformed extra
 * line, or PAY/02867's grid line, which happens to sit on the type's normal
 * grid field) always renders its real amount instead of a blank box.
 * `fallback` (the voucher type's structural grid side) is what an empty,
 * still-being-typed row shows.
 */
export function gridLineSide<T extends VoucherLineAmounts>(line: T | undefined, fallback: "debit" | "credit"): "debit" | "credit" {
  if ((line?.creditAmount || 0) > 0) return "credit";
  if ((line?.debitAmount || 0) > 0) return "debit";
  return fallback;
}

/**
 * The rupee total of "the grid" lines' real amounts — whichever field each
 * one actually has populated, summed in integer paise per this codebase's
 * currency convention (see lib/utils/currency.ts) and converted back to
 * rupees for the form field it feeds.
 *
 * A real line only ever has one of the two fields nonzero (the schema
 * enforces this), so `debitAmount + creditAmount` is just "whichever one is
 * populated" without needing to know which; an all-zero (still-being-typed)
 * line contributes 0 either way.
 *
 * This is exactly what VoucherForm's party-amount auto-sync effect needs:
 * the party line's own amount isn't independently editable — there is no
 * amount box for it — so it is kept equal to this sum on the field opposite
 * the grid's structural side.
 */
export function gridAmountTotal<T extends VoucherLineAmounts>(gridLines: T[]): number {
  const paise = gridLines.map((l) => toPaise((l.debitAmount || 0) + (l.creditAmount || 0)));
  return fromPaise(sumPaise(paise));
}
