import { fromPaise } from "@/lib/utils/currency";
import { parseAmountCell } from "./amount";
import { parseStatementDate } from "./date";
import { assignOccurrenceIndexes, buildFingerprint } from "./fingerprint";
import type {
  StatementDirection,
  StatementLine,
  StatementProfile,
  StatementReadResult,
  StatementRowError,
} from "./types";

/**
 * Applies a profile to a raw grid — the second half of reading a statement,
 * once the format is either detected or remembered.
 */

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

/**
 * Finds the header row when applying a *saved* profile to a new file.
 *
 * `skipRows` is remembered from last time, but the preamble above the header
 * grows and shrinks — an extra "Statement generated on ..." line is enough to
 * shift everything by one. Searching for the row that actually contains the
 * remembered date column is stable against that; skipRows is only the
 * fallback.
 */
export function locateHeaderRow(grid: string[][], profile: StatementProfile): number {
  const wanted = normalizeHeader(profile.dateColumn);
  if (wanted) {
    const searchDepth = Math.min(grid.length, 30);
    for (let i = 0; i < searchDepth; i++) {
      if ((grid[i] ?? []).some((cell) => normalizeHeader(cell) === wanted)) return i;
    }
  }
  return Math.min(profile.skipRows, Math.max(grid.length - 1, 0));
}

function buildColumnIndex(headers: string[]): Map<string, number> {
  const index = new Map<string, number>();
  headers.forEach((header, i) => {
    const key = normalizeHeader(header);
    // First occurrence wins: a duplicate header later in the row is the
    // padding column banks leave at the end, not the real one.
    if (key && !index.has(key)) index.set(key, i);
  });
  return index;
}

interface Resolver {
  cell: (row: string[], column: string | null) => string;
  missing: string[];
}

function buildResolver(headers: string[], profile: StatementProfile): Resolver {
  const index = buildColumnIndex(headers);
  const missing: string[] = [];

  const required = [
    profile.dateColumn,
    ...profile.narrationColumns,
    profile.withdrawalColumn,
    profile.depositColumn,
    profile.amountColumn,
    profile.typeColumn,
  ].filter((c): c is string => !!c);

  for (const column of required) {
    if (!index.has(normalizeHeader(column))) missing.push(column);
  }

  return {
    cell: (row, column) => {
      if (!column) return "";
      const i = index.get(normalizeHeader(column));
      return i === undefined ? "" : (row[i] ?? "").trim();
    },
    missing,
  };
}

interface DirectionalAmount {
  direction: StatementDirection;
  amountPaise: number;
}

function readAmount(
  row: string[],
  profile: StatementProfile,
  resolve: Resolver["cell"]
): DirectionalAmount | { error: string } {
  if (profile.amountMode === "separate_columns") {
    const withdrawal = parseAmountCell(resolve(row, profile.withdrawalColumn));
    const deposit = parseAmountCell(resolve(row, profile.depositColumn));
    const w = withdrawal ? Math.abs(withdrawal.paise) : 0;
    const d = deposit ? Math.abs(deposit.paise) : 0;

    if (w > 0 && d > 0) {
      return { error: "Both the withdrawal and deposit columns have a value — check the column mapping" };
    }
    if (w === 0 && d === 0) return { error: "No amount on this row" };
    return w > 0 ? { direction: "withdrawal", amountPaise: w } : { direction: "deposit", amountPaise: d };
  }

  const parsed = parseAmountCell(resolve(row, profile.amountColumn));
  if (!parsed || parsed.paise === 0) return { error: "No amount on this row" };

  if (profile.amountMode === "amount_with_type") {
    // A Dr/Cr marker inside the amount cell is the file being explicit, so it
    // outranks the indicator column.
    const marker = parsed.explicitSign ?? readTypeMarker(resolve(row, profile.typeColumn));
    if (!marker) return { error: "Could not tell whether this row is a debit or a credit" };
    // A debit on a bank statement is money leaving the account.
    return {
      direction: marker === "Dr" ? "withdrawal" : "deposit",
      amountPaise: Math.abs(parsed.paise),
    };
  }

  // A Dr/Cr marker in the cell outranks the sign convention here for the same
  // reason it outranks the indicator column above: the file said so outright,
  // and `negativeIsWithdrawal` is only ever an assumption about what an unmarked
  // sign meant. The banks that write the marker inline are also the ones with no
  // indicator column, so detection lands them in this mode — reading the marker
  // is what stops their whole statement from importing back to front.
  if (parsed.explicitSign) {
    return {
      direction: parsed.explicitSign === "Dr" ? "withdrawal" : "deposit",
      amountPaise: Math.abs(parsed.paise),
    };
  }

  const isWithdrawal = parsed.negative === profile.negativeIsWithdrawal;
  return { direction: isWithdrawal ? "withdrawal" : "deposit", amountPaise: Math.abs(parsed.paise) };
}

