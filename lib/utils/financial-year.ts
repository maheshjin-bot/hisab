/** Formats the Indian financial year containing `asOf` (e.g. "FY 2026-27") given the company's FY start month (1-12, typically April = 4). */
export function getFinancialYearLabel(asOf: Date, financialYearStartMonth: number): string {
  const year = asOf.getFullYear();
  const month = asOf.getMonth() + 1;
  const startYear = month >= financialYearStartMonth ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, "0");
  return `FY ${startYear}-${endYearShort}`;
}
