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

  const results: RowValidationResult<TParsed>[] = rawRows.map((raw, index) => {
    const rowNumber = index + 2; // header is row 1
    const normalized = normalizeRawRow(raw, config.columns);

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

    const fileLevel = config.validateFile(validSoFar, ctx);
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
