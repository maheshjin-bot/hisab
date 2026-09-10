import { describe, expect, it } from "vitest";
import { readLedgerIdParam, withLedgerIdParam } from "@/lib/reports/ledger-statement-url";

describe("withLedgerIdParam", () => {
  it("adds the param to an empty query string", () => {
    expect(withLedgerIdParam("", "ledger-1")).toBe("ledgerId=ledger-1");
  });

  it("replaces an existing ledgerId rather than appending a second one", () => {
    expect(withLedgerIdParam("ledgerId=old", "new")).toBe("ledgerId=new");
  });

  it("keeps any other params already on the URL untouched", () => {
    const result = withLedgerIdParam("foo=bar", "ledger-1");
    const params = new URLSearchParams(result);
    expect(params.get("foo")).toBe("bar");
    expect(params.get("ledgerId")).toBe("ledger-1");
  });
});

describe("readLedgerIdParam", () => {
  it("reads the id back out", () => {
    expect(readLedgerIdParam(new URLSearchParams("ledgerId=ledger-1"))).toBe("ledger-1");
  });

  it("treats a missing param as nothing selected", () => {
    expect(readLedgerIdParam(new URLSearchParams(""))).toBeUndefined();
  });

  it("treats a blank param the same as a missing one", () => {
    // Reachable if a caller ever builds `?ledgerId=` with no value — the page
    // should fall back to its unselected state rather than trying to fetch
    // ledger "".
    expect(readLedgerIdParam(new URLSearchParams("ledgerId="))).toBeUndefined();
  });
});
