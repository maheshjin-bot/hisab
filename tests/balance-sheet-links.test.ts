import { describe, expect, it } from "vitest";
import { balanceSheetCellLabel, balanceSheetCellLedgerId } from "@/lib/reports/balance-sheet-links";

const realLedger = { ledgerId: "ledger-1", ledgerName: "Till", groupName: "Cash-in-Hand" };
const synthetic = { ledgerId: null, ledgerName: "Net Profit/Loss", groupName: "Capital Account" };

describe("balanceSheetCellLabel", () => {
  it("shows the ledger's own name when its group holds more than one ledger", () => {
    expect(balanceSheetCellLabel(realLedger, 2)).toBe("Till");
  });

  it("collapses a single-ledger group onto the group's own name instead", () => {
    expect(balanceSheetCellLabel(realLedger, 1)).toBe("Cash-in-Hand");
  });

  it("always shows a synthetic row's own name, never the group it sits in", () => {
    // Collapsing this one the way a real single-ledger group collapses would
    // print "Capital Account" where "Net Profit/Loss" belongs.
    expect(balanceSheetCellLabel(synthetic, 1)).toBe("Net Profit/Loss");
    expect(balanceSheetCellLabel(synthetic, 2)).toBe("Net Profit/Loss");
  });
});

describe("balanceSheetCellLedgerId", () => {
  it("links a real ledger's row when its group holds more than one ledger", () => {
    expect(balanceSheetCellLedgerId(realLedger, 2)).toBe("ledger-1");
  });

  it("leaves a collapsed single-ledger group unlinked, even though ledgerId is real", () => {
    // The cell reads as the group's name in this case, not the ledger's — see
    // balanceSheetCellLabel — so a link here would send a group-looking label
    // to one ledger's statement.
    expect(balanceSheetCellLedgerId(realLedger, 1)).toBeNull();
  });

  it("never links a synthetic row, in either grouping", () => {
    expect(balanceSheetCellLedgerId(synthetic, 1)).toBeNull();
    expect(balanceSheetCellLedgerId(synthetic, 2)).toBeNull();
  });
});
