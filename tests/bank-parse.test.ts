import { describe, expect, it } from "vitest";
import { locateHeaderRow, readStatement, summarizeStatement } from "@/lib/bank/parse";
import type { StatementProfile } from "@/lib/bank/types";

/**
 * Applying a saved profile to a raw grid.
 *
 * The fixtures here are shaped like real exports rather than like tables: a
 * preamble of account-holder metadata above the header, a narration split
 * across two columns, a running balance, blanks written three different ways,
 * and a summary block below the transactions.
 */

/** Axis-style: tall preamble, separate withdrawal/deposit columns, dd/mm/yyyy. */
const AXIS: string[][] = [
  ["AXIS BANK LIMITED", "", "", "", "", "", ""],
  ["Statement of Account", "", "", "", "", "", ""],
  ["Name :", "ACME TRADING PVT LTD", "", "", "", "", ""],
  ["Account No :", "918020012345678", "Account Type", "CURRENT", "", "", ""],
  ["Address :", "12 FORT ROAD, MUMBAI 400001", "", "", "", "", ""],
  ["Period :", "01/04/2026", "to", "30/04/2026", "", "", ""],
  ["", "", "", "", "", "", ""],
  ["Tran Date", "Particulars", "Chq No", "Value Dt", "Withdrawal Amt", "Deposit Amt", "Closing Balance"],
  ["01/04/2026", "UPI/P2M/609812345/SWIGGY", "", "01/04/2026", "482.00", "", "1,24,518.00"],
  ["03/04/2026", "NEFT DR-ICIC0000123-RAJESH TRADERS", "N023", "03/04/2026", "25,000.00", "", "99,518.00"],
  ["05/04/2026", "NEFT CR-HDFC0000456-ACME EXPORTS LTD", "N099", "05/04/2026", "", "1,50,000.00", "2,49,518.00"],
  ["18/04/2026", "ATM-CASH WDL-MUMBAI FORT", "", "18/04/2026", "10,000.00", "", "2,39,518.00"],
  ["", "", "", "", "", "", ""],
  ["Opening Balance", "", "", "", "", "", "1,25,000.00"],
  ["Closing Balance", "", "", "", "", "", "2,39,518.00"],
  ["This is a computer generated statement and does not require a signature", "", "", "", "", "", ""],
];

const AXIS_HEADER_ROW = 7;

const AXIS_PROFILE: StatementProfile = {
  label: "Axis Current",
  dateColumn: "Tran Date",
  valueDateColumn: "Value Dt",
  narrationColumns: ["Particulars"],
  referenceColumn: "Chq No",
  balanceColumn: "Closing Balance",
  amountMode: "separate_columns",
  withdrawalColumn: "Withdrawal Amt",
  depositColumn: "Deposit Amt",
  amountColumn: null,
  typeColumn: null,
  negativeIsWithdrawal: true,
  dateFormat: "dmy",
  skipRows: AXIS_HEADER_ROW,
};

/** A minimal grid, for the cases where the fixture would only be noise. */
function grid(rows: string[][]): string[][] {
  return [["Date", "Narration", "Withdrawal", "Deposit"], ...rows];
}

const SIMPLE: StatementProfile = {
  ...AXIS_PROFILE,
  dateColumn: "Date",
  valueDateColumn: null,
  narrationColumns: ["Narration"],
  referenceColumn: null,
  balanceColumn: null,
  withdrawalColumn: "Withdrawal",
  depositColumn: "Deposit",
  skipRows: 0,
};

