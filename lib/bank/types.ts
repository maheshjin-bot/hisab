/**
 * The bank statement domain.
 *
 * Amounts are integer paise everywhere inside this module — see
 * lib/utils/currency.ts for why. They become rupees only at the database
 * boundary, in lib/supabase/queries/bank.ts.
 */

/** How a statement expresses the direction and size of a transaction. */
export type AmountMode =
  /** A Withdrawal column and a Deposit column, one of them blank per row. */
  | "separate_columns"
  /** One Amount column whose sign carries the direction. */
  | "signed_single"
  /** One Amount column plus a separate Dr/Cr indicator column. */
  | "amount_with_type";

export type DateFormat = "dmy" | "mdy" | "ymd";

/** From the account holder's point of view, not the bank's. */
export type StatementDirection = "withdrawal" | "deposit";

/**
 * Everything needed to read one bank's export. Persisted per bank ledger as
 * `bank_statement_profiles` and reused for every later statement from that
 * account — the "learned once" half of the import.
 *
 * Column fields hold the *header text* rather than a column index, so a bank
 * that adds a column between exports doesn't silently shift every mapping by
 * one.
 */
export interface StatementProfile {
  label: string;
  dateColumn: string;
  valueDateColumn: string | null;
  /** Joined with " " when a bank splits the description across columns. */
  narrationColumns: string[];
  referenceColumn: string | null;
  balanceColumn: string | null;
  amountMode: AmountMode;
  withdrawalColumn: string | null;
  depositColumn: string | null;
  amountColumn: string | null;
  typeColumn: string | null;
  /** `signed_single` only: whether a negative amount means money left the account. */
  negativeIsWithdrawal: boolean;
  dateFormat: DateFormat;
  /** Preamble rows above the header row (account holder, address, period). */
  skipRows: number;
}

/** A profile as it comes back from the database, with its identity. */
export interface SavedStatementProfile extends StatementProfile {
  id: string;
  bankLedgerId: string;
  updatedAt: string;
}

/** One transaction, after a profile has been applied to a raw row. */
export interface StatementLine {
  /** 1-based row number in the source file, as the user would see it in Excel. */
  lineNumber: number;
  txnDate: string;
  valueDate: string | null;
  narration: string;
  reference: string | null;
  withdrawalPaise: number;
  depositPaise: number;
  runningBalancePaise: number | null;
  /**
   * Distinguishes genuinely repeated identical transactions on one day from
   * the same transaction seen in two overlapping uploads. Part of the
   * fingerprint; see lib/bank/fingerprint.ts.
   */
  occurrenceIndex: number;
  fingerprint: string;
}

export interface StatementRowError {
  lineNumber: number;
  message: string;
}

export interface StatementReadResult {
  lines: StatementLine[];
  errors: StatementRowError[];
  /** Warnings about the file as a whole — usually a sign the mapping is wrong. */
  issues: string[];
  periodStart: string | null;
  periodEnd: string | null;
  /** The bank's own closing balance, when the file carries a balance column. */
  closingBalancePaise: number | null;
}

export type LineStatus = "unmatched" | "matched" | "posted" | "ignored";

/** A line as stored, with the reconciliation state the workspace acts on. */
export interface StoredStatementLine {
  id: string;
  importId: string;
  bankLedgerId: string;
  lineNumber: number;
  txnDate: string;
  valueDate: string | null;
  narration: string;
  reference: string | null;
  withdrawalPaise: number;
  depositPaise: number;
  runningBalancePaise: number | null;
  status: LineStatus;
  matchedVoucherId: string | null;
  postedVoucherId: string | null;
  fingerprint: string;
}

/** A learned (or hand-written) narration → account rule. */
export interface NarrationRule {
  id: string;
  bankLedgerId: string | null;
  pattern: string;
  direction: StatementDirection;
  contraLedgerId: string;
  hitCount: number;
  isManual: boolean;
  lastUsedAt: string;
}

/** An existing voucher a statement line could turn out to be. */
export interface MatchCandidate {
  voucherId: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  narration: string | null;
  /** Signed from the bank account's side: positive is money in. */
  bankAmountPaise: number;
}

export function directionOf(line: {
  withdrawalPaise: number;
  depositPaise: number;
}): StatementDirection {
  return line.withdrawalPaise > 0 ? "withdrawal" : "deposit";
}

/** Magnitude regardless of direction. */
export function amountPaiseOf(line: {
  withdrawalPaise: number;
  depositPaise: number;
}): number {
  return line.withdrawalPaise > 0 ? line.withdrawalPaise : line.depositPaise;
}

/** Signed from the bank account's side, to compare against a voucher's net effect. */
export function signedPaiseOf(line: {
  withdrawalPaise: number;
  depositPaise: number;
}): number {
  return line.depositPaise - line.withdrawalPaise;
}
