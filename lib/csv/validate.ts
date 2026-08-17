import type { z } from "zod";
import type {
  CsvImportConfig,
  CsvImportPreview,
  FileLevelIssue,
  RawCsvRow,
  RowError,
  RowValidationResult,
} from "./types";

/**
 * Re-keys a raw PapaParse row onto the exact header strings declared in
 * `columns`, matching case-insensitively and trim-insensitively. This is
 * what lets `transformRow` implementations safely do `raw['Ledger Name']`
 * even if a user's spreadsheet tool re-cased or padded the header row.
 * Columns not recognized are passed through unchanged.
 */
function normalizeRawRow<TRow>(
  raw: RawCsvRow,
  columns: CsvImportConfig<TRow, unknown>["columns"]
): RawCsvRow {
  const byNormalizedHeader = new Map(
    columns.map((c) => [c.header.trim().toLowerCase(), c.header])
  );
  const normalized: RawCsvRow = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    const canonical = byNormalizedHeader.get(rawKey.trim().toLowerCase());
    normalized[canonical ?? rawKey] = value;
  }
  return normalized;
}

function findMissingRequiredColumns<TRow>(
  rawRows: RawCsvRow[],
  columns: CsvImportConfig<TRow, unknown>["columns"]
): string[] {
  const presentHeaders = new Set(
    Object.keys(rawRows[0] ?? {}).map((h) => h.trim().toLowerCase())
  );
  return columns
    .filter((c) => c.required)
    .filter((c) => !presentHeaders.has(c.header.trim().toLowerCase()))
    .map((c) => c.header);
}

/**
 * The row number a user sees in Excel for the Nth data row. The header takes
 * row 1, so data starts at 2. Anything that needs to quote a row number back
 * to the user — including `transformRow`, which is handed the 0-based index —
 * has to agree with this, so there is one definition of it.
 */
export function rowNumberForIndex(index: number): number {
  return index + 2;
}

function zodErrorToRowErrors(error: z.ZodError): RowError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join(".") : undefined,
    message: issue.message,
  }));
}

/**
 * Runs the full 3-stage import pipeline: per-column parse (via
 * `transformRow`) -> per-row Zod validation -> whole-file cross-row rules.
 * A row is valid iff `results[i].errors.length === 0`, and that stays true
 * even after a whole-file rule demotes a previously-valid row.
 */
export function buildImportPreview<TRow, TParsed, TContext = void>(
  rawRows: RawCsvRow[],
  config: CsvImportConfig<TRow, TParsed, TContext>,
  ctx: TContext
): CsvImportPreview<TParsed> {
  const fileIssues: FileLevelIssue[] = [];

  const missingColumns = findMissingRequiredColumns(rawRows, config.columns);
  if (missingColumns.length) {
    fileIssues.push({
      rowNumbers: [],
      severity: "error",
      message: `Missing required column${missingColumns.length > 1 ? "s" : ""}: ${missingColumns.join(", ")}`,
    });
  }

  const schema =
    typeof config.rowSchema === "function"
      ? config.rowSchema(ctx)
      : config.rowSchema;

  // The header-normalized copy is kept alongside each result: a stage-3 rule
  // that has to place a rejected row (which has no parsed data at all) can
  // only do it from the raw cells, and it should not have to re-do the
  // case-insensitive header matching to read them.
  const normalizedRows = rawRows.map((raw) => normalizeRawRow(raw, config.columns));

  const results: RowValidationResult<TParsed>[] = rawRows.map((raw, index) => {
    const rowNumber = rowNumberForIndex(index);
    const normalized = normalizedRows[index];

    let transformed: TRow;
    try {
      transformed = config.transformRow(normalized, index, ctx);
    } catch (err) {
      return {
        rowNumber,
        raw,
        data: null,
        errors: [{ message: err instanceof Error ? err.message : String(err) }],
      };
    }

    const parsed = schema.safeParse(transformed);
    if (parsed.success) {
      return { rowNumber, raw, data: parsed.data, errors: [] };
    }
    return { rowNumber, raw, data: null, errors: zodErrorToRowErrors(parsed.error) };
  });

  if (config.validateFile) {
    const validSoFar = results
      .filter((r): r is RowValidationResult<TParsed> & { data: TParsed } => r.errors.length === 0 && r.data !== null)
      .map((r) => ({ rowNumber: r.rowNumber, data: r.data }));

    const rejected = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.errors.length > 0 || result.data === null)
      .map(({ result, index }) => ({ rowNumber: result.rowNumber, raw: normalizedRows[index], errors: result.errors }));

    const fileLevel = config.validateFile(validSoFar, ctx, rejected);
    fileIssues.push(...fileLevel);

    const byRowNumber = new Map(results.map((r) => [r.rowNumber, r]));
    for (const issue of fileLevel) {
      if (issue.severity !== "error") continue;
      for (const rowNumber of issue.rowNumbers) {
        const row = byRowNumber.get(rowNumber);
        if (!row) continue;
        row.errors.push({ message: issue.message });
        row.data = null;
      }
    }
  }

  const validRowCount = results.filter((r) => r.errors.length === 0).length;

  return {
    totalRows: rawRows.length,
    validRowCount,
    invalidRowCount: results.length - validRowCount,
    results,
    fileIssues,
  };
}
