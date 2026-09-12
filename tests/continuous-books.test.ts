import { describe, expect, it } from "vitest";
import {
  CONTINUOUS_PERIOD_LABEL,
  continuousBooksPeriod,
  financialYearAsOfDate,
  isCurrentFinancialYear,
  listBooksPeriods,
  listFinancialYears,
  reportRangeStillApplies,
  resolveFinancialYear,
  showsFinancialYear,
} from "@/lib/utils/financial-year";

/** Midday, so a timezone shift of a few hours can't move the calendar day under the test. */
const at = (iso: string) => new Date(`${iso}T12:00:00`);

const APRIL = 4;
const JULY = 7;

/**
 * A company that keeps no financial years is looked at through one period
 * instead of a list of years. Everything the shell, the dashboard and the
 * report filters do with the selected year is a function of these three
 * values — `start`, `end` and whether the period contains today — so the
 * behaviour they were asked for is asserted here rather than through a DOM.
 */
describe("the one period a continuous set of books is looked at through", () => {
  it("runs from the day the books began to today", () => {
    expect(continuousBooksPeriod("2023-11-04", at("2026-09-07"))).toEqual({
      startYear: 2023,
      label: CONTINUOUS_PERIOD_LABEL,
      start: "2023-11-04",
      end: "2026-09-07",
    });
  });

  it("is always the period in progress, so nothing is ever labelled a closed year", () => {
    // This is what the dashboard reads to decide between "Cash-in-Hand" and
    // "Closing Cash-in-Hand", and what the report presets read to decide
    // between "This month" and a closing month. A book that is never closed
    // has no closing month and no closing balance.
    const period = continuousBooksPeriod("2023-11-04", at("2026-09-07"));
    expect(isCurrentFinancialYear(period, at("2026-09-07"))).toBe(true);
  });

  it("draws reports up to today rather than to a 31 March that means nothing here", () => {
    const today = at("2026-09-07");
    const period = continuousBooksPeriod("2023-11-04", today);

    expect(financialYearAsOfDate(period, today)).toBe("2026-09-07");
    // The whole-period preset and the default report range, which are
    // `{ from: period.start, to: financialYearAsOfDate(period, today) }`.
    expect({ from: period.start, to: financialYearAsOfDate(period, today) }).toEqual({
      from: "2023-11-04",
      to: "2026-09-07",
    });
  });

  it("names the period for what it is, not for a year", () => {
    // The label is the text on the whole-period button in the report filter.
    // "FY 2026-27" over a book with no years is the exact confusion this
    // whole setting exists to remove.
    expect(continuousBooksPeriod("2023-11-04", at("2026-09-07")).label).toBe("All time");
    expect(CONTINUOUS_PERIOD_LABEL).not.toMatch(/\d/);
  });

  it("does not invert when the books are opened in advance", () => {
    // listFinancialYears has the same case and runs its range backwards for
    // it. A period from a future start to a past today would be a range no
    // report could return a row for, and would report itself as closed.
    const today = at("2026-09-07");
    const period = continuousBooksPeriod("2027-04-01", today);

    expect(period.start <= period.end).toBe(true);
    expect(isCurrentFinancialYear(period, today)).toBe(true);
    expect(period).toMatchObject({ start: "2026-09-07", end: "2027-04-01" });
  });

  it("keeps one identity for the life of the books", () => {
    // useReportDateRange tags a hand-typed range with the selected period's
    // startYear and drops it when a different year is chosen. There is no
    // other period to choose here, so the identity must not drift with the
    // calendar or a narrowed range would be thrown away on its own.
    expect(continuousBooksPeriod("2023-11-04", at("2026-09-07")).startYear).toBe(2023);
    expect(continuousBooksPeriod("2023-11-04", at("2031-01-31")).startYear).toBe(2023);
  });
});

describe("what the shell offers to choose between", () => {
  it("offers exactly one period, so there is nothing to select", () => {
    // FinancialYearSelect renders nothing at all for such a company; this is
    // the fact that makes that right rather than merely tidy.
    const periods = listBooksPeriods(false, "2024-04-01", APRIL, at("2026-09-07"));
    expect(periods).toHaveLength(1);
    expect(periods[0].label).toBe("All time");
  });

  it("still offers every financial year to a company that keeps them", () => {
    // The switch must be inert for every company that exists today, on any
    // start month — the July case is the one April hides.
    const today = at("2026-09-07");
    for (const month of [APRIL, JULY]) {
      expect(listBooksPeriods(true, "2024-04-01", month, today)).toEqual(
        listFinancialYears("2024-04-01", month, today)
      );
    }
  });

  it("resolves to that one period whatever year was remembered", () => {
    // The selected year is persisted per company, and a company can be
    // switched from a year-keeping neighbour with 2025 in the store. There is
    // no FY 2025-26 to fall back to here, and an undefined selection would
    // crash the shell.
    const periods = listBooksPeriods(false, "2024-04-01", APRIL, at("2026-09-07"));
    expect(resolveFinancialYear(periods, 2025, at("2026-09-07"))).toBe(periods[0]);
    expect(resolveFinancialYear(periods, undefined, at("2026-09-07"))).toBe(periods[0]);
  });
});

describe("what the shell may put on the screen before the company has answered", () => {
  it("names no year at all until the company's own setting is known", () => {
    // useFinancialYear defaults usesFinancialYears to true while the
    // companies query is still in flight, and that default is right: it is
    // what every company created before this setting existed is, so the shell
    // settles onto the behaviour it has always had rather than the rarer one.
    //
    // But a default is an assumption, and for one paint it would put
    // "FY 2026-27" over a book that keeps no years — the exact confusion this
    // whole setting exists to remove. So the gate is knowing, not the
    // default.
    expect(showsFinancialYear(false, true)).toBe(false);
  });

  it("names one as soon as a year-keeping company has answered", () => {
    // The fix must not cost the selector to the companies it is for.
    expect(showsFinancialYear(true, true)).toBe(true);
  });

  it("never names one for a continuous book, before the answer or after it", () => {
    expect(showsFinancialYear(false, false)).toBe(false);
    expect(showsFinancialYear(true, false)).toBe(false);
  });
});

describe("a report range typed while the company was still loading", () => {
  it("survives the moment the company answers and the period changes under it", () => {
    // The same window. Until the company answers, the selected period is a
    // placeholder — the financial year the calendar is in — and a continuous
    // book's period is the year its books opened in, which is a different
    // number. A range tagged with the placeholder was thrown away the instant
    // the real period arrived, which is not a period the user chose.
    //
    // null is the tag for "typed before there was a real period to tag it
    // with", and it applies to whichever period turns up.
    expect(reportRangeStillApplies(null, 2026)).toBe(true);
    expect(reportRangeStillApplies(null, 2023)).toBe(true);
  });

  it("is still discarded when the user chooses a different year", () => {
    // The rule this must not break: a range typed while looking at FY 2025-26
    // does not survive a switch to FY 2026-27, or the year selector would
    // appear to do nothing.
    expect(reportRangeStillApplies(2025, 2026)).toBe(false);
    expect(reportRangeStillApplies(2025, 2025)).toBe(true);
  });
});
