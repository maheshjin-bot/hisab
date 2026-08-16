import type { SupabaseClient } from "@supabase/supabase-js";
import { format, startOfMonth, subDays } from "date-fns";
import type { Database } from "@/types/database.types";
import { getAllLedgerGroups } from "./ledgers";
import { getLedgerStatement, getTrialBalance, type TrialBalanceRow } from "./reports";

export interface CashFlowSummary {
  cashInHand: number;
  cashInHandChange: number;
  bankBalance: number;
  bankBalanceChange: number;
  monthInflow: number;
  monthOutflow: number;
}

/**
 * Composes the dashboard's cash-position tiles entirely from existing report
 * queries — no dedicated backend function. "Cash" vs "Bank" ledgers are
 * discovered via account_groups.ledger_role = 'cash_bank' (robust to a
 * company renaming its seeded "Cash-in-Hand"/"Bank Accounts" groups) and
 * bucketed by whether the group name reads as cash or as bank. Month
 * Inflow/Outflow is gross movement (every debit / every credit) on those
 * ledgers for the month to date, not net change, so money that went out and
 * came back both count — matching how a cash-flow tile should read.
 */
export async function getCashFlowSummary(
  supabase: SupabaseClient<Database>,
  companyId: string,
  asOfDate: string
): Promise<CashFlowSummary> {
  const asOf = new Date(`${asOfDate}T00:00:00`);
  const monthStartStr = format(startOfMonth(asOf), "yyyy-MM-dd");
  const prevMonthEndStr = format(subDays(startOfMonth(asOf), 1), "yyyy-MM-dd");

  const [groups, trialBalanceNow, trialBalancePrev] = await Promise.all([
    getAllLedgerGroups(supabase, companyId),
    getTrialBalance(supabase, companyId, asOfDate),
    getTrialBalance(supabase, companyId, prevMonthEndStr),
  ]);

  const cashBankGroupNames = new Set(groups.filter((g) => g.ledgerRole === "cash_bank").map((g) => g.name));
  const isCashGroup = (name: string) => name.toLowerCase().includes("cash");

  function bucket(rows: TrialBalanceRow[]) {
    let cash = 0;
    let bank = 0;
    const ledgerIds: string[] = [];
    for (const row of rows) {
      if (!cashBankGroupNames.has(row.groupName)) continue;
      ledgerIds.push(row.ledgerId);
      const net = row.debitBalance - row.creditBalance;
      if (isCashGroup(row.groupName)) cash += net;
      else bank += net;
    }
    return { cash, bank, ledgerIds };
  }

  const now = bucket(trialBalanceNow);
  const prev = bucket(trialBalancePrev);

  const statements = await Promise.all(
    now.ledgerIds.map((ledgerId) => getLedgerStatement(supabase, companyId, ledgerId, monthStartStr, asOfDate))
  );

  let monthInflow = 0;
  let monthOutflow = 0;
  for (const rows of statements) {
    for (const row of rows) {
      monthInflow += row.debitAmount ?? 0;
      monthOutflow += row.creditAmount ?? 0;
    }
  }

  return {
    cashInHand: now.cash,
    cashInHandChange: now.cash - prev.cash,
    bankBalance: now.bank,
    bankBalanceChange: now.bank - prev.bank,
    monthInflow,
    monthOutflow,
  };
}
