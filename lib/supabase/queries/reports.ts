import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import { fetchAllPages } from "@/lib/supabase/fetch-all-pages";

export interface DaybookRow {
  voucherId: string;
  voucherDate: string;
  voucherType: string;
  voucherNumber: string;
  narration: string | null;
  totalAmount: number;
  drLedgers: string | null;
  crLedgers: string | null;
}

export async function getDaybook(
  supabase: SupabaseClient<Database>,
  companyId: string,
  fromDate: string,
  toDate: string
): Promise<DaybookRow[]> {
  // Paged: a busy year's Daybook runs past the API's 1000-row cap.
  const data = await fetchAllPages((from, to) =>
    supabase
      .rpc("get_daybook", {
        p_company_id: companyId,
        p_from_date: fromDate,
        p_to_date: toDate,
      })
      .range(from, to)
  );
  return data.map((r) => ({
    voucherId: r.voucher_id,
    voucherDate: r.voucher_date,
    voucherType: r.voucher_type,
    voucherNumber: r.voucher_number,
    narration: r.narration,
    totalAmount: r.total_amount,
    drLedgers: r.dr_ledgers,
    crLedgers: r.cr_ledgers,
  }));
}

export interface LedgerStatementRow {
  entryDate: string | null;
  voucherId: string | null;
  voucherType: string | null;
  voucherNumber: string | null;
  narration: string | null;
  debitAmount: number | null;
  creditAmount: number | null;
  runningBalance: number;
  /** Every *other* ledger on the voucher, comma-joined — null for the
   * synthetic Opening Balance row. See lib/reports/ledger-statement-links.ts
   * for when this is exactly one name versus several. */
  counterparty: string | null;
  /** Populated only when `counterparty` names exactly one ledger. */
  counterpartyLedgerId: string | null;
}

/** First row is always a synthetic "Opening Balance" entry — see migration 0006. */
export async function getLedgerStatement(
  supabase: SupabaseClient<Database>,
  companyId: string,
  ledgerId: string,
  fromDate: string,
  toDate: string
): Promise<LedgerStatementRow[]> {
  // Paged: a cash ledger's "All time" runs to thousands of entries, past the
  // API's 1000-row cap. Each page re-runs the function, which returns rows in
  // its own fixed order, so the pages join up with running balances intact.
  const data = await fetchAllPages((from, to) =>
    supabase
      .rpc("get_ledger_statement", {
        p_company_id: companyId,
        p_ledger_id: ledgerId,
        p_from_date: fromDate,
        p_to_date: toDate,
      })
      .range(from, to)
  );
  return data.map((r) => ({
    entryDate: r.entry_date,
    voucherId: r.voucher_id,
    voucherType: r.voucher_type,
    voucherNumber: r.voucher_number,
    narration: r.narration,
    debitAmount: r.debit_amount,
    creditAmount: r.credit_amount,
    runningBalance: r.running_balance,
    counterparty: r.counterparty,
    counterpartyLedgerId: r.counterparty_ledger_id,
  }));
}

export interface TrialBalanceRow {
  ledgerId: string;
  ledgerName: string;
  groupName: string;
  nature: string;
  debitBalance: number;
  creditBalance: number;
}

export async function getTrialBalance(
  supabase: SupabaseClient<Database>,
  companyId: string,
  asOfDate: string
): Promise<TrialBalanceRow[]> {
  const { data, error } = await supabase.rpc("get_trial_balance", {
    p_company_id: companyId,
    p_as_of_date: asOfDate,
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    ledgerId: r.ledger_id,
    ledgerName: r.ledger_name,
    groupName: r.group_name,
    nature: r.nature,
    debitBalance: r.debit_balance,
    creditBalance: r.credit_balance,
  }));
}

export interface ProfitAndLossRow {
  ledgerId: string;
  ledgerName: string;
  groupName: string;
  nature: string;
  statement: "trading" | "profit_loss";
  amount: number;
}

/** Period-scoped (from/to), unlike the balance sheet's life-to-date profit figure. */
export async function getProfitAndLoss(
  supabase: SupabaseClient<Database>,
  companyId: string,
  fromDate: string,
  toDate: string
): Promise<ProfitAndLossRow[]> {
  const { data, error } = await supabase.rpc("get_profit_and_loss", {
    p_company_id: companyId,
    p_from_date: fromDate,
    p_to_date: toDate,
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    ledgerId: r.ledger_id,
    ledgerName: r.ledger_name,
    groupName: r.group_name,
    nature: r.nature,
    statement: r.statement as "trading" | "profit_loss",
    amount: r.amount,
  }));
}

export interface BalanceSheetRow {
  side: "liability" | "asset";
  ledgerId: string | null; // null for the synthetic Net Profit/Loss line
  ledgerName: string;
  groupName: string;
  nature: string;
  amount: number;
}

export async function getBalanceSheet(
  supabase: SupabaseClient<Database>,
  companyId: string,
  asOfDate: string
): Promise<BalanceSheetRow[]> {
  const { data, error } = await supabase.rpc("get_balance_sheet", {
    p_company_id: companyId,
    p_as_of_date: asOfDate,
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    side: r.side as "liability" | "asset",
    ledgerId: r.ledger_id,
    ledgerName: r.ledger_name,
    groupName: r.group_name,
    nature: r.nature,
    amount: r.amount,
  }));
}

export interface OutstandingRow {
  ledgerId: string;
  ledgerName: string;
  /** What the party is: 'customer' | 'supplier'. */
  partyKind: "customer" | "supplier";
  /** Which way the money points: 'receivable' | 'payable'. */
  direction: "receivable" | "payable";
  /** Always positive — `direction` carries the sign. */
  amount: number;
  /** Null when the party's whole balance is an opening figure. */
  lastTransactionDate: string | null;
}

/**
 * Every customer and supplier still carrying a balance, biggest first.
 *
 * Life to date and unbounded by any as-of date, deliberately — see migration
 * 0025. "Who owes me" has one answer, and it includes a bill dated next week
 * that has already been entered.
 *
 * `direction` follows the sign of the balance rather than the party's group,
 * so a customer sitting in credit comes back as a payable. `partyKind` still
 * says he is a customer, which is what lets the screen explain the row.
 */
export async function getOutstanding(
  supabase: SupabaseClient<Database>,
  companyId: string
): Promise<OutstandingRow[]> {
  const { data, error } = await supabase.rpc("get_outstanding_balances", {
    p_company_id: companyId,
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    ledgerId: r.ledger_id,
    ledgerName: r.ledger_name,
    partyKind: r.party_kind as "customer" | "supplier",
    direction: r.direction as "receivable" | "payable",
    amount: r.amount,
    // The generated type says `string`; the column is nullable and the
    // generator does not model that for function returns.
    lastTransactionDate: r.last_transaction_date ?? null,
  }));
}
