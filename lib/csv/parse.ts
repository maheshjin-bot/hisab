import Papa from "papaparse";
import type { RawCsvRow } from "./types";

export interface ParseCsvFileResult {
  rows: RawCsvRow[];
  errors: Papa.ParseError[];
}

/** Parses a CSV File (from an <input type="file"> or drop event) into header-keyed rows. */
export function parseCsvFile(file: File): Promise<ParseCsvFileResult> {
  return new Promise((resolve, reject) => {
    Papa.parse<RawCsvRow>(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (header) => header.trim(),
      transform: (value) => value.trim(),
      complete: (results) => {
        resolve({ rows: results.data, errors: results.errors });
      },
      error: (error) => reject(error),
    });
  });
}
