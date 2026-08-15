import type { LedgerRole } from "@/lib/supabase/queries/ledgers";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";

export interface VoucherSideRule {
  /** "Account (Cash/Bank)", "Party A/c Name", "Sales Ledger", etc. */
  label: string;
  allowedRoles: LedgerRole[] | "any";
  /** hard = combobox excludes non-matching ledgers; soft = shown but ranked lower + a warning icon. */
  filterMode: "hard" | "soft";
  defaultRowCount: number;
  minRows: number;
  /** Renders as one fixed-side combobox above the grid, not a grid row (Receipt/Payment/Sales/Purchase). */
  isPrimaryParty?: boolean;
}

export interface VoucherTypeConfig {
  type: VoucherType;
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
}

export const VOUCHER_TYPE_CONFIG: Record<VoucherType, VoucherTypeConfig> = {
  payment: {
    type: "payment",
    label: "Payment",
    shortcutKey: "alt+1",
    numberLabel: "Payment No.",
    narrationPlaceholder: "Being payment towards…",
    defaultMode: "single-party-grid",
    cr: { label: "Account (Cash/Bank)", allowedRoles: ["cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1, isPrimaryParty: true },
    dr: { label: "Paid Towards", allowedRoles: "any", filterMode: "soft", defaultRowCount: 1, minRows: 1 },
  },
  receipt: {
    type: "receipt",
    label: "Receipt",
    shortcutKey: "alt+2",
    numberLabel: "Receipt No.",
    narrationPlaceholder: "Being receipt towards…",
    defaultMode: "single-party-grid",
    dr: { label: "Account (Cash/Bank)", allowedRoles: ["cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1, isPrimaryParty: true },
    cr: { label: "Received From", allowedRoles: "any", filterMode: "soft", defaultRowCount: 1, minRows: 1 },
  },
  contra: {
    type: "contra",
    label: "Contra",
    shortcutKey: "alt+3",
    numberLabel: "Voucher No.",
    narrationPlaceholder: "Being transfer between…",
    defaultMode: "full-grid",
    dr: { label: "Account", allowedRoles: ["cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1 },
    cr: { label: "Account", allowedRoles: ["cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1 },
  },
  journal: {
    type: "journal",
    label: "Journal",
    shortcutKey: "alt+4",
    numberLabel: "Voucher No.",
    narrationPlaceholder: "Being journal entry for…",
    defaultMode: "full-grid",
    dr: { label: "Account (Dr)", allowedRoles: "any", filterMode: "soft", defaultRowCount: 2, minRows: 1 },
    cr: { label: "Account (Cr)", allowedRoles: "any", filterMode: "soft", defaultRowCount: 2, minRows: 1 },
  },
  sales: {
    type: "sales",
    label: "Sales",
    shortcutKey: "alt+5",
    numberLabel: "Invoice No.",
    narrationPlaceholder: "Being sale of…",
    defaultMode: "single-party-grid",
    dr: { label: "Party A/c Name", allowedRoles: ["debtor", "cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1, isPrimaryParty: true },
    cr: { label: "Sales Ledger", allowedRoles: ["income"], filterMode: "soft", defaultRowCount: 1, minRows: 1 },
  },
  purchase: {
    type: "purchase",
    label: "Purchase",
    shortcutKey: "alt+6",
    numberLabel: "Bill No.",
    narrationPlaceholder: "Being purchase of…",
    defaultMode: "single-party-grid",
    cr: { label: "Party A/c Name", allowedRoles: ["creditor", "cash_bank"], filterMode: "hard", defaultRowCount: 1, minRows: 1, isPrimaryParty: true },
    dr: { label: "Purchase Ledger", allowedRoles: ["expense"], filterMode: "soft", defaultRowCount: 1, minRows: 1 },
  },
};

export const VOUCHER_TYPE_ORDER: VoucherType[] = ["payment", "receipt", "contra", "journal", "sales", "purchase"];

export function isRoleAllowed(rule: VoucherSideRule, role: LedgerRole): boolean {
  return rule.allowedRoles === "any" || rule.allowedRoles.includes(role);
}