describe("readStatement — a realistic separate-columns export", () => {
  const result = readStatement(AXIS, AXIS_PROFILE, AXIS_HEADER_ROW);

  it("reads every transaction and nothing else", () => {
    expect(result.errors).toEqual([]);
    expect(result.lines).toHaveLength(4);
  });

  it("puts the amount on the side the file put it, in paise", () => {
    expect(result.lines.map((l) => [l.withdrawalPaise, l.depositPaise])).toEqual([
      [48200, 0],
      [2500000, 0],
      [0, 15000000],
      [1000000, 0],
    ]);
  });

  it("numbers rows the way a spreadsheet does, so an error can be found by opening the file", () => {
    expect(result.lines.map((l) => l.lineNumber)).toEqual([9, 10, 11, 12]);
  });

  it("reads the optional columns, and leaves a blank one null rather than empty", () => {
    expect(result.lines[1].reference).toBe("N023");
    expect(result.lines[0].reference).toBeNull();
    expect(result.lines[0].valueDate).toBe("2026-04-01");
    expect(result.lines[0].runningBalancePaise).toBe(12451800);
  });

  it("stops at the summary block rather than reporting it as broken rows", () => {
    // "Opening Balance" / "Closing Balance" / the disclaimer all sit below the
    // transactions with no date. They are the end of the file, not errors.
    expect(result.errors).toEqual([]);
    expect(result.lines.every((l) => l.narration !== "")).toBe(true);
  });

  it("takes the period from the dates in the file", () => {
    expect(result.periodStart).toBe("2026-04-01");
    expect(result.periodEnd).toBe("2026-04-18");
    expect(result.closingBalancePaise).toBe(23951800);
  });

  it("says nothing when the mapping is right", () => {
    expect(result.issues).toEqual([]);
  });
});

describe("readStatement — the invariant the database also enforces", () => {
  it("puts a non-zero amount on exactly one side, in every amount mode", () => {
    // bank_statement_lines has a check constraint saying the same thing. A line
    // that broke it would fail at insert time, halfway through an import.
    const cases: Array<[StatementProfile, string[][]]> = [
      [AXIS_PROFILE, AXIS],
      [
        { ...SIMPLE, amountMode: "signed_single", amountColumn: "Amount", withdrawalColumn: null, depositColumn: null },
        [
          ["Date", "Narration", "Amount"],
          ["01/04/2026", "PAID SUPPLIER", "-25,000.00"],
          ["03/04/2026", "CLIENT RECEIPT", "1,50,000.00"],
        ],
      ],
      [
        {
          ...SIMPLE,
          amountMode: "amount_with_type",
          amountColumn: "Amount",
          typeColumn: "Dr/Cr",
          withdrawalColumn: null,
          depositColumn: null,
        },
        [
          ["Date", "Narration", "Amount", "Dr/Cr"],
          ["01/04/2026", "PAID SUPPLIER", "25,000.00", "Dr"],
          ["03/04/2026", "CLIENT RECEIPT", "1,50,000.00", "Cr"],
        ],
      ],
    ];

    for (const [profile, rows] of cases) {
      const { lines } = readStatement(rows, profile, profile === AXIS_PROFILE ? AXIS_HEADER_ROW : 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.withdrawalPaise >= 0 && line.depositPaise >= 0).toBe(true);
        expect(line.withdrawalPaise === 0 || line.depositPaise === 0).toBe(true);
        expect(line.withdrawalPaise + line.depositPaise).toBeGreaterThan(0);
        expect(Number.isInteger(line.withdrawalPaise)).toBe(true);
        expect(Number.isInteger(line.depositPaise)).toBe(true);
      }
    }
  });
});

