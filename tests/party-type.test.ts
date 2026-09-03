import { describe, expect, it } from "vitest";
import {
  PARTY_TYPES,
  defaultGroupForPartyType,
  groupsForPartyType,
  partyTypeConfig,
  partyTypeForGroup,
  partyTypeForRole,
} from "@/lib/ledgers/party-type";
import type { AccountGroup, LedgerRole } from "@/lib/supabase/queries/ledgers";

function group(
  id: string,
  name: string,
  ledgerRole: LedgerRole,
  { sortOrder = 0, isSystem = false }: { sortOrder?: number; isSystem?: boolean } = {}
): AccountGroup {
  return {
    id,
    name,
    parentGroupId: null,
    nature: "current_asset",
    ledgerRole,
    statement: "balance_sheet",
    isSystem,
    sortOrder,
  };
}

/** What app_private.seed_chart_of_accounts() leaves a new company with. */
const seeded: AccountGroup[] = [
  group("capital", "Capital Account", "capital", { sortOrder: 1, isSystem: true }),
  group("ca", "Current Assets", "other", { sortOrder: 2, isSystem: true }),
  group("cl", "Current Liabilities", "other", { sortOrder: 3, isSystem: true }),
  group("fa", "Fixed Assets", "fixed_asset", { sortOrder: 4, isSystem: true }),
  group("dexp", "Direct Expenses", "expense", { sortOrder: 5, isSystem: true }),
  group("dinc", "Direct Incomes", "income", { sortOrder: 6, isSystem: true }),
  group("iexp", "Indirect Expenses", "expense", { sortOrder: 7, isSystem: true }),
  group("iinc", "Indirect Incomes", "income", { sortOrder: 8, isSystem: true }),
  group("bank", "Bank Accounts", "cash_bank", { sortOrder: 1 }),
  group("cash", "Cash-in-Hand", "cash_bank", { sortOrder: 2 }),
  group("debtors", "Sundry Debtors", "debtor", { sortOrder: 3 }),
  group("loans", "Loans & Advances", "loan", { sortOrder: 4 }),
  group("creditors", "Sundry Creditors", "creditor", { sortOrder: 1 }),
  group("prov", "Provisions", "other", { sortOrder: 2 }),
  group("outstanding", "Outstanding Expenses", "other", { sortOrder: 3 }),
];

describe("the six plain answers", () => {
  it("offers exactly the six a shopkeeper needs, and no accounting words", () => {
    expect(PARTY_TYPES.map((t) => t.label)).toEqual([
      "Customer",
      "Supplier",
      "Bank account",
      "Cash",
      "Expense",
      "Income",
    ]);
  });

  it("defaults each type to its ordinary direction, so the common case is one field", () => {
    // The first option is the default the form picks; a customer normally owes
    // you, a supplier is normally owed.
    expect(partyTypeConfig("customer").directions[0]).toEqual({ value: "debit", label: "They owe me" });
    expect(partyTypeConfig("supplier").directions[0]).toEqual({ value: "credit", label: "I owe them" });
    expect(partyTypeConfig("bank").directions[0].value).toBe("debit");
  });

  it("asks nothing about direction for expense and income", () => {
    expect(partyTypeConfig("expense").directions).toEqual([]);
    expect(partyTypeConfig("income").directions).toEqual([]);
    expect(partyTypeConfig("expense").defaultDirection).toBe("debit");
    expect(partyTypeConfig("income").defaultDirection).toBe("credit");
  });

  it("never says debit or credit to the user", () => {
    const words = PARTY_TYPES.flatMap((t) => [
      t.label,
      t.plural,
      t.hint,
      t.amountLabel,
      t.amountHint,
      ...t.directions.map((d) => d.label),
    ]).join(" ");
    expect(words.toLowerCase()).not.toMatch(/debit|credit|ledger|dr\b|cr\b/);
  });
});

describe("finding the group by role", () => {
  it("files each plain type in the group a seeded company actually has", () => {
    expect(defaultGroupForPartyType(seeded, "customer")?.id).toBe("debtors");
    expect(defaultGroupForPartyType(seeded, "supplier")?.id).toBe("creditors");
    expect(defaultGroupForPartyType(seeded, "bank")?.id).toBe("bank");
    expect(defaultGroupForPartyType(seeded, "cash")?.id).toBe("cash");
    expect(defaultGroupForPartyType(seeded, "expense")?.id).toBe("dexp");
    expect(defaultGroupForPartyType(seeded, "income")?.id).toBe("dinc");
  });

  it("follows the role, not the name, when a company has renamed its groups", () => {
    const renamed = seeded.map((g) =>
      g.id === "debtors" ? { ...g, name: "ગ્રાહકો" } : g.id === "creditors" ? { ...g, name: "Parties We Buy From" } : g
    );
    expect(defaultGroupForPartyType(renamed, "customer")?.id).toBe("debtors");
    expect(defaultGroupForPartyType(renamed, "supplier")?.id).toBe("creditors");
  });

  it("returns null when no group carries the role, rather than guessing a wrong one", () => {
    // The seeded debtor group deleted, and nothing put in its place. Filing a
    // customer under some current-asset group would leave him invisible in the
    // voucher comboboxes, which is the defect this whole mapping exists for.
    const withoutDebtors = seeded.filter((g) => g.id !== "debtors");
    expect(defaultGroupForPartyType(withoutDebtors, "customer")).toBeNull();
    expect(groupsForPartyType(withoutDebtors, "customer")).toEqual([]);
  });

  it("offers every group with the role when a company has several, best first", () => {
    const many = [
      ...seeded,
      group("retail", "Retail Customers", "debtor", { sortOrder: 7 }),
      group("wholesale", "Wholesale Customers", "debtor", { sortOrder: 5 }),
    ];
    expect(groupsForPartyType(many, "customer").map((g) => g.id)).toEqual([
      "debtors", // sort_order 3
      "wholesale", // 5
      "retail", // 7
    ]);
  });

  it("prefers a real sub-group over a system root carrying the same role", () => {
    // Contrived but reachable: nothing stops an admin putting the debtor role
    // on Current Assets itself.
    const rooted = seeded.map((g) => (g.id === "ca" ? { ...g, ledgerRole: "debtor" as LedgerRole } : g));
    expect(defaultGroupForPartyType(rooted, "customer")?.id).toBe("debtors");
  });
});

