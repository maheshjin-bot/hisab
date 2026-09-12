/**
 * Period wording for a printed statement header.
 *
 * ISO dates are right for inputs and queries but wrong on a document a client
 * reads, so these render "31 March 2026" instead. Parsed as UTC rather than
 * handed to `new Date(iso)` in local time, which shifts the date backwards a
 * day for anyone west of Greenwich.
 */
export function formatIsoDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** For the position statements — Trial Balance, Balance Sheet. */
export function asOfPeriod(iso: string): string {
  return `As of ${formatIsoDate(iso)}`;
}

/** For the flow statements — Daybook, Ledger Statement, Profit & Loss. */
export function rangePeriod(fromIso: string, toIso: string): string {
  return `${formatIsoDate(fromIso)} to ${formatIsoDate(toIso)}`;
}
