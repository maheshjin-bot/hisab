import { describe, expect, it } from "vitest";
import { looksNumeric, parseAmountCell } from "@/lib/bank/amount";

/**
 * Amount cells arrive in every presentation an Indian bank has ever used, and
 * the module's own contract is "permissive about presentation, strict about
 * value": anything it cannot read must come back as null, never as a silent
 * zero, because a zero-amount row lands in the books as a missing transaction
 * rather than a visible failure.
 */

/** The non-breaking space a web portal leaves in a pasted amount. */
const NBSP = String.fromCharCode(0x00a0);

describe("parseAmountCell — presentation", () => {
  it("reads Indian digit grouping at every scale", () => {
    expect(parseAmountCell("1,234.56")?.paise).toBe(123456);
    expect(parseAmountCell("1,00,000.00")?.paise).toBe(10000000);
    expect(parseAmountCell("1,23,456.78")?.paise).toBe(12345678);
    expect(parseAmountCell("12,34,56,789.00")?.paise).toBe(12345678900);
  });

  it("strips currency symbols and the spaces a web portal pastes in", () => {
    expect(parseAmountCell("₹1,50,000.00")?.paise).toBe(15000000);
    expect(parseAmountCell("₹ 1,50,000.00")?.paise).toBe(15000000);
    expect(parseAmountCell(`₹${NBSP}1,50,000.00`)?.paise).toBe(15000000);
    expect(parseAmountCell(`1,50,000.00${NBSP}`)?.paise).toBe(15000000);
    expect(parseAmountCell("  482.00  ")?.paise).toBe(48200);
  });

  it("resolves a single comma by digit count rather than guessing", () => {
    // Three digits after the last comma is grouping; exactly two, with no other
    // comma and no dot, is a decimal comma.
    expect(parseAmountCell("1,234")?.paise).toBe(123400);
    expect(parseAmountCell("1234,56")?.paise).toBe(123456);
    expect(parseAmountCell("1.234.567,89")?.paise).toBe(123456789);
  });

  it("reads the several ways a statement writes a negative", () => {
    expect(parseAmountCell("-18000.00")).toMatchObject({ paise: 1800000, negative: true });
    expect(parseAmountCell("(500)")).toMatchObject({ paise: 50000, negative: true });
    expect(parseAmountCell("(1,234.56)")).toMatchObject({ paise: 123456, negative: true });
    expect(parseAmountCell("+500")).toMatchObject({ paise: 50000, negative: false });
    // The magnitude is always positive; `negative` is the only carrier of sign.
    expect(parseAmountCell("-18000.00")?.paise).toBeGreaterThan(0);
  });

  it("picks up a Dr/Cr marker written into the amount cell itself", () => {
    expect(parseAmountCell("1,234.56 Cr")).toMatchObject({ paise: 123456, explicitSign: "Cr" });
    expect(parseAmountCell("1,234.56 Dr")).toMatchObject({ paise: 123456, explicitSign: "Dr" });
    expect(parseAmountCell("500 CR.")?.explicitSign).toBe("Cr");
    expect(parseAmountCell("500 debit")?.explicitSign).toBe("Dr");
    expect(parseAmountCell("(1,234.56) Dr")).toMatchObject({
      paise: 123456,
      explicitSign: "Dr",
      negative: true,
    });
  });
});

describe("parseAmountCell — the cells that must not read as zero", () => {
  it("treats every shape of blank as absent", () => {
    // In separate-columns mode the unused side is blank on every row, and each
    // bank writes that blank differently.
    expect(parseAmountCell("")).toBeNull();
    expect(parseAmountCell("   ")).toBeNull();
    expect(parseAmountCell("-")).toBeNull();
    expect(parseAmountCell("–")).toBeNull();
    expect(parseAmountCell(".")).toBeNull();
    expect(parseAmountCell(null)).toBeNull();
    expect(parseAmountCell(undefined)).toBeNull();
  });

  it("refuses text rather than reading it as zero", () => {
    for (const cell of ["N/A", "NIL", "Opening Balance", "Dr 500", "Cr", "1,234.56.78", "12-34"]) {
      expect(parseAmountCell(cell)).toBeNull();
    }
  });

  it("distinguishes an explicit zero from a blank", () => {
    // "0.00" is a value the bank stated; "" is a side the transaction did not
    // use. readAmount() has to tell them apart to report a row with no amount.
    expect(parseAmountCell("0.00")).toMatchObject({ paise: 0 });
    expect(parseAmountCell("0")).toMatchObject({ paise: 0 });
    expect(parseAmountCell("")).toBeNull();
  });
});

describe("parseAmountCell — integer paise", () => {
  it("returns whole paise for every amount a statement can carry", () => {
    // The module-wide rule from lib/utils/currency.ts: paise are integers, and
    // a fractional one here would propagate into the fingerprint string and
    // into a numeric(18,2) column.
    const cells = [
      "0.01", "0.10", "100.10", "200.20", "482.00", "1,234.56",
      "1,00,000.00", "99,99,999.99", "(1,234.56)", "-18000.00", "1,234.56 Cr",
    ];
    for (const cell of cells) {
      const parsed = parseAmountCell(cell);
      expect(parsed).not.toBeNull();
      expect(Number.isInteger(parsed!.paise)).toBe(true);
    }
  });

  it("does not lose a paise across the sums that would drift in floats", () => {
    const paise = ["100.10", "200.20"].map((c) => parseAmountCell(c)!.paise);
    expect(paise).toEqual([10010, 20020]);
    expect(paise[0] + paise[1]).toBe(30030);
    // The same addition in rupees is the one currency.ts exists to prevent.
    expect(100.1 + 200.2 === 300.3).toBe(false);
  });

  // FAILS: parseAmountCell("1234567890123456789") returns
  // paise: 123456789012345680000, which is not a safe integer — the trailing
  // digits are already lost to float representation. It should return null (or
  // a value that survives Number.isSafeInteger), because a cell this large is
  // not an amount.
  //
  // parseAmountCell goes via Number() and toPaise()'s Math.round(rupees * 100).
  // Above roughly ninety trillion rupees the multiplication leaves the
  // safe-integer range and Math.round returns a float that only looks integral.
  //
  // Consequence is narrow but real: the value that comes out is stringified
  // into the line's fingerprint and written to a numeric(18,2) column, so a
  // mis-mapped column — an account number or a UTR read as the amount — lands
  // as a plausible-looking huge amount rather than a rejected row. Ranked last
  // of the findings, because reaching it needs a column mapping that the
  // balance-continuity check would already be shouting about.
  it("rejects a digit run too large to be an exact amount", () => {
    const parsed = parseAmountCell("1234567890123456789");
    if (parsed !== null) expect(Number.isSafeInteger(parsed.paise)).toBe(true);
  });
});

describe("looksNumeric", () => {
  it("is true for the cells column detection should count as amounts", () => {
    expect(looksNumeric("1,24,518.00")).toBe(true);
    expect(looksNumeric("0.00")).toBe(true);
    expect(looksNumeric("-18000.00")).toBe(true);
  });

  it("is false for text, dates and blanks", () => {
    for (const cell of ["", "Narration", "01/04/2026", "UPI-SWIGGY-9871234"]) {
      expect(looksNumeric(cell)).toBe(false);
    }
  });

  it("is false for a dash, which some banks use as the blank in an amount column", () => {
    // Pinned because detect.ts's contentScore treats a non-numeric cell as
    // evidence *against* a column being an amount column, and this is the cell
    // that makes that judgement wrong. See tests/bank-detect.test.ts.
    expect(looksNumeric("-")).toBe(false);
  });
});
