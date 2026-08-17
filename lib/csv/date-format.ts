/**
 * Dates in a CSV are ambiguous in a way nothing else in the file is:
 * `04/01/2026` is 4 January to an Indian export and 1 April to a US one, and
 * both readings are valid dates, so nothing downstream can notice the
 * mistake. The importer therefore treats day/month order as a stated choice
 * rather than an assumption — and where the file settles the question itself
 * (some value's day is above 12) it takes the file's word over the choice.
 */
import { format as formatDate, parseISO } from "date-fns";
import type { CsvDateFormat, CsvDateFormatHint, RawCsvRow } from "./types";

const SEPARATED = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Reformatting alone would happily produce `2026-02-31`, which looks like a
 * date all the way to the `::date` cast inside create_vouchers_bulk() — where
 * it surfaces as a raw Postgres error against the whole voucher group rather
 * than against the row that typed it. Round-tripping through a real Date
 * catches it here, while the row number is still attached.
 */
function isRealDate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * The two ways a date cell fails are worth telling apart: "not a date" is a
 * format problem, "31 February" is a typo, and telling someone who wrote the
 * format correctly to use dd/mm/yyyy sends them looking in the wrong place.
 */
export type CsvDateResult = { iso: string } | { iso: null; reason: "unreadable" | "impossible" };

export function readCsvDate(raw: string, format: CsvDateFormat): CsvDateResult {
  const trimmed = raw.trim();

  const iso = trimmed.match(ISO);
  if (iso) {
    return isRealDate(iso[1], iso[2], iso[3]) ? { iso: trimmed } : { iso: null, reason: "impossible" };
  }

  const parts = trimmed.match(SEPARATED);
  if (!parts) return { iso: null, reason: "unreadable" };
  const [, first, second, year] = parts;
  const [day, month] = format === "mm/dd/yyyy" ? [second, first] : [first, second];
  if (!isRealDate(year, month, day)) return { iso: null, reason: "impossible" };
  return { iso: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` };
}

/** Reads one cell to the `yyyy-mm-dd` Postgres wants, or null if it isn't a real date. */
export function parseCsvDate(raw: string, format: CsvDateFormat): string | null {
  return readCsvDate(raw, format).iso;
}

function cell(raw: RawCsvRow, header: string): string {
  const wanted = header.trim().toLowerCase();
  const key = Object.keys(raw).find((k) => k.trim().toLowerCase() === wanted);
  return key ? (raw[key] ?? "") : "";
}

/**
 * A worked example beats a format name: users recognise their own date far
 * more reliably than they recognise "dd/mm/yyyy". Prefers a value where the
 * two readings actually differ, since one that reads the same either way
 * demonstrates nothing.
 */
function workedExample(values: RegExpMatchArray[], format: CsvDateFormat): string | null {
  const informative = values.find((p) => Number(p[1]) <= 12 && Number(p[2]) <= 12 && Number(p[1]) !== Number(p[2]));
  const sample = informative ?? values[0];
  if (!sample) return null;
  const iso = parseCsvDate(sample[0], format);
  if (!iso) return null;
  return `${sample[0]} will import as ${formatDate(parseISO(iso), "d MMMM yyyy")}`;
}

/**
 * Decides how the file's date column should be read, given what the user
 * chose. `locked` means the file proved its own order and the choice is moot;
 * a file that somehow contains proof of both orders is left unlocked, and the
 * values that can't be read that way fail as impossible dates.
 */
export function inspectDateColumn(
  rawRows: RawCsvRow[],
  header: string,
  chosen: CsvDateFormat
): CsvDateFormatHint {
  const values = rawRows
    .map((r) => cell(r, header).trim().match(SEPARATED))
    .filter((m): m is RegExpMatchArray => m !== null);

  const firstMustBeDay = values.some((p) => Number(p[1]) > 12);
  const secondMustBeDay = values.some((p) => Number(p[2]) > 12);
  const locked = firstMustBeDay !== secondMustBeDay;
  const format: CsvDateFormat = !locked ? chosen : firstMustBeDay ? "dd/mm/yyyy" : "mm/dd/yyyy";

  return { format, locked, example: workedExample(values, format) };
}
