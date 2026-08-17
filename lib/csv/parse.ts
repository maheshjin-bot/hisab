import Papa from "papaparse";
import type { RawCsvRow } from "./types";

export interface ParseCsvFileResult {
  rows: RawCsvRow[];
  errors: Papa.ParseError[];
}

/**
 * Parses a CSV File into a raw grid of cells, header row and all.
 *
 * Bank statements need this rather than parseCsvFile(): they open with a block
 * of account metadata above the real header, so "row 1 is the header" — which
 * PapaParse's header mode assumes — puts the account holder's address in the
 * column names. Finding the header is lib/bank/detect.ts's job, and it needs
 * to see every row to do it.
 */
export function parseCsvGrid(file: File): Promise<{ grid: string[][]; errors: Papa.ParseError[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: "greedy",
      complete: (results) => {
        resolve({
          grid: results.data.map((row) => row.map((cell) => (cell ?? "").trim())),
          errors: results.errors,
        });
      },
      error: (error) => reject(error),
    });
  });
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
