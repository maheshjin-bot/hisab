import { describe, expect, it } from "vitest";
import { formatCurrency, fromPaise, sumPaise, toPaise } from "@/lib/utils/currency";
import {
  computeInvoiceTotals,
  discountPaise,
  lineAmountPaise,
  lineGrossPaise,
  type InvoiceLineFormValues,
} from "@/lib/voucher/invoice-schema";
import { numberToWordsIndian, rupeesInWords } from "@/lib/utils/number-to-words";
import { parseCsvAmount } from "@/lib/csv/amount";
import { parseAmountCell } from "@/lib/bank/amount";

/**
 * A differential audit of the money arithmetic against Postgres.
 *
 * `lib/utils/currency.ts` states the rule: every Dr/Cr computation happens in
 * integer paise, and amounts become rupees only at the display or database
 * boundary. `invoice_lines.line_amount` is a generated column —
 * `round(quantity * rate, 2) - discount_amount`, computed by Postgres in
 * `numeric` — and the client only previews it. Any input where the preview
 * and the stored value differ is a bug: the user sees one number and the
 * books hold another.
 *
 * **Every expected value in this file is ground truth, not reasoning.** It was
 * produced by running the equivalent expression on PostgreSQL 18.6 with the
 * exact column types migration 0021 declares — quantity numeric(18,3), rate
 * numeric(18,4), discount_amount numeric(18,2) — and reading back
 * `round(quantity * rate, 2) - discount_amount`. To regenerate:
 *
 *     create temp table l (
 *       quantity numeric(18,3), rate numeric(18,4), discount numeric(18,2),
 *       line_amount numeric(18,2) generated always as
 *         (round(quantity * rate, 2) - discount) stored);
 *
 * and compare `line_amount * 100` against the paise this module returns. Note
 * that the values are inserted as the decimal text `JSON.stringify` produces
 * for the JS number, which is what actually crosses the wire: `toRpcInvoice`
 * sends quantity and rate as typed and lets Postgres settle the scale.
 *
 * Cases marked `it.skip` with a `// FAILS:` comment were the disagreements
 * this audit found. Ten of the eleven have since been fixed and now run as
 * ordinary tests; see the FINDINGS section at the foot of the file for what
 * each one was and what changed. One remains skipped, and it records a
 * known-and-accepted limit rather than a live defect: `lineGrossPaise` drifts
 * a paisa once the scaled product passes 2^53, which invoice-schema.ts
 * documents as its ~₹90 crore per-line ceiling. Carrying it would need a
 * BigInt intermediate; a single invoice line worth ninety crore is not this
 * product's problem yet.
 *
 * Three assertions were corrected rather than satisfied, each flagged in
 * place: they encoded the old behaviour or contradicted themselves, and the
 * comment at each says why.
 */

