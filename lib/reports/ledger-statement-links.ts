/**
 * The Ledger Statement's Particulars cell shows every other ledger on the
 * voucher, comma-joined (see get_ledger_statement in
 * supabase/migrations/0028_ledger_statement_counterparty.sql). Most vouchers
 * are two lines, so this is exactly one name — a real ledger the reader can
 * jump to, the same way Trial Balance/Balance Sheet/P&L/Outstanding link a
 * ledger name today.
 *
 * A journal or contra with more than two lines can name several ledgers in
 * one cell. There is no single ledger a click on that text could mean, so it
 * stays plain text — this is the one thing this function decides.
 */
export interface LedgerStatementCounterpartyRow {
  counterparty: string | null;
  counterpartyLedgerId: string | null;
}

/** The ledger a Particulars cell should link to, or null when it must stay plain text. */
export function ledgerStatementCounterpartyLinkId(row: LedgerStatementCounterpartyRow): string | null {
  return row.counterparty !== null && row.counterpartyLedgerId !== null ? row.counterpartyLedgerId : null;
}