describe("readStatement — rows it must refuse", () => {
  it("refuses a row with an amount on both sides rather than picking one", () => {
    const result = readStatement(grid([["01/04/2026", "BOTH SIDES", "100.00", "200.00"]]), SIMPLE, 0);
    expect(result.lines).toEqual([]);
    expect(result.errors[0]).toMatchObject({ lineNumber: 2 });
    expect(result.errors[0].message).toContain("column mapping");
  });

  it("refuses a row with no amount, however the bank wrote the blank", () => {
    const result = readStatement(
      grid([
        ["01/04/2026", "EXPLICIT ZEROES", "0.00", "0.00"],
        ["02/04/2026", "DASHES", "-", "-"],
        ["03/04/2026", "EMPTY", "", ""],
        ["04/04/2026", "REAL", "100.00", ""],
      ]),
      SIMPLE,
      0
    );
    expect(result.lines).toHaveLength(1);
    expect(result.errors.map((e) => e.lineNumber)).toEqual([2, 3, 4]);
  });

  it("refuses a row whose date the profile's format cannot explain, and keeps going", () => {
    const result = readStatement(
      grid([
        ["01/04/2026", "GOOD", "100.00", ""],
        ["not a date", "BROKEN", "100.00", ""],
        ["03/04/2026", "GOOD", "100.00", ""],
      ]),
      SIMPLE,
      0
    );
    expect(result.lines).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].lineNumber).toBe(3);
    expect(result.errors[0].message).toContain("not a date");
  });

  it("skips a blank row inside the transactions without calling it an error", () => {
    const result = readStatement(
      grid([
        ["01/04/2026", "GOOD", "100.00", ""],
        ["", "", "", ""],
        ["03/04/2026", "GOOD", "100.00", ""],
      ]),
      SIMPLE,
      0
    );
    expect(result.lines).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  it("names the columns it could not find, instead of reading every row as empty", () => {
    const wrong: StatementProfile = { ...SIMPLE, withdrawalColumn: "Debit", depositColumn: "Credit" };
    const result = readStatement(grid([["01/04/2026", "GOOD", "100.00", ""]]), wrong, 0);
    expect(result.issues[0]).toContain('"Debit"');
    expect(result.issues[0]).toContain('"Credit"');
  });

  // The pair to "stops at the summary block" above: the same tail rows, read
  // the other way. readStatement scans up from the end for the last row whose
  // date parses, and once dropped everything below it — which could not tell a
  // summary row from a transaction whose own date is unreadable.
  //
  // What that cost: a statement whose final transactions carry impossible or
  // malformed dates (31/02, a 29 February in a non-leap year, a footer the
  // bank inserted between transactions) imported short, and because the
  // preview counted the same rows it imported, nothing looked wrong. The user
  // reconciled a month missing its last transactions and the closing balance
  // was out by exactly them.
  //
  // The tail pass now separates the two by money — a summary row carries a
  // balance, a transaction carries an amount — so this row is reported and the
  // Axis summary block above still isn't.
  it("reports an unreadable date in the last row rather than dropping it", () => {
    const result = readStatement(
      grid([
        ["01/04/2026", "GOOD", "100.00", ""],
        ["02/04/2026", "GOOD", "100.00", ""],
        ["31/02/2026", "IMPOSSIBLE DATE", "5,000.00", ""],
      ]),
      SIMPLE,
      0
    );
    expect(result.lines).toHaveLength(2);
    expect(result.errors.map((e) => e.lineNumber)).toEqual([4]);
  });

  // Same root cause as above, at its limit: with no dated row anywhere,
  // lastDatedRow stayed at the header row, the loop body never ran, and
  // readStatement returned { lines: [], errors: [], issues: [] } — a silent
  // no-op on a file full of perfectly good transactions.
  //
  // What that cost: the case that reaches this is a saved profile whose
  // dateFormat no longer matches — the user moved from the bank's CSV export
  // (dd/mm/yyyy) to its XLS export (mm/dd/yyyy), or the bank changed it. The
  // screen showed nothing found, no errors and no warnings, and no way to work
  // out that the date format was the thing to change. The one file-level check
  // that would have caught it, balance continuity, needs three parsed lines.
  it("says something when it could not read a single date in the file", () => {
    const result = readStatement(
      grid([
        ["13/04/2026", "GOOD", "100.00", ""],
        ["18/04/2026", "GOOD", "100.00", ""],
        ["24/04/2026", "GOOD", "100.00", ""],
      ]),
      { ...SIMPLE, dateFormat: "mdy" },
      0
    );
    expect(result.lines).toEqual([]);
    expect(result.errors.length + result.issues.length).toBeGreaterThan(0);
  });
});

