/**
 * Amounts in words, Indian numbering — lakh and crore, not million and billion.
 *
 * An invoice carries the total twice on purpose: the figure can be altered
 * with a pen, the words are much harder to. This is the second copy, so it has
 * to be produced from the same integer paise the figure is, never from a
 * re-parsed display string.
 */

import { roundHalfAwayFromZero } from "@/lib/utils/currency";

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];

const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** 0–99. Returns "" for zero so callers can drop the group entirely. */
function underHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = ONES[n % 10];
  return ones ? `${tens} ${ones}` : tens;
}

/**
 * A whole number in Indian words. Groups are crore / lakh / thousand /
 * hundred, and the crore group recurses so 1,23,45,67,890 reads as "One
 * Hundred Twenty Three Crore …" rather than running out of names.
 */
export function numberToWordsIndian(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "Zero";

  const parts: string[] = [];
  let rest = n;

  const crore = Math.floor(rest / 10_000_000);
  rest %= 10_000_000;
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  const thousand = Math.floor(rest / 1_000);
  rest %= 1_000;
  const hundred = Math.floor(rest / 100);
  rest %= 100;

  if (crore) parts.push(`${numberToWordsIndian(crore)} Crore`);
  if (lakh) parts.push(`${underHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${underHundred(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(underHundred(rest));

  return parts.join(" ");
}

/**
 * Integer paise -> the line that goes under an invoice total.
 *
 * "Rupees Twelve Thousand Three Hundred Forty Five and Sixty Seven Paise Only".
 * Exact paise are dropped when there are none, because "and Zero Paise" reads
 * like an error on a printed document.
 */
export function rupeesInWords(paise: number): string {
  // A missing amount must not print as a hole. `numberToWordsIndian` returns
  // "" for a non-finite input, which is right for a helper and wrong for the
  // line that goes on a document a customer receives: it rendered NaN as
  // "Rupees  Only", a blank where the amount belongs, complete with the
  // double space. Refusing is the only safe answer — an invoice that fails to
  // render is recoverable, one that prints an empty total is not.
  if (!Number.isFinite(paise)) {
    throw new Error(`rupeesInWords needs a finite amount in paise, received ${paise}`);
  }

  // Half away from zero, matching the figure this line duplicates: Intl
  // rounds half-expand, so formatCurrency(fromPaise(-0.5)) prints "-₹0.01",
  // and the words have to say one paisa too. `Math.round` was wrong twice
  // over here — it is half-up, so it disagreed on negatives, and it returned
  // -0 for -0.5, whereupon `-0 < 0` is false and the "Minus" was dropped
  // altogether. Callers pass integer paise, where every rounding rule agrees;
  // this is about the contract, on output a customer reads.
  const rounded = roundHalfAwayFromZero(paise);
  const sign = paise < 0 ? "Minus " : "";
  const abs = Math.abs(rounded);

  const rupees = Math.floor(abs / 100);
  const remainder = abs % 100;

  const words = numberToWordsIndian(rupees);
  const paiseWords = remainder ? ` and ${underHundred(remainder)} Paise` : "";

  return `${sign}Rupees ${words}${paiseWords} Only`;
}
