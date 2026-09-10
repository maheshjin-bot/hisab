/**
 * The Balance Sheet's ledger-name cell has two cases where there is nothing
 * sensible to link, alongside the ordinary case of a real, named ledger:
 *
 * - A synthetic row (`ledgerId === null` — Net Profit/Loss, and the trading
 *   result 0026 carries forward) has no ledger to link to at all.
 * - A group holding exactly one ledger is shown collapsed onto its group's
 *   name rather than the ledger's own name (see the Column component in
 *   app/(app)/[companyId]/reports/balance-sheet/page.tsx) — so even though
 *   that row does carry a real ledgerId, the text on screen names the group,
 *   not the ledger, and linking it would send a group-looking label to one
 *   ledger's statement.
 *
 * Both are read here exactly as the page already computes them, so the two
 * can never drift out of step with each other.
 */
export interface BalanceSheetLinkRow {
  ledgerId: string | null;
  ledgerName: string;
  groupName: string;
}

/** What the cell displays — unchanged from the page's original ternary. */
export function balanceSheetCellLabel(row: BalanceSheetLinkRow, groupRowCount: number): string {
  return groupRowCount === 1 && row.ledgerId !== null ? row.groupName : row.ledgerName;
}

/** The ledger a cell should link to, or null when it must stay plain text. */
export function balanceSheetCellLedgerId(row: BalanceSheetLinkRow, groupRowCount: number): string | null {
  return groupRowCount > 1 && row.ledgerId !== null ? row.ledgerId : null;
}