describe("readStatement — signed_single", () => {
  const SIGNED: StatementProfile = {
    ...SIMPLE,
    amountMode: "signed_single",
    amountColumn: "Amount",
    withdrawalColumn: null,
    depositColumn: null,
  };
  const rows = [
    ["Date", "Narration", "Amount"],
    ["01/04/2026", "SUPPLIER PAYMENT", "-25,000.00"],
    ["03/04/2026", "CLIENT RECEIPT", "1,50,000.00"],
    ["05/04/2026", "ACCOUNTING ADJUSTMENT", "0.00"],
  ];

  it("reads direction from the sign", () => {
    const result = readStatement(rows, SIGNED, 0);
    expect(result.lines.map((l) => [l.withdrawalPaise, l.depositPaise])).toEqual([
      [2500000, 0],
      [0, 15000000],
    ]);
  });

  it("mirrors cleanly when the bank exports from its own point of view", () => {
    const result = readStatement(rows, { ...SIGNED, negativeIsWithdrawal: false }, 0);
    expect(result.lines.map((l) => [l.withdrawalPaise, l.depositPaise])).toEqual([
      [0, 2500000],
      [15000000, 0],
    ]);
  });

  it("refuses a zero-amount row rather than emitting a line with no money on it", () => {
    const result = readStatement(rows, SIGNED, 0);
    expect(result.errors).toEqual([{ lineNumber: 4, message: "No amount on this row" }]);
  });

  it("reads accounting parentheses as the negative they are", () => {
    const result = readStatement([["Date", "Narration", "Amount"], ["01/04/2026", "PAID", "(25,000.00)"]], SIGNED, 0);
    expect(result.lines[0].withdrawalPaise).toBe(2500000);
  });

  // FAILS: with an explicit "Dr" in the amount cell, both rows come back as
  // deposits — [[0, 500000], [0, 800000]]. The first should be a withdrawal.
  //
  // amount.ts documents explicitSign as beating "whatever the profile assumed,
  // because it's the file being explicit", and readAmount() honours that in
  // amount_with_type mode. The signed_single branch never looks at it: it
  // decides purely on `parsed.negative === profile.negativeIsWithdrawal`, and
  // "5,000.00 Dr" carries no minus sign, so it reads as a deposit.
  //
  // Consequence: banks that write the marker into the amount cell rather than
  // into a column of their own are exactly the ones detect.ts classifies as
  // signed_single, because it finds no separate indicator column to key on. It
  // does warn that none of the values are negative, but the warning invites the
  // user to check the mapping, and the mapping *is* right — the columns are
  // correct and one amount column really is all there is. Accepting it turns
  // every payment in the statement into a receipt: the direction of the whole
  // file is inverted, and every voucher posted from it debits what it should
  // credit.
  it("honours a Dr/Cr marker in the amount cell even in signed_single mode", () => {
    const result = readStatement(
      [
        ["Date", "Narration", "Amount"],
        ["01/04/2026", "SUPPLIER PAYMENT", "5,000.00 Dr"],
        ["03/04/2026", "CLIENT RECEIPT", "8,000.00 Cr"],
      ],
      SIGNED,
      0
    );
    expect(result.lines.map((l) => [l.withdrawalPaise, l.depositPaise])).toEqual([
      [500000, 0],
      [0, 800000],
    ]);
  });

  // FAILS: a negative in the withdrawal column is read as a withdrawal —
  // [[50000, 0], [50000, 0]]. The reversal on the second row should be a
  // deposit.
  //
  // readAmount() takes Math.abs() of whichever separate column is filled, so
  // the sign the file supplied is discarded. This is the one finding here that
  // is arguably by design: in separate_columns mode the column is supposed to
  // carry the direction and the cell only a magnitude.
  //
  // But a charge reversal is written exactly this way by several banks — the
  // fee is put back in the same column it was taken from, with a minus — and
  // reading it as another charge gets the direction wrong and doubles the error
  // in the balance. The balance-continuity check does catch it as a warning, so
  // it is not silent; ranked accordingly.
  it("reads a negative in the withdrawal column as the reversal it is", () => {
    const result = readStatement(
      grid([
        ["01/04/2026", "SMS CHARGES", "500.00", ""],
        ["02/04/2026", "SMS CHARGES REVERSED", "-500.00", ""],
      ]),
      SIMPLE,
      0
    );
    expect(result.lines.map((l) => [l.withdrawalPaise, l.depositPaise])).toEqual([
      [50000, 0],
      [0, 50000],
    ]);
  });

  // The other half of the rule above, and the reason it is decided per column
  // rather than per row. A file that writes every withdrawal with a minus is
  // not reversing anything — the sign is the column's house style, and the
  // column already carries the direction. Reading each minus as a reversal
  // would invert the direction of the whole statement, which is a far worse
  // failure than the single misread row the reversal case costs.
  it("ignores a minus in a column where every value carries one", () => {
    const result = readStatement(
      grid([
        ["01/04/2026", "SMS CHARGES", "-500.00", ""],
        ["02/04/2026", "SUPPLIER PAYMENT", "-25,000.00", ""],
        ["03/04/2026", "CLIENT RECEIPT", "", "1,50,000.00"],
      ]),
      SIMPLE,
      0
    );
    expect(result.lines.map((l) => [l.withdrawalPaise, l.depositPaise])).toEqual([
      [50000, 0],
      [2500000, 0],
      [0, 15000000],
    ]);
  });
});

