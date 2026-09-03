import type { AccountGroup, LedgerRole } from "@/lib/supabase/queries/ledgers";

/**
 * PLAIN WORDS FOR THE THING BEING CREATED, AND THE GROUP IT ACTUALLY GOES IN.
 *
 * The ledger form used to ask for a Group — a flat list of eighteen account
 * groups — and a Debit/Credit radio. Both are accounting concepts, and the
 * group one is not merely unfriendly, it is a live defect: a group whose
 * `ledger_role` is the default 'other' is filtered out of the voucher
 * comboboxes, so a customer filed under, say, Provisions can never be picked
 * on a receipt. The user gets no error, just a party that has quietly stopped
 * existing on every screen that matters.
 *
 * So the question becomes "What is this?" with six everyday answers, and this
 * module is the translation layer between those answers and the chart of
 * accounts. Nothing below changes an accounting rule: it only decides which
 * existing group a new ledger is filed in, and which way its opening balance
 * points.
 *
 * MAPPED BY ROLE, NEVER BY NAME. `account_groups.ledger_role` is the column
 * 0003 seeds for exactly this purpose and 0010's dashboard already reads it
 * the same way. A company that renames "Sundry Debtors" to "Customers", or
 * runs its books in Gujarati, keeps working; a company that adds its own
 * "Retail Customers" sub-group under Sundry Debtors with the debtor role gets
 * it offered here for free.
 */

export type PartyType = "customer" | "supplier" | "bank" | "cash" | "expense" | "income";

export interface DirectionOption {
  value: "debit" | "credit";
  label: string;
}

export interface PartyTypeConfig {
  value: PartyType;
  /** The word on the picker. */
  label: string;
  /** The same word in the plural, for "no group set up for customers". */
  plural: string;
  /** One line under the picker, so the choice needs no accounting knowledge. */
  hint: string;
  /** The group role a ledger of this kind must live in. */
  role: LedgerRole;
  /** Legend over the opening-amount field. */
  amountLabel: string;
  /** What the opening amount means, in the user's own terms. */
  amountHint: string;
  /**
   * The Debit/Credit choice, written as sentences. The first entry is the
   * ordinary case and is the default, so the everyday ledger is one field and
   * not a decision. Empty for expense and income, where the direction is
   * always the group's normal side and asking about it would be noise.
   */
  directions: DirectionOption[];
  /** Used when `directions` is empty. */
  defaultDirection: "debit" | "credit";
}

export const PARTY_TYPES: PartyTypeConfig[] = [
  {
    value: "customer",
    label: "Customer",
    plural: "customers",
    hint: "Someone who buys from you",
    role: "debtor",
    amountLabel: "Opening amount",
    amountHint:
      "What was already unpaid between you when you started keeping books here. Leave it at 0 if nothing was pending.",
    directions: [
      { value: "debit", label: "They owe me" },
      { value: "credit", label: "I owe them — advance received" },
    ],
    defaultDirection: "debit",
  },
  {
    value: "supplier",
    label: "Supplier",
    plural: "suppliers",
    hint: "Someone you buy from",
    role: "creditor",
    amountLabel: "Opening amount",
    amountHint:
      "What was already unpaid between you when you started keeping books here. Leave it at 0 if nothing was pending.",
    directions: [
      { value: "credit", label: "I owe them" },
      { value: "debit", label: "They owe me — advance paid" },
    ],
    defaultDirection: "credit",
  },
  {
    value: "bank",
    label: "Bank account",
    plural: "bank accounts",
    hint: "A current, savings or overdraft account",
    role: "cash_bank",
    amountLabel: "Opening amount",
    amountHint: "What was in the account when you started keeping books here.",
    directions: [
      { value: "debit", label: "Balance" },
      { value: "credit", label: "Overdrawn" },
    ],
    defaultDirection: "debit",
  },
  {
    value: "cash",
    label: "Cash",
    plural: "cash accounts",
    hint: "Cash in the shop, the drawer or the safe",
    role: "cash_bank",
    amountLabel: "Opening amount",
    amountHint: "How much cash you had in hand when you started keeping books here.",
    directions: [
      { value: "debit", label: "Balance" },
      { value: "credit", label: "Overdrawn" },
    ],
    defaultDirection: "debit",
  },
  {
    value: "expense",
    label: "Expense",
    plural: "expenses",
    hint: "Money you spend — rent, salaries, transport",
    role: "expense",
    amountLabel: "Opening amount",
    amountHint: "Almost always 0. Only fill this in if you are carrying a figure over from older books.",
    directions: [],
    defaultDirection: "debit",
  },
  {
    value: "income",
    label: "Income",
    plural: "income heads",
    hint: "Money you earn — sales, commission, interest",
    role: "income",
    amountLabel: "Opening amount",
    amountHint: "Almost always 0. Only fill this in if you are carrying a figure over from older books.",
    directions: [],
    defaultDirection: "credit",
  },
];

