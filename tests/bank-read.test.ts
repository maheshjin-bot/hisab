import { describe, expect, it } from "vitest";
import { parseAmountCell } from "@/lib/bank/amount";
import { detectDateFormat, parseStatementDate } from "@/lib/bank/date";
import { detectHeaderRow, detectStatementFormat } from "@/lib/bank/detect";
import { assignOccurrenceIndexes, buildFingerprint } from "@/lib/bank/fingerprint";
import { locateHeaderRow, readStatement } from "@/lib/bank/parse";
import type { StatementProfile } from "@/lib/bank/types";

/**
 * Three real-shaped exports. The point of these fixtures is that no two banks
 * agree on anything: header position, column names, date order, or how they
 * say "money left the account".
 */

/** HDFC-style: preamble block, separate withdrawal/deposit columns, dd/mm/yy. */
const HDFC: string[][] = [
  ["HDFC BANK LTD", "", "", "", "", ""],
  ["Statement of account", "", "", "", "", ""],
  ["Account No :", "50100123456789", "", "", "", ""],
  ["", "", "", "", "", ""],
  ["Date", "Narration", "Chq/Ref No", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
  ["01/04/26", "UPI-SWIGGY-9871234@ybl-UTR991823", "991823", "482.00", "", "1,24,518.00"],
  ["03/04/26", "NEFT DR-ICIC0000123-RAJESH TRADERS", "N023", "25,000.00", "", "99,518.00"],
  ["05/04/26", "NEFT CR-HDFC0000456-ACME EXPORTS", "N099", "", "1,50,000.00", "2,49,518.00"],
  ["18/04/26", "ATM WDL 1234 MUMBAI", "", "10,000.00", "", "2,39,518.00"],
  ["", "", "", "", "", ""],
  ["Opening Balance", "", "", "", "", "1,25,000.00"],
];

/** ICICI-style: single signed amount column, dd-Mon-yyyy dates, no preamble. */
const ICICI: string[][] = [
  ["Transaction Date", "Value Date", "Description", "Amount", "Balance"],
  ["01-Apr-2026", "01-Apr-2026", "MMT/IMPS/609812/RENT/LANDLORD", "-18000.00", "82000.00"],
  ["02-Apr-2026", "02-Apr-2026", "SALARY CREDIT APRIL", "95000.00", "177000.00"],
  ["04-Apr-2026", "04-Apr-2026", "BIL/ONL/000123/AIRTEL BROADBAND", "-1499.00", "175501.00"],
];

/** A US-shaped export: mm/dd/yyyy, an Amount column plus a Dr/Cr indicator. */
const TYPED: string[][] = [
  ["Post Date", "Details", "Amount", "Dr/Cr", "Running Balance"],
  ["04/13/2026", "OFFICE SUPPLIES CO", "2,340.00", "Dr", "47,660.00"],
  ["04/15/2026", "CLIENT WIRE INBOUND", "12,000.00", "Cr", "59,660.00"],
];

describe("parseAmountCell", () => {
  it("reads Indian digit grouping", () => {
    expect(parseAmountCell("1,24,518.00")?.paise).toBe(12451800);
    expect(parseAmountCell("₹ 1,50,000.00")?.paise).toBe(15000000);
  });

  it("treats a blank cell as absent, not zero", () => {
    // In separate-columns mode the unused side is blank on every row; reading
    // it as 0 and reading it as "no value" are the same until a row has both
    // sides blank, which must be an error rather than a zero-amount line.
    expect(parseAmountCell("")).toBeNull();
    expect(parseAmountCell("   ")).toBeNull();
    expect(parseAmountCell("-")).toBeNull();
  });

  it("recognises the several ways a statement writes a negative", () => {
    expect(parseAmountCell("-18000.00")?.negative).toBe(true);
    expect(parseAmountCell("(1,234.56)")?.negative).toBe(true);
    expect(parseAmountCell("(1,234.56)")?.paise).toBe(123456);
  });

  it("picks up a Dr/Cr marker written into the amount cell", () => {
    expect(parseAmountCell("1,234.56 Cr")?.explicitSign).toBe("Cr");
    expect(parseAmountCell("1,234.56 Dr")?.explicitSign).toBe("Dr");
    expect(parseAmountCell("1,234.56 Cr")?.paise).toBe(123456);
  });

  it("refuses text rather than reading it as zero", () => {
    expect(parseAmountCell("N/A")).toBeNull();
    expect(parseAmountCell("Opening Balance")).toBeNull();
  });

  it("handles a decimal comma without mistaking grouping for one", () => {
    expect(parseAmountCell("1234,56")?.paise).toBe(123456);
    expect(parseAmountCell("1,234")?.paise).toBe(123400);
    expect(parseAmountCell("1.234.567,89")?.paise).toBe(123456789);
  });
});

describe("parseStatementDate", () => {
  it("applies the declared ordering to all-numeric dates", () => {
    expect(parseStatementDate("03/04/2026", "dmy")).toBe("2026-04-03");
    expect(parseStatementDate("03/04/2026", "mdy")).toBe("2026-03-04");
  });

  it("honours a spelled month over the declared ordering", () => {
    // The same bank uses numeric dates in CSV and spelled ones in XLS, so the
    // profile's format must not be able to misread an unambiguous date.
    expect(parseStatementDate("03-Apr-2026", "mdy")).toBe("2026-04-03");
    expect(parseStatementDate("2026-Apr-03", "dmy")).toBe("2026-04-03");
  });

  it("expands two-digit years into the past, not the future", () => {
    expect(parseStatementDate("01/04/26", "dmy")).toBe("2026-04-01");
  });

  it("rejects a date that does not exist", () => {
    expect(parseStatementDate("31/02/2026", "dmy")).toBeNull();
    expect(parseStatementDate("29/02/2026", "dmy")).toBeNull();
    expect(parseStatementDate("29/02/2028", "dmy")).toBe("2028-02-29");
  });

  it("ignores a time component", () => {
    expect(parseStatementDate("03/04/2026 14:22:01", "dmy")).toBe("2026-04-03");
  });
});

describe("detectDateFormat", () => {
  it("uses a day above 12 to settle the ordering", () => {
    expect(detectDateFormat(["01/04/2026", "18/04/2026"])).toEqual({ format: "dmy", unambiguous: true });
    expect(detectDateFormat(["04/13/2026", "04/15/2026"])).toEqual({ format: "mdy", unambiguous: true });
  });

  it("reports ambiguity rather than guessing when every day is 12 or below", () => {
    // Guessing wrong here moves every transaction to a different month, so
    // the caller has to ask instead.
    expect(detectDateFormat(["01/04/2026", "03/04/2026"])).toEqual({ format: "dmy", unambiguous: false });
  });

  it("recognises ISO dates", () => {
    expect(detectDateFormat(["2026-04-01", "2026-04-03"])).toEqual({ format: "ymd", unambiguous: true });
  });
});

describe("detectHeaderRow", () => {
  it("finds the header under a block of account metadata", () => {
    const detected = detectHeaderRow(HDFC);
    expect(detected.headerRowIndex).toBe(4);
    expect(detected.headers[0]).toBe("Date");
  });

  it("handles a file whose first row is already the header", () => {
    expect(detectHeaderRow(ICICI).headerRowIndex).toBe(0);
  });
});

describe("detectStatementFormat", () => {
  it("maps a separate-columns statement", () => {
    const { profile, confidence } = detectStatementFormat(HDFC, "HDFC Current");

    expect(profile.amountMode).toBe("separate_columns");
    expect(profile.dateColumn).toBe("Date");
    expect(profile.withdrawalColumn).toBe("Withdrawal Amt.");
    expect(profile.depositColumn).toBe("Deposit Amt.");
    expect(profile.balanceColumn).toBe("Closing Balance");
    expect(profile.narrationColumns).toEqual(["Narration"]);
    expect(profile.referenceColumn).toBe("Chq/Ref No");
    expect(profile.dateFormat).toBe("dmy");
    expect(profile.skipRows).toBe(4);
    expect(confidence.dateFormatUnambiguous).toBe(true);
  });

  it("maps a signed single-amount statement and keeps the value date apart from the transaction date", () => {
    const { profile } = detectStatementFormat(ICICI, "ICICI Savings");

    expect(profile.amountMode).toBe("signed_single");
    expect(profile.amountColumn).toBe("Amount");
    expect(profile.dateColumn).toBe("Transaction Date");
    expect(profile.valueDateColumn).toBe("Value Date");
    expect(profile.narrationColumns).toEqual(["Description"]);
  });

  it("maps an amount-plus-indicator statement", () => {
    const { profile } = detectStatementFormat(TYPED, "Ops Account");

    expect(profile.amountMode).toBe("amount_with_type");
    expect(profile.amountColumn).toBe("Amount");
    expect(profile.typeColumn).toBe("Dr/Cr");
    expect(profile.dateFormat).toBe("mdy");
  });
});

function readWithDetection(grid: string[][], label: string) {
  const { profile, grid: detected } = detectStatementFormat(grid, label);
  return { profile, result: readStatement(grid, profile, detected.headerRowIndex) };
}

describe("readStatement", () => {
  it("reads a separate-columns statement into directional lines", () => {
    const { result } = readWithDetection(HDFC, "HDFC Current");

    expect(result.errors).toEqual([]);
    expect(result.lines).toHaveLength(4);

    const [swiggy, rajesh, acme, atm] = result.lines;
    expect(swiggy.withdrawalPaise).toBe(48200);
    expect(swiggy.depositPaise).toBe(0);
    expect(rajesh.withdrawalPaise).toBe(2500000);
    expect(acme.depositPaise).toBe(15000000);
    expect(acme.withdrawalPaise).toBe(0);
    expect(atm.reference).toBeNull();

    expect(result.periodStart).toBe("2026-04-01");
    expect(result.periodEnd).toBe("2026-04-18");
    expect(result.closingBalancePaise).toBe(23951800);
  });

  it("stops at the summary block instead of reporting it as broken rows", () => {
    const { result } = readWithDetection(HDFC, "HDFC Current");
    // "Opening Balance" sits below the transactions with no date. It is the
    // end of the file, not an error the user has to act on.
    expect(result.errors).toEqual([]);
  });

  it("reads direction from the sign in a single-amount statement", () => {
    const { result } = readWithDetection(ICICI, "ICICI Savings");

    expect(result.errors).toEqual([]);
    expect(result.lines[0].withdrawalPaise).toBe(1800000);
    expect(result.lines[1].depositPaise).toBe(9500000);
    expect(result.lines[2].withdrawalPaise).toBe(149900);
    expect(result.lines[0].valueDate).toBe("2026-04-01");
  });

  it("reads direction from the indicator column", () => {
    const { result } = readWithDetection(TYPED, "Ops Account");

    expect(result.errors).toEqual([]);
    expect(result.lines[0].withdrawalPaise).toBe(234000);
    expect(result.lines[1].depositPaise).toBe(1200000);
    expect(result.lines[0].txnDate).toBe("2026-04-13");
  });

  it("warns when the running balance stops adding up", () => {
    // Swapping the two amount columns is the classic mapping mistake, and the
    // balance column is what catches it before anything is posted.
    const { profile } = detectStatementFormat(HDFC, "HDFC Current");
    const swapped: StatementProfile = {
      ...profile,
      withdrawalColumn: profile.depositColumn,
      depositColumn: profile.withdrawalColumn,
    };
    const result = readStatement(HDFC, swapped, 4);

    expect(result.issues.some((issue) => issue.includes("running balance"))).toBe(true);
  });

  it("does not warn when the mapping is right", () => {
    const { result } = readWithDetection(HDFC, "HDFC Current");
    expect(result.issues.filter((issue) => issue.includes("running balance"))).toEqual([]);
  });

  it("reports a row with an amount on both sides rather than picking one", () => {
    const grid = [
      ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt."],
      ["01/04/2026", "AMBIGUOUS", "100.00", "200.00"],
      ["02/04/2026", "FINE", "50.00", ""],
    ];
    const { profile } = detectStatementFormat(grid, "Test");
    const result = readStatement(grid, profile, 0);

    expect(result.lines).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].lineNumber).toBe(2);
  });

  it("numbers rows the way a spreadsheet does, so an error can be found", () => {
    const grid = [
      ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt."],
      ["01/04/2026", "GOOD", "100.00", ""],
      ["not a date", "BROKEN", "100.00", ""],
      ["03/04/2026", "GOOD", "100.00", ""],
    ];
    const { profile } = detectStatementFormat(grid, "Test");
    const result = readStatement(grid, profile, 0);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].lineNumber).toBe(3);
  });
});

