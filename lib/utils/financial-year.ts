/** The Indian default, and the value `create_company` falls back to. */
export const DEFAULT_FINANCIAL_YEAR_START_MONTH = 4;

/**
 * `YYYY-MM-DD` for a date's *local* calendar day.
 *
 * `toISOString().slice(0, 10)` is the obvious thing to reach for and is wrong
 * here: it converts to UTC first, so for anyone east of Greenwich the early
 * hours of a day still report yesterday. In IST that's every day until 05:30.
 */
export function isoLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A `YYYY-MM-DD` string as a Date at local midnight.
 *
 * The mirror of isoLocalDate, and avoids the same trap from the other side:
 * `new Date("2026-04-01")` parses as UTC midnight, which is 31 March for
 * anyone west of Greenwich. A calendar date the books stamped has no
 * time-of-day and no timezone; it must round-trip through this and nothing
 * else.
 */
export function parseIsoLocalDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

/** The calendar year a financial year is named after — FY 2025-26 is start year 2025, whatever month it opens in. */
export function financialYearStartYear(asOf: Date, financialYearStartMonth: number): number {
  const month = asOf.getMonth() + 1;
  return month >= financialYearStartMonth ? asOf.getFullYear() : asOf.getFullYear() - 1;
}

/** Formats the Indian financial year containing `asOf` (e.g. "FY 2026-27") given the company's FY start month (1-12, typically April = 4). */
export function getFinancialYearLabel(asOf: Date, financialYearStartMonth: number): string {
  return financialYearLabelForStartYear(financialYearStartYear(asOf, financialYearStartMonth));
}

