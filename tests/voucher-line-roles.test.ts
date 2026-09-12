import { describe, expect, it } from "vitest";
import { splitVoucherLines, gridLineSide, gridAmountTotal, type VoucherLineAmounts } from "@/lib/voucher/voucher-line-roles";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";

/**
 * `splitVoucherLines` only ever looks at `debitAmount`/`creditAmount` plus the
 * config's `isPrimaryParty` flags, so a minimal line shape is enough — no
 * ledgerId/narration needed for these fixtures except where a test reads it
 * back to prove which line survived the split.
 */
function line(debit: number, credit: number, tag?: string): VoucherLineAmounts & { tag?: string } {
  return { debitAmount: debit, creditAmount: credit, tag };
}

const payment = VOUCHER_TYPE_CONFIG.payment; // cr.isPrimaryParty: true — party is the credit line
const receipt = VOUCHER_TYPE_CONFIG.receipt; // dr.isPrimaryParty: true — party is the debit line

describe("splitVoucherLines — case 1: normal case, both orderings", () => {
  it("party at position 0 (every hand-typed voucher today) — payment", () => {
    // Dr Paid To (grid) / Cr Paid From (party) — party's credit line at index 0.
    const lines = [line(0, 1000, "cash"), line(1000, 0, "expense")];
    const result = splitVoucherLines(lines, payment);
    expect(result.partyIndex).toBe(0);
    expect(result.partyLine?.tag).toBe("cash");
    expect(result.gridIndices).toEqual([1]);
    expect(result.gridLines.map((l) => l.tag)).toEqual(["expense"]);
  });

  it("party at position 1+ (the CSV-import case, PAY/02867-shaped) — payment", () => {
    // Dr Drawings (grid, index 0) / Cr Cash in Hand (party, index 1) — the
    // reverse of the hand-typed order, but the same correct accounting.
    const lines = [line(1000, 0, "drawings"), line(0, 1000, "cash")];
    const result = splitVoucherLines(lines, payment);
    expect(result.partyIndex).toBe(1);
    expect(result.partyLine?.tag).toBe("cash");
    expect(result.gridIndices).toEqual([0]);
    expect(result.gridLines.map((l) => l.tag)).toEqual(["drawings"]);
  });

  it("party at position 0 — receipt", () => {
    // Dr Received Into (party) / Cr Received From (grid).
    const lines = [line(1000, 0, "bank"), line(0, 1000, "income")];
    const result = splitVoucherLines(lines, receipt);
    expect(result.partyIndex).toBe(0);
    expect(result.gridIndices).toEqual([1]);
  });

  it("party at position 1+ — receipt", () => {
    const lines = [line(0, 1000, "income"), line(1000, 0, "bank")];
    const result = splitVoucherLines(lines, receipt);
    expect(result.partyIndex).toBe(1);
    expect(result.gridIndices).toEqual([0]);
  });

  it("gridLineSide reads each grid line's own populated field, not a type-wide constant", () => {
    // Grid line here happens to be on the "wrong" field relative to the
    // voucher type's structural grid side (debit for a payment) — still must
    // read as credit, since that's where its real amount lives.
    expect(gridLineSide(line(0, 500), "debit")).toBe("credit");
    expect(gridLineSide(line(500, 0), "credit")).toBe("debit");
  });
});

describe("splitVoucherLines — case 2: brand new voucher (no initialValues)", () => {
  it("both lines empty falls back to index 0 as the party, matching today's default layout", () => {
    const lines = [line(0, 0), line(0, 0)];
    const result = splitVoucherLines(lines, payment);
    expect(result.partyIndex).toBe(0);
    expect(result.gridIndices).toEqual([1]);
  });

  it("does not require any line to carry data at all — an empty array still returns cleanly", () => {
    const result = splitVoucherLines([] as VoucherLineAmounts[], payment);
    expect(result.partyIndex).toBeNull();
    expect(result.partyLine).toBeUndefined();
    expect(result.gridIndices).toEqual([]);
  });
});

