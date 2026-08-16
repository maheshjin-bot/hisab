/**
 * The universal CSV import/export contract. Every importable module (ledgers,
 * opening balances, vouchers) and every exportable report plugs into this
 * same set of types — see lib/ledgers/ledger-csv-config.ts and
 * lib/voucher/voucher-csv-config.ts for concrete instances.
 */
import type { z } from "zod";
import type { ImportType } from "@/lib/supabase/queries/imports";

/** A single CSV row exactly as PapaParse hands it back (header mode: string values only). */
export type RawCsvRow = Record<string, string>;

export interface CsvColumnDef<TRow> {
  /** Property name on the transformed row. */
  key: Extract<keyof TRow, string>;
  /** CSV column header. Matched case-insensitively and whitespace-trimmed on import. */
  header: string;
  required?: boolean;
  /** Used to build the downloadable sample template. `rowIndex` is 0-based. */
  sampleValue?: string | ((rowIndex: number) => string);
  /** Export only: how to render this field back to a CSV string. */
  format?: (value: unknown, row: TRow) => string;
}

export interface RowError {
  field?: string;
  message: string;
}

export interface RowValidationResult<TParsed> {
  /** 1-based, matches the row number a user would see if they opened the file in Excel (header = row 1). */
  rowNumber: number;
  raw: RawCsvRow;
  data: TParsed | null;
  /** A row is valid iff this is empty — including after a whole-file rule demotes it. */
  errors: RowError[];
}

export interface FileLevelIssue {
  rowNumbers: number[];
  severity: "error" | "warning";
  message: string;
}

export interface CsvImportPreview<TParsed> {
  totalRows: number;
  validRowCount: number;
  invalidRowCount: number;
  results: RowValidationResult<TParsed>[];
  fileIssues: FileLevelIssue[];
}

export interface CommitResult {
  insertedCount: number;
  failedCount: number;
  errors?: { rowNumber: number; message: string }[];
}

export interface CsvImportConfig<TRow, TParsed, TContext = void> {
  /** Used in UI copy: "3 Ledgers imported", "Download Ledger template". */
  entityName: string;
  /** Which import_batches.import_type this run is recorded under. */
  importType: ImportType;
  columns: CsvColumnDef<TRow>[];
  /** Runs once before validating any row — e.g. fetch the existing group-name -> id index. */
  prepareContext?: () => Promise<TContext>;
  /** Stage 1: cheap type coercion from raw strings to a loosely-typed row. */
  transformRow: (raw: RawCsvRow, rowIndex: number, ctx: TContext) => TRow;
  /** Stage 2: the real validation, can depend on context (e.g. "group must exist"). */
  rowSchema: z.ZodType<TParsed> | ((ctx: TContext) => z.ZodType<TParsed>);
  /** Rows sharing a groupKey are one logical unit (e.g. all lines of one voucher). Omit for 1 row = 1 record. */
  groupKey?: (row: TParsed) => string;
  /** Stage 3: whole-file / cross-row rules (e.g. a voucher's debit total must equal its credit total). */
  validateFile?: (
    validRows: Array<{ rowNumber: number; data: TParsed }>,
    ctx: TContext
  ) => FileLevelIssue[];
  /** Commits the fully-valid rows. Should be transactional per logical group where that matters (see voucher import). */
  onCommit: (
    rows: TParsed[],
    ctx: TContext,
    onProgress?: (done: number, total: number) => void
  ) => Promise<CommitResult>;
  /** Simple case: generate N generic sample rows. */
  sampleRowCount?: number;
  /** Grouped case: hand-authored sample rows (e.g. one balanced example voucher). Takes precedence over sampleRowCount. */
  sampleRowsOverride?: RawCsvRow[];
}
