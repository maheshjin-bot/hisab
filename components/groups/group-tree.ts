import type { AccountGroup } from "@/lib/supabase/queries/ledgers";

export interface GroupNode {
  group: AccountGroup;
  depth: number;
  children: GroupNode[];
}

/** Human labels for account_groups.nature, in the order the statements read. */
export const NATURE_LABEL: Record<string, string> = {
  capital: "Capital",
  current_asset: "Current Asset",
  current_liability: "Current Liability",
  fixed_asset: "Fixed Asset",
  direct_income: "Direct Income",
  direct_expense: "Direct Expense",
  indirect_income: "Indirect Income",
  indirect_expense: "Indirect Expense",
};

/** Human labels for account_groups.ledger_role. */
export const LEDGER_ROLE_LABEL: Record<string, string> = {
  cash_bank: "Cash / Bank",
  debtor: "Debtor",
  creditor: "Creditor",
  income: "Income",
  expense: "Expense",
  capital: "Capital",
  loan: "Loan",
  fixed_asset: "Fixed Asset",
  other: "Other",
};

function compare(a: AccountGroup, b: AccountGroup) {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

/**
 * Builds the parent/child tree, ordered by sort_order then name at every
 * level — the same ordering the seed function uses.
 *
 * A group whose parent isn't in the list is treated as a root rather than
 * dropped. That shouldn't happen (the FK is composite on (id, company_id)),
 * but silently losing a group from the only screen that manages them would be
 * a much worse failure than showing it in the wrong place.
 */
export function buildGroupTree(groups: AccountGroup[]): GroupNode[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const childrenOf = new Map<string | null, AccountGroup[]>();

  for (const group of groups) {
    const parentId = group.parentGroupId && byId.has(group.parentGroupId) ? group.parentGroupId : null;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(group);
    else childrenOf.set(parentId, [group]);
  }

  function build(parentId: string | null, depth: number): GroupNode[] {
    return (childrenOf.get(parentId) ?? [])
      .sort(compare)
      .map((group) => ({ group, depth, children: build(group.id, depth + 1) }));
  }

  return build(null, 0);
}

/** Depth-first flattening, for rendering the tree as table rows. */
export function flattenTree(nodes: GroupNode[]): GroupNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

/**
 * Ids of `groupId` and everything beneath it.
 *
 * Used to keep a group out of its own re-parent picker. The database guards
 * cycles too, but only raises after the user has already chosen — and the
 * message ("would create a cycle") explains a rule they were never shown.
 */
export function descendantIds(nodes: GroupNode[], groupId: string): Set<string> {
  const found = new Set<string>();

  function collect(node: GroupNode) {
    found.add(node.group.id);
    node.children.forEach(collect);
  }

  function search(list: GroupNode[]) {
    for (const node of list) {
      if (node.group.id === groupId) collect(node);
      else search(node.children);
    }
  }

  search(nodes);
  return found;
}

/**
 * The groups a given group may be re-parented under.
 *
 * Nature is inherited from the parent and a sub-group can't mix
 * classifications with its parent, so a move is only legal within the same
 * nature — and never into the group's own subtree.
 */
export function validParents(
  tree: GroupNode[],
  all: AccountGroup[],
  group: AccountGroup
): AccountGroup[] {
  const excluded = descendantIds(tree, group.id);
  return all
    .filter((candidate) => candidate.nature === group.nature && !excluded.has(candidate.id))
    .sort(compare);
}
