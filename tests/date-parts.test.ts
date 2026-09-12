import { describe, expect, it } from "vitest";
import { daysInMonth, formatDateParts, parseDateParts, yearOptions } from "@/lib/utils/date-parts";

describe("parseDateParts", () => {
  it("splits an ISO date into year, month and day", () => {
    expect(parseDateParts("2026-04-05")).toEqual({ year: 2026, month: 4, day: 5 });
  });
});

describe("daysInMonth", () => {
  it("knows a 31-day month", () => {
    expect(daysInMonth(2026, 1)).toBe(31);
  });

  it("knows a 30-day month", () => {
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it("gives February 28 days in a common year", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it("gives February 29 days in a leap year", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
  });
});

describe("formatDateParts", () => {
  it("pads month and day to two digits", () => {
    expect(formatDateParts(2026, 4, 5)).toBe("2026-04-05");
  });

  it("clamps a day that doesn't exist in the given month instead of rolling over", () => {
    // The 31st, but April only has 30 — must land on April 30, not May 1.
    expect(formatDateParts(2026, 4, 31)).toBe("2026-04-30");
  });

  it("clamps February 30 down to 28 in a common year", () => {
    expect(formatDateParts(2026, 2, 30)).toBe("2026-02-28");
  });
});

describe("yearOptions", () => {
  it("spans the requested years before and after the center year, oldest first", () => {
    expect(yearOptions(2025, 2, 1)).toEqual([2023, 2024, 2025, 2026]);
  });

  it("defaults to 12 years back and 1 year ahead", () => {
    const years = yearOptions(2025);
    expect(years[0]).toBe(2013);
    expect(years[years.length - 1]).toBe(2026);
    expect(years).toHaveLength(14);
  });
});
