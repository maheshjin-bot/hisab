import { looksNumeric, parseAmountCell } from "./amount";
import { detectDateFormat, looksLikeDate } from "./date";
import type { AmountMode, StatementProfile } from "./types";

/**
 * First-contact reading of a bank statement.
 *
 * Given nothing but the raw grid of cells, work out where the header row is,
 * which column is which, how dates are ordered and how direction is expressed.
 * Everything here is a proposal shown to the user for confirmation — the
 * confirmed version is what gets saved as the profile and reused, so the cost
 * of a wrong guess is one correction, not a wrong set of books.
 *
 * Two signals are combined for every column, and both are needed. Header text
 * alone is unreliable (banks label a withdrawal column "Debit", "Dr", "Paid",
 * or "Amount (Dr)"), and content alone can't tell a withdrawal column from a
 * deposit column, since both are just sparse numbers.
 */

export type StatementField =
  | "date" | "valueDate" | "narration" | "reference"
  | "withdrawal" | "deposit" | "amount" | "type" | "balance";

/** Header keywords per field, strongest first. */
const HEADER_HINTS: Record<StatementField, RegExp[]> = {
  date: [/^(txn|transaction|tran|posting|post|book)\.?\s*date$/i, /^date$/i, /date/i],
  valueDate: [/^value\s*date$/i, /value.*date|val\s*dt/i],
  narration: [
    /^(narration|description|particulars|remarks|details)$/i,
    /narration|description|particular|remark|detail|transaction\s*(details|remarks)/i,
  ],
  reference: [
    /^(ref|reference|utr|chq|cheque)(\s*(no|number|\.))?$/i,
    /ref(erence)?\s*(no|num)|utr|chq|cheque|instrument|transaction\s*id/i,
  ],
  withdrawal: [
    /^(withdrawal|withdrawl|debit|dr)(\s*(amt|amount))?\.?$/i,
    /withdraw|debit|\bdr\b|paid\s*out|payments?/i,
  ],
  deposit: [
    /^(deposit|credit|cr)(\s*(amt|amount))?\.?$/i,
    /deposit|credit|\bcr\b|paid\s*in|receipts?/i,
  ],
  amount: [/^amount$/i, /^(txn|transaction)\s*amount$/i, /amount|amt/i],
  type: [/^(dr\s*\/?\s*cr|cr\s*\/?\s*dr|type|txn\s*type|indicator)$/i, /dr.?cr|debit.?credit\s*(flag|indicator)/i],
  balance: [/^(balance|closing\s*balance|running\s*balance)$/i, /balance|bal\b/i],
};

/** Any of these in a header makes a column a plausible header row cell. */
const ANY_HINT = /date|narration|description|particular|remark|detail|withdraw|deposit|debit|credit|balance|amount|ref|chq|cheque|utr|type/i;

function headerScore(header: string, field: StatementField): number {
  const text = header.trim();
  if (!text) return 0;
  const patterns = HEADER_HINTS[field];
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(text)) return patterns.length - i; // exact match scores highest
  }
  return 0;
}

export interface DetectedGrid {
  headerRowIndex: number;
  headers: string[];
  dataRows: string[][];
}

/**
 * Finds the header row.
 *
 * Bank exports open with a block of account metadata — holder name, address,
 * IFSC, statement period — of varying height, so the header is not row 1 and
 * its position is not fixed for a given bank either. The row with the most
 * recognizable column names wins; ties go to the earliest, and a file with no
 * recognizable header falls back to row 0 so the user can map it by hand.
 */
