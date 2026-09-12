/**
 * Splitting a `YYYY-MM-DD` string into day/month/year and back — what a
 * dropdown-based date picker needs that a single text value doesn't give it.
 */

export interface DateParts {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
}

export function parseDateParts(iso: string): DateParts {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

/** Number of days in a given month (1-12) of a given year — Feb correctly varies with leap years. */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Composes `YYYY-MM-DD`, clamping the day to what the given month actually
 * has. Without this, picking "31" while on a 30-day month and then switching
 * to April would roll over into May 1st instead of just landing on April 30 —
 * the clamp keeps a dropdown day picker from ever producing an impossible or
 * surprising date.
 */
export function formatDateParts(year: number, month: number, day: number): string {
  const clampedDay = Math.min(day, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Years to offer in a dropdown, oldest first, spanning far enough back for
 * real bookkeeping history around `centerYear` (typically the selected
 * financial year) and one year ahead for the rare post-dated entry.
 */
export function yearOptions(centerYear: number, before = 12, after = 1): number[] {
  const years: number[] = [];
  for (let y = centerYear - before; y <= centerYear + after; y++) years.push(y);
  return years;
}
