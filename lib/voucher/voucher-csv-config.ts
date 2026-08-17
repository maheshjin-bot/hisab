import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import type { CsvDateFormat, CsvImportConfig, FileLevelIssue } from "@/lib/csv/types";
import { parseCsvAmount } from "@/lib/csv/amount";
import { inspectDateColumn, readCsvDate, type CsvDateResult } from "@/lib/csv/date-format";
import { groupRowsBy } from "@/lib/csv/group-utils";
import { rowNumberForIndex } from "@/lib/csv/validate";
import { sumPaise, toPaise } from "@/lib/utils/currency";
import { bulkImportVouchers, type VoucherType } from "@/lib/supabase/queries/vouchers";
import { searchLedgersForCombobox } from "@/lib/supabase/queries/ledgers";

const VOUCHER_TYPES = ["receipt", "payment", "contra", "journal", "sales", "purchase"] as const satisfies readonly VoucherType[];

export interface VoucherCsvRow {
  /** Carried from stage 1 so a commit failure can be reported against a real row. */
  rowNumber: number;
  groupId: string;
  date: string;
  voucherType: string;
  ledgerName: string;
  ledgerId: string;
  /** Empty when the ledger resolved. Carried on the row because the message names a near match. */
  ledgerIssue: string;
  drCr: string;
  /** Raw, so the error can quote back what the user actually typed. */
  amount: string;
  narration: string;
  referenceNumber: string;
  referenceDate: string;
}

export interface VoucherCsvParsed {
  rowNumber: number;
  groupId: string;
  date: string;
  voucherType: VoucherType;
  ledgerId: string;
  drCr: "Dr" | "Cr";
  amount: number;
  narration?: string;
  referenceNumber?: string;
  referenceDate?: string;
}

export interface VoucherImportContext {
  /** Trimmed and lower-cased only. Tried first, so an exact name always wins. */
  ledgerIdByExactName: Map<string, string>;
  /**
   * Punctuation- and spacing-insensitive. The value is null where two
   * different ledgers collapse onto the same key — the one case where being
   * lenient would pick a ledger for the user, which is worse than refusing.
   */
  ledgerIdByLooseName: Map<string, string | null>;
  /** Names as stored, for the "did you mean" suggestion. */
  ledgerNames: string[];
  /** The index hit its fetch cap, so a name that isn't in it proves nothing. */
  ledgerIndexTruncated: boolean;
}

function exactKey(s: string) {
  return s.trim().toLowerCase();
}

/**
 * A trailing full stop, a doubled space, `&` where the books say "and", a
 * hyphen where the books have a space — none of these mean a different
 * ledger, but exact matching rejects all of them with the same "unknown
 * ledger" a genuinely missing account gets, which is the part that makes it
 * hard to act on.
 */