/**
 * Reads a running-balance cell, signed from the account holder's side.
 *
 * A "Dr" against a balance means the account is overdrawn — the customer owes
 * the bank — which is the resting state of the OD and cash-credit accounts most
 * businesses here run on, and those banks mark it in the cell rather than with a
 * minus. Reading only the minus left every such statement positive, which both
 * inverted closingBalancePaise against the ledger on the reconciliation screen
 * and made the continuity check below fail on a mapping that was correct.
 */
function readBalanceCell(raw: string): number | null {
  const balance = parseAmountCell(raw);
  if (!balance) return null;
  // The marker is the file being explicit, so it settles the sign on its own; a
  // minus or accounting parentheses is all there is to go on without one.
  const overdrawn = balance.explicitSign ? balance.explicitSign === "Dr" : balance.negative;
  return overdrawn ? -Math.abs(balance.paise) : Math.abs(balance.paise);
}

function readTypeMarker(value: string): "Dr" | "Cr" | null {
  const text = value.trim().toLowerCase().replace(/\./g, "");
  if (text === "dr" || text === "d" || text === "debit" || text === "w" || text === "withdrawal") return "Dr";
  if (text === "cr" || text === "c" || text === "credit" || text === "dep" || text === "deposit") return "Cr";
  return null;
}

/**
 * Reads every data row under a header into normalized lines.
 *
 * `headerRowIndex` is where the header actually is in this file — from
 * detection on a first import, or from locateHeaderRow() when reusing a saved
 * profile.
 */
export function readStatement(
  grid: string[][],
  profile: StatementProfile,
  headerRowIndex: number
): StatementReadResult {
  const headers = (grid[headerRowIndex] ?? []).map((c) => c.trim());
  const resolver = buildResolver(headers, profile);
  const errors: StatementRowError[] = [];
  const issues: string[] = [];

  if (resolver.missing.length) {
    issues.push(
      `This file has no ${resolver.missing.map((c) => `"${c}"`).join(", ")} column. ` +
        "It may be a different export format from the one saved for this account — re-map it below."
    );
  }

  interface Draft {
    lineNumber: number;
    txnDate: string;
    valueDate: string | null;
    narration: string;
    reference: string | null;
    direction: StatementDirection;
    amountPaise: number;
    runningBalancePaise: number | null;
  }

  const drafts: Draft[] = [];

  // Statements end with a summary block ("Opening Balance", "Total
  // Withdrawals", a disclaimer) that has no date. Those rows aren't errors,
  // they're the end of the transactions. Finding the last dated row up front
  // separates "the file has stopped" from "this row in the middle is broken",
  // without re-scanning the tail once per undated row.
  let lastDatedRow = headerRowIndex;
  for (let i = grid.length - 1; i > headerRowIndex; i--) {
    const cell = resolver.cell(grid[i] ?? [], profile.dateColumn);
    if (parseStatementDate(cell, profile.dateFormat) !== null) {
      lastDatedRow = i;
      break;
    }
  }

  for (let i = headerRowIndex + 1; i <= lastDatedRow; i++) {
    const row = grid[i] ?? [];
    // Spreadsheet row number, which is what the user sees when they open the
    // file to check an error.
    const lineNumber = i + 1;

    if (row.every((cell) => cell.trim() === "")) continue;

    const rawDate = resolver.cell(row, profile.dateColumn);
    const txnDate = parseStatementDate(rawDate, profile.dateFormat);
    if (!txnDate) {
      errors.push({
        lineNumber,
        message: rawDate
          ? `"${rawDate}" is not a date this bank format explains`
          : "No date on this row",
      });
      continue;
    }

    const amount = readAmount(row, profile, resolver.cell);
    if ("error" in amount) {
      errors.push({ lineNumber, message: amount.error });
      continue;
    }

    const narration = profile.narrationColumns
      .map((column) => resolver.cell(row, column))
      .filter((part) => part !== "")
      .join(" ");

    const balance = profile.balanceColumn ? readBalanceCell(resolver.cell(row, profile.balanceColumn)) : null;

    drafts.push({
      lineNumber,
      txnDate,
      valueDate: profile.valueDateColumn
        ? parseStatementDate(resolver.cell(row, profile.valueDateColumn), profile.dateFormat)
        : null,
      narration,
      reference: profile.referenceColumn ? resolver.cell(row, profile.referenceColumn) || null : null,
      direction: amount.direction,
      amountPaise: amount.amountPaise,
      runningBalancePaise: balance,
    });
  }

  const withIndexes = assignOccurrenceIndexes(drafts);

  const lines: StatementLine[] = withIndexes.map((draft) => ({
    lineNumber: draft.lineNumber,
    txnDate: draft.txnDate,
    valueDate: draft.valueDate,
    narration: draft.narration,
    reference: draft.reference,
    withdrawalPaise: draft.direction === "withdrawal" ? draft.amountPaise : 0,
    depositPaise: draft.direction === "deposit" ? draft.amountPaise : 0,
    runningBalancePaise: draft.runningBalancePaise,
    occurrenceIndex: draft.occurrenceIndex,
    fingerprint: buildFingerprint({
      txnDate: draft.txnDate,
      direction: draft.direction,
      amountPaise: draft.amountPaise,
      narration: draft.narration,
      occurrenceIndex: draft.occurrenceIndex,
    }),
  }));

  issues.push(...checkBalanceContinuity(lines));

  const dates = lines.map((l) => l.txnDate).sort();
  const lastWithBalance = [...lines].reverse().find((l) => l.runningBalancePaise !== null);

  return {
    lines,
    errors,
    issues,
    periodStart: dates[0] ?? null,
    periodEnd: dates[dates.length - 1] ?? null,
    closingBalancePaise: lastWithBalance?.runningBalancePaise ?? null,
  };
}

