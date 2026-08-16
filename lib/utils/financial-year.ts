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

/** Formats the Indian financial year containing `asOf` (e.g. "FY 2026-27") given the company's FY start month (1-12, typically April = 4). */
export function getFinancialYearLabel(asOf: Date, financialYearStartMonth: number): string {
  const year = asOf.getFullYear();
  const month = asOf.getMonth() + 1;
  const startYear = month >= financialYearStartMonth ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, "0");
  return `FY ${startYear}-${endYearShort}`;
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
