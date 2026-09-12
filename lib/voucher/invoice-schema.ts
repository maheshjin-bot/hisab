import { z } from "zod";
import { roundHalfAwayFromZero, scaleDecimal, toPaise } from "@/lib/utils/currency";

/**
 * The invoice form's shape and its arithmetic.
 *
 * Everything here is a *preview* of what the database will store. `line_amount`
 * is a generated column — `round(quantity * rate, 2) - discount_amount` — and
 * the schema comment on 0021 is explicit that the database is the authority on
 * what a line is worth and the form re-reads it. So nothing in this file is
 * ever sent; it exists so the user can see the total before they save, and so
 * the form can refuse a save the database would refuse anyway with a message
 * that names the offending line.
 */

/** numeric(18,3) — goods are sold by the gram and the millilitre. */
export const QUANTITY_SCALE = 3;
/** numeric(18,4) — a rate is a unit price, and sub-paisa unit prices are ordinary. */
export const RATE_SCALE = 4;

export interface InvoiceLineFormValues {
  description: string;
  revenueLedgerId: string;
  quantity: number;
  unit?: string;
  rate: number;
  discountAmount: number;
}

export interface InvoiceFormValues {
  voucherDate: string;
  narration?: string;
  referenceNumber?: string;
  referenceDate?: string;
  partyLedgerId: string;
  lines: InvoiceLineFormValues[];
}

/**
 * A field the user is halfway through typing is a zero, not a NaN line — the
 * totals bar recomputes on every keystroke, off raw form values.
 */
function blankAsZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Divides by 10^places, rounding half away from zero — Postgres `round()`'s
 * rule, rather than `Math.round`'s round-half-up, which disagrees on negatives.
 * The rule itself lives in currency.ts, so the codebase carries one of it.
 *
 * Scaling both operands to exact integers first is what makes this correct,
 * and it is not cosmetic: `0.615 * 100` is 61.49999999999999 in binary
 * floating point, so a line rounded from the raw product posts 0.61 where the
 * database stores 0.62. Scaling quantity and rate with `scaleDecimal` and only
 * then dividing keeps every intermediate on a value the format represents
 * exactly, so nothing ever approaches a rounding boundary from the wrong side.
 *
 * The product stays exact while it fits a double's 53-bit integer range, which
 * covers a line worth up to about ninety crore. Past that this drifts by a
 * paisa or two — acceptable, because it is a preview and 0021 makes the
 * database the authority on what a line is worth.
 */
function divideRounding(value: number, places: number): number {
  return roundHalfAwayFromZero(value / 10 ** places);
}

/**
 * `round(quantity * rate, 2)` in integer paise — the line before its discount.
 *
 * quantity is 3dp and rate 4dp, so their product is exact at 7dp; rounding
 * that to paise once, here, is the same single settlement the generated column
 * performs. Three lines at 33.333 each give 3333 paise, never 33.333 summed
 * and rounded to 10000.
 *
 * Both operands go through `scaleDecimal`, which is how the column itself
 * takes them: `numeric(18,4)` rounds a rate half away from zero on the way in.
 * This used to be `Math.round(value * 10 ** places)`, and the difference is
 * not a paisa — it is a whole rate tick, which then multiplies by the
 * quantity. A rate of 0.00015 scaled that way gave
 * `Math.round(1.4999999999999998)` = 1, i.e. 0.0001, so a thousand units
 * previewed at ₹0.10 against the ₹0.20 the column stores. Confirmed on
 * PG 18.6: `0.00015::numeric(18,4)` is 0.0002, and
 * `round(1000::numeric(18,3) * 0.00015::numeric(18,4), 2)` is 0.20.
 */
export function lineGrossPaise(line: { quantity: number; rate: number }): number {
  const quantity = scaleDecimal(blankAsZero(line.quantity), QUANTITY_SCALE);
  const rate = scaleDecimal(blankAsZero(line.rate), RATE_SCALE);
  // 3dp x 4dp = 7dp; paise is 2dp, so five places come off.
  return divideRounding(quantity * rate, QUANTITY_SCALE + RATE_SCALE - 2);
}