export function detectHeaderRow(grid: string[][]): DetectedGrid {
  const searchDepth = Math.min(grid.length, 30);
  let bestIndex = 0;
  let bestScore = -1;

  for (let i = 0; i < searchDepth; i++) {
    const row = grid[i] ?? [];
    const filled = row.filter((c) => c.trim() !== "").length;
    if (filled < 3) continue;

    const hints = row.filter((c) => ANY_HINT.test(c)).length;
    // A header row is text, so numeric cells count against it — this is what
    // keeps a data row from winning on the strength of one "date"-ish cell.
    const numeric = row.filter((c) => looksNumeric(c)).length;
    const score = hints * 3 - numeric * 2 + Math.min(filled, 8) * 0.1;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const headers = (grid[bestIndex] ?? []).map((c) => c.trim());
  const dataRows = grid.slice(bestIndex + 1).filter((row) => row.some((c) => c.trim() !== ""));
  return { headerRowIndex: bestIndex, headers, dataRows };
}

function columnValues(dataRows: string[][], index: number, limit = 200): string[] {
  return dataRows.slice(0, limit).map((row) => row[index] ?? "");
}

/**
 * Cells that are printed but mean "nothing here".
 *
 * Kotak and several co-operative banks fill the unused side of a two-column
 * layout with a dash instead of leaving it empty. Kept in step with the same
 * list in amount.ts, which already reads these as blank rather than as zero —
 * a dash is the absence of a movement, not a movement of nought.
 */
const BLANK_MARKERS = new Set(["-", "–", "."]);

/** True for a cell carrying no value, whether it says so with space or a dash. */
function isBlankCell(value: string): boolean {
  const text = value.trim();
  return text === "" || BLANK_MARKERS.has(text);
}

interface ColumnStats {
  index: number;
  header: string;
  filledRatio: number;
  numericRatio: number;
  dateRatio: number;
  /** Mean length of the cells carrying a value — narration columns are the long ones. */
  meanLength: number;
  /** Distinct values, to spot a Dr/Cr indicator column. */
  distinct: Set<string>;
}

function profileColumns(headers: string[], dataRows: string[][]): ColumnStats[] {
  return headers.map((header, index) => {
    const values = columnValues(dataRows, index);
    // Blank markers are dropped from the denominator rather than counted as
    // values. Counting a dash as non-numeric dragged a perfectly good
    // withdrawal column to a numericRatio near 0.5, under the 0.9 gate, so the
    // column was discarded and the file fell through to signed_single with
    // every transaction's direction inverted. Counting a dash as numeric would
    // be the opposite mistake — a column of nothing but dashes would then look
    // like an amount column. Excluded from both sides, a dash column reads as
    // what it is: empty, with no numeric evidence either way.
    const present = values.filter((v) => !isBlankCell(v));
    const numeric = present.filter((v) => looksNumeric(v)).length;
    const dates = present.filter((v) => looksLikeDate(v)).length;
    const totalLength = present.reduce((sum, v) => sum + v.trim().length, 0);
    return {
      index,
      header,
      filledRatio: values.length ? present.length / values.length : 0,
      numericRatio: present.length ? numeric / present.length : 0,
      dateRatio: present.length ? dates / present.length : 0,
      meanLength: present.length ? totalLength / present.length : 0,
      distinct: new Set(present.slice(0, 100).map((v) => v.trim().toLowerCase())),
    };
  });
}

/** Content plausibility for a field, 0..1, independent of the header text. */
function contentScore(stats: ColumnStats, field: StatementField): number {
  switch (field) {
    case "date":
    case "valueDate":
      return stats.dateRatio >= 0.8 ? 1 : stats.dateRatio;
    case "withdrawal":
    case "deposit":
      // Sparse and numeric: on any given row only one of the two is used, so a
      // column that is always filled is a balance, not a movement.
      if (stats.numericRatio < 0.9) return 0;
      return stats.filledRatio > 0 && stats.filledRatio < 0.95 ? 1 : 0.3;
    case "amount":
      return stats.numericRatio >= 0.9 && stats.filledRatio >= 0.9 ? 1 : stats.numericRatio * 0.5;
    case "balance":
      return stats.numericRatio >= 0.9 && stats.filledRatio >= 0.9 ? 1 : 0;
    case "type": {
      const values = [...stats.distinct];
      if (values.length === 0 || values.length > 4) return 0;
      const drCr = values.filter((v) => /^(dr|cr|debit|credit|d|c)\.?$/.test(v)).length;
      return drCr === values.length ? 1 : 0;
    }
    case "narration":
      // Long, almost always present, and not a number.
      if (stats.numericRatio > 0.5 || stats.dateRatio > 0.5) return 0;
      return Math.min(stats.meanLength / 20, 1) * (stats.filledRatio > 0.6 ? 1 : 0.4);
    case "reference":
      if (stats.dateRatio > 0.5) return 0;
      return stats.filledRatio > 0.2 && stats.meanLength <= 30 ? 0.6 : 0.2;
  }
}

interface FieldPick {
  index: number;
  score: number;
}

function pickColumn(
  columns: ColumnStats[],
  field: StatementField,
  taken: Set<number>
): FieldPick | null {
  let best: FieldPick | null = null;
  for (const stats of columns) {
    if (taken.has(stats.index)) continue;
    const header = headerScore(stats.header, field);
    const content = contentScore(stats, field);
    // Both signals must be present for anything but narration, where a bank
    // occasionally leaves the column unlabelled entirely.
    if (header === 0 && (field !== "narration" || content < 0.8)) continue;
    if (content === 0) continue;
    const score = header * 2 + content * 3;
    if (!best || score > best.score) best = { index: stats.index, score };
  }
  return best;
}

export interface DetectionConfidence {
  /** 0..1 per field that was found. Fields not in the map weren't detected. */
  fields: Partial<Record<StatementField, number>>;
  /** Things the user has to decide, phrased for display. */
  warnings: string[];
  dateFormatUnambiguous: boolean;
}

export interface DetectedStatementFormat {
  grid: DetectedGrid;
  profile: StatementProfile;
  confidence: DetectionConfidence;
}

/**
 * Proposes a full profile for a statement whose format is not yet known.
 *
 * `label` is what the saved profile will be called — normally the bank
 * ledger's own name.
 */
export function detectStatementFormat(grid: string[][], label: string): DetectedStatementFormat {
  const detectedGrid = detectHeaderRow(grid);
  const { headers, dataRows } = detectedGrid;
  const columns = profileColumns(headers, dataRows);
  const taken = new Set<number>();
  const fields: DetectionConfidence["fields"] = {};
  const warnings: string[] = [];

  function claim(field: StatementField): number | null {
    const pick = pickColumn(columns, field, taken);
    if (!pick) return null;
    taken.add(pick.index);
    // pickColumn's raw score tops out at 2*|patterns| + 3; normalise to 0..1
    // so the UI can show one comparable number per field.
    fields[field] = Math.min(pick.score / 9, 1);
    return pick.index;
  }

  // Order matters: the most distinctive fields claim their columns first, so a
  // "Value Date" column can't be taken by the looser `date` matcher, and
  // `balance` is settled before `amount` competes for the same numeric columns.
  const valueDateIndex = claim("valueDate");
  const dateIndex = claim("date");
  const balanceIndex = claim("balance");
  const withdrawalIndex = claim("withdrawal");
  const depositIndex = claim("deposit");
  const typeIndex = claim("type");
  const amountIndex = withdrawalIndex !== null && depositIndex !== null ? null : claim("amount");
  const referenceIndex = claim("reference");
  const narrationIndex = claim("narration");

  let amountMode: AmountMode;
  if (withdrawalIndex !== null && depositIndex !== null) {
    amountMode = "separate_columns";
  } else if (amountIndex !== null && typeIndex !== null) {
    amountMode = "amount_with_type";
  } else if (amountIndex !== null) {
    amountMode = "signed_single";
    const signed = columnValues(dataRows, amountIndex).some((v) => {
      const parsed = parseAmountCell(v);
      return parsed?.negative === true;
    });
    if (!signed) {
      warnings.push(
        "Only one amount column was found and none of its values are negative — check whether withdrawals and deposits are really told apart in this file."
      );
    }
  } else {
    // Nothing usable. Leave the mode at the most common shape so the mapping
    // step opens on the right set of fields for the user to fill in.
    amountMode = "separate_columns";
    warnings.push("Could not tell which columns hold the amounts — please pick them.");
  }

  if (dateIndex === null) {
    warnings.push("Could not find a transaction date column — please pick it.");
  }
  if (narrationIndex === null) {
    warnings.push("Could not find a description column — suggestions will be weaker without one.");
  }

  const dateSamples = dateIndex !== null ? columnValues(dataRows, dateIndex) : [];
  const dateGuess = detectDateFormat(dateSamples);
  if (!dateGuess.unambiguous && dateIndex !== null) {
    warnings.push(
      "Every day in this file is 12 or below, so dd/mm and mm/dd look identical — confirm which one this bank uses."
    );
  }

  const nameOf = (index: number | null) => (index === null ? null : headers[index] ?? null);

  const profile: StatementProfile = {
    label,
    dateColumn: nameOf(dateIndex) ?? "",
    valueDateColumn: nameOf(valueDateIndex),
    narrationColumns: narrationIndex === null ? [] : [headers[narrationIndex]],
    referenceColumn: nameOf(referenceIndex),
    balanceColumn: nameOf(balanceIndex),
    amountMode,
    withdrawalColumn: amountMode === "separate_columns" ? nameOf(withdrawalIndex) : null,
    depositColumn: amountMode === "separate_columns" ? nameOf(depositIndex) : null,
    amountColumn: amountMode === "separate_columns" ? null : nameOf(amountIndex),
    typeColumn: amountMode === "amount_with_type" ? nameOf(typeIndex) : null,
    negativeIsWithdrawal: true,
    dateFormat: dateGuess.format,
    skipRows: detectedGrid.headerRowIndex,
  };

  return {
    grid: detectedGrid,
    profile,
    confidence: { fields, warnings, dateFormatUnambiguous: dateGuess.unambiguous },
  };
}
