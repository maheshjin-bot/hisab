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

  it("documents the sub-paise inputs where float representation wins", () => {
    // toPaise is Math.round(rupees * 100), so an exact "half" depends on how
    // the float landed: 1.005 is really 1.00499999999999989 and rounds down,
    // while 2.675 is really 2.67500000000000027 and rounds up. Pinned rather
    // than asserted-as-correct — it is a real limitation, and which way it
    // falls is not predictable from the decimal literal.
    //
    // Not reachable from the voucher form, which steps in 0.01, but a CSV can
    // carry three decimals. The cost is one paise on such a row; the fix
    // would be parsing decimal strings instead of going via float, which is
    // worth doing only if a customer ever hits it.
    expect(toPaise(1.005)).toBe(100);
    expect(toPaise(2.675)).toBe(268);
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
