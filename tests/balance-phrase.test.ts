import { describe, expect, it } from "vitest";
import { balancePhrase } from "@/lib/ledgers/balance-phrase";

describe("balancePhrase", () => {
  it("says a customer in debit owes you", () => {
    expect(balancePhrase(5000, "debtor")).toEqual({ amount: 5000, caption: "they owe", isLiability: false });
  });

  it("does not claim a customer who has paid in advance still owes you", () => {
    // The receipt that put them in credit is money of theirs you are holding.
    const phrase = balancePhrase(-5000, "debtor");
    expect(phrase.caption).toBe("advance received");
    expect(phrase.isLiability).toBe(true);
    expect(phrase.amount).toBe(5000);
  });

  it("says you owe a supplier in credit", () => {
    expect(balancePhrase(-2500, "creditor")).toEqual({ amount: 2500, caption: "you owe", isLiability: true });
  });

  it("treats a supplier in debit as an advance you have paid out", () => {
    expect(balancePhrase(2500, "creditor")).toEqual({ amount: 2500, caption: "advance paid", isLiability: false });
  });

  /** The bug this module exists for: cash in hand is not somebody's debt. */
  it("gives cash and bank no owing sentence at all", () => {
    expect(balancePhrase(5000, "cash_bank")).toEqual({ amount: 5000, caption: null, isLiability: false });
  });

  it("names a negative bank balance an overdraft", () => {
    expect(balancePhrase(-1200, "cash_bank")).toEqual({ amount: 1200, caption: "overdrawn", isLiability: true });
  });

  it("keeps Dr/Cr for kinds with no everyday phrasing", () => {
    expect(balancePhrase(900, "income").caption).toBe("Dr");
    expect(balancePhrase(-900, "income").caption).toBe("Cr");
    expect(balancePhrase(900, "expense").caption).toBe("Dr");
    expect(balancePhrase(-400, "capital").caption).toBe("Cr");
    expect(balancePhrase(400, "fixed_asset").caption).toBe("Dr");
    expect(balancePhrase(-400, "loan").caption).toBe("Cr");
    expect(balancePhrase(400, "other").caption).toBe("Dr");
  });

  it("describes nil as nil, for every kind", () => {
    for (const role of ["debtor", "creditor", "cash_bank", "income", "other"] as const) {
      expect(balancePhrase(0, role)).toEqual({ amount: 0, caption: null, isLiability: false });
    }
  });

  it("never returns a negative figure — the caption carries the direction", () => {
    for (const role of ["debtor", "creditor", "cash_bank", "income", "capital"] as const) {
      expect(balancePhrase(-1234.56, role).amount).toBeGreaterThan(0);
    }
  });
});
