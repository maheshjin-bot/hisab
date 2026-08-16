"use client";

import { useQuery } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import { getCashFlowSummary } from "@/lib/supabase/queries/dashboard";

export function useCashFlowSummaryQuery(companyId: string | undefined, asOfDate: string) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.cashFlowSummary(companyId ?? "", asOfDate),
    queryFn: () => getCashFlowSummary(supabase, companyId as string, asOfDate),
    enabled: !!companyId && !!asOfDate,
  });
}
