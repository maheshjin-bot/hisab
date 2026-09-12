import { describe, expect, it } from "vitest";
import { matchesDaybookSearch } from "@/lib/reports/daybook-filter";
import type { DaybookRow } from "@/lib/supabase/queries/reports";

function row(overrides: Partial<DaybookRow> = {}): DaybookRow {
  return {
    voucherId: "v1",
    voucherDate: "2026-04-05",
    voucherType: "receipt",
    voucherNumber: "REC/00042",
    narration: "advance from Mahesh Bhai",
    totalAmount: 5000,
    drLedgers: "Cash",
    crLedgers: "Mahesh Bhai - Sundry Debtors",
    ...overrides,
  };
}

describe("matchesDaybookSearch", () => {
  it("matches an empty query against everything", () => {
    expect(matchesDaybookSearch(row(), "")).toBe(true);
    expect(matchesDaybookSearch(row(), "   ")).toBe(true);
  });

  it("matches the voucher number", () => {
    expect(matchesDaybookSearch(row(), "rec/00042")).toBe(true);
    expect(matchesDaybookSearch(row(), "00099")).toBe(false);
  });

  it("matches narration, case-insensitively", () => {
    expect(matchesDaybookSearch(row(), "MAHESH")).toBe(true);
  });

  it("matches either ledger list", () => {
    expect(matchesDaybookSearch(row(), "cash")).toBe(true);
    expect(matchesDaybookSearch(row(), "sundry debtors")).toBe(true);
  });

  it("matches the plain-English type label, not the database word", () => {
    // 'receipt' is what's stored; "Money In" is what the column shows.
    expect(matchesDaybookSearch(row({ voucherType: "receipt" }), "money in")).toBe(true);
    expect(matchesDaybookSearch(row({ voucherType: "payment" }), "money out")).toBe(true);
  });

  it("matches the date", () => {
    expect(matchesDaybookSearch(row(), "2026-04-05")).toBe(true);
  });

  it("treats a null narration or ledger list as no match, not a crash", () => {
    expect(matchesDaybookSearch(row({ narration: null, drLedgers: null }), "advance")).toBe(false);
    expect(matchesDaybookSearch(row({ narration: null, drLedgers: null }), "cash")).toBe(false);
  });

  it("refuses text that appears nowhere in the row", () => {
    expect(matchesDaybookSearch(row(), "nonexistent")).toBe(false);
  });

  it("matches the amount, formatted or as plain digits", () => {
    expect(matchesDaybookSearch(row({ totalAmount: 200000 }), "2,00,000")).toBe(true);
    expect(matchesDaybookSearch(row({ totalAmount: 200000 }), "200000")).toBe(true);
    // A partial figure is still a substring match, same as every other column.
    expect(matchesDaybookSearch(row({ totalAmount: 585724 }), "85724")).toBe(true);
  });

  it("does not match an amount the voucher doesn't actually have", () => {
    // The reported case: a ₹5,85,724 voucher whose narration happens to
    // mention 2000000 elsewhere should not be confused with a search for
    // the amount column matching that figure.
    expect(matchesDaybookSearch(row({ totalAmount: 585724, narration: "x" }), "2000000")).toBe(false);
  });

  it("treats a zero amount as nothing to match, not a formatted ₹0.00", () => {
    const zeroRow = row({
      totalAmount: 0,
      voucherNumber: "abc",
      voucherDate: "not-a-real-date",
      narration: "x",
      drLedgers: "y",
      crLedgers: "z",
    });
    expect(matchesDaybookSearch(zeroRow, "0.00")).toBe(false);
  });
});
