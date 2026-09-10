/**
 * The Ledger Statement page's one URL param — `?ledgerId=`, so a link from
 * another report can open the statement pre-populated, and so browser
 * back/forward move between ledgers the way any other filter does.
 *
 * Pulled out as a pure string builder, separate from useSearchParams/
 * useRouter, so the query-string arithmetic can be checked without a router
 * in the loop.
 */
export function withLedgerIdParam(currentSearch: string, ledgerId: string): string {
  const next = new URLSearchParams(currentSearch);
  next.set("ledgerId", ledgerId);
  return next.toString();
}

/** Reads the param back out; "" and a missing param are both "nothing selected". */
export function readLedgerIdParam(searchParams: URLSearchParams): string | undefined {
  const value = searchParams.get("ledgerId");
  return value ? value : undefined;
}
