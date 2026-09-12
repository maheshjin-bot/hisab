import { describe, expect, it } from "vitest";
import { HIGH_CONFIDENCE, patternOf, suggestLedger, tokenize } from "@/lib/bank/suggest";
import { DEFAULT_DATE_WINDOW_DAYS, matchStatementLines } from "@/lib/bank/match";
import type { MatchCandidate, NarrationRule } from "@/lib/bank/types";

const BANK = "bank-ledger-id";

function rule(overrides: Partial<NarrationRule> & Pick<NarrationRule, "pattern" | "contraLedgerId">): NarrationRule {
  return {
    id: `rule-${overrides.pattern}`,
    bankLedgerId: BANK,
    direction: "withdrawal",
    hitCount: 1,
    isManual: false,
    lastUsedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function withdrawal(narration: string, paise = 100000) {
  return { narration, withdrawalPaise: paise, depositPaise: 0 };
}

function deposit(narration: string, paise = 100000) {
  return { narration, withdrawalPaise: 0, depositPaise: paise };
}

describe("tokenize", () => {
  it("drops the rail, the reference numbers and the noise words", () => {
    expect(tokenize("UPI-SWIGGY-9871234@ybl-UTR991823")).toEqual(["swiggy", "ybl"]);
    expect(tokenize("NEFT DR-ICIC0000123-RAJESH TRADERS")).toEqual(["rajesh", "traders"]);
  });

  it("keeps what identifies a counterparty", () => {
    expect(tokenize("BIL/ONL/000123/AIRTEL BROADBAND")).toEqual(["airtel", "broadband"]);
  });
});

describe("patternOf", () => {
  it("is stable across the parts of a narration that change per transaction", () => {
    // The reference number and the rail differ every time; the counterparty
    // does not. Two transactions from the same payee must produce one rule.
    const first = patternOf("UPI-SWIGGY-9871234@ybl-UTR991823");
    const second = patternOf("UPI-SWIGGY-4410999@ybl-UTR773311");
    expect(first).toBe(second);
  });

  it("is order-independent", () => {
    expect(patternOf("RAJESH TRADERS NEFT")).toBe(patternOf("NEFT TRADERS RAJESH"));
  });

  it("is empty when a narration says nothing identifying", () => {
    expect(patternOf("NEFT DR 0000123")).toBe("");
  });
});

describe("suggestLedger", () => {
  it("fills in an exact repeat with enough confidence to pre-select", () => {
    const line = withdrawal("UPI-SWIGGY-4410999@ybl-UTR773311");
    const rules = [
      rule({ pattern: patternOf("UPI-SWIGGY-9871234@ybl-UTR991823"), contraLedgerId: "meals", hitCount: 4 }),
    ];

    const suggestion = suggestLedger(line, { bankLedgerId: BANK, rules });

    expect(suggestion?.ledgerId).toBe("meals");
    expect(suggestion!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
  });

  it("keeps a partial match below the pre-select bar", () => {
    // Similar is not the same. Offering it is useful; posting it unread is not.
    const rules = [rule({ pattern: patternOf("RAJESH TRADERS MUMBAI"), contraLedgerId: "creditor" })];
    const suggestion = suggestLedger(withdrawal("NEFT RAJESH TRADERS DELHI BRANCH"), {
      bankLedgerId: BANK,
      rules,
    });

    expect(suggestion?.ledgerId).toBe("creditor");
    expect(suggestion!.confidence).toBeLessThan(HIGH_CONFIDENCE);
  });

  it("will not answer a deposit with a rule learned from a withdrawal", () => {
    // Money out to a name is a payment to a supplier; the same name coming in
    // is a receipt from a customer. They are different accounts.
    const rules = [rule({ pattern: patternOf("RAJESH TRADERS"), contraLedgerId: "creditor", direction: "withdrawal" })];
    expect(suggestLedger(deposit("NEFT RAJESH TRADERS"), { bankLedgerId: BANK, rules })).toBeNull();
  });

  it("ignores a rule learned on a different bank account, but honours an unscoped one", () => {
    const scopedElsewhere = [
      rule({ pattern: patternOf("AIRTEL BROADBAND"), contraLedgerId: "telecom", bankLedgerId: "other-bank" }),
    ];
    expect(suggestLedger(withdrawal("BIL/AIRTEL BROADBAND"), { bankLedgerId: BANK, rules: scopedElsewhere })).toBeNull();

    const unscoped = [
      rule({ pattern: patternOf("AIRTEL BROADBAND"), contraLedgerId: "telecom", bankLedgerId: null }),
    ];
    expect(suggestLedger(withdrawal("BIL/AIRTEL BROADBAND"), { bankLedgerId: BANK, rules: unscoped })?.ledgerId).toBe("telecom");
  });

  it("prefers the more-used rule when two could apply", () => {
    const rules = [
      rule({ pattern: patternOf("OFFICE SUPPLIES"), contraLedgerId: "stationery", hitCount: 1 }),
      rule({ pattern: patternOf("OFFICE SUPPLIES"), contraLedgerId: "admin", hitCount: 9 }),
    ];
    expect(suggestLedger(withdrawal("POS OFFICE SUPPLIES"), { bankLedgerId: BANK, rules })?.ledgerId).toBe("admin");
  });

  it("falls back to the chart of accounts on the very first import", () => {
    // No rules exist yet, but the company already has the party on its books.
    const ledgers = [
      { id: "airtel", name: "Bharti Airtel Ltd", groupId: "g", groupName: "Sundry Creditors", ledgerRole: "creditor" as const },
      { id: "hdfc", name: "HDFC Current", groupId: "g2", groupName: "Bank Accounts", ledgerRole: "cash_bank" as const },
    ];

    const suggestion = suggestLedger(withdrawal("NEFT/BHARTI AIRTEL LTD/00192"), {
      bankLedgerId: BANK,
      rules: [],
      ledgers,
    });

    expect(suggestion?.ledgerId).toBe("airtel");
    expect(suggestion!.confidence).toBeLessThan(HIGH_CONFIDENCE);
  });

  it("does not propose another bank account from a name match", () => {
    // A transfer between two own accounts is a contra voucher and needs a
    // human to say which side it is; guessing it produces a wrong pair.
    const ledgers = [
      { id: "icici", name: "ICICI Savings", groupId: "g", groupName: "Bank Accounts", ledgerRole: "cash_bank" as const },
    ];
    expect(suggestLedger(withdrawal("IMPS TO ICICI SAVINGS"), { bankLedgerId: BANK, rules: [], ledgers })).toBeNull();
  });

  it("does not match a ledger on one shared common word", () => {
    const ledgers = [
      { id: "x", name: "Metro Traders Private Limited", groupId: "g", groupName: "Sundry Creditors", ledgerRole: "creditor" as const },
    ];
    expect(suggestLedger(withdrawal("NEFT SOMETHING TRADERS ELSE"), { bankLedgerId: BANK, rules: [], ledgers })).toBeNull();
  });

  it("returns nothing rather than a weak guess", () => {
    expect(suggestLedger(withdrawal("ATM WDL 1234 MUMBAI"), { bankLedgerId: BANK, rules: [] })).toBeNull();
  });
});

function candidate(overrides: Partial<MatchCandidate> & Pick<MatchCandidate, "voucherId" | "bankAmountPaise" | "voucherDate">): MatchCandidate {
  return {
    voucherNumber: `PAY/2026-27/${overrides.voucherId}`,
    voucherType: "payment",
    narration: null,
    ...overrides,
  };
}

describe("matchStatementLines", () => {
  const line = {
    id: "line-1",
    txnDate: "2026-04-10",
    narration: "NEFT DR-RAJESH TRADERS",
    withdrawalPaise: 2500000,
    depositPaise: 0,
  };

  it("matches an exact amount on the same day", () => {
    const [result] = matchStatementLines([line], [
      candidate({ voucherId: "v1", bankAmountPaise: -2500000, voucherDate: "2026-04-10" }),
    ]);

    expect(result.matched?.voucherId).toBe("v1");
    expect(result.reason).toContain("Same amount and date");
  });

  it("matches a cheque that cleared a few days after it was written", () => {
    const [result] = matchStatementLines([line], [
      candidate({ voucherId: "v1", bankAmountPaise: -2500000, voucherDate: "2026-04-06" }),
    ]);

    expect(result.matched?.voucherId).toBe("v1");
    expect(result.reason).toContain("4 days apart");
  });

  it("will not match across the direction of the money", () => {
    // A ₹25,000 receipt is not a ₹25,000 payment, however close the dates are.
    const [result] = matchStatementLines([line], [
      candidate({ voucherId: "v1", bankAmountPaise: 2500000, voucherDate: "2026-04-10" }),
    ]);

    expect(result.matched).toBeNull();
  });

  it("will not match an amount that is merely close", () => {
    const [result] = matchStatementLines([line], [
      candidate({ voucherId: "v1", bankAmountPaise: -2500001, voucherDate: "2026-04-10" }),
    ]);

    expect(result.matched).toBeNull();
  });

  it("refuses to choose between two equally good candidates", () => {
    // This is the important one. Picking either would hide a real discrepancy
    // and the rec would appear to balance, so the user has to decide.
    const [result] = matchStatementLines([line], [
      candidate({ voucherId: "v1", bankAmountPaise: -2500000, voucherDate: "2026-04-10" }),
      candidate({ voucherId: "v2", bankAmountPaise: -2500000, voucherDate: "2026-04-10" }),
    ]);

    expect(result.matched).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(result.reason).toContain("equally close");
  });

  it("separates two same-amount candidates by narration when the dates cannot", () => {
    const [result] = matchStatementLines([line], [
      candidate({ voucherId: "v1", bankAmountPaise: -2500000, voucherDate: "2026-04-10", narration: "Payment to Rajesh Traders" }),
      candidate({ voucherId: "v2", bankAmountPaise: -2500000, voucherDate: "2026-04-10", narration: "Advance to Kumar Steel" }),
    ]);

    expect(result.matched?.voucherId).toBe("v1");
  });

  it("gives a voucher to the line it fits best, not the first line to ask", () => {
    // Line A is a week off, line B is exact. Line-by-line matching would let A
    // take the voucher and leave B unreconciled.
    const early = { ...line, id: "line-early", txnDate: "2026-04-03" };
    const exact = { ...line, id: "line-exact", txnDate: "2026-04-10" };

    const results = matchStatementLines([early, exact], [
      candidate({ voucherId: "v1", bankAmountPaise: -2500000, voucherDate: "2026-04-10" }),
    ]);

    expect(results.find((r) => r.lineId === "line-exact")?.matched?.voucherId).toBe("v1");
    expect(results.find((r) => r.lineId === "line-early")?.matched).toBeNull();
  });

  it("never gives one voucher to two lines", () => {
    const a = { ...line, id: "a" };
    const b = { ...line, id: "b" };

    const results = matchStatementLines([a, b], [
      candidate({ voucherId: "v1", bankAmountPaise: -2500000, voucherDate: "2026-04-10" }),
    ]);

    expect(results.filter((r) => r.matched !== null)).toHaveLength(1);
  });

  it("ignores a voucher outside the date window", () => {
    const [result] = matchStatementLines([line], [
      candidate({
        voucherId: "v1",
        bankAmountPaise: -2500000,
        voucherDate: "2026-03-01",
      }),
    ]);

    expect(result.matched).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(DEFAULT_DATE_WINDOW_DAYS).toBe(7);
  });

  it("says plainly when nothing in the books explains a line", () => {
    const [result] = matchStatementLines([line], []);
    expect(result.reason).toBe("No voucher in the books matches this amount");
  });
});
