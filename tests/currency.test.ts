import { describe, expect, it } from "vitest";
import { formatCurrency, formatWithDrCr, fromPaise, sumPaise, toPaise } from "@/lib/utils/currency";

describe("paise arithmetic", () => {
  it("survives the float sums that would otherwise produce false imbalances", () => {
    // The case the module's own comment names: in raw floats this is false.
    expect(100.1 + 200.2 === 300.3).toBe(false);

    const paise = sumPaise([100.1, 200.2].map(toPaise));
    expect(paise).toBe(30030);
    expect(fromPaise(paise)).toBe(300.3);
  });

  it("keeps a long column of thirds exact", () => {
    const amounts = Array.from({ length: 300 }, () => 0.1);
    expect(fromPaise(sumPaise(amounts.map(toPaise)))).toBe(30);
    // The same sum in floats drifts.
    expect(amounts.reduce((a, b) => a + b, 0)).not.toBe(30);
  });

  it("rounds to the nearest paise", () => {
    expect(toPaise(0.004)).toBe(0);
    expect(toPaise(0.006)).toBe(1);
    expect(toPaise(1.014)).toBe(101);
    expect(toPaise(1.016)).toBe(102);
  });

  it("settles a sub-paise half the way the column does, not the way the float fell", () => {
    // toPaise used to be Math.round(rupees * 100), so an exact "half" landed
    // wherever the float did: 1.005 * 100 is 100.49999999999999 and rounded
    // down, while 2.675 * 100 is 267.50000000000006 and rounded up. Which way
    // it fell was not predictable from the decimal literal, and half the time
    // it disagreed with the column the value was on its way to.
    //
    // It now reads the decimal digits instead of multiplying, so both agree
    // with Postgres. Confirmed on PG 18.6:
    //   '1.005'::numeric(18,2) = 1.01,  '2.675'::numeric(18,2) = 2.68
    expect(toPaise(1.005)).toBe(101);
    expect(toPaise(2.675)).toBe(268);

    // Reachable: parseCsvAmount accepts three decimal places, so any CSV
    // voucher or opening-balance row can carry one of these.
    expect(toPaise(0.145)).toBe(15);
    expect(toPaise(33.675)).toBe(3368);
  });

  it("rounds a half away from zero on both sides, as Postgres round() does", () => {
    // Math.round is half toward +Infinity, so it disagreed with the column on
    // every negative half: Math.round(-0.5) is -0 where Postgres gives -1.
    // Confirmed: (-0.005)::numeric(18,2) = -0.01, (-1.005) = -1.01.
    expect(toPaise(-0.005)).toBe(-1);
    expect(toPaise(-1.005)).toBe(-101);
    expect(toPaise(-2.675)).toBe(-268);
    expect(toPaise(0.005)).toBe(1);
  });

  it("round-trips every amount it is given", () => {
    for (const rupees of [0, 0.01, 1, 99.99, 1234.56, 1_00_00_000.99]) {
      expect(fromPaise(toPaise(rupees))).toBe(rupees);
    }
  });

  it("treats a debit and an equal credit as balancing exactly", () => {
    const debits = [33.33, 33.33, 33.34].map(toPaise);
    const credits = [100].map(toPaise);
    expect(sumPaise(debits)).toBe(sumPaise(credits));
  });
});

describe("Indian currency formatting", () => {
  it("groups in lakhs and crores, not thousands", () => {
    //   is the non-breaking space Intl puts after the symbol.
    expect(formatCurrency(1000000)).toBe("₹10,00,000.00");
    expect(formatCurrency(314750)).toBe("₹3,14,750.00");
    expect(formatCurrency(10000000)).toBe("₹1,00,00,000.00");
  });

  it("drops decimals only when asked", () => {
    expect(formatCurrency(314750)).toBe("₹3,14,750.00");
    expect(formatCurrency(314750, { decimals: false })).toBe("₹3,14,750");
  });

  it("renders a side as a suffix rather than a minus sign", () => {
    expect(formatWithDrCr(1250)).toBe("₹1,250.00 Dr");
    expect(formatWithDrCr(-1250)).toBe("₹1,250.00 Cr");
    expect(formatWithDrCr(0)).toBe("₹0.00 Dr");
  });
});
