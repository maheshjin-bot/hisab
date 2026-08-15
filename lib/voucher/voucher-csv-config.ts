import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import type { CsvImportConfig, FileLevelIssue } from "@/lib/csv/types";
import { groupRowsBy } from "@/lib/csv/group-utils";
import { sumPaise, toPaise } from "@/lib/utils/currency";
import { bulkImportVouchers, type VoucherType } from "@/lib/supabase/queries/vouchers";
import { searchLedgersForCombobox } from "@/lib/supabase/queries/ledgers";

const VOUCHER_TYPES = ["receipt", "payment", "contra", "journal", "sales", "purchase"] as const satisfies readonly VoucherType[];

export interface VoucherCsvRow {
  groupId: string;
  date: string;
  voucherType: string;
  ledgerName: string;
  ledgerId: string;
  drCr: string;
  amount: number;
  narration: string;
}

export interface VoucherCsvParsed {
  groupId: string;
  date: string;
  voucherType: VoucherType;
  ledgerId: string;
  drCr: "Dr" | "Cr";
  amount: number;
  narration?: string;
}

export interface VoucherImportContext {
  ledgerIdByNormalizedName: Map<string, string>;
}

function normalize(s: string) {
  return s.trim().toLowerCase();
}

/** Accepts dd/mm/yyyy or yyyy-mm-dd; returns yyyy-mm-dd for Postgres, or null if unparseable. */
function parseDate(raw: string): string | null {
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return trimmed;
  const dmy = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

export function buildVoucherCsvImportConfig(
  supabase: SupabaseClient<Database>,
  companyId: string
): CsvImportConfig<VoucherCsvRow, VoucherCsvParsed, VoucherImportContext> {
  return {
    entityName: "Voucher line",
    columns: [
      { key: "groupId", header: "Voucher Ref", required: true, sampleValue: "PMT-0001" },
      { key: "date", header: "Date", required: true, sampleValue: "01/04/2026" },
      { key: "voucherType", header: "Voucher Type", required: true, sampleValue: "Payment" },
      { key: "ledgerName", header: "Ledger", required: true, sampleValue: (i) => (i === 0 ? "Office Rent" : "Cash-in-Hand") },
      { key: "drCr", header: "Dr/Cr", required: true, sampleValue: (i) => (i === 0 ? "Dr" : "Cr") },
      { key: "amount", header: "Amount", required: true, sampleValue: "5000.00" },
      { key: "narration", header: "Narration", sampleValue: "Rent for April" },
    ],
    prepareContext: async () => {
      // A generous limit covers realistic SME ledger counts for the name index;
      // the combobox itself uses a separate, query-as-you-type search.
      const ledgers = await searchLedgersForCombobox(supabase, companyId, "", 5000);
      return { ledgerIdByNormalizedName: new Map(ledgers.map((l) => [normalize(l.name), l.id])) };
    },
    transformRow: (raw, _i, ctx) => ({
      groupId: raw["Voucher Ref"] ?? "",
      date: raw["Date"] ?? "",
      voucherType: (raw["Voucher Type"] ?? "").trim().toLowerCase(),
      ledgerName: raw["Ledger"] ?? "",
      ledgerId: ctx.ledgerIdByNormalizedName.get(normalize(raw["Ledger"] ?? "")) ?? "",
      drCr: (raw["Dr/Cr"] ?? "").trim(),
      amount: Number(raw["Amount"] || "0"),
      narration: raw["Narration"] ?? "",
    }),
    rowSchema: () =>
      z
        .object({
          groupId: z.string().min(1, { error: "Voucher Ref is required" }),
          date: z
            .string()
            .transform((v, ctx) => {
              const parsed = parseDate(v);
              if (!parsed) {
                ctx.addIssue({ code: "custom", message: "Invalid date — use dd/mm/yyyy" });
                return z.NEVER;
              }
              return parsed;
            }),
          voucherType: z.enum(VOUCHER_TYPES, { error: "Unknown voucher type" }),
          ledgerName: z.string(),
          ledgerId: z.string().min(1, { error: "Unknown ledger name" }),
          drCr: z.enum(["Dr", "Cr"], { error: "Dr/Cr must be exactly 'Dr' or 'Cr'" }),
          amount: z.number({ error: "Amount must be a number" }).positive({ error: "Amount must be greater than 0" }),
          narration: z.string().optional(),
        })
        .transform((row) => ({
          groupId: row.groupId,
          date: row.date,
          voucherType: row.voucherType,
          ledgerId: row.ledgerId,
          drCr: row.drCr,
          amount: row.amount,
          narration: row.narration,
        })),
    groupKey: (row) => row.groupId,
    // The Dr = Cr check is inherently cross-row, so it can't live in rowSchema
    // — it runs once per voucher-ref group, after per-row validation, in
    // integer paise so rounding can't produce a false imbalance.
    validateFile: (validRows): FileLevelIssue[] => {
      const issues: FileLevelIssue[] = [];
      const groups = groupRowsBy(validRows, (r) => r.data.groupId);
      for (const [groupId, groupRows] of groups) {
        const drPaise = sumPaise(groupRows.filter((r) => r.data.drCr === "Dr").map((r) => toPaise(r.data.amount)));
        const crPaise = sumPaise(groupRows.filter((r) => r.data.drCr === "Cr").map((r) => toPaise(r.data.amount)));
        if (drPaise !== crPaise) {
          issues.push({
            rowNumbers: groupRows.map((r) => r.rowNumber),
            severity: "error",
            message: `Voucher ${groupId}: Dr total ${(drPaise / 100).toFixed(2)} ≠ Cr total ${(crPaise / 100).toFixed(2)}`,
          });
        }
        if (groupRows.length < 2) {
          issues.push({
            rowNumbers: groupRows.map((r) => r.rowNumber),
            severity: "error",
            message: `Voucher ${groupId}: needs at least two lines`,
          });
        }
      }
      return issues;
    },
    onCommit: (rows, _ctx, onProgress) => bulkImportVouchers(supabase, companyId, rows, onProgress),
    sampleRowsOverride: [
      { "Voucher Ref": "PMT-0001", Date: "01/04/2026", "Voucher Type": "Payment", Ledger: "Office Rent", "Dr/Cr": "Dr", Amount: "5000.00", Narration: "Rent for April" },
      { "Voucher Ref": "PMT-0001", Date: "01/04/2026", "Voucher Type": "Payment", Ledger: "Cash-in-Hand", "Dr/Cr": "Cr", Amount: "5000.00", Narration: "Rent for April" },
    ],
  };
}
