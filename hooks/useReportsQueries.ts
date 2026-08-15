"use client";

import { useQuery } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import {
  getBalanceSheet,
  getDaybook,
  getLedgerStatement,
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
