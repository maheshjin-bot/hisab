import { describe, expect, it } from "vitest";
import { canMergeLedgerRole, mergeBlockedReason } from "@/lib/ledgers/merge-eligibility";
import type { Ledger } from "@/lib/supabase/queries/ledgers";

describe("canMergeLedgerRole", () => {
  it("refuses cash and bank — they carry reconciliation state a merge doesn't move", () => {
    expect(canMergeLedgerRole("cash_bank")).toBe(false);
  });

  it("allows every other role", () => {
    expect(canMergeLedgerRole("debtor")).toBe(true);
    expect(canMergeLedgerRole("creditor")).toBe(true);
    expect(canMergeLedgerRole("income")).toBe(true);
    expect(canMergeLedgerRole("expense")).toBe(true);
    expect(canMergeLedgerRole("capital")).toBe(true);
    expect(canMergeLedgerRole("loan")).toBe(true);
    expect(canMergeLedgerRole("fixed_asset")).toBe(true);
    expect(canMergeLedgerRole("other")).toBe(true);
  });

  it("treats an unknown role as allowed, matching the 'other' fallback the query layer already uses", () => {
    expect(canMergeLedgerRole(undefined)).toBe(true);
  });
});

describe("mergeBlockedReason", () => {
  const source: Ledger = {
    id: "src",
    companyId: "co",
    name: "Aggarwal Ambaji",
    groupId: "g1",
    openingBalanceAmount: 0,
    openingBalanceType: "debit",
    contactPerson: null,
    phone: null,
    email: null,
    address: null,
    notes: null,
    isActive: true,
  };

  it("asks for a target when none is chosen yet", () => {
    expect(mergeBlockedReason(source, null, "")).toBe("Choose a ledger to merge into");
  });

  it("refuses a target that is the source itself", () => {
    expect(mergeBlockedReason(source, { id: "src" }, "")).toMatch(/can't be merged into itself/);
  });

  it("asks for the exact name once a real target is chosen but not yet typed", () => {
    expect(mergeBlockedReason(source, { id: "tgt" }, "")).toBe('Type "Aggarwal Ambaji" to confirm');
  });

  it("is case- and whitespace-sensitive: a near-miss still blocks", () => {
    expect(mergeBlockedReason(source, { id: "tgt" }, "aggarwal ambaji")).not.toBeNull();
    expect(mergeBlockedReason(source, { id: "tgt" }, " Aggarwal Ambaji ")).toBeNull();
  });

  it("clears once a valid target is chosen and the name is typed exactly", () => {
    expect(mergeBlockedReason(source, { id: "tgt" }, "Aggarwal Ambaji")).toBeNull();
  });
});
