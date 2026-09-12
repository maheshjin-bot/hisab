import { describe, expect, it } from "vitest";
import { backupFileName, summariseBackup, BACKUP_FORMAT } from "@/lib/supabase/queries/backup";

const validBackup = {
  format: BACKUP_FORMAT,
  version: 1,
  exported_at: "2026-08-17T06:00:00Z",
  company: { name: "Sharma Enterprises" },
  account_groups: [{}, {}, {}],
  ledgers: [{}, {}],
  vouchers: [{}],
  voucher_entries: [{}, {}],
};

describe("reading a backup file", () => {
  it("summarises a valid one", () => {
    const s = summariseBackup(validBackup);
    expect(s.companyName).toBe("Sharma Enterprises");
    expect(s.accountGroups).toBe(3);
    expect(s.ledgers).toBe(2);
    expect(s.vouchers).toBe(1);
    expect(s.voucherEntries).toBe(2);
  });

  it("counts invoice lines, and reads a file written before they existed as none", () => {
    // Backups written before migration 0021 simply have no invoice_lines key.
    // Reporting that as zero is right; failing to count them when they *are*
    // there would make a complete backup look like it had lost data.
    expect(summariseBackup(validBackup).invoiceLines).toBe(0);
    expect(summariseBackup({ ...validBackup, invoice_lines: [{}, {}, {}] }).invoiceLines).toBe(3);
  });

  it("refuses a file that isn't a HISAB backup", () => {
    // The realistic mistakes: some other app's export, or a stray JSON file.
    expect(() => summariseBackup({ format: "quickbooks.export" })).toThrow(/isn't a HISAB backup/);
    expect(() => summariseBackup({ hello: "world" })).toThrow(/isn't a HISAB backup/);
    expect(() => summariseBackup([])).toThrow(/isn't a HISAB backup/);
    expect(() => summariseBackup(null)).toThrow(/isn't a HISAB backup/);
    expect(() => summariseBackup("a string")).toThrow(/isn't a HISAB backup/);
  });

  it("refuses a backup from a newer version, and says so", () => {
    expect(() => summariseBackup({ ...validBackup, version: 99 })).toThrow(/newer version/);
  });

  it("accepts the current version and older ones", () => {
    expect(summariseBackup({ ...validBackup, version: 1 }).version).toBe(1);
    expect(summariseBackup({ ...validBackup, version: 0 }).version).toBe(0);
  });

  it("survives a backup whose collections are missing or malformed", () => {
    // A truncated or hand-edited file shouldn't crash the dialog before the
    // user has been told what's wrong with it.
    const s = summariseBackup({ format: BACKUP_FORMAT, version: 1, company: {} });
    expect(s.accountGroups).toBe(0);
    expect(s.vouchers).toBe(0);
    expect(s.companyName).toBe("Unnamed company");
    expect(s.exportedAt).toBeNull();

    const t = summariseBackup({ format: BACKUP_FORMAT, version: 1, ledgers: "not-an-array" });
    expect(t.ledgers).toBe(0);
  });
});

describe("backup file names", () => {
  const when = new Date(2026, 7, 17); // 17 Aug 2026, local

  it("is dated and sortable", () => {
    expect(backupFileName("Sharma Enterprises", when)).toBe("hisab-sharma-enterprises-2026-08-17.json");
  });

  it("flattens punctuation and case rather than emitting an awkward filename", () => {
    expect(backupFileName("Test Books — July FY", when)).toBe("hisab-test-books-july-fy-2026-08-17.json");
    expect(backupFileName("A/B \\ C:D", when)).toBe("hisab-a-b-c-d-2026-08-17.json");
  });

  it("still produces something usable for a name with nothing to slugify", () => {
    expect(backupFileName("—", when)).toBe("hisab-company-2026-08-17.json");
    expect(backupFileName("", when)).toBe("hisab-company-2026-08-17.json");
  });

  it("zero-pads the date so files sort chronologically", () => {
    expect(backupFileName("X", new Date(2026, 0, 5))).toBe("hisab-x-2026-01-05.json");
  });
});
