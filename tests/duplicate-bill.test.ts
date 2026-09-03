import { describe, expect, it, vi } from "vitest";
import {
  duplicateBillProbeKey,
  findDuplicateBill,
  normalizeBillReference,
  type DuplicateBillProbe,
} from "@/lib/supabase/queries/vouchers";

const probe = (over: Partial<DuplicateBillProbe> = {}): DuplicateBillProbe => ({
  companyId: "company-1",
  partyLedgerId: "supplier-1",
  referenceNumber: "INV-001",
  voucherDate: "2026-04-05",
  ...over,
});

/**
 * A stand-in for the Supabase client that records what it was asked for.
 *
 * The lookup is one `.rpc()` call and nothing else, so this is the whole
 * surface — and asserting on `calls` is how the "don't ask at all" cases below
 * are proved rather than assumed. A test that only checked the return value
 * would pass just as happily on an implementation that made the round trip and
 * threw the answer away, which is the behaviour that would fire a request on
 * every blur of every voucher in the app.
 */
function fakeSupabase(result: { data?: unknown; error?: unknown } = { data: [] }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: result.data ?? null, error: result.error ?? null };
    }),
  };
  // The real signature is SupabaseClient<Database>; this only ever uses .rpc.
  return { client: client as never, calls };
}

const row = (over: Record<string, unknown> = {}) => ({
  voucher_id: "voucher-9",
  voucher_number: "PUR/2026-27/00003",
  voucher_date: "2026-04-05",
  total_amount: 1180,
  reference_number: "INV-001",
  ...over,
});

describe("normalising a supplier's bill number", () => {
  it("ignores case and surrounding whitespace, exactly as the index expression does", () => {
    expect(normalizeBillReference("INV-001")).toBe("INV-001");
    expect(normalizeBillReference("inv-001")).toBe("INV-001");
    expect(normalizeBillReference("  INV-001  ")).toBe("INV-001");
    expect(normalizeBillReference("\t inv-001 \n")).toBe("INV-001");
  });

  it("keeps whitespace inside the number, because two labels that differ there may be two bills", () => {
    expect(normalizeBillReference("INV 001")).toBe("INV 001");
    expect(normalizeBillReference("INV  001")).toBe("INV  001");
    expect(normalizeBillReference("INV 001")).not.toBe(normalizeBillReference("INV  001"));
  });

  it("treats nothing, and nothing but whitespace, as no bill number", () => {
    expect(normalizeBillReference(null)).toBe("");
    expect(normalizeBillReference(undefined)).toBe("");
    expect(normalizeBillReference("")).toBe("");
    expect(normalizeBillReference("   ")).toBe("");
  });
});

describe("deciding whether there is anything to look up", () => {
  it("has a key when the supplier, the bill number and the date are all known", () => {
    expect(duplicateBillProbeKey(probe())).not.toBeNull();
  });

  it("has none until a supplier is chosen", () => {
    expect(duplicateBillProbeKey(probe({ partyLedgerId: "" }))).toBeNull();
    expect(duplicateBillProbeKey(probe({ partyLedgerId: null }))).toBeNull();
  });

  it("has none for a blank bill number — most purchases have none and they are not duplicates of each other", () => {
    expect(duplicateBillProbeKey(probe({ referenceNumber: "" }))).toBeNull();
    expect(duplicateBillProbeKey(probe({ referenceNumber: "   " }))).toBeNull();
    expect(duplicateBillProbeKey(probe({ referenceNumber: null }))).toBeNull();
  });

  it("has none without a date, since the financial year is derived from it", () => {
    expect(duplicateBillProbeKey(probe({ voucherDate: "" }))).toBeNull();
  });

  it("is the same key however the bill number was typed", () => {
    expect(duplicateBillProbeKey(probe({ referenceNumber: " inv-001 " }))).toBe(
      duplicateBillProbeKey(probe({ referenceNumber: "INV-001" }))
    );
  });

  it("changes when anything the answer depends on changes", () => {
    const base = duplicateBillProbeKey(probe());
    expect(duplicateBillProbeKey(probe({ companyId: "company-2" }))).not.toBe(base);
    expect(duplicateBillProbeKey(probe({ partyLedgerId: "supplier-2" }))).not.toBe(base);
    expect(duplicateBillProbeKey(probe({ referenceNumber: "INV-002" }))).not.toBe(base);
    expect(duplicateBillProbeKey(probe({ voucherDate: "2025-04-05" }))).not.toBe(base);
    expect(duplicateBillProbeKey(probe({ excludeVoucherId: "voucher-1" }))).not.toBe(base);
  });
});

describe("looking a duplicate bill up", () => {
  it("asks the database with the values the form holds, untouched", async () => {
    const { client, calls } = fakeSupabase({ data: [] });
    await findDuplicateBill(client, probe({ referenceNumber: "  inv-001 ", excludeVoucherId: "voucher-1" }));

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("find_duplicate_bill");
    expect(calls[0].args).toEqual({
      p_company_id: "company-1",
      p_party_ledger_id: "supplier-1",
      // Sent as typed. upper(btrim(...)) lives in the migration, on both the
      // index and the lookup, and a second normalisation here would be a
      // second definition of what "the same bill" means.
      p_reference_number: "  inv-001 ",
      p_voucher_date: "2026-04-05",
      p_exclude_voucher_id: "voucher-1",
    });
  });

  it("sends no voucher to exclude when the purchase is a new one", async () => {
    const { client, calls } = fakeSupabase({ data: [] });
    await findDuplicateBill(client, probe());
    expect(calls[0].args.p_exclude_voucher_id).toBeNull();
  });

  it("does not go to the database at all when there is nothing to ask about", async () => {
    for (const bad of [
      probe({ referenceNumber: "   " }),
      probe({ referenceNumber: null }),
      probe({ partyLedgerId: "" }),
      probe({ voucherDate: "" }),
    ]) {
      const { client, calls } = fakeSupabase({ data: [row()] });
      expect(await findDuplicateBill(client, bad)).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it("returns the existing voucher with everything the warning has to name", async () => {
    const { client } = fakeSupabase({ data: [row()] });
    expect(await findDuplicateBill(client, probe())).toEqual({
      voucherId: "voucher-9",
      voucherNumber: "PUR/2026-27/00003",
      voucherDate: "2026-04-05",
      totalAmount: 1180,
      referenceNumber: "INV-001",
    });
  });

  it("names the earliest entry when the bill is already on the books more than once", async () => {
    // The function orders by date, so the first row is the one the books have
    // had longest — the entry the user is most likely to recognise.
    const { client } = fakeSupabase({ data: [row(), row({ voucher_id: "voucher-10", voucher_date: "2026-04-12" })] });
    const found = await findDuplicateBill(client, probe());
    expect(found?.voucherId).toBe("voucher-9");
  });

  it("finds nothing when the bill is new", async () => {
    const { client } = fakeSupabase({ data: [] });
    expect(await findDuplicateBill(client, probe())).toBeNull();

    const empty = fakeSupabase({ data: null });
    expect(await findDuplicateBill(empty.client, probe())).toBeNull();
  });

  it("throws what the database said rather than reporting no duplicate", async () => {
    // Reporting null on an error would turn a broken lookup into a silent
    // all-clear, which is the failure this whole feature exists to prevent.
    const { client } = fakeSupabase({ error: { message: "permission denied" } });
    await expect(findDuplicateBill(client, probe())).rejects.toMatchObject({ message: "permission denied" });
  });
});
