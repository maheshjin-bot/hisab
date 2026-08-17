import { toPaise } from "@/lib/utils/currency";

export interface ParsedAmount {
  paise: number;
  /**
   * A Dr/Cr marker found inside the cell itself. Several Indian banks put it
   * there rather than in a column of its own — "1,234.56 Cr" — and it beats
   * whatever the profile assumed, because it's the file being explicit.
   */
  explicitSign: "Dr" | "Cr" | null;
  /** True when the cell carried a minus sign or accounting parentheses. */
  negative: boolean;
}

const DR_SUFFIX = /\b(dr|debit)\.?$/i;
const CR_SUFFIX = /\b(cr|credit)\.?$/i;

/**
 * Reads one amount cell.
 *
 * Deliberately permissive about presentation and strict about value: currency
 * symbols, Indian digit grouping (1,23,456.78), accounting parentheses,
 * trailing Dr/Cr markers and stray spaces are all stripped, but anything left
 * over that isn't a number returns null rather than a silent 0 — a statement
 * row that quietly reads as zero is worse than one that reports an error,
 * because it lands in the books as a missing transaction rather than a
 * visible failure.
 *
 * Returns null for a blank cell too: in `separate_columns` mode a blank is the
 * normal state of the side a transaction didn't use.
 */
export function parseAmountCell(raw: string | undefined | null): ParsedAmount | null {
  if (raw === undefined || raw === null) return null;

  let text = raw.trim();
  if (text === "" || text === "-" || text === "–" || text === ".") return null;

  let explicitSign: ParsedAmount["explicitSign"] = null;
  if (DR_SUFFIX.test(text)) {
    explicitSign = "Dr";
    text = text.replace(DR_SUFFIX, "").trim();
  } else if (CR_SUFFIX.test(text)) {
    explicitSign = "Cr";
    text = text.replace(CR_SUFFIX, "").trim();
  }

  let negative = false;
  // (1,234.56) is accounting notation for a negative, and some exports use it
  // instead of a minus.
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  //   is listed alongside \s on purpose: statements pasted out of a web
  // portal are full of non-breaking spaces.
  text = text.replace(/[₹$€£]/g, "").replace(/[\s ]/g, "");

  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  text = normalizeSeparators(text);
  if (text === "" || !/^\d+(\.\d+)?$/.test(text)) return null;

  const value = Number(text);
  if (!Number.isFinite(value)) return null;

  return { paise: toPaise(value), explicitSign, negative };
}

/**
 * Collapses grouping separators to nothing and the decimal separator to a dot.
 *
 * The ambiguous case is a single comma: "1,234" is one thousand two hundred
 * and thirty-four to an Indian bank and one point two three four to a German
 * one. Resolved by digit count — a comma followed by exactly two digits and
 * nothing else is a decimal comma, anything else is grouping. Three trailing
 * digits after the last comma is unambiguous grouping, which is the case that
 * actually shows up in Indian statements.
 */
function normalizeSeparators(text: string): string {
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma === -1) return text; // dots only, or plain digits
  if (lastDot > lastComma) return text.replace(/,/g, ""); // 1,23,456.78

  if (lastDot === -1) {
    const afterComma = text.length - lastComma - 1;
    // 1234,56 -> decimal comma. 1,234 / 1,23,456 -> grouping.
    if (afterComma === 2 && text.indexOf(",") === lastComma) {
      return text.slice(0, lastComma) + "." + text.slice(lastComma + 1);
    }
    return text.replace(/,/g, "");
  }

  // Dots before the last comma: European grouping, 1.234.567,89
  return text.replace(/\./g, "").replace(",", ".");
}

/** True when a cell looks like a number rather than prose — used by column detection. */
export function looksNumeric(raw: string | undefined | null): boolean {
  return parseAmountCell(raw) !== null;
}