function looseKey(s: string) {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Edit distance, capped: only used to decide whether a name is close enough to suggest. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** The closest stored name, if one is close enough that suggesting it is help rather than noise. */
function nearestLedgerName(target: string, names: string[]): string | null {
  const wanted = looseKey(target);
  if (!wanted) return null;
  const budget = Math.min(3, Math.max(1, Math.floor(wanted.length / 4)));

  let best: { name: string; distance: number } | null = null;
  for (const name of names) {
    const distance = editDistance(wanted, looseKey(name));
    if (distance <= budget && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name ?? null;
}

export interface LedgerResolution {
  id: string;
  /** Empty when the name resolved; otherwise the message the row should carry. */
  issue: string;
}

export function resolveLedgerName(ctx: VoucherImportContext, rawName: string): LedgerResolution {
  const name = rawName.trim();
  if (!name) return { id: "", issue: "Ledger is required" };

  const exact = ctx.ledgerIdByExactName.get(exactKey(name));
  if (exact) return { id: exact, issue: "" };

  const loose = ctx.ledgerIdByLooseName.get(looseKey(name));
  if (loose) return { id: loose, issue: "" };
  if (loose === null) {
    return {
      id: "",
      issue: `Ledger name "${name}" matches more than one ledger — use the name exactly as it appears in your books`,
    };
  }

  const suggestion = nearestLedgerName(name, ctx.ledgerNames);
  return {
    id: "",
    issue: suggestion
      ? `Unknown ledger name "${name}" — did you mean "${suggestion}"?`
      : `Unknown ledger name "${name}" — check the spelling, or create the ledger first`,
  };
}

/**
 * Builds the name -> id index the row transform resolves ledgers against.
 * Split out of `prepareContext` so it can be exercised without a Supabase
 * client — the resolution rules are the part worth testing.
 */
export function buildVoucherImportContext(
  ledgers: { id: string; name: string }[],
  options: { truncated?: boolean } = {}
): VoucherImportContext {
  const ledgerIdByLooseName = new Map<string, string | null>();
  for (const ledger of ledgers) {
    const key = looseKey(ledger.name);
    if (!key) continue;
    const existing = ledgerIdByLooseName.get(key);
    // Seen before under a different id: the key no longer identifies one
    // ledger, so it must stop resolving to either of them.
    ledgerIdByLooseName.set(key, existing === undefined || existing === ledger.id ? ledger.id : null);
  }

  return {
    ledgerIdByExactName: new Map(ledgers.map((l) => [exactKey(l.name), l.id])),
    ledgerIdByLooseName,
    ledgerNames: ledgers.map((l) => l.name),
    ledgerIndexTruncated: options.truncated ?? false,
  };
}

export interface VoucherCsvImportOptions {
  /**
   * How to read `04/01/2026`. Defaults to the Indian order; the preview
   * offers the other, and overrides both when the file itself settles it.
   */
  dateFormat?: CsvDateFormat;
}

const DATE_COLUMN = "Date";
const LEDGER_INDEX_LIMIT = 5000;

function dateErrorMessage(
  raw: string,
  reason: Extract<CsvDateResult, { iso: null }>["reason"],
  format: CsvDateFormat
): string {
  return reason === "impossible"
    ? `"${raw.trim()}" isn't a date on the calendar — check the day and month`
    : `Invalid date — use ${format}`;
}

/**
 * The fields that belong to the voucher header rather than to a line. Only
 * the first row of a group supplies them to the database, so all of a group's
 * rows have to agree on every one of them.
 */
const HEADER_FIELDS: { label: string; of: (row: VoucherCsvParsed) => string }[] = [
  { label: "date", of: (r) => r.date },
  { label: "voucher type", of: (r) => r.voucherType },
  { label: "reference number", of: (r) => r.referenceNumber ?? "" },
  { label: "reference date", of: (r) => r.referenceDate ?? "" },
];

export function buildVoucherCsvImportConfig(
  supabase: SupabaseClient<Database>,
  companyId: string,
  options: VoucherCsvImportOptions = {}
): CsvImportConfig<VoucherCsvRow, VoucherCsvParsed, VoucherImportContext> {
  const dateFormat = options.dateFormat ?? "dd/mm/yyyy";
  return {
    entityName: "Voucher line",
    importType: "vouchers",
    columns: [
      { key: "groupId", header: "Voucher Ref", required: true, sampleValue: "PMT-0001" },
      { key: "date", header: "Date", required: true, sampleValue: "01/04/2026" },
      { key: "voucherType", header: "Voucher Type", required: true, sampleValue: "Payment" },
      { key: "ledgerName", header: "Ledger", required: true, sampleValue: (i) => (i === 0 ? "Office Rent" : "Cash-in-Hand") },
      { key: "drCr", header: "Dr/Cr", required: true, sampleValue: (i) => (i === 0 ? "Dr" : "Cr") },
      { key: "amount", header: "Amount", required: true, sampleValue: "5000.00" },
      { key: "narration", header: "Narration", sampleValue: "Rent for April" },
      // Per-voucher, not per-line: a purchase book without the supplier's
      // bill number is most of what makes it a purchase book.
      { key: "referenceNumber", header: "Reference No.", sampleValue: "INV/2026/0412" },
      { key: "referenceDate", header: "Reference Date", sampleValue: "28/03/2026" },
    ],
    prepareContext: async () => {
      // A generous limit covers realistic SME ledger counts for the name index;
      // the combobox itself uses a separate, query-as-you-type search. One
      // extra row is fetched purely to notice the cap being hit: above it, a
      // name that isn't in the index might still exist in the books, and
      // silently reporting it as unknown is the worst of the options.
      const ledgers = await searchLedgersForCombobox(supabase, companyId, "", LEDGER_INDEX_LIMIT + 1);
      return buildVoucherImportContext(ledgers.slice(0, LEDGER_INDEX_LIMIT), {
        truncated: ledgers.length > LEDGER_INDEX_LIMIT,
      });
    },
    transformRow: (raw, index, ctx) => {
      const ledger = resolveLedgerName(ctx, raw["Ledger"] ?? "");
      return {
        rowNumber: rowNumberForIndex(index),
        groupId: raw["Voucher Ref"] ?? "",
        date: raw["Date"] ?? "",
        voucherType: (raw["Voucher Type"] ?? "").trim().toLowerCase(),
        ledgerName: raw["Ledger"] ?? "",
        ledgerId: ledger.id,
        ledgerIssue: ledger.issue,
        drCr: (raw["Dr/Cr"] ?? "").trim(),
        amount: raw["Amount"] ?? "",
        narration: raw["Narration"] ?? "",
        referenceNumber: raw["Reference No."] ?? "",
        referenceDate: raw["Reference Date"] ?? "",
      };
    },
    rowSchema: () =>
      z
        .object({
          rowNumber: z.number(),
          groupId: z.string().min(1, { error: "Voucher Ref is required" }),
          date: z
            .string()
            .transform((v, ctx) => {
              const parsed = readCsvDate(v, dateFormat);
              if (parsed.iso === null) {
                ctx.addIssue({ code: "custom", message: dateErrorMessage(v, parsed.reason, dateFormat) });
                return z.NEVER;
              }
              return parsed.iso;
            }),
          voucherType: z.enum(VOUCHER_TYPES, { error: "Unknown voucher type" }),
          ledgerName: z.string(),
          ledgerId: z.string(),
          // The message is worked out in transformRow, where the whole ledger
          // index is in hand to look for a near match, and simply surfaced
          // here — so it stays a field error alongside any others the row has.
          ledgerIssue: z.string().refine((v) => v === "", { error: (issue) => String(issue.input) }),
          drCr: z.enum(["Dr", "Cr"], { error: "Dr/Cr must be exactly 'Dr' or 'Cr'" }),
          amount: z.string().transform((v, ctx) => {
            const parsed = parseCsvAmount(v);
            if (parsed === null) {
              ctx.addIssue({
                code: "custom",
                message: v.trim()
                  ? `Amount "${v.trim()}" isn't a number — a ₹ sign and grouping commas are fine, words aren't`
                  : "Amount is required",
              });
              return z.NEVER;
            }
            if (parsed <= 0) {
              ctx.addIssue({
                code: "custom",
                message: "Amount must be greater than 0 — the Dr/Cr column carries the direction, so the amount never needs a minus sign or brackets",
              });
              return z.NEVER;
            }
            return parsed;
          }),
          narration: z.string().optional(),
          referenceNumber: z.string().transform((v) => v.trim() || undefined),
          // Blank is the normal case — it means "no supplier bill", not a
          // bad date.
          referenceDate: z.string().transform((v, ctx) => {
            if (!v.trim()) return undefined;
            const parsed = readCsvDate(v, dateFormat);
            if (parsed.iso === null) {
              ctx.addIssue({ code: "custom", message: `Reference Date: ${dateErrorMessage(v, parsed.reason, dateFormat)}` });
              return z.NEVER;
            }
            return parsed.iso;
          }),
        })
        .transform((row) => ({
          rowNumber: row.rowNumber,
          groupId: row.groupId,
          date: row.date,
          voucherType: row.voucherType,
          ledgerId: row.ledgerId,
          drCr: row.drCr,
          amount: row.amount,
          narration: row.narration,
          referenceNumber: row.referenceNumber,
          referenceDate: row.referenceDate,
        })),
    groupKey: (row) => row.groupId,
    dateFormat: {
      value: dateFormat,
      withFormat: (format) => buildVoucherCsvImportConfig(supabase, companyId, { ...options, dateFormat: format }),
      inspect: (rawRows) => inspectDateColumn(rawRows, DATE_COLUMN, dateFormat),
    },
    // Everything cross-row lives here, because none of it is decidable from a
    // single row. The order matters: a group whose lines don't even agree on
    // what voucher they describe must not be balance-checked, because the
    // totals of a group that isn't really one voucher mean nothing.
    validateFile: (validRows, ctx, rejectedRows): FileLevelIssue[] => {
      const issues: FileLevelIssue[] = [];

      // Above the fetch cap the name index is a partial view of the books, so
      // every match and every miss in this file is unreliable — including the
      // ones that look fine. Nothing here is safe to import.
      if (ctx.ledgerIndexTruncated) {
        return [
          {
            rowNumbers: [...validRows.map((r) => r.rowNumber), ...rejectedRows.map((r) => r.rowNumber)],
            severity: "error",
            message: `Not all of this company's ledgers could be loaded for matching (the importer reads at most ${LEDGER_INDEX_LIMIT.toLocaleString("en-IN")}), so ledger names in this file cannot be resolved reliably. Import in smaller batches by ledger, or archive ledgers you no longer post to.`,
          },
        ];
      }

      const groups = groupRowsBy(validRows, (r) => r.data.groupId);

      // A rejected row has no parsed data, but its Voucher Ref cell still
      // says which voucher it was meant to be part of. A row that didn't even
      // name a voucher can't be placed, and already carries that as its own
      // error.
      const groupRefOf = (raw: Record<string, string>) => (raw["Voucher Ref"] ?? "").trim();
      const rejectedByGroup = groupRowsBy(
        rejectedRows.filter((r) => groupRefOf(r.raw) !== ""),
        (r) => groupRefOf(r.raw)
      );

      for (const groupId of new Set([...groups.keys(), ...rejectedByGroup.keys()])) {
        const groupRows = groups.get(groupId) ?? [];
        const rowNumbers = groupRows.map((r) => r.rowNumber);
        const rejectedInGroup = rejectedByGroup.get(groupId) ?? [];

        // Group integrity comes before anything that reads the group's
        // totals. Stage 3 is handed only the rows that survived stages 1-2,
        // so a group missing a line can look perfectly balanced and commit
        // short, and a group that no longer balances gets reported as the
        // user's arithmetic error rather than as the dropped line it is.
        if (rejectedInGroup.length) {
          if (groupRows.length) {
            const first = rejectedInGroup[0];
            const alsoBad = rejectedInGroup.length - 1;
            issues.push({
              // Only the surviving lines are demoted here; the rejected line
              // already carries its own, more precise error.
              rowNumbers,
              severity: "error",
              message: `Voucher ${groupId} skipped — line ${first.rowNumber}: ${first.errors[0]?.message ?? "this line is not valid"}${alsoBad ? ` (and ${alsoBad} further line${alsoBad > 1 ? "s" : ""} in this voucher)` : ""}. A voucher imports whole or not at all, so its other lines were left out too.`,
            });
          }
          continue;
        }

        // Only the first row's date/type/reference reach the database — the
        // rest are dropped on the floor by the group payload. So a typo on
        // line 2 would import silently under line 1's header. Disagreement is
        // the user's error to resolve, not ours to pick a winner for.
        const disagreements = HEADER_FIELDS.filter(
          (f) => new Set(groupRows.map((r) => f.of(r.data))).size > 1
        );
        if (disagreements.length) {
          for (const field of disagreements) {
            const seen = [...new Set(groupRows.map((r) => field.of(r.data) || "(blank)"))];
            issues.push({
              rowNumbers,
              severity: "error",
              message: `Voucher ${groupId}: every line must carry the same ${field.label}, but this file has ${seen.join(" and ")}. Split them into separate voucher refs, or correct the typo.`,
            });
          }
          continue;
        }

        if (groupRows.length < 2) {
          issues.push({
            rowNumbers,
            severity: "error",
            message: `Voucher ${groupId}: needs at least two lines`,
          });
          continue;
        }

        // Integer paise, so 100.10 + 200.20 can't produce a phantom imbalance.
        const drPaise = sumPaise(groupRows.filter((r) => r.data.drCr === "Dr").map((r) => toPaise(r.data.amount)));
        const crPaise = sumPaise(groupRows.filter((r) => r.data.drCr === "Cr").map((r) => toPaise(r.data.amount)));
        if (drPaise !== crPaise) {
          issues.push({
            rowNumbers,
            severity: "error",
            message: `Voucher ${groupId}: Dr total ${(drPaise / 100).toFixed(2)} ≠ Cr total ${(crPaise / 100).toFixed(2)}`,
          });
        }
      }
      return issues;
    },
    onCommit: (rows, _ctx, onProgress) => bulkImportVouchers(supabase, companyId, rows, onProgress),

    // Both lines repeat the header fields, because that is what the importer
    // requires — a voucher is one row per line, and every one of them has to
    // agree about which voucher it belongs to.
    sampleRowsOverride: [
      { "Voucher Ref": "PMT-0001", Date: "01/04/2026", "Voucher Type": "Payment", Ledger: "Office Rent", "Dr/Cr": "Dr", Amount: "5000.00", Narration: "Rent for April", "Reference No.": "INV/2026/0412", "Reference Date": "28/03/2026" },
      { "Voucher Ref": "PMT-0001", Date: "01/04/2026", "Voucher Type": "Payment", Ledger: "Cash-in-Hand", "Dr/Cr": "Cr", Amount: "5000.00", Narration: "Rent for April", "Reference No.": "INV/2026/0412", "Reference Date": "28/03/2026" },
    ],
  };
}
