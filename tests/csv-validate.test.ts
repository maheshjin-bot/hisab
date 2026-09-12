import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import { buildImportPreview } from "@/lib/csv/validate";
import type { CsvImportConfig, RawCsvRow } from "@/lib/csv/types";
import { buildVoucherCsvImportConfig, buildVoucherImportContext } from "@/lib/voucher/voucher-csv-config";
import { bulkImportVouchers } from "@/lib/supabase/queries/vouchers";

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

/* ------------------------------------------------------------------ *
 * The real voucher importer.
 *
 * buildVoucherCsvImportConfig only touches Supabase inside prepareContext
 * and onCommit, neither of which the preview pipeline calls — so the whole
 * three-stage validation is exercised here with a stub client and a
 * hand-built context.
 * ------------------------------------------------------------------ */

const noSupabase = null as unknown as SupabaseClient<Database>;

const LEDGERS = [
  { id: "led-rent", name: "Office Rent" },
  { id: "led-cash", name: "Cash-in-Hand" },
  { id: "led-bank", name: "HDFC Bank" },
];

function voucherCtx(ledgers: { id: string; name: string }[] = LEDGERS) {
  return buildVoucherImportContext(ledgers);
}

function voucherConfig() {
  return buildVoucherCsvImportConfig(noSupabase, "company-1");
}

/** One voucher line, in the exact header spelling the template ships with. */
function vRow(over: Partial<Record<string, string>> = {}): RawCsvRow {
  return {
    "Voucher Ref": "PMT-0001",
    Date: "01/04/2026",
    "Voucher Type": "Payment",
    Ledger: "Office Rent",
    "Dr/Cr": "Dr",
    Amount: "5000.00",
    Narration: "Rent for April",
    ...over,
  } as RawCsvRow;
}

const allMessages = (preview: { fileIssues: { message: string }[]; results: { errors: { message: string }[] }[] }) =>
  [...preview.fileIssues.map((i) => i.message), ...preview.results.flatMap((r) => r.errors.map((e) => e.message))].join(" | ");

