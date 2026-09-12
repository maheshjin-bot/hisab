import { describe, expect, it } from "vitest";
import {
  financialYearAsOfDate,
  financialYearContaining,
  financialYearFromStartYear,
  financialYearLabelForStartYear,
  financialYearStartYear,
  isCurrentFinancialYear,
  isoMonthStart,
  listFinancialYears,
  parseIsoLocalDate,
  resolveFinancialYear,
} from "@/lib/utils/financial-year";

/** Midday, so a timezone shift of a few hours can't move the calendar day under the test. */
const at = (iso: string) => new Date(`${iso}T12:00:00`);

const APRIL = 4;
const JULY = 7;

describe("financial year boundaries by start year", () => {
  it("closes an April year on 31 March", () => {
    expect(financialYearFromStartYear(2025, APRIL)).toEqual({
      startYear: 2025,
      label: "FY 2025-26",
      start: "2025-04-01",
      end: "2026-03-31",
    });
  });

  it("closes a July year on 30 June — the case April hides", () => {
    // The demo seed uses July deliberately. A year that ends on the 30th of a
    // 30-day month is what catches an off-by-one in a hardcoded "31st".
    expect(financialYearFromStartYear(2025, JULY)).toEqual({
      startYear: 2025,
      label: "FY 2025-26",
      start: "2025-07-01",
      end: "2026-06-30",
    });
  });

  it("handles a February year across a leap year, and one that isn't", () => {
    // Derived from the day before the next year opens, so February's length
    // is never assumed.
    expect(financialYearFromStartYear(2023, 2).end).toBe("2024-01-31");
    expect(financialYearFromStartYear(2024, 3).end).toBe("2025-02-28");
    expect(financialYearFromStartYear(2023, 3).end).toBe("2024-02-29");
  });

  it("handles January and December, the extremes of the start month", () => {
    expect(financialYearFromStartYear(2026, 1)).toMatchObject({ start: "2026-01-01", end: "2026-12-31" });
    expect(financialYearFromStartYear(2026, 12)).toMatchObject({ start: "2026-12-01", end: "2027-11-30" });
  });

  it("names the year after the calendar year it opens in", () => {
    expect(financialYearLabelForStartYear(2025)).toBe("FY 2025-26");
    expect(financialYearLabelForStartYear(2099)).toBe("FY 2099-00");
  });

  it("agrees with financialYearStartYear on both sides of the turnover", () => {
    expect(financialYearStartYear(at("2026-03-31"), APRIL)).toBe(2025);
    expect(financialYearStartYear(at("2026-04-01"), APRIL)).toBe(2026);
    expect(financialYearStartYear(at("2026-06-30"), JULY)).toBe(2025);
    expect(financialYearStartYear(at("2026-07-01"), JULY)).toBe(2026);
  });
});

describe("which years are offered", () => {
  it("runs from the year the books began through the year in progress, newest first", () => {
    // Today is 3 September 2026, the date the selector was built for.
    const years = listFinancialYears("2024-04-01", APRIL, at("2026-09-03"));
    expect(years.map((y) => y.label)).toEqual(["FY 2026-27", "FY 2025-26", "FY 2024-25"]);
  });

  it("never offers a year before the books existed", () => {
    const years = listFinancialYears("2025-04-01", APRIL, at("2026-09-03"));
    expect(years.map((y) => y.startYear)).toEqual([2026, 2025]);
    expect(years.some((y) => y.startYear < 2025)).toBe(false);
  });

  it("puts a book beginning inside a year in that whole year, not from that day", () => {
    // Books opened mid-year on 15 August 2025 still belong to FY 2025-26,
    // whose reports must start on 1 April 2025 — the opening balances are
    // dated before the first voucher.
    const years = listFinancialYears("2025-08-15", APRIL, at("2026-09-03"));
    expect(years.map((y) => y.startYear)).toEqual([2026, 2025]);
    expect(years[1].start).toBe("2025-04-01");
  });

  it("counts a July company's years off July, not April", () => {
    // 3 September 2026 is FY 2026-27 for both, but 3 May 2026 is not: an
    // April company has turned over, a July one has not.
    expect(listFinancialYears("2024-07-01", JULY, at("2026-05-03")).map((y) => y.label)).toEqual([
      "FY 2025-26",
      "FY 2024-25",
    ]);
    expect(listFinancialYears("2024-04-01", APRIL, at("2026-05-03")).map((y) => y.label)).toEqual([
      "FY 2026-27",
      "FY 2025-26",
      "FY 2024-25",
    ]);
  });

  it("offers exactly one year for books opened in the year in progress", () => {
    expect(listFinancialYears("2026-04-10", APRIL, at("2026-09-03")).map((y) => y.label)).toEqual(["FY 2026-27"]);
  });

  it("still includes the current year when the books begin in the future", () => {
    // A set of books opened in advance. The list must never be missing the
    // year we are actually in, or the default selection has nothing to land on.
    const years = listFinancialYears("2028-04-01", APRIL, at("2026-09-03"));
    expect(years.map((y) => y.startYear)).toEqual([2028, 2027, 2026]);
  });
});

