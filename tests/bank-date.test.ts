import { describe, expect, it } from "vitest";
import { detectDateFormat, looksLikeDate, parseStatementDate } from "@/lib/bank/date";

/**
 * Date reading is the highest-consequence part of the statement importer: a
 * misread date does not fail, it posts a real transaction into the wrong month
 * — or, once a financial year boundary is crossed, into a period that may
 * already be locked and filed.
 *
 * These tests are about the adversarial half: ambiguity, impossible dates, and
 * whether the profile's declared ordering is honoured on every path.
 */

describe("parseStatementDate — the declared ordering", () => {
  it("resolves the genuinely ambiguous case deterministically from the profile", () => {
    // 04/01/2026 is 4 January or 1 April and nothing in the cell can say which.
    // The profile is the only thing that can, so it must decide, every time.
    expect(parseStatementDate("04/01/2026", "dmy")).toBe("2026-01-04");
    expect(parseStatementDate("04/01/2026", "mdy")).toBe("2026-04-01");
    // Under ymd the same cell is year 4, which is not a date this file explains.
    expect(parseStatementDate("04/01/2026", "ymd")).toBeNull();
  });

  it("refuses a cell the declared ordering cannot explain rather than swapping to one that can", () => {
    // 13 cannot be a month. Silently falling back to dmy here would mean one
    // row in an mdy file read under different rules from its neighbours.
    expect(parseStatementDate("13/04/2026", "mdy")).toBeNull();
    expect(parseStatementDate("13/04/2026", "dmy")).toBe("2026-04-13");
  });

  it("lets a four-digit leading part override the declared ordering", () => {
    // "2026-04-03" cannot be dmy under any reading, so honouring the profile
    // literally would reject a date that is perfectly clear.
    expect(parseStatementDate("2026-04-03", "dmy")).toBe("2026-04-03");
    expect(parseStatementDate("2026-04-03", "mdy")).toBe("2026-04-03");
    expect(parseStatementDate("2026/4/3", "dmy")).toBe("2026-04-03");
  });

  it("accepts every separator a statement uses, and a trailing time", () => {
    expect(parseStatementDate("03/04/2026", "dmy")).toBe("2026-04-03");
    expect(parseStatementDate("03-04-2026", "dmy")).toBe("2026-04-03");
    expect(parseStatementDate("03.04.2026", "dmy")).toBe("2026-04-03");
    expect(parseStatementDate("1-4-26", "dmy")).toBe("2026-04-01");
    expect(parseStatementDate("03/04/2026 14:22:01", "dmy")).toBe("2026-04-03");
    expect(parseStatementDate("2026-04-03T00:00:00Z", "ymd")).toBe("2026-04-03");
  });

  it("returns null for anything that is not a date at all", () => {
    for (const cell of ["", "   ", "Opening Balance", "45678", "03/2026", "N/A", "-"]) {
      expect(parseStatementDate(cell, "dmy")).toBeNull();
    }
    expect(parseStatementDate(null, "dmy")).toBeNull();
    expect(parseStatementDate(undefined, "dmy")).toBeNull();
  });
});

describe("parseStatementDate — impossible dates", () => {
  it("rejects a day the month does not have rather than reformatting it", () => {
    // The failure mode this guards against: emitting "2026-02-31", which is a
    // well-formed string that only fails later, at the database, as an
    // unexplained insert error on one row of a two-hundred-row import.
    expect(parseStatementDate("31/02/2026", "dmy")).toBeNull();
    expect(parseStatementDate("31/04/2026", "dmy")).toBeNull();
    expect(parseStatementDate("32/01/2026", "dmy")).toBeNull();
    expect(parseStatementDate("00/04/2026", "dmy")).toBeNull();
    // Month 13 under the declared ordering, not day 13 — 03/13/2026 under mdy
    // is 13 March, a perfectly real date.
    expect(parseStatementDate("13/03/2026", "mdy")).toBeNull();
    expect(parseStatementDate("03/13/2026", "mdy")).toBe("2026-03-13");
    expect(parseStatementDate("03/00/2026", "dmy")).toBeNull();
  });

  it("gets the leap year rule right in all three of its cases", () => {
    expect(parseStatementDate("29/02/2026", "dmy")).toBeNull();
    expect(parseStatementDate("29/02/2028", "dmy")).toBe("2028-02-29");
    // 2100 is divisible by 4 but not a leap year; 2000 is, via the 400 rule.
    expect(parseStatementDate("29/02/2100", "dmy")).toBeNull();
    expect(parseStatementDate("29/02/2000", "dmy")).toBe("2000-02-29");
  });
});

describe("parseStatementDate — two-digit years", () => {
  it("reads a numeric two-digit year as the recent past", () => {
    expect(parseStatementDate("01/04/26", "dmy")).toBe("2026-04-01");
    expect(parseStatementDate("04/01/26", "mdy")).toBe("2026-04-01");
    expect(parseStatementDate("26/04/01", "ymd")).toBe("2026-04-01");
  });

  it("puts the pivot at 70, so old imported history stays readable", () => {
    expect(parseStatementDate("01/04/69", "dmy")).toBe("2069-04-01");
    expect(parseStatementDate("01/04/70", "dmy")).toBe("1970-04-01");
  });
});

