/**
 * `Number("1,00,000.00")` is NaN, so a plain `Number(cell)` rejects every row
 * of an ordinary Indian-formatted export — including a file HISAB itself
 * wrote, which formats with exactly that grouping. What arrives in a real
 * CSV is a number a human or a spreadsheet dressed up: grouping separators,
 * a currency symbol, and brackets where an accountant means a minus sign.
 * Undressing it is not the same as guessing: anything left over that isn't a
 * number is still refused.
 */

const CURRENCY_PREFIX = /^(₹|rs\.?|inr)\s*/i;
/** Ordinary spaces plus the non-breaking and narrow ones Excel likes to emit. */
const SPACES = /[\s  ]/g;
const BARE_NUMBER = /^\d+(\.\d*)?$/;

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

  text = text.replace(CURRENCY_PREFIX, "");
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }

  text = text.replace(SPACES, "").replace(/,/g, "");
  if (!BARE_NUMBER.test(text)) return null;

  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}
