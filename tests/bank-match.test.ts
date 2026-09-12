import { describe, expect, it } from "vitest";
import { DEFAULT_DATE_WINDOW_DAYS, matchStatementLines, type MatchableLine } from "@/lib/bank/match";
import type { MatchCandidate } from "@/lib/bank/types";

/**
 * Reconciling statement lines against vouchers already in the books.
 *
 * The module is built around one rule — an uncertain match is worse than no
 * match — because a wrong match hides the discrepancy the reconciliation exists
 * to expose, and hides it invisibly. Most of these tests are about the cases
 * where a tie-break would be tempting.
 */

/** Signed from the bank's side: a payment is money out, so it is negative. */
function payment(id: string, date: string, narration: string | null = null, paise = 500000): MatchCandidate {
  return {
    voucherId: id,
    voucherNumber: `PAY-${id}`,
    voucherType: "payment",
    voucherDate: date,
    narration,
    bankAmountPaise: -paise,
  };
}

function receipt(id: string, date: string, narration: string | null = null, paise = 500000): MatchCandidate {
  return {
    voucherId: id,
    voucherNumber: `RCT-${id}`,
    voucherType: "receipt",
    voucherDate: date,
    narration,
    bankAmountPaise: paise,
  };
}

function withdrawal(id: string, date: string, narration = "NEFT DR-RAJESH TRADERS", paise = 500000): MatchableLine {
  return { id, txnDate: date, narration, withdrawalPaise: paise, depositPaise: 0 };
}

function deposit(id: string, date: string, narration = "NEFT CR-ACME EXPORTS", paise = 500000): MatchableLine {
  return { id, txnDate: date, narration, withdrawalPaise: 0, depositPaise: paise };
}

describe("matchStatementLines — what counts as the same transaction", () => {
  it("matches a cheque that cleared a few days after it was written", () => {
    const [match] = matchStatementLines(
      [withdrawal("L1", "2026-04-14")],
      [payment("V1", "2026-04-10", "Rajesh Traders — April supplies")]
    );
    expect(match.matched?.voucherId).toBe("V1");
    expect(match.reason).toBe("Same amount as PAY-V1, 4 days apart");
  });

  it("says 'day' rather than 'days' for a one-day gap", () => {
    const [match] = matchStatementLines([withdrawal("L1", "2026-04-11")], [payment("V1", "2026-04-10")]);
    expect(match.reason).toBe("Same amount as PAY-V1, 1 day apart");
  });

  it("requires the amount to be exact, to the paise", () => {
    const [match] = matchStatementLines(
      [withdrawal("L1", "2026-04-10", "NEFT DR-RAJESH TRADERS", 500000)],
      [payment("V1", "2026-04-10", null, 500001)]
    );
    expect(match.matched).toBeNull();
    expect(match.candidates).toEqual([]);
    expect(match.reason).toBe("No voucher in the books matches this amount");
  });

  it("requires the direction to agree — a payment is not a receipt of the same size", () => {
    // ₹5,000 out and ₹5,000 in on the same day are two different transactions.
    const [asWithdrawal] = matchStatementLines([withdrawal("L1", "2026-04-10")], [receipt("V1", "2026-04-10")]);
    expect(asWithdrawal.candidates).toEqual([]);

    const [asDeposit] = matchStatementLines([deposit("L1", "2026-04-10")], [receipt("V1", "2026-04-10")]);
    expect(asDeposit.matched?.voucherId).toBe("V1");
  });

  it("holds the date window at seven days in both directions", () => {
    const inside = matchStatementLines([withdrawal("L1", "2026-04-10")], [payment("V1", "2026-04-17")]);
    const outside = matchStatementLines([withdrawal("L1", "2026-04-10")], [payment("V1", "2026-04-18")]);
    const before = matchStatementLines([withdrawal("L1", "2026-04-10")], [payment("V1", "2026-04-03")]);

    expect(DEFAULT_DATE_WINDOW_DAYS).toBe(7);
    expect(inside[0].matched?.voucherId).toBe("V1");
    expect(outside[0].matched).toBeNull();
    expect(outside[0].candidates).toEqual([]);
    expect(before[0].matched?.voucherId).toBe("V1");
  });

  it("honours a caller-supplied window", () => {
    const wider = matchStatementLines([withdrawal("L1", "2026-04-10")], [payment("V1", "2026-04-25")], { windowDays: 30 });
    expect(wider[0].matched?.voucherId).toBe("V1");
  });

  it("does not match against an unparseable date", () => {
    const [match] = matchStatementLines([withdrawal("L1", "not-a-date")], [payment("V1", "2026-04-10")]);
    expect(match.matched).toBeNull();
    expect(match.candidates).toEqual([]);
  });
});

describe("matchStatementLines — refusing to guess", () => {
  it("leaves a line unmatched when two vouchers are equally good, and offers both", () => {
    // Two identical payments on the same day, neither narrated. Nothing here
    // can tell them apart, and picking one would hide whichever is wrong.
    const [match] = matchStatementLines(
      [withdrawal("L1", "2026-04-10")],
      [payment("V1", "2026-04-10"), payment("V2", "2026-04-10")]
    );
    expect(match.matched).toBeNull();
    expect(match.candidates.map((c) => c.voucherId).sort()).toEqual(["V1", "V2"]);
    expect(match.reason).toBe("2 vouchers of this amount are equally close — pick one");
  });

  it("lets the narration separate two candidates the dates cannot", () => {
    const [match] = matchStatementLines(
      [withdrawal("L1", "2026-04-10", "NEFT DR-ICIC0000123-RAJESH TRADERS")],
      [payment("V1", "2026-04-10", "Acme Exports invoice 42"), payment("V2", "2026-04-10", "Rajesh Traders")]
    );
    expect(match.matched?.voucherId).toBe("V2");
  });

  it("lets date proximity outrank narration, because that is the stronger signal", () => {
    const [match] = matchStatementLines(
      [withdrawal("L1", "2026-04-10", "NEFT DR-ICIC0000123-RAJESH TRADERS")],
      [payment("V1", "2026-04-10", null), payment("V2", "2026-04-13", "Rajesh Traders")]
    );
    expect(match.matched?.voucherId).toBe("V1");
  });

  it("leaves both lines unmatched when two identical lines meet two identical vouchers", () => {
    const results = matchStatementLines(
      [withdrawal("L1", "2026-04-10"), withdrawal("L2", "2026-04-10")],
      [payment("V1", "2026-04-10"), payment("V2", "2026-04-10")]
    );
    expect(results.map((r) => r.matched)).toEqual([null, null]);
  });
});