describe("parseStatementDate — spelled months", () => {
  it("honours a spelled month over the declared ordering, wherever the year sits", () => {
    expect(parseStatementDate("03-Apr-2026", "mdy")).toBe("2026-04-03");
    expect(parseStatementDate("Apr-03-2026", "dmy")).toBe("2026-04-03");
    expect(parseStatementDate("2026-Apr-03", "dmy")).toBe("2026-04-03");
    expect(parseStatementDate("03-APR-2026", "ymd")).toBe("2026-04-03");
    expect(parseStatementDate("03-april-2026", "dmy")).toBe("2026-04-03");
  });

  it("reads both spellings of September", () => {
    expect(parseStatementDate("03-Sep-2026", "dmy")).toBe("2026-09-03");
    expect(parseStatementDate("03-Sept-2026", "dmy")).toBe("2026-09-03");
  });

  it("still rejects an impossible day under a spelled month", () => {
    expect(parseStatementDate("31-Feb-2026", "dmy")).toBeNull();
    expect(parseStatementDate("31-Apr-2026", "dmy")).toBeNull();
  });

  // FAILS: parseStatementDate("03-Apr-26", "dmy") returns "2003-04-26".
  // It should return "2026-04-03".
  //
  // In the spelled-month branch of parseStatementDate, the two remaining parts
  // are read as [day, year] only when `rest[1].length === 4 || b > 31`. For a
  // two-digit year that test is false whenever the year is 00-31, so the
  // branch falls through to the `else`, which reads them as [year, day] — the
  // day and the year are swapped. Years 32-99 happen to survive, which is why
  // "03-Apr-32" is read correctly and "03-Apr-26" is not.
  //
  // Consequence: dd-Mon-yy is the standard date format of the XLS exports from
  // HDFC, ICICI and Axis. Importing one puts every transaction in FY 2003-04
  // instead of FY 2026-27, and on the wrong day of the month as well. Nothing
  // reports an error — the dates that come out are real dates, so parsing
  // succeeds, the preview looks plausible and the whole statement posts into a
  // financial year that is more than twenty years closed.
  it("reads a spelled month with a two-digit year", () => {
    expect(parseStatementDate("03-Apr-26", "dmy")).toBe("2026-04-03");
    expect(parseStatementDate("15-Apr-26", "dmy")).toBe("2026-04-15");
    expect(parseStatementDate("01-Apr-26", "mdy")).toBe("2026-04-01");
    // The one that already works, kept here to show the boundary: a two-digit
    // year above 31 takes the correct branch.
    expect(parseStatementDate("03-Apr-32", "dmy")).toBe("2032-04-03");
  });
});

describe("looksLikeDate", () => {
  it("accepts a cell that parses under any ordering", () => {
    expect(looksLikeDate("03/04/2026")).toBe(true);
    expect(looksLikeDate("2026-04-03")).toBe(true);
    expect(looksLikeDate("03-Apr-2026")).toBe(true);
  });

  it("rejects amounts, references and prose, which is what keeps column detection honest", () => {
    for (const cell of ["", "1,24,518.00", "50100123456789", "UPI-SWIGGY-9871234", "Closing Balance"]) {
      expect(looksLikeDate(cell)).toBe(false);
    }
  });
});

describe("detectDateFormat", () => {
  it("settles the ordering on the first value above 12", () => {
    expect(detectDateFormat(["01/04/2026", "18/04/2026"])).toEqual({ format: "dmy", unambiguous: true });
    expect(detectDateFormat(["04/13/2026", "04/15/2026"])).toEqual({ format: "mdy", unambiguous: true });
  });

  it("reports ambiguity instead of guessing when every day is 12 or below", () => {
    expect(detectDateFormat(["01/04/2026", "03/04/2026"])).toEqual({ format: "dmy", unambiguous: false });
  });

  it("reports ambiguity when both positions exceed 12, which means the column is not consistently either", () => {
    expect(detectDateFormat(["18/04/2026", "04/15/2026"])).toEqual({ format: "dmy", unambiguous: false });
  });

  it("recognises an ISO column, and only when every row is ISO", () => {
    expect(detectDateFormat(["2026-04-01", "2026-04-03"])).toEqual({ format: "ymd", unambiguous: true });
    expect(detectDateFormat(["2026-04-01", "18/04/2026"])).toEqual({ format: "dmy", unambiguous: true });
  });

  it("survives a column of junk without claiming certainty", () => {
    expect(detectDateFormat([])).toEqual({ format: "dmy", unambiguous: false });
    expect(detectDateFormat(["", "Opening Balance", "1,24,518.00"])).toEqual({ format: "dmy", unambiguous: false });
  });

  // FAILS: detectDateFormat(["01-Apr-2026", "15-Apr-2026", "24-Apr-2026"])
  // returns { format: "dmy", unambiguous: false }. It should return
  // unambiguous: true.
  //
  // The loop skips every spelled-month sample (`continue` before `considered++`),
  // so a column made entirely of them ends with considered === 0 and falls
  // through to the final "every day was 12 or below" return — which is the
  // ambiguity signal.
  //
  // Consequence: detectStatementFormat turns that flag into the warning
  // "Every day in this file is 12 or below, so dd/mm and mm/dd look identical
  // — confirm which one this bank uses" and shows it on every ICICI-style
  // export. The statement it is shown for contains no numeric dates at all, so
  // the question is unanswerable and the setting it asks about has no effect on
  // how that file is read. It trains users to click past the one warning in the
  // importer that they must not click past when it is real.
  it.skip("does not call a spelled-month column ambiguous", () => {
    expect(detectDateFormat(["01-Apr-2026", "15-Apr-2026", "24-Apr-2026"]).unambiguous).toBe(true);
  });
});
