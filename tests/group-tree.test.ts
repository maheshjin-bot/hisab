import { describe, expect, it } from "vitest";
import {
  buildGroupTree,
  descendantIds,
  flattenTree,
  validParents,
} from "@/components/groups/group-tree";
import { buildGroupFormSchema } from "@/components/groups/group-form-schema";
import type { AccountGroup } from "@/lib/supabase/queries/ledgers";

function group(
  id: string,
  name: string,
  parentGroupId: string | null,
  nature: string,
  sortOrder = 0,
  isSystem = false
): AccountGroup {
  return {
    id,
    name,
    parentGroupId,
    nature,
    ledgerRole: "other",
    statement: "",
    isSystem,
    sortOrder,
  };
}

const groups: AccountGroup[] = [
  group("ca", "Current Assets", null, "current_asset", 2, true),
  group("cl", "Current Liabilities", null, "current_liability", 3, true),
  group("bank", "Bank Accounts", "ca", "current_asset", 1),
  group("cash", "Cash-in-Hand", "ca", "current_asset", 2),
  group("hdfc", "HDFC", "bank", "current_asset", 1),
  group("cred", "Sundry Creditors", "cl", "current_liability", 1),
];

describe("buildGroupTree", () => {
  it("nests children under their parent at the right depth", () => {
    const flat = flattenTree(buildGroupTree(groups));
    expect(flat.map((n) => [n.group.id, n.depth])).toEqual([
      ["ca", 0],
      ["bank", 1],
      ["hdfc", 2],
      ["cash", 1],
      ["cl", 0],
      ["cred", 1],
    ]);
  });

  it("orders by sort_order then name at every level", () => {
    const shuffled = [
      group("root", "Root", null, "current_asset", 1),
      group("z", "Zebra", "root", "current_asset", 1),
      group("a", "Apple", "root", "current_asset", 1),
      group("first", "Zzz first", "root", "current_asset", 0),
    ];
    const ids = flattenTree(buildGroupTree(shuffled)).map((n) => n.group.id);
    // sort_order 0 wins outright; the two ties then break alphabetically.
    expect(ids).toEqual(["root", "first", "a", "z"]);
  });

  it("surfaces a group whose parent is missing rather than dropping it", () => {
    const orphaned = [...groups, group("lost", "Orphan", "does-not-exist", "current_asset", 9)];
    const ids = flattenTree(buildGroupTree(orphaned)).map((n) => n.group.id);
    // Losing a group entirely from the only screen that manages them would be
    // a far worse failure than showing it at the root.
    expect(ids).toContain("lost");
    expect(buildGroupTree(orphaned).map((n) => n.group.id)).toContain("lost");
  });

  it("returns nothing for an empty chart", () => {
    expect(buildGroupTree([])).toEqual([]);
  });
});

describe("descendantIds", () => {
  const tree = buildGroupTree(groups);

  it("includes the group itself and everything beneath it", () => {
    expect([...descendantIds(tree, "ca")].sort()).toEqual(["bank", "ca", "cash", "hdfc"]);
    expect([...descendantIds(tree, "bank")].sort()).toEqual(["bank", "hdfc"]);
  });

  it("is just the group itself for a leaf", () => {
    expect([...descendantIds(tree, "hdfc")]).toEqual(["hdfc"]);
  });
});

describe("validParents", () => {
  const tree = buildGroupTree(groups);

  it("never offers the group's own subtree, which would be a cycle", () => {
    const ids = validParents(tree, groups, groups.find((g) => g.id === "bank")!).map((g) => g.id);
    expect(ids).not.toContain("bank");
    expect(ids).not.toContain("hdfc");
  });

  it("only offers groups of the same nature, since nature is inherited", () => {
    const ids = validParents(tree, groups, groups.find((g) => g.id === "bank")!).map((g) => g.id);
    expect(ids.sort()).toEqual(["ca", "cash"]);

    const liabilityIds = validParents(tree, groups, groups.find((g) => g.id === "cred")!).map((g) => g.id);
    expect(liabilityIds).toEqual(["cl"]);
  });
});

describe("group form schema", () => {
  const sub = buildGroupFormSchema(false);
  const systemGroup = buildGroupFormSchema(true);

  it("requires a parent for a sub-group", () => {
    expect(sub.safeParse({ name: "GST Payable", parentGroupId: "", ledgerRole: "other" }).success).toBe(false);
    expect(sub.safeParse({ name: "GST Payable", parentGroupId: "cl", ledgerRole: "other" }).success).toBe(true);
  });

  it("lets a system group save without one, since a root has no parent", () => {
    // The regression: a system group resets parentGroupId to "" because it is
    // null in the database, so an always-required schema made the eight
    // primary groups impossible to rename — and reported the error against a
    // field that is disabled.
    const result = systemGroup.safeParse({ name: "Current Assets", parentGroupId: "", ledgerRole: "other" });
    expect(result.success).toBe(true);
  });

  it("still requires a name either way", () => {
    expect(sub.safeParse({ name: "  ", parentGroupId: "cl", ledgerRole: "other" }).success).toBe(false);
    expect(systemGroup.safeParse({ name: "", parentGroupId: "", ledgerRole: "other" }).success).toBe(false);
  });

  it("rejects a ledger role that isn't one of the nine", () => {
    expect(sub.safeParse({ name: "X", parentGroupId: "cl", ledgerRole: "not_a_role" }).success).toBe(false);
  });
});
