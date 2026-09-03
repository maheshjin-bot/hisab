/**
 * `Number("1,00,000.00")` is NaN, so a plain `Number(cell)` rejects every row
 * of an ordinary Indian-formatted export — including a file HISAB itself
 * wrote, which formats with exactly that grouping. What arrives in a real
 * CSV is a number a human or a spreadsheet dressed up: grouping separators,
 * a currency symbol, and brackets where an accountant means a minus sign.
 * Undressing it is not the same as guessing: anything left over that isn't a
 * number is still refused.
 */

import { toPaise } from "@/lib/utils/currency";

const CURRENCY_PREFIX = /^(₹|rs\.?|inr)\s*/i;
/** Ordinary spaces plus the non-breaking and narrow ones Excel likes to emit. */
const SPACES = /[\s  ]/g;
/**
 * A decimal point has to be followed by a digit. `\.\d*` also accepted a
 * trailing "1.", which `Number` happily reads as 1 — the bank parser refuses
 * it, and a cell ending in a bare point is a truncated value, not an amount.
 */
const BARE_NUMBER = /^\d+(\.\d+)?$/;

/** Rupees, or null when the cell isn't a number at all (including when it's empty). */
export function parseCsvAmount(raw: string): number | null {
  let text = raw.trim();
  if (!text) return null;

  let negative = false;
  const bracketed = /^\((.*)\)$/.exec(text);
  if (bracketed) {
    negative = true;
    text = bracketed[1].trim();
  }

  // The symbol may sit on either side of the sign: a spreadsheet writes
  // "-₹5" and a portal writes "₹-5", and both mean the same five rupees out.
  // Stripping the prefix only once, before the minus check, read the second
  // and refused the first — so a ledger opening-balance CSV rejected a row a
  // bank statement would have accepted. At most one of each is allowed, so
  // "--5" and "-₹-5" are still refused by the digit check below.
  text = text.replace(CURRENCY_PREFIX, "");
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1).trim().replace(CURRENCY_PREFIX, "");
  }

  text = text.replace(SPACES, "").replace(/,/g, "");
  if (!BARE_NUMBER.test(text)) return null;

  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  // The same guard bank/amount.ts carries, and for the same reason: above
  // roughly ₹90,00,00,00,00,000 the paise are already gone before anything
  // downstream can notice, and `toPaise` of the value is no longer a safe
  // integer. The CSV voucher importer's whole-file Dr = Cr check then runs on
  // figures whose low digits are fiction and can call a file balanced that is
  // not. A cell this large is a mis-mapped column — an account number or a
  // UTR read as the amount — and a rejected row says so where a silently
  // rounded one does not.
  if (!Number.isSafeInteger(toPaise(value))) return null;
  return negative ? -value : value;
}