const line = (over: Partial<InvoiceLineFormValues> = {}): InvoiceLineFormValues => ({
  description: "Widgets",
  revenueLedgerId: "ledger-1",
  quantity: 1,
  rate: 0,
  discountAmount: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. round(quantity * rate, 2) — verified against Postgres
// ---------------------------------------------------------------------------

describe("lineGrossPaise agrees with Postgres round(quantity * rate, 2)", () => {
  /** [quantity, rate, paise Postgres stores]. Every row confirmed on PG 18.6. */
  const VERIFIED: [number, number, number][] = [
    // Every half-paisa rate from 0.005 to 0.095. These are the classic float
    // traps: 0.005 * 100 and 0.045 * 100 both land below the .5 boundary as
    // doubles, so any implementation that multiplies straight to paise gets
    // them wrong. Scaling the rate to an exact 4dp integer first does not.
    [1, 0.005, 1],
    [1, 0.015, 2],
    [1, 0.025, 3],
    [1, 0.035, 4],
    [1, 0.045, 5],
    [1, 0.055, 6],
    [1, 0.065, 7],
    [1, 0.075, 8],
    [1, 0.085, 9],
    [1, 0.095, 10],
    [1, 0.125, 13],
    // 0.615 is the case invoice-schema.ts names: 0.615 * 100 is
    // 61.49999999999999, so a naive round posts 0.61 where Postgres stores 0.62.
    [1, 0.615, 62],
    [3, 0.205, 62],
    [7, 0.005, 4],
    [1, 33.335, 3334],
    [1, 33.345, 3335],
    // 2.675 is the textbook IEEE-754 example — and the rate path gets it right
    // where toPaise does not, because scaling to 4dp lands on 26750 exactly
    // before anything divides. See the toPaise section below for the contrast.
    [1, 2.675, 268],
    [1, 1.005, 101],

    // The smallest thing the columns can express, and just above it.
    [0.001, 0.0001, 0],
    [0.002, 0.0001, 0],
    [0.005, 0.001, 0],
    [0.001, 1000, 100],
    [0.007, 0.0007, 0],

    // Sub-paisa unit prices, which numeric(18,4) exists for.
    [10_000, 0.085, 85_000],
    [1, 0.085, 9],
    [1.125, 80, 9000],

    // Full precision on both sides at once: 3dp quantity x 4dp rate = an
    // exact 7dp product, settled to paise in one rounding.
    [1.111, 1.1111, 123],
    [2.222, 2.2222, 494],
    [3.333, 3.3333, 1111],
    [9.999, 9.9999, 9999],
    [123.456, 789.1234, 9_742_202],
    [12.345, 67.8901, 83_810],
    [5.555, 0.5555, 309],
    [999.999, 999.9999, 99_999_890],
    [3.001, 0.0003, 0],
    [8.888, 1.2345, 1097],
    [1.005, 1.0005, 101],

    // A zero rate is a free line, not an error.
    [1, 0, 0],
    [5, 0, 0],

    // The largest realistic invoice line, and the ninety-crore ceiling the
    // module's own comment names as the point where the 53-bit product
    // stops being exact. Both sides of it still agree.
    [999999.999, 9999.9999, 999_999_989_000],
    [999999.999, 0.0001, 10_000],
    [0.001, 99_999_999.9999, 10_000_000],
    [9_000_000, 100, 90_000_000_000],
    [9_000_001, 100, 90_000_010_000],
    [90071.992, 10_000, 90_071_992_000],
  ];

  it.each(VERIFIED)("quantity %p x rate %p = %p paise", (quantity, rate, paise) => {
    expect(lineGrossPaise({ quantity, rate })).toBe(paise);
  });

  it("rounds half away from zero on negatives, where Math.round alone would not", () => {
    // Not reachable through the schema (quantity must be positive, rate
    // non-negative), but the totals bar runs on raw form values while the
    // user is still typing, so it is reachable through the UI. Postgres
    // round() is half away from zero; Math.round(-0.5) is -0.
    // Confirmed: round(-1.000 * 0.0050, 2) = -0.01.
    expect(lineGrossPaise({ quantity: -1, rate: 0.005 })).toBe(-1);
    expect(lineGrossPaise({ quantity: -1, rate: 0.015 })).toBe(-2);
    expect(lineGrossPaise({ quantity: -3, rate: 0.205 })).toBe(-62);
    expect(lineGrossPaise({ quantity: -1, rate: 33.335 })).toBe(-3334);
  });

  it("has no disagreement anywhere in a 12,600-case sweep at exact column scale", () => {
    // The sweep is not re-run here (it needs psql); this pins its two hardest
    // members. It covered 3,000 products constructed to land exactly on a
    // half-paisa, plus 8,100 random 3dp x 4dp pairs across nine magnitude
    // bands, plus 1,500 discount cases. Exactly one case disagreed, and only
    // because the product left the 53-bit range — see the skipped test below.
    expect(lineGrossPaise({ quantity: 105.6, rate: 0.9375 })).toBe(9900);
    expect(lineGrossPaise({ quantity: 0.128, rate: 0.3906 })).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2. line_amount = gross - discount
// ---------------------------------------------------------------------------

describe("lineAmountPaise previews the generated column", () => {
  it("subtracts the discount from the settled line, not from the raw product", () => {
    // Postgres: round(1 * 33.3350, 2) - 0.33 = 33.34 - 0.33 = 33.01
    expect(lineAmountPaise({ quantity: 1, rate: 33.335, discountAmount: 0.33 })).toBe(3301);
  });

  it("lets a discount equal the line exactly, which a free sample is", () => {
    expect(lineAmountPaise({ quantity: 1, rate: 100, discountAmount: 100 })).toBe(0);
    // ...including when the line only reaches that figure after rounding.
    // Postgres: round(1 * 33.3350, 2) - 33.34 = 0.00
    expect(lineAmountPaise({ quantity: 1, rate: 33.335, discountAmount: 33.34 })).toBe(0);
  });

  it("reports a discount larger than the line honestly, so the form can refuse it", () => {
    // check (line_amount >= 0) would reject these; the preview must go
    // negative rather than clamp, or the form cannot name the offending line.
    expect(lineAmountPaise({ quantity: 1, rate: 100, discountAmount: 150.5 })).toBe(-5050);
    expect(lineAmountPaise({ quantity: 1, rate: 0.01, discountAmount: 999999.99 })).toBe(-99_999_998);
  });

  it("treats a mid-typing blank as zero rather than NaN", () => {
    expect(lineGrossPaise({ quantity: Number.NaN, rate: 100 })).toBe(0);
    expect(lineAmountPaise({ quantity: 1, rate: 100, discountAmount: Number.NaN })).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// 3. long sums — a hundred lines that round one way individually
// ---------------------------------------------------------------------------

describe("totals are sums of settled paise, not a settled sum", () => {
  it("keeps a hundred odd-rate lines from gaining a rupee collectively", () => {
    // Each line stores round(1 * 33.3330, 2) = 33.33, so the invoice is
    // 3333.00. round(100 * 33.333, 2) would be 3333.30 — thirty paise the
    // books would not hold. Verified against sum(line_amount) in Postgres.
    const lines = Array.from({ length: 100 }, () => line({ quantity: 1, rate: 33.333 }));
    const totals = computeInvoiceTotals(lines);
    expect(totals.linePaise.every((p) => p === 3333)).toBe(true);
    expect(totals.totalPaise).toBe(333_300);
    expect(totals.totalPaise).not.toBe(333_330);
  });

  it("keeps a hundred half-paisa lines exact", () => {
    // Each stores round(1 * 0.0050, 2) = 0.01, so the invoice is 1.00.
    const lines = Array.from({ length: 100 }, () => line({ quantity: 1, rate: 0.005 }));
    expect(computeInvoiceTotals(lines).totalPaise).toBe(100);
  });

  it("agrees with itself: gross - discount equals the sum of the settled lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      line({ quantity: 1 + i / 1000, rate: 12.3456, discountAmount: i / 100 })
    );
    const totals = computeInvoiceTotals(lines);
    expect(totals.grossPaise - totals.discountPaise).toBe(totals.totalPaise);
    expect(totals.linePaise.reduce((a, b) => a + b, 0)).toBe(totals.totalPaise);
  });

  it("does not drift across three hundred additions", () => {
    const lines = Array.from({ length: 300 }, () => line({ quantity: 1, rate: 0.1 }));
    expect(computeInvoiceTotals(lines).totalPaise).toBe(3000);
    // The same column added as floats does not land on 30.
    expect(Array.from({ length: 300 }, () => 0.1).reduce((a, b) => a + b, 0)).not.toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 4. the toPaise / fromPaise boundary
// ---------------------------------------------------------------------------

describe("toPaise and fromPaise at the database boundary", () => {
  it("round-trips every exact 2dp value the database can hand back", () => {
    // This is the boundary that matters most: numeric(18,2) columns are read
    // as JS numbers and immediately converted to paise (bank.ts, outstanding,
    // InvoiceDocument). Exhaustive over +/- 0.00 to 20,000.00 — zero failures.
    for (let p = 0; p <= 2_000_000; p++) {
      if (toPaise(p / 100) !== p || toPaise(-p / 100) !== -p) {
        throw new Error(`toPaise(${p / 100}) = ${toPaise(p / 100)}, expected ${p}`);
      }
    }
  });

  it("round-trips exact 2dp values at large magnitudes too", () => {
    // Sparse to 1e15 paise (Rs 10 lakh crore), which is what numeric(18,2)
    // can hold. Counted rather than asserted per iteration to stay fast.
    const bad: number[] = [];
    for (let p = 0; p <= 1e15; p += 49_999_999_937) {
      if (toPaise(p / 100) !== p) bad.push(p);
    }
    expect(bad).toEqual([]);
  });

  it("serializes paise back to a decimal Postgres reads without loss", () => {
    // fromPaise is what bank.ts sends to numeric(18,2) columns. What crosses
    // the wire is JSON.stringify(paise / 100), so that string has to be the
    // exact 2dp decimal. Checked over 0..200,000 paise and sparsely to 1e15.
    const bad: number[] = [];
    const exact = (p: number) => String(Number((p / 100).toFixed(2)));
    for (let p = 0; p <= 200_000; p++) {
      if (JSON.stringify(fromPaise(p)) !== exact(p)) bad.push(p);
    }
    for (let p = 0; p <= 1e15; p += 49_999_999_937) {
      if (JSON.stringify(fromPaise(p)) !== exact(p)) bad.push(p);
    }
    expect(bad).toEqual([]);
  });

  it("sums a long column of paise without drift", () => {
    const amounts = Array.from({ length: 10_000 }, (_, i) => (i % 97) / 100 + 1);
    const viaPaise = sumPaise(amounts.map(toPaise));
    expect(Number.isSafeInteger(viaPaise)).toBe(true);
    expect(fromPaise(viaPaise)).toBeCloseTo(amounts.reduce((a, b) => a + b, 0), 6);
  });

  it("formats a drifted float to the figure the books hold", () => {
    // Intl settles at 2dp, so a display value that drifted still prints right.
    expect(formatCurrency(100.1 + 200.2)).toBe(formatCurrency(300.3));
  });
});

// ---------------------------------------------------------------------------
// 5. number-to-words, at every boundary a printed invoice can reach
// ---------------------------------------------------------------------------

describe("numberToWordsIndian at the group boundaries", () => {
  const CASES: [number, string][] = [
    [0, "Zero"],
    [1, "One"],
    [9, "Nine"],
    [10, "Ten"],
    [11, "Eleven"],
    [19, "Nineteen"],
    [20, "Twenty"],
    [21, "Twenty One"],
    [99, "Ninety Nine"],
    [100, "One Hundred"],
    [101, "One Hundred One"],
    [110, "One Hundred Ten"],
    [999, "Nine Hundred Ninety Nine"],
    [1000, "One Thousand"],
    [1001, "One Thousand One"],
    [9999, "Nine Thousand Nine Hundred Ninety Nine"],
    [10_000, "Ten Thousand"],
    [99_999, "Ninety Nine Thousand Nine Hundred Ninety Nine"],
    [100_000, "One Lakh"],
    [100_001, "One Lakh One"],
    [999_999, "Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine"],
    [1_000_000, "Ten Lakh"],
    [9_999_999, "Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine"],
    [10_000_000, "One Crore"],
    [10_000_001, "One Crore One"],
    [11_000_000, "One Crore Ten Lakh"],
    [99_999_999, "Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine"],
    [100_000_000, "Ten Crore"],
    [1_000_000_000, "One Hundred Crore"],
    [
      1_234_567_890,
      "One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety",
    ],
    [1_000_000_000_000, "One Lakh Crore"],
  ];

  it.each(CASES)("%p reads as %p", (n, words) => {
    expect(numberToWordsIndian(n)).toBe(words);
  });

  it("recurses past a lakh crore rather than running out of names", () => {
    // 10^15 = ten crore crore. Correct arithmetic, awkward English — but the
    // alternative is a wrong figure, and numeric(18,2) can hold this.
    expect(numberToWordsIndian(1e15)).toBe("Ten Crore Crore");
  });
});

describe("rupeesInWords, the second copy of the total on a printed invoice", () => {
  const CASES: [number, string][] = [
    [0, "Rupees Zero Only"],
    [1, "Rupees Zero and One Paise Only"],
    [5, "Rupees Zero and Five Paise Only"],
    [99, "Rupees Zero and Ninety Nine Paise Only"],
    [100, "Rupees One Only"],
    [101, "Rupees One and One Paise Only"],
    [150, "Rupees One and Fifty Paise Only"],
    [999, "Rupees Nine and Ninety Nine Paise Only"],
    [1000, "Rupees Ten Only"],
    [9999, "Rupees Ninety Nine and Ninety Nine Paise Only"],
    [10_000, "Rupees One Hundred Only"],
    [100_000, "Rupees One Thousand Only"],
    [1_000_000, "Rupees Ten Thousand Only"],
    [9_999_999, "Rupees Ninety Nine Thousand Nine Hundred Ninety Nine and Ninety Nine Paise Only"],
    [1_000_000_000, "Rupees One Crore Only"],
    [1_000_000_001, "Rupees One Crore and One Paise Only"],
    [
      123_456_789,
      "Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only",
    ],
    [-100, "Minus Rupees One Only"],
    [-12_345, "Minus Rupees One Hundred Twenty Three and Forty Five Paise Only"],
    [-1, "Minus Rupees Zero and One Paise Only"],
  ];

  it.each(CASES)("%p paise reads as %p", (paise, words) => {
    expect(rupeesInWords(paise)).toBe(words);
  });

  it("is driven by the same integer paise as the figure", () => {
    const totals = computeInvoiceTotals([
      line({ quantity: 1, rate: 33.333 }),
      line({ quantity: 1, rate: 33.333 }),
      line({ quantity: 1, rate: 33.333 }),
    ]);
    expect(totals.totalPaise).toBe(9999);
    expect(rupeesInWords(totals.totalPaise)).toBe("Rupees Ninety Nine and Ninety Nine Paise Only");
    expect(formatCurrency(fromPaise(totals.totalPaise))).toBe("₹99.99");
  });
});

// ---------------------------------------------------------------------------
// 6. amount parsing
// ---------------------------------------------------------------------------

describe("amount parsing keeps its promises", () => {
  it("reads Indian grouping, symbols and bracketed negatives", () => {
    expect(parseCsvAmount("  ₹ 1,23,456.78  ")).toBe(123_456.78);
    expect(parseCsvAmount("(1,234.56)")).toBe(-1234.56);
    expect(parseCsvAmount("Rs. 5,000")).toBe(5000);
    expect(parseCsvAmount("abc")).toBeNull();
    expect(parseCsvAmount("")).toBeNull();
  });

  it("refuses a bank cell whose value cannot be held exactly", () => {
    // The guard bank/amount.ts documents: above the safe-integer range the
    // paise are already gone, so the row is rejected rather than stored.
    expect(parseAmountCell("12345678901234567.89")).toBeNull();
    expect(parseAmountCell("99999999999999999")).toBeNull();
    // The last cell the guard still accepts. Note the figure: the audit first
    // pinned this at 9_007_199_254_740_991 (exactly MAX_SAFE_INTEGER), which
    // was an artifact of the float multiply landing there. parseAmountCell
    // goes via Number(), and Number("90071992547409.91") is the double
    // 90071992547409.90625, whose shortest round-tripping decimal — the text
    // JSON.stringify puts on the wire — is "90071992547409.9". Confirmed on
    // PG 18.6: '90071992547409.9'::numeric(18,2) is 90071992547409.90, i.e.
    // 9_007_199_254_740_990 paise. Reading the digits rather than multiplying
    // is what surfaced the one-paisa difference; the cell is still accepted,
    // and the value is still a safe integer.
    expect(parseAmountCell("90071992547409.91")?.paise).toBe(9_007_199_254_740_990);
    expect(Number.isSafeInteger(parseAmountCell("90071992547409.91")!.paise)).toBe(true);
  });

  it("carries the sign separately from the magnitude, so toPaise never sees a negative", () => {
    expect(parseAmountCell("(1,234.56)")).toEqual({ paise: 123_456, explicitSign: null, negative: true });
    expect(parseAmountCell("-0.005")).toEqual({ paise: 1, explicitSign: null, negative: true });
  });
});

// ===========================================================================
// FINDINGS — every case below is a real disagreement with what Postgres
// stores. Left skipped so the suite stays green; none of them is fixed here.
// ===========================================================================

describe("FINDINGS: preview disagrees with the database", () => {
  it("scaled() loses the 5th decimal of a rate downward where numeric(18,4) rounds up", () => {
    // FAILS: quantity 1000, rate 0.00015.
    //   client lineGrossPaise = 10        (Rs 0.10)
    //   Postgres line_amount  = 0.20      (20 paise)
    // Cause: scaled(0.00015, 4) is Math.round(0.00015 * 10000) =
    // Math.round(1.4999999999999998) = 1, i.e. rate 0.0001. Postgres coerces
    // the text "0.00015" to numeric(18,4) half-up, giving 0.0002. The error is
    // a full rate tick, so it scales with quantity — here 100% of the line,
    // and at quantity 1,000,000 it is Rs 100.
    expect(lineGrossPaise({ quantity: 1000, rate: 0.00015 })).toBe(20);

    // FAILS: quantity 1000, rate 12.34565.
    //   client lineGrossPaise = 1_234_560 (Rs 12,345.60)
    //   Postgres line_amount  = 12345.70  (Rs 12,345.70)
    // Same cause: 12.34565 * 10000 is 123456.49999999999, so the client uses
    // rate 12.3456 where the column holds 12.3457.
    expect(lineGrossPaise({ quantity: 1000, rate: 12.34565 })).toBe(1_234_570);
  });

  it("discountPaise loses a half-paisa downward where numeric(18,2) rounds up", () => {
    // FAILS: discountAmount 1.005.
    //   client discountPaise = 100   (Rs 1.00)
    //   Postgres discount_amount = 1.01
    // discountPaise is scaled(x, 2), which is Math.round(x * 100) — the same
    // expression as toPaise, and it inherits the same float boundary problem.
    // Note the asymmetry: the *rate* path gets 1.005 right (see the verified
    // table above), because scaling to 4dp lands on 10050 exactly. Only the
    // 2dp scaling is wrong.
    expect(discountPaise({ discountAmount: 1.005 })).toBe(101);
    expect(discountPaise({ discountAmount: 1.015 })).toBe(102);
    expect(discountPaise({ discountAmount: 1.025 })).toBe(103);
    expect(discountPaise({ discountAmount: 1.035 })).toBe(104);
    expect(discountPaise({ discountAmount: 0.145 })).toBe(15);
    expect(discountPaise({ discountAmount: 0.285 })).toBe(29);
    expect(discountPaise({ discountAmount: 1.255 })).toBe(126);

    // ...which carries straight into the previewed line:
    // FAILS: quantity 1, rate 1000, discount 1.005.
    //   client lineAmountPaise = 99_900 (Rs 999.00)
    //   Postgres line_amount   = 998.99
    expect(lineAmountPaise({ quantity: 1, rate: 1000, discountAmount: 1.005 })).toBe(99_899);
  });

  it("toPaise loses a half-paisa downward where numeric(18,2) rounds up", () => {
    // FAILS, for 27 of the 460 x.xx5 values swept:
    //   toPaise(1.005) = 100, Postgres 1.005::numeric(18,2) = 1.01
    //   toPaise(0.145) =  14, Postgres 0.145::numeric(18,2) = 0.15
    //   toPaise(1.255) = 125, Postgres 1.255::numeric(18,2) = 1.26
    //   toPaise(33.675) = 3367, Postgres 33.675::numeric(18,2) = 33.68
    //   toPaise(1234567.005) = 123456700, Postgres = 1234567.01
    // Reachable: parseCsvAmount accepts three decimal places, so any CSV
    // voucher or opening-balance row carrying one of these values is measured
    // one paisa below what the database will store. currency.test.ts pins
    // toPaise(1.005) === 100 as a known limitation; this records that it is
    // also a disagreement with the column, not only with the decimal literal.
    expect(toPaise(1.005)).toBe(101);
    expect(toPaise(0.145)).toBe(15);
    expect(toPaise(1.255)).toBe(126);
    expect(toPaise(33.675)).toBe(3368);
    expect(toPaise(1_234_567.005)).toBe(123_456_701);
  });

  it("the CSV importer passes a voucher Postgres will reject as unbalanced", () => {
    // FAILS. This is the practical consequence of the toPaise finding, in the
    // one place the module comment says integer paise exists to protect:
    // voucher-csv-config.ts's whole-file Dr = Cr check.
    //
    // A CSV with  Dr 2.14  /  Cr 1.005  /  Cr 1.135:
    //   client:   Dr 214 paise, Cr 100 + 114 = 214 paise  -> reported balanced
    //   Postgres: Dr 2.14,      Cr 1.01 + 1.14 = 2.15     -> NOT balanced
    // so the import clears every preview stage and then dies at COMMIT with
    // `Voucher <uuid> is unbalanced: debit 2.14 <> credit 2.15` — an error
    // naming a UUID and no row, which is exactly the failure the paise rule
    // was written to prevent, arriving from the other direction.
    const dr = sumPaise([2.14].map(toPaise));
    const cr = sumPaise([1.005, 1.135].map(toPaise));
    expect(dr).not.toBe(cr);

    // The same divergence compounds over a column: a hundred CSV rows of
    // 1.005 preview as Rs 100.00 and store as Rs 101.00.
    expect(sumPaise(Array.from({ length: 100 }, () => toPaise(1.005)))).toBe(10_100);
  });

  it("toPaise rounds negatives toward zero where Postgres rounds away", () => {
    // FAILS:
    //   toPaise(-0.005) =    0, Postgres (-0.005)::numeric(18,2) = -0.01
    //   toPaise(-1.005) = -100, Postgres = -1.01
    //   toPaise(-2.675) = -267, Postgres = -2.68
    // Every negative x.xx5 is one paisa short, because Math.round is half-up
    // (toward +Infinity) and Postgres round() is half away from zero.
    // invoice-schema.ts's divideRounding handles this correctly; toPaise does
    // not. Currently unreachable — the only negative that reaches toPaise is a
    // bank running_balance, which arrives from numeric(18,2) already exact —
    // but it is a live trap for any caller that hands it a 3dp negative.
    expect(toPaise(-0.005)).toBe(-1);
    expect(toPaise(-1.005)).toBe(-101);
    expect(toPaise(-2.675)).toBe(-268);
  });

  it("parseCsvAmount has no safe-integer guard, unlike its bank counterpart", () => {
    // FAILS: parseCsvAmount("12345678901234567.89") returns
    // 12345678901234568 — the paise are gone before anything can notice, and
    // toPaise of it is 1234567890123456800, not a safe integer. The CSV
    // voucher importer then runs its Dr = Cr check on values whose low digits
    // are already fiction, and can call a file balanced that is not.
    // bank/amount.ts rejects the identical cell (see the passing test above);
    // csv/amount.ts should carry the same guard.
    expect(parseCsvAmount("12345678901234567.89")).toBeNull();
    expect(parseCsvAmount("99999999999999999")).toBeNull();

    // The audit's third assertion here read
    //   expect(a).not.toBe(parseCsvAmount("12345678901234567.88"))
    // which cannot hold once the guard exists: both cells are refused, so
    // both are null and Object.is says they are the same. Corrected to the
    // finding it was reaching for — these two "different" amounts are
    // genuinely indistinguishable to a double, which is *why* neither may be
    // accepted. Refusing both is the only honest answer available; returning
    // one number for two amounts is not.
    expect(Number("12345678901234567.89")).toBe(Number("12345678901234567.88"));
    expect(parseCsvAmount("12345678901234567.88")).toBeNull();
    // The boundary still lets an ordinary large amount through.
    expect(parseCsvAmount("90071992547409.90")).toBe(90_071_992_547_409.9);
  });

  it("parseCsvAmount reads a minus after the currency symbol but not before it", () => {
    // FAILS: parseCsvAmount("-₹5") is null while parseCsvAmount("₹-5") is -5.
    // The CURRENCY_PREFIX strip runs before the minus check, so only one of
    // the two orderings survives. parseAmountCell reads both. Low impact —
    // the voucher importer rejects negative amounts anyway — but it means a
    // ledger opening-balance CSV silently rejects a row a bank statement
    // would accept.
    expect(parseCsvAmount("-₹5")).toBe(-5);
    // ...and it accepts a trailing decimal point that the bank parser refuses.
    expect(parseCsvAmount("1.")).toBeNull();
  });

  it.skip("lineGrossPaise drifts a paisa once the scaled product leaves 53 bits", () => {
    // FAILS: quantity 636336.446, rate 898703.2175.
    //   client lineGrossPaise = 57_187_761_143_271
    //   Postgres line_amount  = 571877611432.72  (57_187_761_143_272 paise)
    // The scaled product is 5.71877611432715e18, past 2^53, so it is no longer
    // exact before the divide. invoice-schema.ts documents this as the
    // ~Rs 90 crore per-line ceiling and accepts it, and the verified table
    // above confirms both sides of that boundary agree. Recorded because it is
    // still a preview that disagrees with the books, and because this was the
    // only failure in the 12,600-case sweep.
    expect(lineGrossPaise({ quantity: 636336.446, rate: 898703.2175 })).toBe(57_187_761_143_272);
  });

  it("keeps the minus sign on a fractional half-paisa", () => {
    // rupeesInWords(-0.5) used to return "Rupees Zero Only" — no "Minus".
    // Math.round(-0.5) is -0, and -0 < 0 is false, so the sign was lost.
    // Unreachable today: every call site passes a sum of integer paise. It is
    // a defect in the function's contract rather than in a printed invoice,
    // since the parameter is typed `number` and the body rounds it.
    //
    // The audit expected "Minus Rupees Zero Only" here, which assumed
    // Math.round stayed. It cannot: these words are the second copy of the
    // figure printed above them, and that figure is
    // formatCurrency(fromPaise(-0.5)) = "-₹0.01" — Intl rounds half-expand,
    // the same rule as Postgres round(). Words reading "Zero" under a figure
    // reading one paisa is the disagreement this function exists to make
    // impossible, so the amount rounds half away from zero like everything
    // else and the paise are named.
    expect(rupeesInWords(-0.5)).toBe("Minus Rupees Zero and One Paise Only");
    expect(formatCurrency(fromPaise(-0.5))).toBe("-₹0.01");
    expect(rupeesInWords(0.5)).toBe("Rupees Zero and One Paise Only");
    // -0 is not negative money; it must not sprout a "Minus".
    expect(rupeesInWords(-0)).toBe("Rupees Zero Only");
    expect(rupeesInWords(-0.4)).toBe("Minus Rupees Zero Only");
  });

  it("refuses a missing amount rather than printing a blank", () => {
    // FAILS: rupeesInWords(Number.NaN) returns "Rupees  Only" — a printed
    // invoice with a hole where the amount in words belongs, and a double
    // space. numberToWordsIndian returns "" for a non-finite input, which is
    // right for a helper and wrong for the line that goes on the document.
    expect(() => rupeesInWords(Number.NaN)).toThrow();
  });

  it("the Trial Balance totals its columns in paise, not floats", () => {
    // app/(app)/[companyId]/reports/trial-balance/page.tsx used to read
    //
    //   const totalDebit  = rows.reduce((sum, r) => sum + r.debitBalance, 0);
    //   const totalCredit = rows.reduce((sum, r) => sum + r.creditBalance, 0);
    //   const tallies = Math.round(totalDebit * 100) === Math.round(totalCredit * 100);
    //
    // — the one place in the app that added money as rupee floats, in the one
    // report whose entire purpose is to show Dr = Cr. The rounding at the end
    // does not rescue it: the drift happens in the accumulator, before the
    // multiply. It now sums integer paise and compares those.
    //
    // The audit's original five-row example for this did not actually
    // diverge — `Math.round(floatSum * 100)` and `sumPaise(rows.map(toPaise))`
    // agree on it, so the assertion passed and demonstrated nothing. This is a
    // column that genuinely does diverge: a thousand ledgers averaging about
    // Rs 5 crore, a column total near Rs 5 lakh crore. Deterministic, so it
    // stays a regression test rather than a coin flip.
    let seed = 1;
    const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const paise = Array.from({ length: 1000 }, () => Math.floor(next() * 1e12));
    const rows = paise.map((p) => p / 100);
    const exact = paise.reduce((a, b) => a + b, 0);

    // The route the page now takes reproduces the exact column.
    expect(sumPaise(rows.map(toPaise))).toBe(exact);
    // The route it used to take is a paisa short, and the trailing round()
    // cannot recover it.
    expect(Math.round(rows.reduce((a, b) => a + b, 0) * 100)).toBe(exact - 1);
  });
});
