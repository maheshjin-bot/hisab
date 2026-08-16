/** Centralized React Query key factory — keeps invalidation calls in sync with what queries actually use. */
export const queryKeys = {
  companies: () => ["companies"] as const,
  company: (companyId: string) => ["companies", companyId] as const,
  companyMembers: (companyId: string) => ["companies", companyId, "members"] as const,
  companyInvites: (companyId: string) => ["companies", companyId, "invites"] as const,

  ledgerGroups: (companyId: string) => ["companies", companyId, "ledger-groups"] as const,
  ledgers: (companyId: string, params: unknown) => ["companies", companyId, "ledgers", params] as const,
  ledgerSearch: (companyId: string, q: string) => ["companies", companyId, "ledger-search", q] as const,
  ledger: (ledgerId: string) => ["ledgers", ledgerId] as const,

  vouchers: (companyId: string, params: unknown) => ["companies", companyId, "vouchers", params] as const,
  voucher: (voucherId: string) => ["vouchers", voucherId] as const,

  daybook: (companyId: string, from: string, to: string) => ["companies", companyId, "reports", "daybook", from, to] as const,
  ledgerStatement: (companyId: string, ledgerId: string, from: string, to: string) =>
    ["companies", companyId, "reports", "ledger-statement", ledgerId, from, to] as const,
  trialBalance: (companyId: string, asOf: string) => ["companies", companyId, "reports", "trial-balance", asOf] as const,
  profitAndLoss: (companyId: string, from: string, to: string) =>
    ["companies", companyId, "reports", "profit-and-loss", from, to] as const,
  balanceSheet: (companyId: string, asOf: string) => ["companies", companyId, "reports", "balance-sheet", asOf] as const,

  cashFlowSummary: (companyId: string, asOf: string) => ["companies", companyId, "dashboard", "cash-flow", asOf] as const,
};