export function partyTypeConfig(type: PartyType): PartyTypeConfig {
  // The list is a literal and every PartyType appears in it, so this cannot
  // miss; the non-null assertion is avoided by falling back to the first
  // entry rather than by claiming it.
  return PARTY_TYPES.find((t) => t.value === type) ?? PARTY_TYPES[0];
}

/**
 * TELLING A BANK GROUP FROM A CASH GROUP.
 *
 * Both carry ledger_role 'cash_bank' — the role exists to hard-filter the
 * Payment voucher's money leg, and for that purpose cash and bank are one
 * thing. Splitting them is a name test, which is what get_dashboard_summary
 * does (`g.name ilike '%cash%'`) and what migration 0016 flagged as imperfect.
 *
 * The imperfection is real and it is not hypothetical in India: a Cash Credit
 * account is a bank overdraft facility, and "Cash Credit A/c" matches `%cash%`
 * and is read as a till by that test. So the rule here is ordered rather than
 * a single `ilike`:
 *
 *   1. anything naming a bank, or naming a bank product that happens to have
 *      "cash" in it — a cash credit line, an overdraft — is a bank group. This
 *      is the case the dashboard's test gets wrong, and it costs two
 *      comparisons.
 *   2. of what is left, anything naming cash is a cash group.
 *   3. anything else is treated as a bank group, because the seeded pair is
 *      "Bank Accounts" and "Cash-in-Hand" and an unnamed third group is far
 *      more likely to be another bank than another till.
 *
 * This is a *preference* used to pick a group, not a classification stored
 * anywhere, so being wrong about an oddly named group costs the user one trip
 * to Advanced rather than a mis-posted balance. get_dashboard_summary is
 * deliberately left alone: changing how the tiles split cash from bank is an
 * accounting-presentation change, not this task, and the two do not have to
 * agree for either to be correct about the ledger it files.
 */
function cashBankFlavour(groupName: string): "bank" | "cash" {
  const name = groupName.toLowerCase();
  if (name.includes("bank") || name.includes("cash credit") || name.includes("overdraft")) return "bank";
  if (name.includes("cash")) return "cash";
  return "bank";
}

/**
 * The plain type an existing group represents, or null if it represents none
 * of them — Loans & Advances, Provisions, Capital Account, Fixed Assets and
 * anything a company has left on the default 'other' role.
 *
 * Used when opening an existing ledger for editing: the form shows the type
 * derived from the group the ledger is already in, and does not re-file it.
 */
export function partyTypeForGroup(group: Pick<AccountGroup, "name" | "ledgerRole">): PartyType | null {
  switch (group.ledgerRole) {
    case "debtor":
      return "customer";
    case "creditor":
      return "supplier";
    case "cash_bank":
      return cashBankFlavour(group.name);
    case "expense":
      return "expense";
    case "income":
      return "income";
    default:
      return null;
  }
}

/**
 * Every group a ledger of this type could legitimately live in, best first.
 *
 * A company can easily have more than one — "Sundry Debtors" plus a
 * "Retail Customers" sub-group of it, or three bank groups — and it can have
 * none, if somebody deleted the seeded group or left a replacement on the
 * default 'other' role. Both cases are handled by the caller, which files the
 * ledger in `groupsForPartyType(...)[0]` and tells the user which group that
 * was, or says plainly that there is no group to file it in.
 *
 * Ordering, for a stable and defensible "best":
 *   1. for bank and cash, groups whose name matches the flavour asked for
 *   2. the seeded sub-groups (is_system = false, which the eight protected
 *      roots are not) — "Sundry Debtors" beats "Current Assets" for a customer
 *      even in the odd book where the root itself carries the debtor role
 *   3. the company's own sort_order, then name, so the answer never depends on
 *      the order the rows came back in
 */
export function groupsForPartyType(groups: AccountGroup[], type: PartyType): AccountGroup[] {
  const config = partyTypeConfig(type);
  const wantsFlavour = config.role === "cash_bank";

  return groups
    .filter((g) => g.ledgerRole === config.role)
    .sort((a, b) => {
      if (wantsFlavour) {
        const aMatch = cashBankFlavour(a.name) === type ? 0 : 1;
        const bMatch = cashBankFlavour(b.name) === type ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
      }
      const aSystem = a.isSystem ? 1 : 0;
      const bSystem = b.isSystem ? 1 : 0;
      if (aSystem !== bSystem) return aSystem - bSystem;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name);
    });
}

/** The group a new ledger of this type is filed in, or null if there is none. */
export function defaultGroupForPartyType(groups: AccountGroup[], type: PartyType): AccountGroup | null {
  return groupsForPartyType(groups, type)[0] ?? null;
}
