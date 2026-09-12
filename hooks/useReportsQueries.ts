"use client";

import { useQuery } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import {
  getBalanceSheet,
  getDaybook,
  getLedgerStatement,
  getOutstanding,
  getProfitAndLoss,
  getTrialBalance,
} from "@/lib/supabase/queries/reports";

export function useDaybookQuery(companyId: string | undefined, from: string, to: string) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.daybook(companyId ?? "", from, to),
    queryFn: () => getDaybook(supabase, companyId as string, from, to),
    enabled: !!companyId && !!from && !!to,
  });
}

export function useLedgerStatementQuery(
  companyId: string | undefined,
  ledgerId: string | undefined,
  from: string,
  to: string
) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.ledgerStatement(companyId ?? "", ledgerId ?? "", from, to),
    queryFn: () => getLedgerStatement(supabase, companyId as string, ledgerId as string, from, to),
    enabled: !!companyId && !!ledgerId && !!from && !!to,
  });
}

export function useTrialBalanceQuery(companyId: string | undefined, asOfDate: string) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.trialBalance(companyId ?? "", asOfDate),
    queryFn: () => getTrialBalance(supabase, companyId as string, asOfDate),
    enabled: !!companyId && !!asOfDate,
  });
}

export function useProfitAndLossQuery(companyId: string | undefined, from: string, to: string) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.profitAndLoss(companyId ?? "", from, to),
    queryFn: () => getProfitAndLoss(supabase, companyId as string, from, to),
    enabled: !!companyId && !!from && !!to,
  });
}

export function useBalanceSheetQuery(companyId: string | undefined, asOfDate: string) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.balanceSheet(companyId ?? "", asOfDate),
    queryFn: () => getBalanceSheet(supabase, companyId as string, asOfDate),
    enabled: !!companyId && !!asOfDate,
  });
}

/**
 * Who owes me, and who I owe.
 *
 * The key is written out rather than added to lib/query-keys.ts, which an
 * unrelated uncommitted workstream owns in this tree. It follows the same
 * shape as the factory's other report keys — ["companies", id, "reports", …]
 * — so the invalidations that already sweep that prefix reach it too. Fold it
 * into the factory when the two branches meet.
 *
 * No date argument: the answer is life to date, which is the only version of
 * this question anyone asks. See migration 0025.
 */
export function useOutstandingQuery(companyId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: ["companies", companyId ?? "", "reports", "outstanding"],
    queryFn: () => getOutstanding(supabase, companyId as string),
    enabled: !!companyId,
  });
}
