import { describe, expect, it } from "vitest";
import { detectHeaderRow, detectStatementFormat } from "@/lib/bank/detect";
import { readStatement } from "@/lib/bank/parse";

/**
 * First-contact reading of a statement whose format is not yet known.
 *
 * Everything detection produces is a proposal the user confirms, so a wrong
 * guess costs one correction — unless the wrong guess is one the user has no
 * way to see, which is what these tests are looking for.
 */

/** HDFC-style: tall preamble that itself contains date-ish words, separate columns. */
const HDFC: string[][] = [
  ["HDFC BANK LIMITED", "", "", "", "", "", ""],
  ["Statement of Account", "", "", "", "", "", ""],
  ["Name :", "ACME TRADING PVT LTD", "", "", "", "", ""],
  ["Account No :", "50100123456789", "Account Type", "CURRENT", "", "", ""],
  ["Address :", "12 FORT ROAD, MUMBAI 400001", "", "", "", "", ""],
  ["Statement of Transactions in Savings Account", "Date From", "01/04/2026", "Date To", "30/04/2026", "", ""],
  ["", "", "", "", "", "", ""],
  ["Date", "Narration", "Chq/Ref No", "Value Date", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
  ["01/04/2026", "UPI-SWIGGY-9871234@ybl-UTR991823", "991823", "01/04/2026", "482.00", "", "1,24,518.00"],
  ["03/04/2026", "NEFT DR-ICIC0000123-RAJESH TRADERS", "N023", "03/04/2026", "25,000.00", "", "99,518.00"],
  ["05/04/2026", "NEFT CR-HDFC0000456-ACME EXPORTS LTD", "N099", "05/04/2026", "", "1,50,000.00", "2,49,518.00"],
  ["18/04/2026", "ATM-CASH WDL-MUMBAI FORT-1234", "", "18/04/2026", "10,000.00", "", "2,39,518.00"],
  ["", "", "", "", "", "", ""],
  ["Opening Balance", "", "", "", "", "", "1,25,000.00"],
];

/** Kotak-style: one amount column plus a Dr/Cr indicator, spelled months. */
const KOTAK: string[][] = [
  ["Transaction Date", "Value Date", "Description", "Ref No/Chq No", "Amount", "Dr/Cr", "Balance"],
  ["01-Apr-2026", "01-Apr-2026", "MMT/IMPS/609812/RENT/LANDLORD", "609812", "18,000.00", "DR", "82,000.00"],
  ["15-Apr-2026", "15-Apr-2026", "SALARY CREDIT APRIL 2026", "", "95,000.00", "CR", "1,77,000.00"],
  ["24-Apr-2026", "24-Apr-2026", "BIL/ONL/000123/AIRTEL BROADBAND", "000123", "1,499.00", "DR", "1,75,501.00"],
];

/** One amount column whose sign carries the direction. */
const SIGNED: string[][] = [
  ["Txn Date", "Particulars", "Amount", "Balance"],
  ["01/04/2026", "MMT/IMPS/609812/RENT/LANDLORD MUMBAI", "-18,000.00", "82,000.00"],
  ["15/04/2026", "SALARY CREDIT APRIL 2026 ACME LTD", "95,000.00", "1,77,000.00"],
  ["24/04/2026", "BIL/ONL/000123/AIRTEL BROADBAND BILL", "-1,499.00", "1,75,501.00"],
];

describe("detectHeaderRow", () => {
  it("finds the header under a preamble that itself talks about dates", () => {
    // "Statement of Transactions ... Date From ... Date To" is a row full of
    // header-ish words sitting above the real header. Scoring whole rows —
    // hints minus numeric cells — is what keeps it from winning.
    const detected = detectHeaderRow(HDFC);
    expect(detected.headerRowIndex).toBe(7);
    expect(detected.headers[0]).toBe("Date");
    expect(detected.headers).toHaveLength(7);
  });

  it("handles a file whose first row is already the header", () => {
    expect(detectHeaderRow(KOTAK).headerRowIndex).toBe(0);
  });

  it("drops blank rows from the sample it profiles columns with", () => {
    const detected = detectHeaderRow(HDFC);
    // Four transactions plus the "Opening Balance" summary row; the two blank
    // rows are gone.
    expect(detected.dataRows).toHaveLength(5);
    expect(detected.dataRows[0][0]).toBe("01/04/2026");
  });

  it("trims the header cells, so a mapping is not defeated by a stray space", () => {
    const padded = [[" Date ", "  Narration", "Withdrawal Amt ", "Deposit Amt", "Balance"], ...HDFC.slice(8, 12)];
    expect(detectHeaderRow(padded).headers).toEqual(["Date", "Narration", "Withdrawal Amt", "Deposit Amt", "Balance"]);
  });
});

describe("detectStatementFormat — the three amount modes", () => {
  it("maps a separate-columns statement, preamble and all", () => {
    const { profile, confidence } = detectStatementFormat(HDFC, "HDFC Current");

    expect(profile).toMatchObject({
      label: "HDFC Current",
      amountMode: "separate_columns",
      dateColumn: "Date",
      valueDateColumn: "Value Date",
      narrationColumns: ["Narration"],
      referenceColumn: "Chq/Ref No",
      balanceColumn: "Closing Balance",
      withdrawalColumn: "Withdrawal Amt.",
      depositColumn: "Deposit Amt.",
      amountColumn: null,
      typeColumn: null,
      dateFormat: "dmy",
      skipRows: 7,
    });
    expect(confidence.warnings).toEqual([]);
    expect(confidence.dateFormatUnambiguous).toBe(true);
  });

  it("keeps the value date out of the transaction date's hands", () => {
    // The loose `date` matcher would happily take "Value Date"; the claim order
    // is what stops it, and getting this wrong shifts every date by the
    // settlement lag.
    const { profile } = detectStatementFormat(HDFC, "X");
    expect(profile.dateColumn).toBe("Date");
    expect(profile.valueDateColumn).toBe("Value Date");
  });

  it("maps an amount-plus-indicator statement", () => {
    const { profile } = detectStatementFormat(KOTAK, "Kotak Current");
    expect(profile).toMatchObject({
      amountMode: "amount_with_type",
      amountColumn: "Amount",
      typeColumn: "Dr/Cr",
      withdrawalColumn: null,
      depositColumn: null,
      referenceColumn: "Ref No/Chq No",
    });
  });

  it("maps a signed single-amount statement without complaining", () => {
    const { profile, confidence } = detectStatementFormat(SIGNED, "ICICI Savings");
    expect(profile).toMatchObject({
      amountMode: "signed_single",
      amountColumn: "Amount",
      typeColumn: null,
      negativeIsWithdrawal: true,
      balanceColumn: "Balance",
    });
    expect(confidence.warnings).toEqual([]);
  });

  it("does not let the balance column be taken for an amount column", () => {
    // Both are dense columns of numbers; only the header separates them.
    const { profile } = detectStatementFormat(SIGNED, "X");
    expect(profile.amountColumn).toBe("Amount");
    expect(profile.balanceColumn).toBe("Balance");
  });

  it("gives each field it found a confidence, and omits the ones it did not", () => {
    const { confidence } = detectStatementFormat(SIGNED, "X");
    expect(Object.keys(confidence.fields).sort()).toEqual(["amount", "balance", "date", "narration"]);
    for (const score of Object.values(confidence.fields)) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe("detectStatementFormat — what it warns about", () => {
  it("warns when one amount column carries no negatives, so direction may be missing", () => {
    const unsigned = SIGNED.map((row, i) => (i === 0 ? row : [...row.slice(0, 2), row[2].replace("-", ""), row[3]]));
    const { confidence } = detectStatementFormat(unsigned, "X");
    expect(confidence.warnings.some((w) => w.includes("none of its values are negative"))).toBe(true);
  });

  it("warns rather than guessing when every day in the file is 12 or below", () => {
    const lowDays = [
      ["Txn Date", "Particulars", "Amount", "Balance"],
      ["01/04/2026", "MMT/IMPS/609812/RENT/LANDLORD MUMBAI", "-18,000.00", "82,000.00"],
      ["05/04/2026", "SALARY CREDIT APRIL 2026 ACME LTD", "95,000.00", "1,77,000.00"],
      ["11/04/2026", "BIL/ONL/000123/AIRTEL BROADBAND BILL", "-1,499.00", "1,75,501.00"],
    ];
    const { confidence } = detectStatementFormat(lowDays, "X");
    expect(confidence.dateFormatUnambiguous).toBe(false);
    expect(confidence.warnings.some((w) => w.includes("dd/mm and mm/dd"))).toBe(true);
  });

  it("asks for help rather than inventing a mapping for a file with no header", () => {
    const headerless = [
      ["01/04/2026", "UPI-SWIGGY-9871234@ybl", "482.00", "", "1,24,518.00"],
      ["03/04/2026", "NEFT DR-RAJESH TRADERS", "25,000.00", "", "99,518.00"],
      ["05/04/2026", "NEFT CR-ACME EXPORTS LTD", "", "1,50,000.00", "2,49,518.00"],
    ];
    const { profile, confidence } = detectStatementFormat(headerless, "X");
    expect(profile.dateColumn).toBe("");
    expect(confidence.warnings.some((w) => w.includes("transaction date column"))).toBe(true);
    expect(confidence.warnings.some((w) => w.includes("which columns hold the amounts"))).toBe(true);
  });
});

describe("detectStatementFormat — the profile has to survive the round trip", () => {
  it("produces a profile that reads its own file", () => {
    // Detection names columns by index but records them by header text, so the
    // two halves have to agree. This is the check that they do.
    const { profile, grid } = detectStatementFormat(HDFC, "HDFC Current");
    const result = readStatement(HDFC, profile, grid.headerRowIndex);

    expect(result.errors).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.lines).toHaveLength(4);
    expect(result.lines.map((l) => [l.withdrawalPaise, l.depositPaise])).toEqual([
      [48200, 0], [2500000, 0], [0, 15000000], [1000000, 0],
    ]);
    expect(result.lines.every((l) => l.narration !== "")).toBe(true);
  });

  // FAILS: an unlabelled narration column is detected by content and then
  // recorded in the profile as narrationColumns: [""], which resolves to
  // nothing at parse time. Every line comes back with narration: "" and the
  // fingerprints collapse to "2026-04-01|W|48200||0". It should either record
  // the column in a way parse.ts can find, or not claim it at all and warn.
  //
  // pickColumn() deliberately allows a narration column with no header at all
  // ("a bank occasionally leaves the column unlabelled entirely") and scores it
  // purely on content. But the profile addresses columns by header text — by
  // design, so that a bank adding a column between exports doesn't shift every
  // mapping by one — and buildColumnIndex() skips empty keys. There is no
  // header text to record, so the mapping cannot be expressed.
  //
  // Consequence: no error, no warning. The "Could not find a description
  // column" warning is not emitted, because a column *was* found. The preview
  // shows a statement with a blank description on every row, which is easy to
  // read as "this bank doesn't send descriptions". Then: every posted voucher
  // has an empty narration; suggest.ts has nothing to learn a rule from, so the
  // account never gets proposed and the second import is as manual as the
  // first; and the fingerprint loses its strongest component, so two unrelated
  // transactions of the same amount on the same day, arriving in two different
  // uploads, become indistinguishable and the second is dropped.
  it.skip("records an unlabelled narration column in a way parse.ts can resolve", () => {
    const unlabelled = [
      ["Date", "", "Withdrawal Amt", "Deposit Amt", "Balance"],
      ["01/04/2026", "UPI-SWIGGY-9871234@ybl-UTR991823", "482.00", "", "1,24,518.00"],
      ["03/04/2026", "NEFT DR-ICIC0000123-RAJESH TRADERS", "25,000.00", "", "99,518.00"],
      ["05/04/2026", "NEFT CR-HDFC0000456-ACME EXPORTS LTD", "", "1,50,000.00", "2,49,518.00"],
      ["18/04/2026", "ATM-CASH WDL-MUMBAI FORT-1234", "10,000.00", "", "2,39,518.00"],
    ];
    const { profile, grid } = detectStatementFormat(unlabelled, "X");
    const result = readStatement(unlabelled, profile, grid.headerRowIndex);
    expect(result.lines.every((l) => l.narration !== "")).toBe(true);
  });

  // FAILS: a statement that writes its unused amount side as "-" is mapped as
  // signed_single with amountColumn "Withdrawal Amt". Every withdrawal in the
  // file is then read as a deposit, and the one genuine deposit row errors as
  // "No amount on this row". It should be mapped as separate_columns.
  //
  // contentScore() for withdrawal/deposit requires numericRatio >= 0.9, and
  // numericRatio counts a cell as non-numeric when parseAmountCell returns null
  // — which it does for "-", correctly, since a dash is a blank and not a zero.
  // But the ratio is taken over *non-empty* cells, so a column whose blanks are
  // written as dashes scores about 0.5 and is rejected outright by
  // `if (content === 0) continue`, despite an exact header match on
  // "Withdrawal Amt". Detection then falls through to the single-amount branch
  // and picks the first column whose header merely contains "amt".
  //
  // Consequence: this is how Kotak and several co-operative banks write a CSV,
  // and the direction of every transaction in the file is inverted. There is a
  // warning ("none of its values are negative"), but it asks the user to check
  // whether withdrawals and deposits are told apart in the file — and they
  // plainly are, in two clearly labelled columns, so the natural reading is
  // that the warning is wrong. The balance-continuity check would have caught
  // it at the next step, except that the deposit row errors out and only three
  // lines survive.
  it("maps two amount columns whose blanks are written as dashes", () => {
    const dashes = [
      ["Date", "Narration", "Withdrawal Amt", "Deposit Amt", "Balance"],
      ["01/04/2026", "UPI-SWIGGY-9871234@ybl-UTR991823", "482.00", "-", "1,24,518.00"],
      ["03/04/2026", "NEFT DR-ICIC0000123-RAJESH TRADERS", "25,000.00", "-", "99,518.00"],
      ["05/04/2026", "NEFT CR-HDFC0000456-ACME EXPORTS LTD", "-", "1,50,000.00", "2,49,518.00"],
      ["18/04/2026", "ATM-CASH WDL-MUMBAI FORT-1234", "10,000.00", "-", "2,39,518.00"],
    ];
    const { profile } = detectStatementFormat(dashes, "X");
    expect(profile.amountMode).toBe("separate_columns");
    expect(profile.withdrawalColumn).toBe("Withdrawal Amt");
    expect(profile.depositColumn).toBe("Deposit Amt");
  });
});