describe("F-03 voucher group rows must agree on the header fields", () => {
  it("rejects a group whose lines carry different dates", () => {
    const preview = buildImportPreview(
      [
        vRow({ Date: "01/04/2026" }),
        vRow({ Date: "02/04/2026", Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" }),
      ],
      voucherConfig(),
      voucherCtx()
    );
    expect(allMessages(preview)).toContain("PMT-0001");
    expect(allMessages(preview)).toMatch(/same date|one date|dates? differ|disagree/i);
    expect(preview.validRowCount).toBe(0);
  });

  it("rejects a group whose lines carry different voucher types", () => {
    const preview = buildImportPreview(
      [
        vRow({ "Voucher Type": "Payment" }),
        vRow({ "Voucher Type": "Journal", Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" }),
      ],
      voucherConfig(),
      voucherCtx()
    );
    expect(allMessages(preview)).toMatch(/voucher type/i);
    expect(preview.validRowCount).toBe(0);
  });

  it("leaves an agreeing group alone", () => {
    const preview = buildImportPreview(
      [vRow(), vRow({ Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" })],
      voucherConfig(),
      voucherCtx()
    );
    expect(preview.fileIssues).toEqual([]);
    expect(preview.validRowCount).toBe(2);
  });
});

describe("F-06 a group containing a rejected line fails as a whole", () => {
  it("never commits a voucher with lines silently missing", () => {
    // Rows 4 and 5 are rejected for an unknown ledger. Rows 2 and 3 happen to
    // balance on their own, so without a group-integrity gate this voucher
    // would commit two lines short.
    const preview = buildImportPreview(
      [
        vRow({ Ledger: "Office Rent", "Dr/Cr": "Dr", Amount: "5000.00" }),
        vRow({ Ledger: "Cash-in-Hand", "Dr/Cr": "Cr", Amount: "5000.00" }),
        vRow({ Ledger: "Telephone Expenses", "Dr/Cr": "Dr", Amount: "300.00" }),
        vRow({ Ledger: "Petty Cash", "Dr/Cr": "Cr", Amount: "300.00" }),
      ],
      voucherConfig(),
      voucherCtx()
    );
    expect(preview.validRowCount).toBe(0);
    const messages = allMessages(preview);
    expect(messages).toContain("PMT-0001");
    expect(messages).toContain("skipped");
    expect(messages).toContain("line 4");
    expect(messages).toContain("Unknown ledger name");
  });

  it("blames the rejected line, not the imbalance it caused", () => {
    // Dropping row 3 leaves Dr 5000 against Cr 5300 — an imbalance the user
    // never wrote, and the one the old code reported.
    const preview = buildImportPreview(
      [
        vRow({ Ledger: "Office Rent", "Dr/Cr": "Dr", Amount: "5000.00" }),
        vRow({ Ledger: "Telephone Expenses", "Dr/Cr": "Dr", Amount: "300.00" }),
        vRow({ Ledger: "Cash-in-Hand", "Dr/Cr": "Cr", Amount: "5300.00" }),
      ],
      voucherConfig(),
      voucherCtx()
    );
    const messages = allMessages(preview);
    expect(messages).toContain("skipped");
    expect(messages).toContain("line 3");
    expect(messages).not.toContain("Dr total");
  });
});

describe("F-04 the day/month order is a choice, not an assumption", () => {
  const dateOf = (preview: { results: { data: unknown }[] }, i = 0) =>
    (preview.results[i].data as { date: string } | null)?.date;

  const pair = (date: string) => [vRow({ Date: date }), vRow({ Date: date, Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" })];

  it("still reads dd/mm/yyyy by default", () => {
    const preview = buildImportPreview(pair("04/01/2026"), voucherConfig(), voucherCtx());
    expect(dateOf(preview)).toBe("2026-01-04");
  });

  it("reads mm/dd/yyyy when the file is a US-locale export", () => {
    const config = buildVoucherCsvImportConfig(noSupabase, "company-1", { dateFormat: "mm/dd/yyyy" });
    const preview = buildImportPreview(pair("04/01/2026"), config, voucherCtx());
    expect(dateOf(preview)).toBe("2026-04-01");
  });

  it("rebuilds the config through the control the preview UI drives", () => {
    const control = voucherConfig().dateFormat;
    expect(control?.value).toBe("dd/mm/yyyy");
    const flipped = control!.withFormat("mm/dd/yyyy");
    expect(flipped.dateFormat?.value).toBe("mm/dd/yyyy");
    expect(dateOf(buildImportPreview(pair("04/01/2026"), flipped, voucherCtx()))).toBe("2026-04-01");
  });

  it("locks dd/mm/yyyy when a value in the file can only be a day", () => {
    // 13 cannot be a month, so this file has already answered the question —
    // even though the user left the selector on mm/dd/yyyy.
    const config = buildVoucherCsvImportConfig(noSupabase, "company-1", { dateFormat: "mm/dd/yyyy" });
    const hint = config.dateFormat!.inspect([...pair("13/04/2026"), ...pair("04/01/2026")]);
    expect(hint.format).toBe("dd/mm/yyyy");
    expect(hint.locked).toBe(true);
  });

  it("locks mm/dd/yyyy when a value's second component can only be a day", () => {
    const hint = voucherConfig().dateFormat!.inspect(pair("04/13/2026"));
    expect(hint.format).toBe("mm/dd/yyyy");
    expect(hint.locked).toBe(true);
  });

  it("leaves an entirely ambiguous file on the chosen format, unlocked", () => {
    const hint = voucherConfig().dateFormat!.inspect(pair("04/01/2026"));
    expect(hint.format).toBe("dd/mm/yyyy");
    expect(hint.locked).toBe(false);
  });

  it("works the example out of a real value in the user's file", () => {
    const hint = voucherConfig().dateFormat!.inspect(pair("04/01/2026"));
    expect(hint.example).toBe("04/01/2026 will import as 4 January 2026");
    const usHint = voucherConfig().dateFormat!.withFormat("mm/dd/yyyy").dateFormat!.inspect(pair("04/01/2026"));
    expect(usHint.example).toBe("04/01/2026 will import as 1 April 2026");
  });
});

describe("F-15 a date that isn't on the calendar is caught on its own row", () => {
  const first = (date: string) =>
    buildImportPreview(
      [vRow({ Date: date }), vRow({ Date: date, Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" })],
      voucherConfig(),
      voucherCtx()
    ).results[0];

  it("rejects 31 February instead of passing 2026-02-31 to Postgres", () => {
    const row = first("31/02/2026");
    expect(row.data).toBeNull();
    // The format was fine — saying "use dd/mm/yyyy" would send the user
    // looking in the wrong place.
    expect(JSON.stringify(row.errors)).toContain("31/02/2026");
    expect(JSON.stringify(row.errors)).not.toContain("use dd/mm/yyyy");
  });

  it("does still say which format it wanted when the value isn't a date at all", () => {
    expect(JSON.stringify(first("last Tuesday").errors)).toContain("dd/mm/yyyy");
  });

  it("rejects 29 February in a non-leap year", () => {
    expect(first("29/02/2027").data).toBeNull();
  });

  it("accepts 29 February in a leap year", () => {
    expect((first("29/02/2028").data as { date: string }).date).toBe("2028-02-29");
  });

  it("rejects an impossible date written the ISO way too", () => {
    expect(first("2026-02-31").data).toBeNull();
  });

  it("rejects a 13th month", () => {
    expect(first("01/13/2026").data).toBeNull();
  });
});

/** Records what bulkImportVouchers actually sends to create_vouchers_bulk. */
function stubSupabase(results: { group_key: string; voucher_id: string | null; error_message: string | null }[]) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: results, error: null };
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

type BulkGroup = {
  group_key: string;
  voucher_date: string;
  voucher_type: string;
  reference_number: string | null;
  reference_date: string | null;
  lines: unknown[];
};

/** Everything the preview would hand to onCommit. */
function committableRows(rows: RawCsvRow[], config = voucherConfig(), ctx = voucherCtx()) {
  const preview = buildImportPreview(rows, config, ctx);
  return preview.results.filter((r) => r.errors.length === 0 && r.data !== null).map((r) => r.data!);
}

describe("F-08 the supplier's bill number survives the import", () => {
  const withRef = (over: Partial<Record<string, string>> = {}) =>
    vRow({ "Reference No.": "SUP/2026/119", "Reference Date": "28/03/2026", ...over });

  it("carries reference number and date into the group payload", async () => {
    const rows = committableRows([
      withRef(),
      withRef({ Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" }),
    ]);
    expect(rows).toHaveLength(2);

    const { client, calls } = stubSupabase([{ group_key: "PMT-0001", voucher_id: "v1", error_message: null }]);
    await bulkImportVouchers(client, "company-1", rows);

    const group = (calls[0].args.p_groups as BulkGroup[])[0];
    expect(group.reference_number).toBe("SUP/2026/119");
    expect(group.reference_date).toBe("2026-03-28");
  });

  it("leaves both null when the columns are absent, as they are today", async () => {
    const rows = committableRows([vRow(), vRow({ Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" })]);
    const { client, calls } = stubSupabase([{ group_key: "PMT-0001", voucher_id: "v1", error_message: null }]);
    await bulkImportVouchers(client, "company-1", rows);

    const group = (calls[0].args.p_groups as BulkGroup[])[0];
    expect(group.reference_number).toBeNull();
    expect(group.reference_date).toBeNull();
  });

  it("applies the group-agreement rule to the reference number too", () => {
    const preview = buildImportPreview(
      [withRef(), withRef({ "Reference No.": "SUP/2026/120", Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" })],
      voucherConfig(),
      voucherCtx()
    );
    expect(allMessages(preview)).toMatch(/reference number/i);
    expect(preview.validRowCount).toBe(0);
  });

  it("reads the reference date with the same day/month order as the voucher date", () => {

    const config = buildVoucherCsvImportConfig(noSupabase, "company-1", { dateFormat: "mm/dd/yyyy" });
    const rows = committableRows(
      [withRef({ "Reference Date": "04/01/2026" }), withRef({ "Reference Date": "04/01/2026", Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" })],
      config
    );
    expect((rows[0] as { referenceDate?: string }).referenceDate).toBe("2026-04-01");
  });
});

describe("F-09 amounts as a spreadsheet writes them", () => {
  const amountRow = (amount: string) =>
    buildImportPreview(
      [vRow({ Amount: amount }), vRow({ Amount: amount, Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" })],
      voucherConfig(),
      voucherCtx()
    ).results[0];

  const valueOf = (amount: string) => (amountRow(amount).data as { amount: number } | null)?.amount;
  const errorOf = (amount: string) => JSON.stringify(amountRow(amount).errors);

  it("accepts Indian digit grouping — the format HISAB's own export writes", () => {
    expect(valueOf("1,00,000.00")).toBe(100000);
  });

  it("accepts Western grouping too", () => {
    expect(valueOf("1,000.50")).toBe(1000.5);
  });

  it("accepts a rupee sign", () => {
    expect(valueOf("₹5,000.00")).toBe(5000);
    expect(valueOf("Rs. 5,000")).toBe(5000);
  });

  it("still accepts a plain number", () => {
    expect(valueOf("5000.00")).toBe(5000);
  });

  it("reads accountants' brackets as a negative rather than as gibberish", () => {
    const errors = errorOf("(500)");
    expect(errors).toMatch(/Dr\/Cr/);
    expect(errors).not.toMatch(/isn't a number/);
  });

  it("explains a genuinely non-numeric amount instead of just refusing it", () => {
    const errors = errorOf("five thousand");
    expect(errors).toContain("five thousand");
    expect(errors).toMatch(/isn't a number/);
  });

  it("says an empty amount is missing, not malformed", () => {
    expect(errorOf("")).toMatch(/required/i);
  });

  it("keeps the balance check exact when grouped amounts are used", () => {
    const preview = buildImportPreview(
      [
        vRow({ Amount: "1,00,000.10" }),
        vRow({ Amount: "50,000.05", Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" }),
        vRow({ Amount: "50,000.05", Ledger: "HDFC Bank", "Dr/Cr": "Cr" }),
      ],
      voucherConfig(),
      voucherCtx()
    );
    expect(preview.fileIssues).toEqual([]);
    expect(preview.validRowCount).toBe(3);
  });
});

describe("F-10 ledger names as people actually write them", () => {
  const NAMED = [
    { id: "led-rent", name: "Office Rent" },
    { id: "led-cash", name: "Cash-in-Hand" },
    { id: "led-sal", name: "Salaries and Wages" },
  ];

  const ledgerRow = (name: string, ledgers = NAMED) =>
    buildImportPreview(
      [vRow({ Ledger: name }), vRow({ Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" })],
      voucherConfig(),
      voucherCtx(ledgers)
    ).results[0];

  const resolved = (name: string, ledgers = NAMED) => (ledgerRow(name, ledgers).data as { ledgerId: string } | null)?.ledgerId;
  const failure = (name: string, ledgers = NAMED) => JSON.stringify(ledgerRow(name, ledgers).errors);

  it("still matches an exact name", () => {
    expect(resolved("Office Rent")).toBe("led-rent");
  });

  it("ignores a trailing full stop", () => {
    expect(resolved("Office Rent.")).toBe("led-rent");
  });

  it("ignores doubled spaces", () => {
    expect(resolved("Office  Rent")).toBe("led-rent");
  });

  it("treats & and 'and' as the same word", () => {
    expect(resolved("Salaries & Wages")).toBe("led-sal");
  });

  it("ignores a hyphen where the ledger has one", () => {
    expect(resolved("Cash in Hand")).toBe("led-cash");
  });

  it("refuses to guess when two ledgers normalise to the same name", () => {
    const ambiguous = [
      { id: "led-a", name: "A. Kumar" },
      { id: "led-b", name: "A Kumar" },
      { id: "led-cash", name: "Cash-in-Hand" },
    ];
    expect(resolved("A.  Kumar!", ambiguous)).toBeUndefined();
    expect(failure("A.  Kumar!", ambiguous)).toMatch(/more than one/i);
    // An exact name still resolves, because exact is tried first.
    expect(resolved("A Kumar", ambiguous)).toBe("led-b");
  });

  it("suggests the near match instead of just refusing", () => {
    const errors = failure("Ofice Rent");
    expect(errors).toContain("Unknown ledger name");
    expect(errors).toMatch(/did you mean/i);
    expect(errors).toContain("Office Rent");
  });

  it("does not invent a suggestion for a name nothing resembles", () => {
    const errors = failure("Zephyr Holdings LLP");
    expect(errors).toContain("Unknown ledger name");
    expect(errors).not.toMatch(/did you mean/i);
  });

  it("fails the whole file when the ledger index was truncated, rather than mismatching", () => {
    const preview = buildImportPreview(
      [vRow(), vRow({ Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" })],
      voucherConfig(),
      buildVoucherImportContext(NAMED, { truncated: true })
    );
    expect(preview.validRowCount).toBe(0);
    expect(allMessages(preview)).toMatch(/too many ledgers|could not be loaded|not all of this company's ledgers/i);
  });
});

describe("F-20 a commit error points at a row that exists", () => {
  const twoVouchers = () =>
    committableRows([
      vRow({ "Voucher Ref": "PMT-0001" }),
      vRow({ "Voucher Ref": "PMT-0001", Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" }),
      vRow({ "Voucher Ref": "PMT-0002" }),
      vRow({ "Voucher Ref": "PMT-0002", Ledger: "Cash-in-Hand", "Dr/Cr": "Cr" }),
    ]);

  it("reports a rejected voucher against its first row, not row 0", async () => {
    const rows = twoVouchers();
    expect(rows).toHaveLength(4);

    const { client } = stubSupabase([
      { group_key: "PMT-0001", voucher_id: "v1", error_message: null },
      { group_key: "PMT-0002", voucher_id: null, error_message: "voucher date falls in a locked period" },
    ]);
    const result = await bulkImportVouchers(client, "company-1", rows);

    expect(result.errors).toHaveLength(1);
    // PMT-0002's lines are rows 4 and 5 of the file; row 0 does not exist.
    expect(result.errors[0].rowNumber).toBe(4);
    expect(result.errors[0].message).toContain("locked period");
    expect(result.insertedCount).toBe(2);
  });
});
