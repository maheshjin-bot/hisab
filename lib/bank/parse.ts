import { fromPaise } from "@/lib/utils/currency";
import { parseAmountCell } from "./amount";
import { parseStatementDate } from "./date";
import { assignOccurrenceIndexes, buildFingerprint } from "./fingerprint";
import { isPositionalColumnKey, positionalColumnKey } from "./types";
import type {
  DateFormat,
  StatementDirection,
  StatementLine,
  StatementProfile,
  StatementReadResult,
  StatementRowError,
} from "./types";

/** How the profile's date ordering reads to a user who has to choose another one. */
const DATE_FORMAT_LABEL: Record<DateFormat, string> = {
  dmy: "day/month/year",
  mdy: "month/day/year",
  ymd: "year-month-day",
};

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
 *
 * The date column alone is not enough to identify that row, though. A
 * spreadsheet export writes its generation stamp as a label cell beside a
 * value cell — "Date" | "17/08/2026" — and a preamble row like that contains
 * the remembered date column just as literally as the header does. Taking the
 * first such row read the preamble as the header, and since none of the other
 * mapped columns are up there, every column came back missing and the import
 * produced zero lines with per-row errors blaming the data. The file's *first*
 * upload was fine, because detectHeaderRow scores whole rows; it only broke
 * once the profile was saved, which is every upload after the first.
 *
 * So the profile's other columns corroborate: a real header row carries the
 * narration, amount and balance names too, and a label cell carries none of
 * them. Proximity to the remembered skipRows only settles a tie between rows
 * that are equally corroborated — it can't lead, because the height of the
 * preamble is exactly the thing that moves.
 */
export function locateHeaderRow(grid: string[][], profile: StatementProfile): number {
  const wanted = normalizeHeader(profile.dateColumn);
  if (wanted) {
    // Positional keys are deliberately absent from this list: they name a
    // column with no header text, so they corroborate nothing about a row.
    const corroborating = [
      ...profile.narrationColumns,
      profile.valueDateColumn,
      profile.referenceColumn,
      profile.balanceColumn,
      profile.withdrawalColumn,
      profile.depositColumn,
      profile.amountColumn,
      profile.typeColumn,
    ]
      .filter((c): c is string => !!c && !isPositionalColumnKey(c))
      .map(normalizeHeader);

    const searchDepth = Math.min(grid.length, 30);
    let best: { index: number; found: number } | null = null;

    for (let i = 0; i < searchDepth; i++) {
      const cells = new Set((grid[i] ?? []).map(normalizeHeader));
      if (!cells.has(wanted)) continue;
      const found = corroborating.filter((column) => cells.has(column)).length;
      if (
        !best ||
        found > best.found ||
        (found === best.found &&
          Math.abs(i - profile.skipRows) < Math.abs(best.index - profile.skipRows))
      ) {
        best = { index: i, found };
      }
    }

    if (best) return best.index;
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
    // Every column is also indexed by its position, unconditionally — this is
    // what lets a column detect.ts recorded with positionalColumnKey(), for
    // having no header text at all, still be found here.
    index.set(normalizeHeader(positionalColumnKey(i)), i);
  });
  return index;
}

interface Resolver {
  cell: (row: string[], column: string | null) => string;
  missing: string[];
  /** Required fields that landed on one column, keyed by that column's header. */
  collisions: Map<string, string[]>;
}

/** How each required field reads to a user looking at the mapping screen. */
function requiredFields(profile: StatementProfile): { field: string; column: string }[] {
  return [
    { field: "transaction date", column: profile.dateColumn },
    ...profile.narrationColumns.map((column) => ({ field: "description", column })),
    { field: "withdrawal", column: profile.withdrawalColumn },
    { field: "deposit", column: profile.depositColumn },
    { field: "amount", column: profile.amountColumn },
    { field: "debit/credit indicator", column: profile.typeColumn },
  ].filter((entry): entry is { field: string; column: string } => !!entry.column);
}

function buildResolver(headers: string[], profile: StatementProfile): Resolver {
  const index = buildColumnIndex(headers);
  const missing: string[] = [];
  const required = requiredFields(profile);

  for (const { column } of required) {
    if (!index.has(normalizeHeader(column))) missing.push(column);
  }

  // Two fields resolving to one column is the same class of failure as a
  // missing one — the mapping cannot be applied — but it used to surface
  // nowhere. Every row then failed with a message that blamed the data ("both
  // columns have a value"), pointing the user at a mapping screen where the
  // two fields do show two different headers; they only read the same once
  // trimmed and lowercased, which is how a merged "Debit | Credit"
  // super-header lands in an XLS export. Named here alongside the missing
  // columns so the file-level explanation matches the actual mistake.
  const byColumn = new Map<number, { field: string; column: string }[]>();
  for (const entry of required) {
    const i = index.get(normalizeHeader(entry.column));
    if (i === undefined) continue;
    const existing = byColumn.get(i);
    if (existing) existing.push(entry);
    else byColumn.set(i, [entry]);
  }

  const collisions = new Map<string, string[]>();
  for (const entries of byColumn.values()) {
    if (entries.length < 2) continue;
    collisions.set(entries[0].column, entries.map((e) => e.field));
  }

  return {
    cell: (row, column) => {
      if (!column) return "";
      const i = index.get(normalizeHeader(column));
      return i === undefined ? "" : (row[i] ?? "").trim();
    },
    missing,
    collisions,
  };
}

