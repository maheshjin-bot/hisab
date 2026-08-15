import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

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
  const { data, error } = await supabase.rpc("get_daybook", {
    p_company_id: companyId,
    p_from_date: fromDate,
    p_to_date: toDate,
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
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
}

/** First row is always a synthetic "Opening Balance" entry — see migration 0006. */
export async function getLedgerStatement(
  supabase: SupabaseClient<Database>,
  companyId: string,
  ledgerId: string,
  fromDate: string,
  toDate: string
): Promise<LedgerStatementRow[]> {
  const { data, error } = await supabase.rpc("get_ledger_statement", {
    p_company_id: companyId,
    p_ledger_id: ledgerId,
    p_from_date: fromDate,
    p_to_date: toDate,
  });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    entryDate: r.entry_date,
    voucherId: r.voucher_id,
    voucherType: r.voucher_type,
    voucherNumber: r.voucher_number,
    narration: r.narration,
    debitAmount: r.debit_amount,
    creditAmount: r.credit_amount,
    runningBalance: r.running_balance,
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
