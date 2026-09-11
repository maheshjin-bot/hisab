import { describe, expect, it } from "vitest";
import { nextDaybookSort, sortDaybookRows, type DaybookSort } from "@/lib/reports/daybook-sort";
import type { DaybookRow } from "@/lib/supabase/queries/reports";

function row(overrides: Partial<DaybookRow>): DaybookRow {
  return {
    voucherId: "v",
    voucherDate: "2026-04-01",
    voucherType: "receipt",
    voucherNumber: "REC/00001",
    narration: null,
    totalAmount: 0,
    drLedgers: null,
    crLedgers: null,
    ...overrides,
  };
}

describe("nextDaybookSort", () => {
  it("starts ascending on a column with no sort yet", () => {
    expect(nextDaybookSort(null, "totalAmount")).toEqual({ column: "totalAmount", direction: "asc" });
  });

  it("flips ascending to descending on the same column", () => {
    const asc: DaybookSort = { column: "totalAmount", direction: "asc" };
    expect(nextDaybookSort(asc, "totalAmount")).toEqual({ column: "totalAmount", direction: "desc" });
  });

  it("clears back to the report's own order on a third click", () => {
    const desc: DaybookSort = { column: "totalAmount", direction: "desc" };
    expect(nextDaybookSort(desc, "totalAmount")).toBeNull();
  });

  it("switching to a different column restarts at ascending, not wherever the old column was", () => {
    const desc: DaybookSort = { column: "totalAmount", direction: "desc" };
    expect(nextDaybookSort(desc, "voucherDate")).toEqual({ column: "voucherDate", direction: "asc" });
  });
});

describe("sortDaybookRows", () => {
  it("returns the rows unchanged, in the same array identity's order, when there is no sort", () => {
    const rows = [row({ totalAmount: 300 }), row({ totalAmount: 100 })];
    expect(sortDaybookRows(rows, null)).toEqual(rows);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ totalAmount: 300 }), row({ totalAmount: 100 })];
    const original = [...rows];
    sortDaybookRows(rows, { column: "totalAmount", direction: "asc" });
    expect(rows).toEqual(original);
  });

  it("sorts a numeric column ascending and descending", () => {
    const rows = [row({ totalAmount: 300 }), row({ totalAmount: 100 }), row({ totalAmount: 200 })];
    expect(sortDaybookRows(rows, { column: "totalAmount", direction: "asc" }).map((r) => r.totalAmount)).toEqual([
      100, 200, 300,
    ]);
    expect(sortDaybookRows(rows, { column: "totalAmount", direction: "desc" }).map((r) => r.totalAmount)).toEqual([
      300, 200, 100,
    ]);
  });

  it("sorts a text column alphabetically", () => {
    const rows = [row({ voucherNumber: "REC/00003" }), row({ voucherNumber: "REC/00001" })];
    expect(sortDaybookRows(rows, { column: "voucherNumber", direction: "asc" }).map((r) => r.voucherNumber)).toEqual([
      "REC/00001",
      "REC/00003",
    ]);
  });

  it("sorts Type by the label shown on screen, not the database word", () => {
    // 'payment' -> "Money Out" sorts before 'receipt' -> "Money In" by raw
    // word (payment < receipt), but the other way round by label (Money In
    // < Money Out) — proving the sort key really is the displayed label.
    const rows = [row({ voucherType: "payment" }), row({ voucherType: "receipt" })];
    expect(sortDaybookRows(rows, { column: "voucherType", direction: "asc" }).map((r) => r.voucherType)).toEqual([
      "receipt",
      "payment",
    ]);
  });

  it("treats a null text field as sorting first, not crashing", () => {
    const rows = [row({ narration: "z-narration" }), row({ narration: null })];
    expect(sortDaybookRows(rows, { column: "narration", direction: "asc" }).map((r) => r.narration)).toEqual([
      null,
      "z-narration",
    ]);
  });
});