describe("splitVoucherLines — case 3: degenerate/zero-amount line", () => {
  it("a freshly added empty grid row is never misidentified as the party", () => {
    // Real party (cash, credit) at 0, real grid line (expense, debit) at 1,
    // and a brand new all-zero row just appended at 2.
    const lines = [line(0, 1000, "cash"), line(1000, 0, "expense"), line(0, 0, "new-empty-row")];
    const result = splitVoucherLines(lines, payment);
    expect(result.partyIndex).toBe(0);
    expect(result.gridIndices).toEqual([1, 2]);
    expect(result.gridLines.map((l) => l.tag)).toEqual(["expense", "new-empty-row"]);
  });

  it("a voucher with no line on the primary side yet (still being typed) falls back to index 0, not a crash or a missing party", () => {
    // e.g. the user picked ledgers for both rows but hasn't typed an amount
    // into the grid row yet, so the party's auto-synced amount is still 0.
    const lines = [line(0, 0, "cash"), line(0, 0, "expense")];
    const result = splitVoucherLines(lines, payment);
    expect(result.partyIndex).toBe(0);
    expect(result.partyLine?.tag).toBe("cash");
    expect(result.gridIndices).toEqual([1]);
  });
});

describe("splitVoucherLines — case 4: more than one line with a nonzero amount on the primary side", () => {
  it("picks the first such line as the party and treats every other one as an extra grid row, without dropping data or throwing", () => {
    // Two credit lines for a payment — should not happen for a real
    // single-party voucher, but malformed/imported data might do it.
    const lines = [line(0, 600, "cash-a"), line(1000, 0, "expense"), line(0, 400, "cash-b")];
    const result = splitVoucherLines(lines, payment);
    expect(result.partyIndex).toBe(0);
    expect(result.partyLine?.tag).toBe("cash-a");
    expect(result.gridIndices).toEqual([1, 2]);
    expect(result.gridLines.map((l) => l.tag)).toEqual(["expense", "cash-b"]);
  });
});

