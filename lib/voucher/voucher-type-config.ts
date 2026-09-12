import type { LedgerRole } from "@/lib/supabase/queries/ledgers";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";

export interface VoucherSideRule {
  /** "Paid From (Cash / Bank)", "Customer", "Sales Account", etc. */
  label: string;
  allowedRoles: LedgerRole[] | "any";
  /** hard = combobox excludes non-matching ledgers; soft = shown but ranked lower + a warning icon. */
  filterMode: "hard" | "soft";
  defaultRowCount: number;
  minRows: number;
  /** Renders as one fixed-side combobox above the grid, not a grid row (Money In/Money Out/Sale Bill/Purchase Bill). */
  isPrimaryParty?: boolean;
}

export interface VoucherTypeConfig {
  type: VoucherType;
  /**
   * What the screen calls this voucher. Plain shopkeeper English, never the
   * textbook word — the person entering fifty of these in a sitting thinks
   * "money came in", not "receipt voucher".
   *
   * The database value is `type` above and never changes with it: every check
   * constraint, RPC, query key and route segment still says `receipt`,
   * `payment`, `contra`, `journal`, `sales`, `purchase`.
   */
  label: string;
  /** Canonical shortcut — Alt+1..6, unambiguous and easy to document in a "?" help overlay. */
  shortcutKey: string;
  numberLabel: string;
  narrationPlaceholder: string;
  /** single-party-grid: one fixed combobox + a uniform-side grid. full-grid: every row picks its own Dr/Cr. */
  defaultMode: "single-party-grid" | "full-grid";
  dr: VoucherSideRule;
  cr: VoucherSideRule;
  /** Tally allows freely mixing Dr/Cr rows in any voucher type; off by default in v1. */
  allowMixedSides?: boolean;
  /** Cash-flow direction for UI colour-coding (nav dots, activity feed badges) — not used in any ledger-posting logic. */
  flow: "in" | "out" | "neutral";
}

