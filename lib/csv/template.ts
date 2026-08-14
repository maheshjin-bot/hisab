import Papa from "papaparse";
import type { CsvImportConfig, RawCsvRow } from "./types";

function resolveSampleValue(
  sampleValue: string | ((rowIndex: number) => string) | undefined,
  rowIndex: number
): string {
  if (sampleValue === undefined) return "";
  return typeof sampleValue === "function" ? sampleValue(rowIndex) : sampleValue;
}

export function generateSampleCsvText<TRow, TParsed, TContext = void>(
  config: CsvImportConfig<TRow, TParsed, TContext>
): string {
  const headers = config.columns.map((c) => c.header);

  const rows: RawCsvRow[] =
    config.sampleRowsOverride ??
    Array.from({ length: config.sampleRowCount ?? 2 }, (_, rowIndex) =>
      Object.fromEntries(
        config.columns.map((c) => [c.header, resolveSampleValue(c.sampleValue, rowIndex)])
      )
    );

  return Papa.unparse({ fields: headers, data: rows });
}

function triggerBrowserDownload(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Client-side only — call from a Client Component (e.g. a "Download template" button). */
export function downloadSampleCsv<TRow, TParsed, TContext = void>(
  config: CsvImportConfig<TRow, TParsed, TContext>,
  filename?: string
) {
  const text = generateSampleCsvText(config);
  triggerBrowserDownload(text, filename ?? `${config.entityName.toLowerCase().replace(/\s+/g, "-")}-template.csv`);
}

/** Shared by CsvExportButton — kept here so template + real export use one download primitive. */
export { triggerBrowserDownload };
