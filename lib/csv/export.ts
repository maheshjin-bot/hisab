import Papa from "papaparse";
import type { CsvColumnDef } from "./types";
import { triggerBrowserDownload } from "./template";

export type ExportColumnDef<TRow> = Pick<CsvColumnDef<TRow>, "key" | "header" | "format">;

/** Client-side only — call from a Client Component (e.g. a "Export CSV" button's onClick). */
export function exportToCsv<TRow>(
  rows: TRow[],
  columns: ExportColumnDef<TRow>[],
  filename: string
) {
  const headers = columns.map((c) => c.header);
  const data = rows.map((row) =>
    columns.map((c) => {
      const value = row[c.key];
      return c.format ? c.format(value, row) : value == null ? "" : String(value);
    })
  );

  const csvText = Papa.unparse({ fields: headers, data });
  triggerBrowserDownload(csvText, filename.endsWith(".csv") ? filename : `${filename}.csv`);
}
