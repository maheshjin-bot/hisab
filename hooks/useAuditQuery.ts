"use client";

import { useQuery } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import {
  getVoucherHistory,
  listAuditLog,
  type ListAuditParams,
} from "@/lib/supabase/queries/audit";

export function useAuditLogQuery(companyId: string | undefined, params: ListAuditParams) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: ["companies", companyId ?? "", "audit", params],
    queryFn: () => listAuditLog(supabase, companyId as string, params),
    enabled: !!companyId,
  });
}

export function useVoucherHistoryQuery(companyId: string | undefined, voucherId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: ["companies", companyId ?? "", "audit", "voucher", voucherId ?? ""],
    queryFn: () => getVoucherHistory(supabase, companyId as string, voucherId as string),
    enabled: !!companyId && !!voucherId,
  });
}
