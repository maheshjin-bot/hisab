import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import type { CsvImportConfig, FileLevelIssue } from "@/lib/csv/types";
import { bulkInsertLedgers, getAllLedgerGroups } from "@/lib/supabase/queries/ledgers";
import { sumPaise, toPaise } from "@/lib/utils/currency";

export interface LedgerCsvRow {
  name: string;
  groupName: string;
  groupId: string;
  openingBalance: number;
  openingBalanceType: "debit" | "credit";
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

export interface LedgerCsvParsed {
  name: string;
  groupId: string;
  openingBalance: number;
  openingBalanceType: "debit" | "credit";
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

export interface LedgerImportContext {
  groupIdByNormalizedName: Map<string, string>;
  existingNames: Set<string>;
}

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function parseDrCr(raw: string): "debit" | "credit" {
  const v = raw.trim().toLowerCase();
  return v === "cr" || v === "credit" ? "credit" : "debit";
}

export function buildLedgerCsvImportConfig(
  supabase: SupabaseClient<Database>,
  companyId: string,
  existingLedgerNames: string[]
): CsvImportConfig<LedgerCsvRow, LedgerCsvParsed, LedgerImportContext> {
  return {
    entityName: "Ledger",
    columns: [
      { key: "name", header: "Ledger Name", required: true, sampleValue: "Axis Bank" },
      { key: "groupName", header: "Group", required: true, sampleValue: "Bank Accounts" },
      { key: "openingBalance", header: "Opening Balance", sampleValue: "25000.00" },
      { key: "openingBalanceType", header: "Dr/Cr", sampleValue: "Dr" },
      { key: "contactPerson", header: "Contact Person", sampleValue: "" },
      { key: "phone", header: "Phone", sampleValue: "" },
      { key: "email", header: "Email", sampleValue: "" },
      { key: "address", header: "Address", sampleValue: "" },
      { key: "notes", header: "Notes", sampleValue: "" },
    ],
    prepareContext: async () => {
      const groups = await getAllLedgerGroups(supabase, companyId);
      return {
        groupIdByNormalizedName: new Map(groups.map((g) => [normalize(g.name), g.id])),
        existingNames: new Set(existingLedgerNames.map(normalize)),
      };
    },
    transformRow: (raw, _i, ctx) => ({
      name: raw["Ledger Name"] ?? "",
      groupName: raw["Group"] ?? "",
      groupId: ctx.groupIdByNormalizedName.get(normalize(raw["Group"] ?? "")) ?? "",
      openingBalance: Number(raw["Opening Balance"] || "0"),
      openingBalanceType: parseDrCr(raw["Dr/Cr"] || "Dr"),
      contactPerson: raw["Contact Person"] ?? "",
      phone: raw["Phone"] ?? "",
      email: raw["Email"] ?? "",
      address: raw["Address"] ?? "",
      notes: raw["Notes"] ?? "",
    }),
    rowSchema: (ctx) =>
      z
        .object({
          name: z
            .string()
            .trim()
            .min(1, { error: "Ledger name is required" })
            .refine((n) => !ctx.existingNames.has(normalize(n)), { error: "A ledger with this name already exists" }),
          groupName: z.string(),
          groupId: z.string().min(1, { error: "Unknown group — check spelling" }),
          openingBalance: z.number({ error: "Opening balance must be a number" }).min(0),
          openingBalanceType: z.enum(["debit", "credit"]),
          contactPerson: z.string().optional(),
          phone: z.string().optional(),
          email: z
            .string()
            .optional()
            .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { error: "Invalid email" }),
          address: z.string().optional(),
          notes: z.string().optional(),
        })
        .transform((row) => ({
          name: row.name,
          groupId: row.groupId,
          openingBalance: row.openingBalance,
          openingBalanceType: row.openingBalanceType,
          contactPerson: row.contactPerson,
          phone: row.phone,
          email: row.email,
          address: row.address,
          notes: row.notes,
        })),
    // Opening balances aren't voucher_entries, so nothing at the database
    // level enforces that they collectively net to zero the way the
    // double-entry trigger does for vouchers — confirmed directly by an
    // end-to-end smoke test that fed in two ledgers with debit opening
    // balances and no offsetting entry, and watched Trial Balance/Balance
    // Sheet correctly report the resulting (correct, given the bad input)
    // imbalance. This is exactly the check the spec calls for on bulk
    // opening-balance import. Skipped entirely when every row's opening
    // balance is 0 (plain ledger-master import, nothing to balance yet).
    validateFile: (validRows): FileLevelIssue[] => {
      const debitPaise = sumPaise(
        validRows.filter((r) => r.data.openingBalanceType === "debit").map((r) => toPaise(r.data.openingBalance))
      );
      const creditPaise = sumPaise(
        validRows.filter((r) => r.data.openingBalanceType === "credit").map((r) => toPaise(r.data.openingBalance))
      );
      if (debitPaise === 0 && creditPaise === 0) return [];
      if (debitPaise === creditPaise) return [];
      return [
        {
          rowNumbers: validRows.filter((r) => r.data.openingBalance > 0).map((r) => r.rowNumber),
          severity: "error",
          message: `Opening balances don't tally: total Dr ${(debitPaise / 100).toFixed(2)} ≠ total Cr ${(creditPaise / 100).toFixed(2)}. Include a balancing entry (e.g. Capital Account) in this same file.`,
        },
      ];
    },
    onCommit: async (rows) => {
      const result = await bulkInsertLedgers(supabase, companyId, rows.map((r) => ({
        name: r.name,
        groupId: r.groupId,
        openingBalanceAmount: r.openingBalance,
        openingBalanceType: r.openingBalanceType,
        contactPerson: r.contactPerson || undefined,
        phone: r.phone || undefined,
        email: r.email || undefined,
        address: r.address || undefined,
        notes: r.notes || undefined,
      })));
      return result;
    },
    sampleRowCount: 2,
  };
}