describe("what as-of date a selection produces", () => {
  const today = at("2026-09-03");

  it("uses today for the year in progress, never its far-off closing date", () => {
    const current = financialYearContaining(today, APRIL); // FY 2026-27
    expect(current.end).toBe("2027-03-31");
    // 31 March 2027 has not happened; a balance sheet dated then would be a
    // forecast, not a report.
    expect(financialYearAsOfDate(current, today)).toBe("2026-09-03");
    expect(isCurrentFinancialYear(current, today)).toBe(true);
  });

  it("uses the closing date for a year already finished", () => {
    const closed = financialYearFromStartYear(2025, APRIL);
    expect(financialYearAsOfDate(closed, today)).toBe("2026-03-31");
    expect(isCurrentFinancialYear(closed, today)).toBe(false);
  });

  it("does the same for a July year, whose closing date is 30 June", () => {
    const current = financialYearContaining(today, JULY); // FY 2026-27, opened 1 July 2026
    expect(current.start).toBe("2026-07-01");
    expect(financialYearAsOfDate(current, today)).toBe("2026-09-03");

    const closed = financialYearFromStartYear(2025, JULY);
    expect(financialYearAsOfDate(closed, today)).toBe("2026-06-30");
  });

  it("treats the first and last day of a year as inside it", () => {
    const year = financialYearFromStartYear(2025, APRIL);
    expect(financialYearAsOfDate(year, at("2025-04-01"))).toBe("2025-04-01");
    expect(financialYearAsOfDate(year, at("2026-03-31"))).toBe("2026-03-31");
    // One day later it is closed, and pins to its end.
    expect(financialYearAsOfDate(year, at("2026-04-01"))).toBe("2026-03-31");
  });

  it("gives the month the tiles cover", () => {
    expect(isoMonthStart("2026-03-31")).toBe("2026-03-01");
    expect(isoMonthStart("2026-09-03")).toBe("2026-09-01");
  });
});

describe("resolving a remembered choice", () => {
  const today = at("2026-09-03");
  const years = listFinancialYears("2024-04-01", APRIL, today);

  it("returns the remembered year when it is still offered", () => {
    expect(resolveFinancialYear(years, 2025, today).label).toBe("FY 2025-26");
  });

  it("falls back to the year in progress when nothing is remembered", () => {
    expect(resolveFinancialYear(years, undefined, today).label).toBe("FY 2026-27");
  });

  it("falls back when the remembered year is no longer on offer", () => {
    // Books re-dated, FY start month changed, or simply a year that predates
    // the books — none of which should strand the user on an empty report.
    expect(resolveFinancialYear(years, 2019, today).label).toBe("FY 2026-27");
    expect(resolveFinancialYear(years, 2030, today).label).toBe("FY 2026-27");
  });

  it("falls back to the newest year when no year contains today", () => {
    // The future-books case: nothing in the list is current.
    const future = listFinancialYears("2028-04-01", APRIL, at("2026-09-03"));
    const noCurrent = future.filter((y) => y.startYear > 2026);
    expect(resolveFinancialYear(noCurrent, undefined, today).startYear).toBe(2028);
  });
});

describe("parsing an ISO date back to a local day", () => {
  it("does not shift the day, in either direction", () => {
    const d = parseIsoLocalDate("2026-04-01");
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 4, 1]);
    // `new Date("2026-04-01")` is UTC midnight and reads as 31 March west of
    // Greenwich; this must not.
    expect(financialYearStartYear(parseIsoLocalDate("2026-04-01"), APRIL)).toBe(2026);
  });
});