interface DirectionalAmount {
  direction: StatementDirection;
  amountPaise: number;
}

function opposite(direction: StatementDirection): StatementDirection {
  return direction === "withdrawal" ? "deposit" : "withdrawal";
}

/**
 * Whether a minus in a separate withdrawal/deposit column means anything.
 *
 * True for a column that carries both signs; false for one where every value
 * is negative, because there the minus is the column's house style and says
 * nothing about direction. Read the whole column, once, before any row — a
 * single row cannot tell the two apart, and guessing per row is how a file
 * that signs every withdrawal ends up read back to front.
 */
interface SignConvention {
  withdrawalMeansReversal: boolean;
  depositMeansReversal: boolean;
}

function detectSignConvention(
  rows: string[][],
  profile: StatementProfile,
  resolve: Resolver["cell"]
): SignConvention {
  const carriesBothSigns = (column: string | null): boolean => {
    if (!column) return false;
    let negative = 0;
    let positive = 0;
    for (const row of rows) {
      const parsed = parseAmountCell(resolve(row, column));
      if (!parsed || parsed.paise === 0) continue;
      if (parsed.negative) negative++;
      else positive++;
    }
    return negative > 0 && positive > 0;
  };

  return {
    withdrawalMeansReversal: carriesBothSigns(profile.withdrawalColumn),
    depositMeansReversal: carriesBothSigns(profile.depositColumn),
  };
}

function readAmount(
  row: string[],
  profile: StatementProfile,
  resolve: Resolver["cell"],
  signs: SignConvention
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

    // In this mode the column names the direction and the cell carries only a
    // magnitude — which is why the magnitudes above are taken as absolutes.
    //
    // A minus is the one exception, and only in a column that also carries
    // unsigned values. There it is the file overruling its own column: a
    // reversed bank charge is put back in the column it was taken from, with a
    // minus, by SBI, Kotak and most co-operative banks, rather than being
    // written on the other side. Read as another charge it gets the direction
    // wrong *and* doubles the row's error in the running balance.
    //
    // In a column where every value is negative the minus is decoration, and
    // honouring it would invert the direction of the entire statement — a far
    // worse trade than the single misread row it would fix. Hence the
    // whole-column test above rather than a per-row one.
    const column = w > 0 ? withdrawal : deposit;
    const base: StatementDirection = w > 0 ? "withdrawal" : "deposit";
    const meansReversal = w > 0 ? signs.withdrawalMeansReversal : signs.depositMeansReversal;
    const direction = column?.negative && meansReversal ? opposite(base) : base;
    return { direction, amountPaise: w > 0 ? w : d };
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

  for (const [column, fields] of resolver.collisions) {
    issues.push(
      `The ${fields.map((f) => `"${f}"`).join(" and ")} fields are both mapped to the ` +
        `"${column}" column, so they read the same cell on every row. ` +
        "If this file has two columns with the same heading, one of them needs a different name — re-map them below."
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
  // Counted separately from errors.length so the file-level "no dates at all"
  // message below is only raised when dates are actually what failed.
  let dateFailures = 0;

  // Settled over the whole file before any row is read — see detectSignConvention.
  const signs = detectSignConvention(grid.slice(headerRowIndex + 1), profile, resolver.cell);

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
      dateFailures++;
      errors.push({
        lineNumber,
        message: rawDate
          ? `"${rawDate}" is not a date this bank format explains`
          : "No date on this row",
      });
      continue;
    }

    const amount = readAmount(row, profile, resolver.cell, signs);
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

  // Everything below the last *readable* date. Normally that's the summary
  // block — "Opening Balance", "Closing Balance", a disclaimer — which is the
  // end of the file rather than a run of broken rows, and skipping it is why
  // lastDatedRow exists at all.
  //
  // But a transaction whose own date is unreadable lands down here too: 31/02,
  // a 29 February in a non-leap year, a page footer the bank inserted between
  // transactions. Those were dropped without a word, and because the preview
  // counts the same rows it imported, an entire tail of the month could go
  // missing with nothing on screen looking wrong.
  //
  // What separates the two cases is money, not the date cell. A summary row
  // carries a balance; a transaction carries a withdrawal or a deposit. So a
  // row down here is only reported when it has an amount to lose — which also
  // keeps a wordy disclaimer or a "Page 1 of 3" footer from being called an
  // error.
  for (let i = lastDatedRow + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (row.every((cell) => cell.trim() === "")) continue;
    if ("error" in readAmount(row, profile, resolver.cell, signs)) continue;

    const rawDate = resolver.cell(row, profile.dateColumn);
    dateFailures++;
    errors.push({
      lineNumber: i + 1,
      message: rawDate
        ? `"${rawDate}" is not a date this bank format explains`
        : "No date on this row",
    });
  }

  // Nothing parsed, and dates are why. The reachable cause is a saved profile
  // whose date format no longer matches the file — the user moved from the
  // bank's CSV export to its XLS export, or the bank changed it — and the
  // per-row errors alone don't say which setting to reach for. The balance
  // continuity check can't cover this: it needs three parsed lines to run, and
  // there are none.
  if (!drafts.length && dateFailures > 0) {
    issues.push(
      `No row's date could be read as ${DATE_FORMAT_LABEL[profile.dateFormat]}. ` +
        "If this is a different export from the one saved for this account, change the date format below."
    );
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