describe("readStatement — amount_with_type", () => {
  const TYPED: StatementProfile = {
    ...SIMPLE,
    amountMode: "amount_with_type",
    amountColumn: "Amount",
    typeColumn: "Dr/Cr",
    withdrawalColumn: null,
    depositColumn: null,
  };
  const rows = (type: string) => [
    ["Date", "Narration", "Amount", "Dr/Cr"],
    ["01/04/2026", "OFFICE SUPPLIES", "2,340.00", type],
  ];

  it("accepts every spelling of the indicator a bank uses", () => {
    for (const marker of ["Dr", "DR", "D", "debit", "Dr.", "W", "withdrawal"]) {
      expect(readStatement(rows(marker), TYPED, 0).lines[0]?.withdrawalPaise).toBe(234000);
    }
    for (const marker of ["Cr", "CR", "C", "credit", "Cr.", "dep", "deposit"]) {
      expect(readStatement(rows(marker), TYPED, 0).lines[0]?.depositPaise).toBe(234000);
    }
  });

  it("refuses a row whose indicator it cannot read rather than assuming a direction", () => {
    const result = readStatement(rows("?"), TYPED, 0);
    expect(result.lines).toEqual([]);
    expect(result.errors[0].message).toContain("debit or a credit");
  });

  it("lets a marker in the amount cell outrank the indicator column", () => {
    // The file being explicit twice, and disagreeing with itself: the cell wins.
    const result = readStatement(
      [
        ["Date", "Narration", "Amount", "Dr/Cr"],
        ["01/04/2026", "OFFICE SUPPLIES", "2,340.00 Cr", "Dr"],
      ],
      TYPED,
      0
    );
    expect(result.lines[0].depositPaise).toBe(234000);
  });
});