describe("locateHeaderRow", () => {
  it("finds the header even when the preamble has grown since the profile was saved", () => {
    const { profile } = detectStatementFormat(HDFC, "HDFC Current");
    const withExtraPreamble = [["Statement generated on 01/05/2026", "", "", "", "", ""], ...HDFC];

    expect(profile.skipRows).toBe(4);
    expect(locateHeaderRow(withExtraPreamble, profile)).toBe(5);
  });

  it("falls back to the remembered row when the header column is gone", () => {
    const profile = { ...(detectStatementFormat(HDFC, "X").profile), dateColumn: "Nope" };
    expect(locateHeaderRow(HDFC, profile)).toBe(4);
  });
});

describe("fingerprints", () => {
  const line = {
    txnDate: "2026-04-01",
    direction: "withdrawal" as const,
    amountPaise: 48200,
    narration: "UPI-SWIGGY-9871234@ybl-UTR991823",
  };

  it("is stable across the formatting differences between two exports", () => {
    const a = buildFingerprint({ ...line, occurrenceIndex: 0 });
    const b = buildFingerprint({
      ...line,
      narration: "  upi-swiggy-9871234@YBL-utr991823  ",
      occurrenceIndex: 0,
    });
    expect(a).toBe(b);
  });

  it("separates a genuine repeat from a re-import", () => {
    // Two identical charges on one day are two transactions; the occurrence
    // index is the only thing that distinguishes them, and it has to be
    // derived the same way in both files for the overlap to be recognised.
    const withIndexes = assignOccurrenceIndexes([line, line, { ...line, amountPaise: 999 }]);
    expect(withIndexes.map((l) => l.occurrenceIndex)).toEqual([0, 1, 0]);

    const first = buildFingerprint(withIndexes[0]);
    const second = buildFingerprint(withIndexes[1]);
    expect(first).not.toBe(second);
  });

  it("gives the same line the same fingerprint in two overlapping statements", () => {
    const january = [{ ...line, txnDate: "2026-01-15" }, line, line];
    const overlap = [line, line, { ...line, txnDate: "2026-05-02" }];

    const a = assignOccurrenceIndexes(january).filter((l) => l.txnDate === "2026-04-01").map(buildFingerprint);
    const b = assignOccurrenceIndexes(overlap).filter((l) => l.txnDate === "2026-04-01").map(buildFingerprint);

    expect(a).toEqual(b);
  });

  it("distinguishes the two directions", () => {
    expect(buildFingerprint({ ...line, occurrenceIndex: 0 })).not.toBe(
      buildFingerprint({ ...line, direction: "deposit", occurrenceIndex: 0 })
    );
  });
});
