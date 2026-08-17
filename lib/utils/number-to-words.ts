/**
 * Amounts in words, Indian numbering — lakh and crore, not million and billion.
 *
 * An invoice carries the total twice on purpose: the figure can be altered
 * with a pen, the words are much harder to. This is the second copy, so it has
 * to be produced from the same integer paise the figure is, never from a
 * re-parsed display string.
 */

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
  const rounded = Math.round(paise);
  const sign = rounded < 0 ? "Minus " : "";
  const abs = Math.abs(rounded);

  const rupees = Math.floor(abs / 100);
  const remainder = abs % 100;

  const words = numberToWordsIndian(rupees);
  const paiseWords = remainder ? ` and ${underHundred(remainder)} Paise` : "";

  return `${sign}Rupees ${words}${paiseWords} Only`;
}
