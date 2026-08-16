import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildImportPreview } from "@/lib/csv/validate";
import type { CsvImportConfig, RawCsvRow } from "@/lib/csv/types";

interface Ctx {
  existingNames: Set<string>;
}

interface Parsed {
  name: string;
  amount: number;
  side: "Dr" | "Cr";
  voucher: string;
}

/**
 * A miniature grouped import, shaped like the real voucher config: three
 * validation stages, a group key, and a whole-file rule that only makes sense
 * across rows.
 */
function config(): CsvImportConfig<Parsed, Parsed, Ctx> {
  return {
    entityName: "Line",
    importType: "vouchers",
    columns: [
      { key: "voucher", header: "Voucher", required: true, sampleValue: "V1" },
      { key: "name", header: "Name", required: true, sampleValue: "Cash" },
      { key: "amount", header: "Amount", sampleValue: "100" },
      { key: "side", header: "Dr/Cr", sampleValue: "Dr" },
    ],
    prepareContext: async () => ({ existingNames: new Set<string>() }),
    transformRow: (raw) => ({
      voucher: raw["Voucher"] ?? "",
      name: raw["Name"] ?? "",
      amount: Number(raw["Amount"] ?? "0"),
      side: (raw["Dr/Cr"] ?? "Dr") as "Dr" | "Cr",
    }),
    rowSchema: (ctx: Ctx) =>
      z.object({
        voucher: z.string().min(1, { error: "Voucher is required" }),
        name: z
          .string()
          .min(1, { error: "Name is required" })
          .refine((n) => !ctx.existingNames.has(n.toLowerCase()), { error: "Already exists" }),
        amount: z.number({ error: "Amount must be a number" }).positive({ error: "Amount must be positive" }),
        side: z.enum(["Dr", "Cr"]),
      }) as z.ZodType<Parsed>,
    groupKey: (row) => row.voucher,
    validateFile: (validRows) => {
      const byVoucher = new Map<string, { dr: number; cr: number; rows: number[] }>();
      for (const { rowNumber, data } of validRows) {
        const entry = byVoucher.get(data.voucher) ?? { dr: 0, cr: 0, rows: [] };
        if (data.side === "Dr") entry.dr += data.amount;
        else entry.cr += data.amount;
        entry.rows.push(rowNumber);
        byVoucher.set(data.voucher, entry);
      }
      return [...byVoucher.entries()]
        .filter(([, e]) => e.dr !== e.cr)
        .map(([voucher, e]) => ({
          rowNumbers: e.rows,
          severity: "error" as const,
          message: `Voucher ${voucher} is unbalanced`,
        }));
    },
    onCommit: async () => ({ insertedCount: 0, failedCount: 0, errors: [] }),
  };
}

const ctx: Ctx = { existingNames: new Set(["taken"]) };

const row = (voucher: string, name: string, amount: string, side: string): RawCsvRow => ({
  Voucher: voucher,
  Name: name,
  Amount: amount,
  "Dr/Cr": side,
});

describe("CSV three-stage validation", () => {
  it("accepts a balanced file", () => {
    const preview = buildImportPreview(
      [row("V1", "Cash", "100", "Dr"), row("V1", "Sales", "100", "Cr")],
      config(),
      ctx
    );
    expect(preview.results.every((r) => r.errors.length === 0)).toBe(true);
    expect(preview.fileIssues).toEqual([]);
  });

  it("numbers rows from 2, since the header is row 1", () => {
    const preview = buildImportPreview([row("V1", "", "100", "Dr")], config(), ctx);
    expect(preview.results[0].rowNumber).toBe(2);
  });

  it("reports a missing required column once for the file, not per row", () => {
    const preview = buildImportPreview(
      [{ Name: "Cash", Amount: "100", "Dr/Cr": "Dr" }, { Name: "Sales", Amount: "100", "Dr/Cr": "Cr" }],
      config(),
      ctx
    );
    const missing = preview.fileIssues.filter((i) => i.message.includes("Missing required column"));
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain("Voucher");
  });

  it("keeps a per-row schema failure on the row that caused it", () => {
    const preview = buildImportPreview(
      [row("V1", "Cash", "not-a-number", "Dr"), row("V1", "Sales", "100", "Cr"), row("V2", "Cash", "5", "Dr"), row("V2", "Sales", "5", "Cr")],
      config(),
      ctx
    );
    expect(JSON.stringify(preview.results[0].errors)).toContain("Amount must be a number");
    // A different voucher entirely is untouched by it.
    expect(preview.results[2].errors).toEqual([]);
    expect(preview.results[3].errors).toEqual([]);
  });

  it("propagates a whole-file issue onto the rows it concerns", () => {
    // Dropping the invalid Dr line leaves its voucher with a lone Cr line, so
    // the surviving row is genuinely part of an unbalanced voucher and is
    // told so — the file-level issue is not merely reported in aggregate.
    const preview = buildImportPreview(
      [row("V1", "Cash", "not-a-number", "Dr"), row("V1", "Sales", "100", "Cr")],
      config(),
      ctx
    );
    expect(JSON.stringify(preview.results[1].errors)).toContain("Voucher V1 is unbalanced");
  });

  it("uses the context, so a duplicate of an existing record is rejected", () => {
    const preview = buildImportPreview([row("V1", "Taken", "100", "Dr")], config(), ctx);
    expect(JSON.stringify(preview.results[0].errors)).toContain("Already exists");
  });

  it("applies whole-file rules that no single row could catch", () => {
    const preview = buildImportPreview(
      [row("V1", "Cash", "100", "Dr"), row("V1", "Sales", "60", "Cr")],
      config(),
      ctx
    );
    expect(preview.fileIssues.map((i) => i.message)).toContain("Voucher V1 is unbalanced");
  });

  it("checks each group independently", () => {
    const preview = buildImportPreview(
      [
        row("V1", "Cash", "100", "Dr"),
        row("V1", "Sales", "100", "Cr"),
        row("V2", "Cash", "50", "Dr"),
        row("V2", "Sales", "40", "Cr"),
      ],
      config(),
      ctx
    );
    const messages = preview.fileIssues.map((i) => i.message);
    expect(messages).toContain("Voucher V2 is unbalanced");
    expect(messages).not.toContain("Voucher V1 is unbalanced");
  });

  it("handles an empty file without inventing issues", () => {
    const preview = buildImportPreview([], config(), ctx);
    expect(preview.results).toEqual([]);
  });
});