describe("telling a bank group from a cash one", () => {
  it("puts a bank account in the bank group and cash in the cash group", () => {
    expect(defaultGroupForPartyType(seeded, "bank")?.name).toBe("Bank Accounts");
    expect(defaultGroupForPartyType(seeded, "cash")?.name).toBe("Cash-in-Hand");
  });

  it("reads a Cash Credit account as a bank, which a plain %cash% test does not", () => {
    // A Cash Credit account is an overdraft facility at a bank. migration 0016
    // flagged the dashboard's `name ilike '%cash%'` test as imperfect; this is
    // the case it gets wrong.
    const cc = [
      group("cc", "Cash Credit A/c", "cash_bank", { sortOrder: 1 }),
      group("till", "Cash-in-Hand", "cash_bank", { sortOrder: 2 }),
    ];
    expect(defaultGroupForPartyType(cc, "bank")?.id).toBe("cc");
    expect(defaultGroupForPartyType(cc, "cash")?.id).toBe("till");
    expect(partyTypeForGroup(cc[0])).toBe("bank");
  });

  it("falls back to the only cash_bank group there is rather than refusing", () => {
    const onlyBank = [group("bank", "Bank Accounts", "cash_bank")];
    // Asked for cash with nowhere cash-shaped to put it, the bank group is
    // still a legitimate answer — the role is what the voucher engine filters
    // on, and the user can rename or re-file afterwards.
    expect(defaultGroupForPartyType(onlyBank, "cash")?.id).toBe("bank");
  });
});

describe("opening an existing ledger", () => {
  it("derives the plain type from the group the ledger is already in", () => {
    expect(partyTypeForGroup(group("x", "Sundry Debtors", "debtor"))).toBe("customer");
    expect(partyTypeForGroup(group("x", "Sundry Creditors", "creditor"))).toBe("supplier");
    expect(partyTypeForGroup(group("x", "Bank Accounts", "cash_bank"))).toBe("bank");
    expect(partyTypeForGroup(group("x", "Cash-in-Hand", "cash_bank"))).toBe("cash");
    expect(partyTypeForGroup(group("x", "Indirect Expenses", "expense"))).toBe("expense");
    expect(partyTypeForGroup(group("x", "Indirect Incomes", "income"))).toBe("income");
  });

  it("says nothing rather than something wrong for a group that is none of the six", () => {
    expect(partyTypeForGroup(group("x", "Loans & Advances", "loan"))).toBeNull();
    expect(partyTypeForGroup(group("x", "Capital Account", "capital"))).toBeNull();
    expect(partyTypeForGroup(group("x", "Plant & Machinery", "fixed_asset"))).toBeNull();
    expect(partyTypeForGroup(group("x", "Provisions", "other"))).toBeNull();
  });

  it("round-trips: the type a group derives files a new ledger back in that group", () => {
    // The property that keeps editing safe. If these disagreed, opening a
    // ledger and saving it unchanged could re-home it.
    for (const g of seeded) {
      const type = partyTypeForGroup(g);
      if (!type) continue;
      expect(groupsForPartyType(seeded, type).map((c) => c.id)).toContain(g.id);
    }
  });
});

describe("partyTypeForRole", () => {
  it("offers the plain word for the role a voucher field wants", () => {
    expect(partyTypeForRole("debtor")).toBe("customer");
    expect(partyTypeForRole("creditor")).toBe("supplier");
    expect(partyTypeForRole("income")).toBe("income");
    expect(partyTypeForRole("expense")).toBe("expense");
  });

  it("proposes a bank account for cash_bank — the first of the two words that share the role", () => {
    expect(partyTypeForRole("cash_bank")).toBe("bank");
  });

  it("has no word for roles the plain picker doesn't cover", () => {
    expect(partyTypeForRole("capital")).toBeNull();
    expect(partyTypeForRole("loan")).toBeNull();
    expect(partyTypeForRole("fixed_asset")).toBeNull();
    expect(partyTypeForRole("other")).toBeNull();
  });
});
