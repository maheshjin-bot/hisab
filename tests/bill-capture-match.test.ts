import { describe, expect, it } from "vitest";
import { discountPercentToAmount, matchLedgersByName, normalizeNameForMatch, toInvoiceLineInput } from "@/lib/bill-capture/match";

describe("normalizeNameForMatch", () => {
  it("lowercases and strips a common legal suffix", () => {
    expect(normalizeNameForMatch("Sharma Textiles Pvt Ltd")).toBe("sharma textiles");
    expect(normalizeNameForMatch("Sharma Textiles")).toBe("sharma textiles");
  });

  it("collapses punctuation and repeated whitespace, and treats 'Traders'/'& Co.' as the same generic suffix noise", () => {
    expect(normalizeNameForMatch("R.K.  Traders & Co.")).toBe("r k");
  });
});

describe("matchLedgersByName", () => {
  const candidates = [
    { id: "1", name: "Sharma Textiles Pvt Ltd" },
    { id: "2", name: "Ramesh Traders" },
    { id: "3", name: "Aggarwal Ambaji" },
  ];

  it("scores an exact (post-normalization) match highest", () => {
    const matches = matchLedgersByName(candidates, "Sharma Textiles");
    expect(matches[0]).toMatchObject({ id: "1", score: 1 });
  });

  it("returns nothing for an empty or missing name", () => {
    expect(matchLedgersByName(candidates, null)).toEqual([]);
    expect(matchLedgersByName(candidates, "")).toEqual([]);
  });

  it("ranks a plausible substring match above an unrelated one, and excludes zero-overlap candidates", () => {
    const matches = matchLedgersByName(candidates, "Ramesh Traders Surat Branch");
    expect(matches[0].id).toBe("2");
    expect(matches.find((m) => m.id === "3")).toBeUndefined();
  });

  it("is always a suggestion — the caller decides whether score 1 is trusted, this never removes the alternatives", () => {
    const matches = matchLedgersByName(candidates, "Sharma Textiles");
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("discountPercentToAmount", () => {
  it("computes a rupee amount from quantity, rate and a percent", () => {
    expect(discountPercentToAmount(10, 100, 10)).toBe(100);
  });

  it("rounds to the nearest paisa rather than carrying float noise", () => {
    expect(discountPercentToAmount(3, 333.33, 15)).toBe(150);
  });

  it("is zero when any input needed to compute it wasn't read", () => {
    expect(discountPercentToAmount(null, 100, 10)).toBe(0);
    expect(discountPercentToAmount(10, null, 10)).toBe(0);
    expect(discountPercentToAmount(10, 100, null)).toBe(0);
  });

  it("is zero, not a false discount, when the document simply has none", () => {
    expect(discountPercentToAmount(10, 100, 0)).toBe(0);
  });
});

describe("toInvoiceLineInput", () => {
  it("builds exactly the shape createVoucher()'s invoice payload expects", () => {
    const line = { description: "Cotton fabric", unit: "Mtr", quantity: 100, rate: 50, discountPercent: 10, amount: 4500 };
    expect(toInvoiceLineInput(line, "ledger-1", 0)).toEqual({
      description: "Cotton fabric",
      revenueLedgerId: "ledger-1",
      quantity: 100,
      unit: "Mtr",
      rate: 50,
      discountAmount: 500, // 100 * 50 * 10 / 100
      lineOrder: 0,
    });
  });

  it("defaults an unreadable quantity to 1 and an unreadable rate to 0, rather than posting null", () => {
    const line = { description: "Unclear line", unit: null, quantity: null, rate: null, discountPercent: null, amount: null };
    expect(toInvoiceLineInput(line, "ledger-1", 2)).toMatchObject({ quantity: 1, rate: 0, discountAmount: 0, lineOrder: 2 });
  });
});
