import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export interface CashFlowSummary {
  cashInHand: number;
  cashInHandChange: number;
  bankBalance: number;
  bankBalanceChange: number;
  monthInflow: number;
  monthOutflow: number;
}

/**
 * The dashboard's cash-position tiles, in one round trip.
 *
 * This used to be composed client-side from two full trial balances plus one
 * get_ledger_statement per cash and bank ledger, so its cost grew with the
 * number of bank accounts a company had. get_dashboard_summary() computes the
 * same six figures in a single query; the definitions are unchanged —
 * "Cash" vs "Bank" is still discovered through account_groups.ledger_role
 * rather than group names, and Month Inflow/Outflow is still gross movement
 * rather than net change.
 */
export async function getCashFlowSummary(
  supabase: SupabaseClient<Database>,
  companyId: string,
  asOfDate: string
): Promise<CashFlowSummary> {
  const { data, error } = await supabase
    .rpc("get_dashboard_summary", { p_company_id: companyId, p_as_of_date: asOfDate })
    .single();
  if (error) throw error;

  const row = data as {
    cash_in_hand: number | null;
    cash_in_hand_change: number | null;
    bank_balance: number | null;
    bank_balance_change: number | null;
    month_inflow: number | null;
    month_outflow: number | null;
  };

  return {
    cashInHand: Number(row.cash_in_hand ?? 0),
    cashInHandChange: Number(row.cash_in_hand_change ?? 0),
    bankBalance: Number(row.bank_balance ?? 0),
    bankBalanceChange: Number(row.bank_balance_change ?? 0),
    monthInflow: Number(row.month_inflow ?? 0),
    monthOutflow: Number(row.month_outflow ?? 0),
  };
}