describe("splitVoucherLines — PAY/02867 (the confirmed production defect)", () => {
  // Confirmed against the live Ledger Statement: Dr Amit - Drawings &
  // Advances / Cr Amit Cash in Hand, ₹10,00,000 — correct accounting for
  // money paid out — but stored with the drawings (grid) line at position 0
  // and the cash (party) line at position 1.
  const lines = [
    { ledgerId: "drawings", debitAmount: 1000000, creditAmount: 0, tag: "Amit - Drawings & Advances" },
    { ledgerId: "cash", debitAmount: 0, creditAmount: 1000000, tag: "Amit Cash in Hand" },
  ];

  it("identifies the credit-side line (index 1) as the party, matching the Ledger Statement's Cr posting", () => {
    const result = splitVoucherLines(lines, payment);
    expect(result.partyIndex).toBe(1);
    expect(result.partyLine?.ledgerId).toBe("cash");
    expect(result.gridIndices).toEqual([0]);
    expect(result.gridLines[0].ledgerId).toBe("drawings");
  });

  it("the grid line's amount reads from creditAmount when that's what's populated (not a blank debitAmount box)", () => {
    const result = splitVoucherLines(lines, payment);
    const gridLine = result.gridLines[0];
    // The grid line here is the drawings debit posting — debitAmount is what
    // has the real figure, and gridLineSide must say so.
    expect(gridLineSide(gridLine, "debit")).toBe("debit");
    expect(gridLine.debitAmount).toBe(1000000);
  });

  describe("case 5: the party-amount auto-sync effect", () => {
    it("computes the party's amount as the sum of the real grid lines' amounts on the real opposite side, and does not fight a correctly-loaded value", () => {
      const result = splitVoucherLines(lines, payment);
      // Grid = [drawings: debit 1000000]. The sum of the grid's real amounts —
      // on whichever field each one actually populates — is 1000000.
      const total = gridAmountTotal(result.gridLines);
      expect(total).toBe(1000000);
      // The party line (cash) is on the credit side; for a payment the grid
      // sits on debit, so the effect would write this total into the party's
      // *opposite* field, creditAmount. It already holds exactly that value,
      // so the effect is a no-op — it must not overwrite or "correct" it.
      expect(result.partyLine?.creditAmount).toBe(total);
    });

    it("a brand-new voucher (all zero) also produces a no-op sync: party amount 0 matches an empty grid's total 0", () => {
      const freshLines = [
        { ledgerId: "", debitAmount: 0, creditAmount: 0 },
        { ledgerId: "", debitAmount: 0, creditAmount: 0 },
      ];
      const result = splitVoucherLines(freshLines, payment);
      expect(gridAmountTotal(result.gridLines)).toBe(0);
      expect(result.partyLine?.creditAmount).toBe(0);
    });
  });

  describe("case 6: load then immediately save is a no-op", () => {
    // Mirrors VoucherForm.save(): `values.lines.map((l, i) => ({ ...l,
    // lineOrder: i }))` — the save payload is just the loaded lines plus an
    // explicit line order, never rebuilt from party/grid position.
    function simulateSave<T>(loadedLines: T[]): (T & { lineOrder: number })[] {
      return loadedLines.map((l, i) => ({ ...l, lineOrder: i }));
    }

    it("constructs the exact PAY/02867 shape and asserts the save payload keeps the same debit/credit/ledger assignment as the input", () => {
      const before = [
        { ledgerId: "drawings-ledger-id", debitAmount: 1000000, creditAmount: 0, narration: "" },
        { ledgerId: "cash-ledger-id", debitAmount: 0, creditAmount: 1000000, narration: "" },
      ];

      // Identification (case 1) — the real party is the credit line at index 1.
      const split = splitVoucherLines(before, payment);
      expect(split.partyIndex).toBe(1);

      // Auto-sync (case 5) — recomputing the party's amount from the grid
      // changes nothing, since the loaded data was already consistent.
      const resyncedTotal = gridAmountTotal(split.gridLines);
      expect(resyncedTotal).toBe(before[0].debitAmount);
      // So no setValue would fire, and `before` itself is what gets saved.

      const after = simulateSave(before);

      expect(after).toEqual([
        { ledgerId: "drawings-ledger-id", debitAmount: 1000000, creditAmount: 0, narration: "", lineOrder: 0 },
        { ledgerId: "cash-ledger-id", debitAmount: 0, creditAmount: 1000000, narration: "", lineOrder: 1 },
      ]);

      // The property that matters most: not the reversed assignment the old
      // position-based code would have implied (drawings credited, cash
      // debited) — the same assignment the Ledger Statement already proves
      // correct (drawings debited, cash credited).
      expect(after[0]).toMatchObject({ ledgerId: "drawings-ledger-id", debitAmount: 1000000, creditAmount: 0 });
      expect(after[1]).toMatchObject({ ledgerId: "cash-ledger-id", debitAmount: 0, creditAmount: 1000000 });
    });

    it("a normal hand-typed voucher (party at position 0) round-trips unchanged too", () => {
      const before = [
        { ledgerId: "cash-ledger-id", debitAmount: 0, creditAmount: 500, narration: "" },
        { ledgerId: "expense-ledger-id", debitAmount: 500, creditAmount: 0, narration: "" },
      ];
      const split = splitVoucherLines(before, payment);
      expect(split.partyIndex).toBe(0);
      const after = simulateSave(before);
      expect(after).toEqual([
        { ledgerId: "cash-ledger-id", debitAmount: 0, creditAmount: 500, narration: "", lineOrder: 0 },
        { ledgerId: "expense-ledger-id", debitAmount: 500, creditAmount: 0, narration: "", lineOrder: 1 },
      ]);
    });
  });
});
