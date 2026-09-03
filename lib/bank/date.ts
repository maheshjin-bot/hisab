import type { DateFormat } from "./types";

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Splits "03/04/2026", "03-Apr-2026", "2026.04.03" into their three parts. */
function splitParts(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Statements often carry a time alongside the date ("03/04/2026 14:22:01").
  const dateOnly = trimmed.split(/[T\s]/)[0];
  const parts = dateOnly.split(/[/\-.]/).filter((p) => p !== "");
  return parts.length === 3 ? parts : null;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const max = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= max;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Two-digit years. A bank statement is a record of something that has already
 * happened, so "26" is 2026 rather than 1926, and the window is anchored well
 * back to keep old imported history readable.
 */
function expandYear(raw: number): number {
  if (raw >= 100) return raw;
  return raw >= 70 ? 1900 + raw : 2000 + raw;
}

/**
 * Reads one date cell into `yyyy-mm-dd`, or null if it isn't a date.
 *
 * `format` only disambiguates all-numeric dates. A spelled month ("03-Apr-26")
 * says what it is regardless of the profile, so it's honoured over the
 * declared format rather than fought with — which matters because the same
 * bank often uses numeric dates in its CSV and spelled ones in its XLS.
 */
export function parseStatementDate(raw: string | undefined | null, format: DateFormat): string | null {
  if (!raw) return null;
  const parts = splitParts(raw);
  if (!parts) return null;

  const namedIndex = parts.findIndex((p) => MONTH_NAMES[p.slice(0, 4).toLowerCase()] !== undefined
    || MONTH_NAMES[p.slice(0, 3).toLowerCase()] !== undefined);

  let year: number;
  let month: number;
  let day: number;

  if (namedIndex !== -1) {
    const key = parts[namedIndex].toLowerCase();
    month = MONTH_NAMES[key.slice(0, 4)] ?? MONTH_NAMES[key.slice(0, 3)];
    const rest = parts.filter((_, i) => i !== namedIndex);
    if (rest.some((p) => !/^\d+$/.test(p))) return null;
    const [a, b] = rest.map(Number);
    // The spelled month has already told us which part is the month, so the
    // only question left is which of the other two is the year. A four-digit
    // leading part can only be the year ("2026-Apr-03"); otherwise the year is
    // the trailing part, because every spelled-month layout a statement
    // actually uses puts it last — "03-Apr-2026", "Apr-03-2026", "03-Apr-26".
    //
    // The trailing part's *width* deliberately isn't consulted: a two-digit
    // year is still a year, and reading "03-Apr-26" as year 3 / day 26 is how
    // an HDFC or ICICI XLS export ends up filed twenty-three years early.
    if (rest[0].length === 4) {
      year = expandYear(a);
      day = b;
    } else {
      day = a;
      year = expandYear(b);
    }
  } else {
    if (parts.some((p) => !/^\d+$/.test(p))) return null;
    const [a, b, c] = parts.map(Number);
    if (format === "ymd" || parts[0].length === 4) {
      year = expandYear(a);
      month = b;
      day = c;
    } else if (format === "mdy") {
      month = a;
      day = b;
      year = expandYear(c);
    } else {
      day = a;
      month = b;
      year = expandYear(c);
    }
  }

  if (!isRealDate(year, month, day)) return null;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** True when a cell parses as a date under any of the three orderings. */
export function looksLikeDate(raw: string | undefined | null): boolean {
  if (!raw) return false;
  return (
    parseStatementDate(raw, "dmy") !== null ||
    parseStatementDate(raw, "mdy") !== null ||
    parseStatementDate(raw, "ymd") !== null
  );
}

export interface DateFormatGuess {
  format: DateFormat;
  /**
   * False when the sample never contained a day above 12, which leaves
   * dd/mm and mm/dd indistinguishable. The UI has to ask rather than assume,
   * because guessing wrong here silently moves every transaction to a
   * different month.
   *
   * True, not false, for a column that spells its months out: `format` has no
   * bearing on how those cells are read, so there is nothing for the user to
   * settle.
   */
  unambiguous: boolean;
}

/**
 * Infers the date ordering from a column of samples.
 *
 * The whole inference rests on one fact: a value above 12 in a position can
 * only be a day. So a column containing 13/04/2026 is dmy and one containing
 * 04/13/2026 is mdy, and a column where every value could be either is
 * reported as ambiguous rather than guessed at.
 */
export function detectDateFormat(samples: string[]): DateFormatGuess {
  let firstOver12 = false;
  let secondOver12 = false;
  let isoLike = 0;
  let considered = 0;
  // Spelled months are skipped by the inference below — they carry no evidence
  // about the ordering of an all-numeric date — but they are not *nothing*,
  // and the count is what separates "no ordering evidence" from "no ordering
  // question". See the return below.
  let spelled = 0;

  for (const sample of samples) {
    const parts = splitParts(sample ?? "");
    if (!parts) continue;
    if (parts.some((p) => MONTH_NAMES[p.slice(0, 3).toLowerCase()] !== undefined)) {
      spelled++;
      continue;
    }
    if (parts.some((p) => !/^\d+$/.test(p))) continue;

    considered++;
    if (parts[0].length === 4) {
      isoLike++;
      continue;
    }
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    if (first > 12) firstOver12 = true;
    if (second > 12) secondOver12 = true;
  }

  if (considered > 0 && isoLike === considered) return { format: "ymd", unambiguous: true };
  // Both positions exceeding 12 means the column isn't consistently either;
  // dmy is the better default for this app's users, but say it's a guess.
  if (firstOver12 && secondOver12) return { format: "dmy", unambiguous: false };
  if (firstOver12) return { format: "dmy", unambiguous: true };
  if (secondOver12) return { format: "mdy", unambiguous: true };
  // Not one numeric date in the column, and at least one spelled month: the
  // ICICI-style export, where "01-Apr-2026" says what it is and the declared
  // ordering never gets consulted. Reporting that as ambiguous asks the user a
  // question about a file that contains nothing the answer could change — and
  // an unanswerable warning on every import of a common format is how the one
  // warning here that must not be clicked past stops being read.
  //
  // A column mixing spelled and numeric dates still falls through to the
  // ambiguous return below, because the numeric half really does depend on
  // the ordering.
  if (considered === 0 && spelled > 0) return { format: "dmy", unambiguous: true };
  // Every day in the sample was 12 or below: dd/mm and mm/dd are genuinely
  // indistinguishable here, so the caller has to ask.
  return { format: "dmy", unambiguous: false };
}