describe("readStatement — the running balance check", () => {
  it("catches the classic mis-mapping: withdrawals and deposits swapped", () => {
    const swapped: StatementProfile = {
      ...AXIS_PROFILE,
      withdrawalColumn: AXIS_PROFILE.depositColumn,
      depositColumn: AXIS_PROFILE.withdrawalColumn,
    };
    const result = readStatement(AXIS, swapped, AXIS_HEADER_ROW);
    expect(result.issues.some((i) => i.includes("running balance"))).toBe(true);
    expect(result.issues.some((i) => i.includes("swapped"))).toBe(true);
  });

  it("recognises a newest-first file as ordered, not broken", () => {
    const rows = [
      ["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
      ["18/04/2026", "ATM CASH WITHDRAWAL", "10,000.00", "", "1,20,000.00"],
      ["15/04/2026", "SUPPLIER PAYMENT", "20,000.00", "", "1,30,000.00"],
      ["10/04/2026", "CLIENT RECEIPT", "", "50,000.00", "1,50,000.00"],
    ];
    const result = readStatement(rows, { ...SIMPLE, balanceColumn: "Balance" }, 0);
    expect(result.issues).toEqual([
      "This statement is ordered newest first. That's fine — the dates are read from the file, not its order.",
    ]);
    // The dates still come from the cells, so the period is the right way round.
    expect(result.periodStart).toBe("2026-04-10");
    expect(result.periodEnd).toBe("2026-04-18");
  });

  it("does not fire on a file too short to tell order from error", () => {
    const rows = [
      ["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
      ["01/04/2026", "A", "100.00", "", "900.00"],
      ["02/04/2026", "B", "100.00", "", "700.00"],
    ];
    expect(readStatement(rows, { ...SIMPLE, balanceColumn: "Balance" }, 0).issues).toEqual([]);
  });

  // FAILS: an overdraft balance written "1,50,000.00 Dr" is read as
  // +15000000 paise. It should be -15000000 — a Dr balance on a bank account
  // means the account is overdrawn.
  //
  // parseAmountCell does extract explicitSign: "Dr" from the cell, but
  // readStatement's balance branch only consults `balance.negative`, which is
  // set by a minus sign or accounting parentheses and not by a Dr marker.
  //
  // Consequence, twice over. The running balance is +₹1,50,000 instead of
  // -₹1,50,000 on every row, so the continuity check compares nonsense and
  // emits a spurious "the running balance doesn't add up on 2 of 2 rows —
  // check withdrawals and deposits aren't swapped" against a mapping that is
  // perfectly correct. And closingBalancePaise, which the reconciliation screen
  // exists to compare against the ledger's own closing balance, comes back with
  // the wrong sign — so an OD or cash-credit account, which is what most Indian
  // businesses actually run, shows a phantom discrepancy of twice the balance
  // on the one screen whose entire job is to say whether the books and the bank
  // agree.
  it("reads an overdrawn balance as negative", () => {
    const rows = [
      ["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
      ["01/04/2026", "SUPPLIER PAYMENT", "50,000.00", "", "1,50,000.00 Dr"],
      ["03/04/2026", "SUPPLIER PAYMENT", "25,000.00", "", "1,75,000.00 Dr"],
      ["05/04/2026", "CUSTOMER RECEIPT", "", "1,00,000.00", "75,000.00 Dr"],
    ];
    const result = readStatement(rows, { ...SIMPLE, balanceColumn: "Balance" }, 0);
    expect(result.lines.map((l) => l.runningBalancePaise)).toEqual([-15000000, -17500000, -7500000]);
    expect(result.closingBalancePaise).toBe(-7500000);
    expect(result.issues).toEqual([]);
  });
});

describe("readStatement — duplicate header text", () => {
  it("takes the first of two identically named columns", () => {
    // Documented behaviour: a repeated header later in the row is the padding
    // column banks leave at the end.
    const rows = [
      ["Date", "Narration", "Withdrawal", "Deposit", "Withdrawal"],
      ["01/04/2026", "PAID", "100.00", "", "999.00"],
    ];
    expect(readStatement(rows, SIMPLE, 0).lines[0].withdrawalPaise).toBe(10000);
  });

  // FAILS: when two different columns share a header, both mappings resolve to
  // the same column and every row fails. This returns zero lines and the two
  // errors "Both the withdrawal and deposit columns have a value" and "No
  // amount on this row", with issues === []. It should raise a file-level issue
  // naming the duplicate, the way a missing column does.
  //
  // buildColumnIndex keys columns by header text, first occurrence wins, and
  // buildResolver's `missing` check only asks whether each mapped header
  // *exists* — never whether two mapped fields resolved to the same column.
  //
  // Consequence: XLS exports that carry a merged "Debit | Credit" super-header
  // produce two sub-columns with the same text, and the user maps them by
  // position in the mapping UI. The import then fails on every row with a
  // per-row message that blames the data ("both columns have a value") and
  // points at a mapping that looks right on screen, because the two fields do
  // show two different headers — they just happen to read the same. Loud rather
  // than silent, which is why it is ranked below the wrong-data findings, but
  // the message actively sends the user in the wrong direction.
  it("explains a mapping where two fields resolve to the same column", () => {
    const rows = [
      ["Date", "Narration", "Amount", "Amount"],
      ["01/04/2026", "PAID SUPPLIER", "25,000.00", ""],
      ["03/04/2026", "CLIENT RECEIPT", "", "1,50,000.00"],
    ];
    const result = readStatement(rows, { ...SIMPLE, withdrawalColumn: "Amount", depositColumn: "Amount" }, 0);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.join(" ")).toContain("Amount");
  });
});

describe("readStatement — the re-upload it has to survive", () => {
  it("gives a transaction the same fingerprint in two overlapping statements", () => {
    // The whole point of the fingerprint, exercised end to end: two exports of
    // overlapping periods, differing in preamble height and in how the portal
    // re-wrapped the narrations.
    const first = [
      ["Date", "Narration", "Withdrawal", "Deposit"],
      ["10/01/2026", "UPI-NETFLIX INDIA-9871234@ybl", "499.00", ""],
      ["15/01/2026", "UPI-SPOTIFY-9871234@ybl", "119.00", ""],
      ["15/01/2026", "UPI-SPOTIFY-9871234@ybl", "119.00", ""],
      ["20/01/2026", "NEFT DR-ICIC0000123-RAJESH TRADERS", "25,000.00", ""],
    ];
    const second = [
      ["Statement generated on 01/03/2026", "", "", ""],
      ["Date", "Narration", "Withdrawal", "Deposit"],
      ["15/01/2026", "upi/spotify/9871234@YBL", "119.00", ""],
      ["15/01/2026", "  UPI-SPOTIFY-9871234@ybl  ", "119.00", ""],
      ["20/01/2026", "NEFT DR-ICIC0000123-RAJESH TRADERS", "25,000.00", ""],
      ["02/02/2026", "UPI-ZOMATO-9871234@ybl", "310.00", ""],
    ];

    const a = readStatement(first, SIMPLE, 0).lines.map((l) => l.fingerprint);
    const b = readStatement(second, SIMPLE, 1).lines.map((l) => l.fingerprint);

    // Three of the second file's four lines were already seen; one is new.
    expect(b.filter((f) => a.includes(f))).toHaveLength(3);
    expect(b.filter((f) => !a.includes(f))).toHaveLength(1);
    // And the two identical Spotify charges stayed two transactions, not one.
    expect(new Set(a)).toHaveProperty("size", 4);
  });

  it("keeps two identical charges on one day apart", () => {
    const result = readStatement(
      grid([
        ["15/01/2026", "UPI-SPOTIFY-9871234@ybl", "119.00", ""],
        ["15/01/2026", "UPI-SPOTIFY-9871234@ybl", "119.00", ""],
      ]),
      SIMPLE,
      0
    );
    expect(result.lines.map((l) => l.occurrenceIndex)).toEqual([0, 1]);
    expect(result.lines[0].fingerprint).not.toBe(result.lines[1].fingerprint);
  });

  it("does not let a failed row shift the fingerprints of the good ones", () => {
    const withBadRow = readStatement(
      grid([
        ["15/01/2026", "UPI-SPOTIFY-9871234@ybl", "119.00", ""],
        ["not a date", "BROKEN", "500.00", ""],
        ["15/01/2026", "UPI-SPOTIFY-9871234@ybl", "119.00", ""],
      ]),
      SIMPLE,
      0
    );
    const without = readStatement(
      grid([
        ["15/01/2026", "UPI-SPOTIFY-9871234@ybl", "119.00", ""],
        ["15/01/2026", "UPI-SPOTIFY-9871234@ybl", "119.00", ""],
      ]),
      SIMPLE,
      0
    );
    expect(withBadRow.lines.map((l) => l.fingerprint)).toEqual(without.lines.map((l) => l.fingerprint));
  });
});

describe("locateHeaderRow", () => {
  it("finds the header again after the preamble has grown since the profile was saved", () => {
    // An extra "Statement generated on ..." line is enough to shift everything
    // by one, which is why the remembered skipRows is only the fallback.
    const shifted = [["Statement generated on 01/05/2026", "", "", "", "", "", ""], ...AXIS];
    expect(locateHeaderRow(shifted, AXIS_PROFILE)).toBe(AXIS_HEADER_ROW + 1);
  });

  it("finds it again after the preamble has shrunk", () => {
    const shrunk = AXIS.slice(2);
    expect(locateHeaderRow(shrunk, AXIS_PROFILE)).toBe(AXIS_HEADER_ROW - 2);
  });

  it("falls back to the remembered row when the date column has been renamed", () => {
    expect(locateHeaderRow(AXIS, { ...AXIS_PROFILE, dateColumn: "Posted On" })).toBe(AXIS_HEADER_ROW);
  });

  it("does not run off the end of a file shorter than the remembered skipRows", () => {
    expect(locateHeaderRow([["a"], ["b"]], { ...AXIS_PROFILE, dateColumn: "Posted On", skipRows: 40 })).toBe(1);
  });

  // FAILS: locateHeaderRow returns 1 here — a preamble row whose first cell is
  // the single word "Date". It should return 2, the real header row, which is
  // what detectHeaderRow returns for the same grid.
  //
  // locateHeaderRow takes the first row within the top 30 that contains a cell
  // equal to the remembered date column name, and stops. It has no second
  // signal: it does not check that the row contains any of the profile's other
  // columns, and it does not prefer a row nearer the remembered skipRows.
  //
  // Consequence: a "Date: 17/08/2026" generation stamp in the preamble — a
  // label cell and a value cell, which is how a spreadsheet export writes it —
  // is enough to capture the search. The saved profile then reads the preamble
  // row as the header, every mapped column is missing, and the import produces
  // zero lines plus per-row errors blaming the data. The same file imports
  // correctly on its very first upload, because first-contact detection scores
  // whole rows rather than looking for one cell; it only breaks once the
  // profile has been saved and is being reused, which is every upload after the
  // first.
  it("does not mistake a labelled preamble cell for the header row", () => {
    const withStamp = [
      ["ACME TRADING PVT LTD", "", "", "", ""],
      ["Date", "17/08/2026", "", "", ""],
      ["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
      ["01/04/2026", "UPI-SWIGGY-9871234@ybl", "482.00", "", "1,24,518.00"],
    ];
    expect(locateHeaderRow(withStamp, { ...SIMPLE, balanceColumn: "Balance", skipRows: 2 })).toBe(2);
  });
});

describe("summarizeStatement", () => {
  it("totals in paise and converts once, so the totals cannot drift", () => {
    const result = readStatement(
      grid([
        ["01/04/2026", "A", "100.10", ""],
        ["02/04/2026", "B", "200.20", ""],
        ["03/04/2026", "C", "", "300.30"],
      ]),
      SIMPLE,
      0
    );
    expect(summarizeStatement(result.lines)).toEqual({ withdrawals: 300.3, deposits: 300.3, count: 3 });
    // The same addition done in rupees is the one currency.ts exists to prevent.
    expect(100.1 + 200.2 === 300.3).toBe(false);
  });

  it("is zero for an empty statement rather than undefined", () => {
    expect(summarizeStatement([])).toEqual({ withdrawals: 0, deposits: 0, count: 0 });
  });
});