/** "FY 2025-26" from the start year alone. */
export function financialYearLabelForStartYear(startYear: number): string {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * One financial year, identified by the calendar year it opens in.
 *
 * `startYear` is the identity that gets persisted and passed around: it is a
 * single stable integer, unlike the label (presentation) or the boundary dates
 * (derived, and different for a company whose year starts in July).
 */
export interface FinancialYear {
  startYear: number;
  /** "FY 2025-26". */
  label: string;
  /** First day, `YYYY-MM-DD`. */
  start: string;
  /** Last day, `YYYY-MM-DD` — 31 March for an April year, 30 June for a July one. */
  end: string;
}

/**
 * The financial year opening in `startYear`.
 *
 * The end date is the day before the *next* year opens rather than a hardcoded
 * "31 March" or a month-length table, so February and leap years fall out for
 * free and a December start year correctly ends on 30 November.
 */
export function financialYearFromStartYear(startYear: number, financialYearStartMonth: number): FinancialYear {
  const nextStart = new Date(startYear + 1, financialYearStartMonth - 1, 1);
  const lastDay = new Date(nextStart);
  lastDay.setDate(lastDay.getDate() - 1);
  return {
    startYear,
    label: financialYearLabelForStartYear(startYear),
    start: `${startYear}-${String(financialYearStartMonth).padStart(2, "0")}-01`,
    end: isoLocalDate(lastDay),
  };
}

/** The financial year `asOf` falls in. */
export function financialYearContaining(asOf: Date, financialYearStartMonth: number): FinancialYear {
  return financialYearFromStartYear(financialYearStartYear(asOf, financialYearStartMonth), financialYearStartMonth);
}

/**
 * The financial years a company can be looked at in — newest first.
 *
 * Bounded below by `book_beginning_date`: there are no books before the books
 * began, and offering FY 2019-20 to a company that opened in 2024 would only
 * ever produce empty reports. Bounded above by the year containing `today`,
 * because a report about a year that has not started yet is not useful either.
 *
 * The one exception is a company whose books begin in the future — a set of
 * books opened in advance. The range then runs the other way round so that
 * both today's year and the book's own year are offered, and the caller never
 * has to cope with a list that cannot contain the current year.
 */
export function listFinancialYears(
  bookBeginningDate: string,
  financialYearStartMonth: number,
  today: Date
): FinancialYear[] {
  const first = financialYearStartYear(parseIsoLocalDate(bookBeginningDate), financialYearStartMonth);
  const current = financialYearStartYear(today, financialYearStartMonth);
  const from = Math.min(first, current);
  const to = Math.max(first, current);

  const years: FinancialYear[] = [];
  for (let startYear = to; startYear >= from; startYear--) {
    years.push(financialYearFromStartYear(startYear, financialYearStartMonth));
  }
  return years;
}

/**
 * What the whole-period button and the shell call the one period of a company
 * that keeps no financial years.
 *
 * Not a year label, and deliberately carries no digits: "FY 2026-27" printed
 * over a book with no years is the exact confusion this setting exists to
 * remove.
 */
export const CONTINUOUS_PERIOD_LABEL = "All time";

/**
 * The single period a continuous set of books is looked at through.
 *
 * A company with `uses_financial_years = false` keeps one unbroken book, so
 * there is nothing to choose between and no closing date: the screens are
 * drawn from the day the books began up to today, permanently. Returning a
 * `FinancialYear` rather than a shape of its own is what keeps the dashboard,
 * the report presets and the as-of date exactly as they are — each of them
 * already reads `start`, `end` and "does this contain today", and each already
 * has the right answer for those three once this is what it is handed.
 *
 * `start` and `end` are ordered rather than assumed, for the case
 * listFinancialYears also has to cope with: books opened in advance. A period
 * running from a future start back to today would return no rows from any
 * report and would report itself as a closed period, which a book that is
 * never closed cannot be.
 *
 * `startYear` is the calendar year the books opened in and never moves. It is
 * the identity `useReportDateRange` tags a hand-typed range with, and a value
 * that drifted with the calendar would throw that range away once a year for
 * no reason the user could see.
 */
export function continuousBooksPeriod(bookBeginningDate: string, today: Date): FinancialYear {
  const todayIso = isoLocalDate(today);
  const [start, end] =
    bookBeginningDate <= todayIso ? [bookBeginningDate, todayIso] : [todayIso, bookBeginningDate];

  return {
    startYear: Number(bookBeginningDate.slice(0, 4)),
    label: CONTINUOUS_PERIOD_LABEL,
    start,
    end,
  };
}

/**
 * The periods a company's books can be looked at in: its financial years, or
 * the one continuous period if it keeps none.
 *
 * The single place that switch is made on the client. Everything downstream —
 * which period is selected, whether the selector renders at all, what the
 * report range opens on — falls out of the list this returns.
 */
export function listBooksPeriods(
  usesFinancialYears: boolean,
  bookBeginningDate: string,
  financialYearStartMonth: number,
  today: Date
): FinancialYear[] {
  return usesFinancialYears
    ? listFinancialYears(bookBeginningDate, financialYearStartMonth, today)
    : [continuousBooksPeriod(bookBeginningDate, today)];
}

/**
 * Whether a financial year may be named on the screen for this company yet.
 *
 * `useFinancialYear` defaults `usesFinancialYears` to true while the
 * companies query is still in flight, and that default is right: it is what
 * every company created before this setting existed is, so the shell settles
 * onto the behaviour it has always had rather than onto the rarer one.
 *
 * But a default is an assumption, and reading it as an answer put "FY
 * 2026-27" over a book that keeps no years for one paint — the exact
 * confusion the setting exists to remove. The fix belongs here rather than in
 * the default: the gate is *knowing*, and a year is named once the company
 * has answered and not before.
 */
export function showsFinancialYear(companySettingsKnown: boolean, usesFinancialYears: boolean): boolean {
  return companySettingsKnown && usesFinancialYears;
}

/**
 * Whether a hand-typed report range still belongs to the period on screen.
 *
 * A range typed while looking at FY 2025-26 must not survive a switch to FY
 * 2026-27, or the year selector would appear to do nothing — which is what
 * tagging the range with `startYear` is for.
 *
 * The same loading window that put a year on the screen too early also gave
 * that range the wrong period to be tagged with. Until the company answers,
 * the selected period is a placeholder — the financial year the calendar is
 * in — and a continuous book's period is the year its books opened in, a
 * different number. So a range typed in that window was thrown away the
 * instant the company loaded, over a period change the user never made.
 *
 * `null` is the tag for "typed before there was a real period to tag it
 * with". Such a range applies to whichever period turns up; the caller
 * re-tags it the moment one does, so it never outlives a period the user did
 * choose.
 */
export function reportRangeStillApplies(overrideStartYear: number | null, selectedStartYear: number): boolean {
  return overrideStartYear === null || overrideStartYear === selectedStartYear;
}

/** True when `today` falls inside `year` — i.e. this is the year the business is actually trading in. */
export function isCurrentFinancialYear(year: FinancialYear, today: Date): boolean {
  const iso = isoLocalDate(today);
  return iso >= year.start && iso <= year.end;
}

/**
 * The date a report should be drawn up to for a selected year.
 *
 * Today for the year in progress — a balance "as of 31 March 2027" for a year
 * that is only half over is a projection, and nothing in the books supports
 * it. The closing date for any year already finished, which is the figure
 * anyone reopening a closed year is after.
 */
export function financialYearAsOfDate(year: FinancialYear, today: Date): string {
  return isCurrentFinancialYear(year, today) ? isoLocalDate(today) : year.end;
}

/**
 * Turns a remembered `startYear` into one of the years actually on offer.
 *
 * A stored choice can go stale — the books' beginning date was corrected, the
 * FY start month was changed, or the calendar simply rolled over past the year
 * that was stored. In every one of those cases the honest fallback is the year
 * the business is trading in now, not an empty report for a year that is no
 * longer offered.
 */
export function resolveFinancialYear(
  years: FinancialYear[],
  startYear: number | undefined,
  today: Date
): FinancialYear {
  if (startYear !== undefined) {
    const match = years.find((y) => y.startYear === startYear);
    if (match) return match;
  }
  return years.find((y) => isCurrentFinancialYear(y, today)) ?? years[0];
}

/** First day of the month `iso` falls in, as `YYYY-MM-DD`. */
export function isoMonthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * First day of the financial year containing `asOf`, as `YYYY-MM-DD`.
 *
 * Same year-rollover rule as getFinancialYearLabel — a company whose year
 * starts in July is in FY 2026 from 1 July 2026, and still in FY 2025 on
 * 30 June 2026.
 */
export function isoFinancialYearStart(asOf: Date, financialYearStartMonth: number): string {
  const month = asOf.getMonth() + 1;
  const startYear = month >= financialYearStartMonth ? asOf.getFullYear() : asOf.getFullYear() - 1;
  return `${startYear}-${String(financialYearStartMonth).padStart(2, "0")}-01`;
}
