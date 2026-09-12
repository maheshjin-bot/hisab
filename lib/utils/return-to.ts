/**
 * Carries "come back here" through a link to a voucher's edit page, so
 * following a voucher number off a report (or anywhere else that isn't the
 * ordinary Vouchers register) and clicking Cancel or Save lands back on
 * that report — with whatever ledger, date range, search and sort it had —
 * instead of the register, which is only the *default* return address.
 */
export function withReturnTo(href: string, currentPathAndQuery: string): string {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}returnTo=${encodeURIComponent(currentPathAndQuery)}`;
}

/**
 * Reads a `returnTo` back out, refusing anything that isn't a plain
 * same-site path. A query string is attacker-controlled input the instant
 * it's attacker-supplied — `returnTo=https://evil.example` or the
 * protocol-relative `returnTo=//evil.example` would otherwise hand an open
 * redirect to whoever crafts the link, since both are valid arguments to
 * router.push() and neither looks like a path at a glance. `fallback` is
 * used for a missing or rejected value alike.
 */
export function readReturnTo(searchParams: URLSearchParams, fallback: string): string {
  const raw = searchParams.get("returnTo");
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return fallback;
}