describe("matchStatementLines — a voucher is claimed once", () => {
  it("never gives one voucher to two lines", () => {
    // The database enforces the same thing with a unique index: two lines
    // reconciled to one payment makes a rec that balances while a real
    // transaction is missing.
    const results = matchStatementLines(
      [withdrawal("L1", "2026-04-10"), withdrawal("L2", "2026-04-11")],
      [payment("V1", "2026-04-10", "Rajesh Traders")]
    );
    const claimed = results.map((r) => r.matched?.voucherId).filter(Boolean);
    expect(claimed).toEqual(["V1"]);
    expect(results[1].matched).toBeNull();
  });

  it("assigns across the whole batch rather than line by line", () => {
    // Line by line, A-line would look first and take V1 (one day away),
    // leaving B-line — which is an exact date match for V1 — with only the
    // voucher five days off. Scoring every pair first avoids that.
    const results = matchStatementLines(
      [withdrawal("A-line", "2026-04-10"), withdrawal("B-line", "2026-04-11")],
      [payment("V1", "2026-04-11"), payment("V2", "2026-04-15")]
    );
    expect(results.find((r) => r.lineId === "B-line")?.matched?.voucherId).toBe("V1");
    expect(results.find((r) => r.lineId === "A-line")?.matched?.voucherId).toBe("V2");
  });

  it("gives the same answer whatever order the lines and vouchers arrive in", () => {
    const lines = [withdrawal("L1", "2026-04-10", "NEFT RAJESH TRADERS"), withdrawal("L2", "2026-04-10", "NEFT ACME EXPORTS")];
    const candidates = [payment("V1", "2026-04-10", "Rajesh Traders"), payment("V2", "2026-04-10", "Acme Exports")];

    const forwards = matchStatementLines(lines, candidates);
    const backwards = matchStatementLines([...lines].reverse(), [...candidates].reverse());

    const pairs = (r: typeof forwards) =>
      r.map((m) => `${m.lineId}->${m.matched?.voucherId ?? "-"}`).sort();
    expect(pairs(backwards)).toEqual(pairs(forwards));
    expect(pairs(forwards)).toEqual(["L1->V1", "L2->V2"]);
  });
});

describe("matchStatementLines — shape of the result", () => {
  it("returns one result per line, in the order it was given them", () => {
    const results = matchStatementLines(
      [withdrawal("L3", "2026-04-10"), withdrawal("L1", "2026-04-30"), withdrawal("L2", "2026-04-10")],
      [payment("V1", "2026-04-10")]
    );
    expect(results.map((r) => r.lineId)).toEqual(["L3", "L1", "L2"]);
  });

  it("orders the offered candidates best first", () => {
    const [match] = matchStatementLines(
      [withdrawal("L1", "2026-04-10")],
      [payment("V-far", "2026-04-16"), payment("V-near", "2026-04-11"), payment("V-exact", "2026-04-10")]
    );
    expect(match.candidates.map((c) => c.voucherId)).toEqual(["V-exact", "V-near", "V-far"]);
  });

  it("copes with an empty batch on either side", () => {
    expect(matchStatementLines([], [payment("V1", "2026-04-10")])).toEqual([]);
    const [match] = matchStatementLines([withdrawal("L1", "2026-04-10")], []);
    expect(match).toMatchObject({ lineId: "L1", matched: null, candidates: [] });
  });

  // FAILS: L3 below is told "2 vouchers of this amount are equally close — pick
  // one", but both of those vouchers have already been claimed by L1 and L2.
  // It should say what it says when a single candidate is taken — that another
  // line matched them first.
  //
  // describe() branches on scored.length alone. It is given the line's full
  // scored list, which is never filtered against claimedVouchers, so it cannot
  // tell "two candidates you must choose between" from "two candidates that are
  // both gone".
  //
  // Consequence: the message names an action, and the action fails. The user
  // picks one of the two offered vouchers, and
  // bank_statement_lines_matched_voucher_idx — the unique index that exists
  // precisely so a voucher cannot explain two lines — rejects it. What they
  // actually need to know is that the books are one voucher short for this
  // line, which is the real finding of the reconciliation. Message-only: no
  // wrong data is written, which is why it is ranked last of the match
  // findings.
  it("does not tell a line to pick between vouchers that are already taken", () => {
    const results = matchStatementLines(
      [withdrawal("L1", "2026-04-10"), withdrawal("L2", "2026-04-11"), withdrawal("L3", "2026-04-12")],
      [payment("V1", "2026-04-10"), payment("V2", "2026-04-11")]
    );
    const l3 = results.find((r) => r.lineId === "L3")!;
    expect(l3.matched).toBeNull();
    expect(l3.reason).not.toContain("pick one");
  });
});
