import { describe, expect, it } from "vitest";
import {
  getFinancialYearLabel,
  isoFinancialYearStart,
  isoLocalDate,
} from "@/lib/utils/financial-year";
import { asOfPeriod, rangePeriod } from "@/lib/utils/statement-period";
import { safeReturnPath, loginUrlReturningTo } from "@/lib/utils/return-path";

const at = (iso: string) => new Date(`${iso}T12:00:00`);

describe("financial year boundaries", () => {
  it("handles an April year, the Indian default", () => {
    expect(isoFinancialYearStart(at("2026-08-16"), 4)).toBe("2026-04-01");
    expect(isoFinancialYearStart(at("2026-04-01"), 4)).toBe("2026-04-01");
    // The day before the year turns over still belongs to the previous year.
    expect(isoFinancialYearStart(at("2026-03-31"), 4)).toBe("2025-04-01");
  });

  it("handles a July year, which the old hardcoded April logic got wrong", () => {
    expect(isoFinancialYearStart(at("2026-08-16"), 7)).toBe("2026-07-01");
    expect(isoFinancialYearStart(at("2026-06-30"), 7)).toBe("2025-07-01");
  });

  it("handles a January year, where the FY and calendar year coincide", () => {
    expect(isoFinancialYearStart(at("2026-08-16"), 1)).toBe("2026-01-01");
    expect(isoFinancialYearStart(at("2026-01-01"), 1)).toBe("2026-01-01");
  });

  it("handles a December year, the latest possible start month", () => {
    expect(isoFinancialYearStart(at("2026-12-01"), 12)).toBe("2026-12-01");
    expect(isoFinancialYearStart(at("2026-11-30"), 12)).toBe("2025-12-01");
  });

  it("agrees with the label for the same instant", () => {
    for (const month of [1, 4, 7, 10, 12]) {
      for (const iso of ["2026-01-15", "2026-06-30", "2026-08-16", "2026-12-31"]) {
        const start = isoFinancialYearStart(at(iso), month);
        const label = getFinancialYearLabel(at(iso), month);
        // "FY 2026-27" must name the year the start date falls in.
        expect(label).toBe(
          `FY ${start.slice(0, 4)}-${String((Number(start.slice(0, 4)) + 1) % 100).padStart(2, "0")}`
        );
      }
    }
  });
});

describe("local calendar dates", () => {
  it("reports the local day, not the UTC one", () => {
    // 00:30 local on the 16th is still the 15th in UTC for IST; toISOString
    // would report the wrong day.
    const earlyMorning = new Date(2026, 7, 16, 0, 30, 0);
    expect(isoLocalDate(earlyMorning)).toBe("2026-08-16");
  });

  it("zero-pads month and day", () => {
    expect(isoLocalDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("statement period wording", () => {
  it("renders an as-of date the way a document would", () => {
    expect(asOfPeriod("2026-03-31")).toBe("As of 31 March 2026");
  });

  it("renders a range", () => {
    expect(rangePeriod("2025-04-01", "2026-03-31")).toBe("1 April 2025 to 31 March 2026");
  });

  it("does not shift the day for timezones west of UTC", () => {
    // Parsed as UTC deliberately: `new Date("2026-03-31")` in a negative
    // offset would render as the 30th.
    expect(asOfPeriod("2026-01-01")).toBe("As of 1 January 2026");
  });
});

describe("return paths", () => {
  it("keeps ordinary in-app paths", () => {
    expect(safeReturnPath("/abc/dashboard")).toBe("/abc/dashboard");
    expect(safeReturnPath("/invite/tok?x=1")).toBe("/invite/tok?x=1");
  });

  it("rejects anything that could leave the origin", () => {
    expect(safeReturnPath("//evil.example")).toBe("/");
    expect(safeReturnPath("/\\evil.example")).toBe("/");
    expect(safeReturnPath("https://evil.example")).toBe("/");
    expect(safeReturnPath("javascript:alert(1)")).toBe("/");
    expect(safeReturnPath(null)).toBe("/");
    expect(safeReturnPath("")).toBe("/");
  });

  it("builds a login URL that survives the round trip", () => {
    expect(loginUrlReturningTo("/invite/abc?x=1")).toBe("/login?next=%2Finvite%2Fabc%3Fx%3D1");
    // Nothing worth returning to means a plain /login, not "?next=".
    expect(loginUrlReturningTo("https://evil.example")).toBe("/login");
    expect(loginUrlReturningTo(null)).toBe("/login");
  });
});