/**
 * `discount_amount` in integer paise — the value the numeric(18,2) column
 * will hold.
 *
 * This is `toPaise` and nothing else. It used to be `Math.round(x * 100)`,
 * which reintroduced inside this module the very float boundary the module
 * exists to avoid: a discount of 1.005 previewed as ₹1.00 where the column
 * stores 1.01, so the line the user saw was a paisa off the line the books
 * held. All three of this module's scales — 2dp discount, 3dp quantity, 4dp
 * rate — now go through the one `scaleDecimal`, so there is a single rounding
 * rule here and no second way to do it.
 */
export function discountPaise(line: { discountAmount: number }): number {
  return toPaise(blankAsZero(line.discountAmount));
}

/** The generated column, previewed: `round(quantity * rate, 2) - discount_amount`. */
export function lineAmountPaise(line: { quantity: number; rate: number; discountAmount: number }): number {
  return lineGrossPaise(line) - discountPaise(line);
}

export interface InvoiceTotals {
  /** Per line, in the order given — what each row shows in its Amount cell. */
  linePaise: number[];
  /** Before discounts. */
  grossPaise: number;
  discountPaise: number;
  /** What the party will be debited (sales) or credited (purchase). */
  totalPaise: number;
}

/**
 * Live totals for the invoice totals bar.
 *
 * Sums of already-settled paise, exactly as the generator sums already-settled
 * `line_amount`s — so this preview and the posted voucher agree to the paisa by
 * construction, not by both happening to round the same way.
 */
export function computeInvoiceTotals(lines: InvoiceLineFormValues[]): InvoiceTotals {
  const linePaise = lines.map((l) =>
    lineAmountPaise({ quantity: l?.quantity || 0, rate: l?.rate || 0, discountAmount: l?.discountAmount || 0 })
  );
  const grossPaise = lines.reduce((sum, l) => sum + lineGrossPaise({ quantity: l?.quantity || 0, rate: l?.rate || 0 }), 0);
  const discount = lines.reduce((sum, l) => sum + discountPaise({ discountAmount: l?.discountAmount || 0 }), 0);
  return {
    linePaise,
    grossPaise,
    discountPaise: discount,
    totalPaise: grossPaise - discount,
  };
}

export const invoiceLineSchema = z.object({
  description: z.string().min(1, { error: "Describe what this line is for" }).max(500),
  revenueLedgerId: z.string().min(1, { error: "Select a ledger for this line" }),
  quantity: z.number().positive({ error: "Quantity must be more than zero" }),
  unit: z.string().max(20).optional(),
  rate: z.number().min(0, { error: "Rate cannot be negative" }),
  discountAmount: z.number().min(0, { error: "Discount cannot be negative" }),
});

/**
 * The invoice form's schema.
 *
 * The two refinements below are the client-side halves of constraints the
 * database holds anyway — `check (line_amount >= 0)` and the generator's
 * refusal of a zero total. Duplicated deliberately: the database's version
 * arrives as an error toast naming no line, and a discount larger than the
 * line it discounts is a typo the user should be shown in place.
 */
export function buildInvoiceSchema() {
  return z
    .object({
      voucherDate: z.string().min(1, { error: "Date is required" }),
      narration: z.string().max(1000).optional(),
      referenceNumber: z.string().max(100).optional(),
      referenceDate: z.string().optional(),
      partyLedgerId: z.string().min(1, { error: "Select the party" }),
      lines: z.array(invoiceLineSchema).min(1, { error: "An invoice needs at least one line" }),
    })
    .refine((form) => form.lines.every((l) => lineAmountPaise(l) >= 0), {
      error: "A line's discount cannot be more than the line itself",
      path: ["lines"],
    })
    .refine((form) => computeInvoiceTotals(form.lines).totalPaise > 0, {
      error: "An invoice must come to more than nothing",
      path: ["lines"],
    });
}
