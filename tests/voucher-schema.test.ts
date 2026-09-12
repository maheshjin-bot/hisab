import { describe, expect, it } from "vitest";
import { buildVoucherSchema, voucherLineSchema } from "@/lib/voucher/voucher-schema";
import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";

const line = (ledgerId: string, debit: number, credit: number) => ({
  ledgerId,
  debitAmount: debit,
  creditAmount: credit,
});

const form = (lines: ReturnType<typeof line>[]) => ({
  voucherDate: "2026-04-01",
  lines,
});

describe("voucher line", () => {
  it("requires an amount on exactly one side", () => {
    expect(voucherLineSchema.safeParse(line("l1", 100, 0)).success).toBe(true);
    expect(voucherLineSchema.safeParse(line("l1", 0, 100)).success).toBe(true);
    // Both sides, or neither, is not a line.
    expect(voucherLineSchema.safeParse(line("l1", 100, 100)).success).toBe(false);
    expect(voucherLineSchema.safeParse(line("l1", 0, 0)).success).toBe(false);
  });

  it("requires a ledger", () => {
    expect(voucherLineSchema.safeParse(line("", 100, 0)).success).toBe(false);
  });

  it("rejects negative amounts rather than treating them as the other side", () => {
    expect(voucherLineSchema.safeParse(line("l1", -100, 0)).success).toBe(false);
  });
});

describe.each(VOUCHER_TYPE_ORDER)("%s voucher", (type) => {
  const schema = buildVoucherSchema(VOUCHER_TYPE_CONFIG[type]);

  it("accepts a balanced two-line voucher", () => {
    const result = schema.safeParse(form([line("a", 500, 0), line("b", 0, 500)]));
    expect(result.success).toBe(true);
  });

  it("rejects an unbalanced voucher", () => {
    const result = schema.safeParse(form([line("a", 500, 0), line("b", 0, 400)]));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("Total debit must equal total credit");
  });

  it("rejects a single-line voucher", () => {
    expect(schema.safeParse(form([line("a", 500, 0)])).success).toBe(false);
  });

  it("requires a date", () => {
    const result = schema.safeParse({ voucherDate: "", lines: [line("a", 5, 0), line("b", 0, 5)] });
    expect(result.success).toBe(false);
  });

  it("balances amounts that float addition would not", () => {
    // 100.10 + 200.20 !== 300.30 in floats; the schema compares paise, so
    // this must be accepted.
    const result = schema.safeParse(
      form([line("a", 100.1, 0), line("b", 200.2, 0), line("c", 0, 300.3)])
    );
    expect(result.success).toBe(true);
  });

  it("catches an imbalance of a single paise", () => {
    const result = schema.safeParse(form([line("a", 500.01, 0), line("b", 0, 500)]));
    expect(result.success).toBe(false);
  });

  it("ignores untouched blank rows a full-grid type's own defaultRowCount pre-fills the form with", () => {
    // The exact bug reported live: Adjustment opens with 2+2 starter rows,
    // a person fills exactly two of them and leaves the other two exactly
    // as emptyLine() made them — no ledger, both amounts at their default.
    // The whole voucher used to be refused for "Select a ledger" on rows
    // nobody ever touched.
    const blank = line("", 0, 0);
    const result = schema.safeParse(form([line("a", 500, 0), line("b", 0, 500), blank, blank]));
    expect(result.success).toBe(true);
  });

  it("still refuses a row that is only partly filled in, blank rows or not", () => {
    // A ledger picked with no amount yet is a real, incomplete line — not
    // the same shape isBlankVoucherLine() drops.
    const startedButEmpty = line("c", 0, 0);
    const result = schema.safeParse(form([line("a", 500, 0), line("b", 0, 500), startedButEmpty]));
    expect(result.success).toBe(false);
  });
});