/**
 * Walks the running balance column and checks each step against the movement
 * on that row.
 *
 * This is the single most useful check in the whole importer, and it's free:
 * if the mapping has withdrawals and deposits the wrong way round, or the
 * amount column belongs to a different field, the balance stops adding up on
 * the very first row. Catching that here means the user re-maps a column
 * instead of discovering an inverted month after posting sixty vouchers.
 *
 * Reported as a warning rather than an error: some banks order the file newest
 * first, and some interleave same-day transactions in an order that doesn't
 * match the balance sequence, neither of which makes the amounts wrong.
 */
function checkBalanceContinuity(lines: StatementLine[]): string[] {
  const withBalance = lines.filter((l) => l.runningBalancePaise !== null);
  if (withBalance.length < 3) return [];

  let breaks = 0;
  let firstBreakLine = 0;

  for (let i = 1; i < withBalance.length; i++) {
    const previous = withBalance[i - 1].runningBalancePaise as number;
    const current = withBalance[i].runningBalancePaise as number;
    const movement = withBalance[i].depositPaise - withBalance[i].withdrawalPaise;
    if (previous + movement !== current) {
      breaks++;
      if (!firstBreakLine) firstBreakLine = withBalance[i].lineNumber;
    }
  }

  if (breaks === 0) return [];

  // Every step failing is the signature of a newest-first file, which is fine
  // once you know it; scattered failures mean something is genuinely off.
  if (breaks === withBalance.length - 1) {
    const reversedFits = checkReverseContinuity(withBalance);
    if (reversedFits) {
      return ["This statement is ordered newest first. That's fine — the dates are read from the file, not its order."];
    }
  }

  const total = withBalance.length - 1;
  return [
    `The running balance doesn't add up on ${breaks} of ${total} rows (first at row ${firstBreakLine}). ` +
      "That usually means a column is mapped to the wrong field — check withdrawals and deposits aren't swapped.",
  ];
}

function checkReverseContinuity(lines: StatementLine[]): boolean {
  for (let i = lines.length - 2; i >= 0; i--) {
    const previous = lines[i + 1].runningBalancePaise as number;
    const current = lines[i].runningBalancePaise as number;
    const movement = lines[i].depositPaise - lines[i].withdrawalPaise;
    if (previous + movement !== current) return false;
  }
  return true;
}

/** Totals for the preview header, in rupees, ready to format. */
export function summarizeStatement(lines: StatementLine[]): {
  withdrawals: number;
  deposits: number;
  count: number;
} {
  let withdrawals = 0;
  let deposits = 0;
  for (const line of lines) {
    withdrawals += line.withdrawalPaise;
    deposits += line.depositPaise;
  }
  return { withdrawals: fromPaise(withdrawals), deposits: fromPaise(deposits), count: lines.length };
}
