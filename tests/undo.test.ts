import { describe, expect, it } from "vitest";
import {
  describePreviewRow,
  sinceFromDate,
  sinceFromHours,
  totalPreviewEntries,
  UNDO_PRESETS,
  type RevertPreviewRow,
} from "@/lib/supabase/queries/undo";

const row = (
  tableName: string,
  action: RevertPreviewRow["action"],
  entries: number
): RevertPreviewRow => ({
  tableName,
  action,
  entries,
  earliest: "2026-08-14T10:00:00Z",
  latest: "2026-08-17T10:00:00Z",
});

describe("undo windows", () => {
  it("offers the presets the feature was asked for, including last 3 days", () => {
    const ids = UNDO_PRESETS.map((p) => p.id);
    expect(ids).toContain("3d");
    expect(UNDO_PRESETS.find((p) => p.id === "3d")?.hours).toBe(72);
    expect(UNDO_PRESETS.find((p) => p.id === "24h")?.hours).toBe(24);
    expect(UNDO_PRESETS.find((p) => p.id === "7d")?.hours).toBe(168);
  });

  it("counts back from now, in whole hours", () => {
    const now = new Date("2026-08-17T12:00:00Z");
    expect(sinceFromHours(72, now).toISOString()).toBe("2026-08-14T12:00:00.000Z");
    expect(sinceFromHours(1, now).toISOString()).toBe("2026-08-17T11:00:00.000Z");
  });

  it("takes a chosen date from its local midnight, not UTC midnight", () => {
    // Parsed as local so "since 14 August" means the start of the user's 14th,
    // not an instant that may fall on the 13th for them.
    const since = sinceFromDate("2026-08-14");
    expect(since.getFullYear()).toBe(2026);
    expect(since.getMonth()).toBe(7); // August
    expect(since.getDate()).toBe(14);
    expect(since.getHours()).toBe(0);
    expect(since.getMinutes()).toBe(0);
  });
});

describe("describing what will be undone", () => {
  it("reads as a sentence rather than a table name", () => {
    expect(describePreviewRow(row("vouchers", "INSERT", 3))).toBe("3 vouchers created");
    expect(describePreviewRow(row("ledgers", "UPDATE", 1))).toBe("1 ledgers edited");
    expect(describePreviewRow(row("voucher_entries", "DELETE", 6))).toBe("6 voucher lines deleted");
    expect(describePreviewRow(row("account_groups", "UPDATE", 2))).toBe("2 account groups edited");
  });

  it("falls back to the raw name for a table it doesn't know", () => {
    expect(describePreviewRow(row("something_new", "INSERT", 1))).toBe("1 something_new created");
  });

  it("totals across every row", () => {
    expect(
      totalPreviewEntries([
        row("vouchers", "INSERT", 3),
        row("voucher_entries", "INSERT", 6),
        row("ledgers", "UPDATE", 1),
      ])
    ).toBe(10);
    expect(totalPreviewEntries([])).toBe(0);
  });
});