export const VOUCHER_TYPE_CONFIG: Record<VoucherType, VoucherTypeConfig> = {
  payment: {
    type: "payment",
    label: "Money Out",
    shortcutKey: "alt+1",
    numberLabel: "Voucher No.",
    narrationPlaceholder: "What was this paid for?",
    defaultMode: "single-party-grid",
    flow: "out",
    cr: { label: "Paid From (Cash / Bank)", allowedRoles: ["cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1, isPrimaryParty: true },
    dr: { label: "Paid To / Paid For", allowedRoles: "any", filterMode: "soft", defaultRowCount: 1, minRows: 1 },
  },
  receipt: {
    type: "receipt",
    label: "Money In",
    shortcutKey: "alt+2",
    numberLabel: "Voucher No.",
    narrationPlaceholder: "What was this money for?",
    defaultMode: "single-party-grid",
    flow: "in",
    dr: { label: "Received Into (Cash / Bank)", allowedRoles: ["cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1, isPrimaryParty: true },
    cr: { label: "Received From", allowedRoles: "any", filterMode: "soft", defaultRowCount: 1, minRows: 1 },
  },
  contra: {
    type: "contra",
    label: "Cash ↔ Bank Transfer",
    shortcutKey: "alt+3",
    numberLabel: "Voucher No.",
    narrationPlaceholder: "e.g. Cash deposited into the bank",
    defaultMode: "full-grid",
    flow: "neutral",
    dr: { label: "Cash / Bank Account", allowedRoles: ["cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1 },
    cr: { label: "Cash / Bank Account", allowedRoles: ["cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1 },
  },
  journal: {
    type: "journal",
    label: "Adjustment",
    shortcutKey: "alt+4",
    numberLabel: "Voucher No.",
    narrationPlaceholder: "Why are you making this adjustment?",
    defaultMode: "full-grid",
    flow: "neutral",
    dr: { label: "Account (Dr)", allowedRoles: "any", filterMode: "soft", defaultRowCount: 2, minRows: 1 },
    cr: { label: "Account (Cr)", allowedRoles: "any", filterMode: "soft", defaultRowCount: 2, minRows: 1 },
  },
  sales: {
    type: "sales",
    label: "Sale Bill",
    shortcutKey: "alt+5",
    numberLabel: "Invoice No.",
    narrationPlaceholder: "What did you sell?",
    defaultMode: "single-party-grid",
    flow: "in",
    dr: { label: "Customer", allowedRoles: ["debtor", "cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1, isPrimaryParty: true },
    cr: { label: "Sales Account", allowedRoles: ["income"], filterMode: "soft", defaultRowCount: 1, minRows: 1 },
  },
  purchase: {
    type: "purchase",
    label: "Purchase Bill",
    shortcutKey: "alt+6",
    numberLabel: "Bill No.",
    narrationPlaceholder: "What did you buy?",
    defaultMode: "single-party-grid",
    flow: "out",
    cr: { label: "Supplier", allowedRoles: ["creditor", "cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1, isPrimaryParty: true },
    dr: { label: "Purchase Account", allowedRoles: ["expense"], filterMode: "soft", defaultRowCount: 1, minRows: 1 },
  },
};

export const VOUCHER_TYPE_ORDER: VoucherType[] = ["payment", "receipt", "contra", "journal", "sales", "purchase"];

export function isRoleAllowed(rule: Pick<VoucherSideRule, "allowedRoles">, role: LedgerRole): boolean {
  return rule.allowedRoles === "any" || rule.allowedRoles.includes(role);
}

/**
 * What a ledger's role is *called* in a sentence a shopkeeper reads. Not the
 * same list as LEDGER_ROLE_LABEL in components/groups: that one titles a column
 * on the account-groups admin screen, this one has to drop into
 * "… is a customer, but a Sale Bill usually puts an income account here."
 */
const ROLE_PHRASE: Record<LedgerRole, string> = {
  cash_bank: "a cash or bank account",
  debtor: "a customer",
  creditor: "a supplier",
  income: "an income account",
  expense: "an expense account",
  capital: "a capital account",
  loan: "a loan account",
  fixed_asset: "a fixed asset",
  other: "an account of some other kind",
};

export function describeRole(role: LedgerRole): string {
  return ROLE_PHRASE[role] ?? ROLE_PHRASE.other;
}

/** "an income account", or "a customer or a cash or bank account" for a multi-role rule. */
export function describeExpectedRoles(rule: VoucherSideRule): string {
  if (rule.allowedRoles === "any") return "any account";
  const phrases = rule.allowedRoles.map(describeRole);
  if (phrases.length <= 1) return phrases[0] ?? "any account";
  return `${phrases.slice(0, -1).join(", ")} or ${phrases[phrases.length - 1]}`;
}

/**
 * F-18. A soft-filtered side deliberately accepts any ledger, and that
 * permissiveness stays — it is what lets a hand-added rounding or freight line
 * exist in a product with no tax layer. But a warning triangle in a dropdown is
 * not consequential on its own: an asset credited on a sale produces a Profit &
 * Loss that looks perfectly plausible and is quietly wrong, the voucher still
 * balances, and nothing downstream ever flags it.
 *
 * So picks that fall outside the expected roles are collected here, and the
 * forms make the user confirm them by name before the save goes through.
 */
export interface LedgerRoleMismatch {
  ledgerName: string;
  ledgerRole: LedgerRole;
  /** The side being filled — its expected roles are what the confirmation quotes. */
  rule: VoucherSideRule;
  /** 1-based grid row; omitted when the field is the fixed party box above the grid. */
  lineNumber?: number;
}

/** Null unless this pick is one a soft-filtered side would let through unexpectedly. */
export function roleMismatch(
  rule: VoucherSideRule,
  ledger: { name: string; ledgerRole: LedgerRole } | undefined,
  lineNumber?: number
): LedgerRoleMismatch | null {
  // A hard side cannot offer a wrong role in the first place, and an "any" side
  // has nothing to be wrong about. Only a soft, role-narrowed side can.
  if (!ledger) return null;
  if (rule.filterMode !== "soft" || rule.allowedRoles === "any") return null;
  if (isRoleAllowed(rule, ledger.ledgerRole)) return null;
  return { ledgerName: ledger.name, ledgerRole: ledger.ledgerRole, rule, lineNumber };
}
