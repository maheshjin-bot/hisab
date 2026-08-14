import { addDays, addMonths, addYears, isValid, setDate } from "date-fns";

/**
 * Parses Tally-style quick date entry. Resolve this on confirm (Enter/Tab/
 * blur) only — never per keystroke, or it'll fight a user mid-way through
 * typing a full dd/mm/yyyy date. Returns null (keep the field's previous
 * value) rather than throwing on unparseable input.
 *
 * Supported: "today" / "t", "+3d" / "-1d" / "3d", "+2m" / "-1m", "+1y" / "-1y",
 * a bare day-of-month ("15" -> the 15th of the current month), "dd/mm",
 * "dd/mm/yyyy" (or "-" separators).
 */
export function parseSmartDate(input: string, referenceDate: Date = new Date()): Date | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed === "today" || trimmed === "t") {
    return referenceDate;
  }

  const relative = trimmed.match(/^([+-]?)(\d+)([dmy])$/);
  if (relative) {
    const [, sign, amountStr, unit] = relative;
    const amount = (sign === "-" ? -1 : 1) * Number(amountStr);
    if (unit === "d") return addDays(referenceDate, amount);
    if (unit === "m") return addMonths(referenceDate, amount);
    return addYears(referenceDate, amount);
  }

  const dayOnly = trimmed.match(/^(\d{1,2})$/);
  if (dayOnly) {
    const day = Number(dayOnly[1]);
    if (day >= 1 && day <= 31) {
      const candidate = setDate(referenceDate, day);
      return isValid(candidate) && candidate.getDate() === day ? candidate : null;
    }
  }

  const dayMonth = trimmed.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (dayMonth) {
    const candidate = buildDate(referenceDate.getFullYear(), dayMonth[2], dayMonth[1]);
    if (candidate) return candidate;
  }

  const full = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (full) {
    const year = full[3].length === 2 ? 2000 + Number(full[3]) : Number(full[3]);
    const candidate = buildDate(year, full[2], full[1]);
    if (candidate) return candidate;
  }

  return null;
}

function buildDate(year: number, monthStr: string, dayStr: string): Date | null {
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(year, month - 1, day);
  // Guards against JS's rollover (e.g. Feb 30 silently becoming Mar 2).
  return candidate.getDate() === day ? candidate : null;
}
