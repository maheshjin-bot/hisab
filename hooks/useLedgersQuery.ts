"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import {
  createLedger,
  getAllLedgerGroups,
  searchLedgers,
  searchLedgersForCombobox,
  updateLedger,
  type LedgerInput,
  type SearchLedgersParams,
} from "@/lib/supabase/queries/ledgers";

export function useLedgerGroupsQuery(companyId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.ledgerGroups(companyId ?? ""),
    queryFn: () => getAllLedgerGroups(supabase, companyId as string),
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000, // groups change rarely
  });
}

export function useLedgersQuery(companyId: string | undefined, params: SearchLedgersParams) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.ledgers(companyId ?? "", params),
    queryFn: () => searchLedgers(supabase, companyId as string, params),
    enabled: !!companyId,
    placeholderData: (prev) => prev, // avoid a flash of empty state while paginating/sorting
  });
}

export function useLedgerSearchQuery(companyId: string | undefined, q: string) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.ledgerSearch(companyId ?? "", q),
    queryFn: () => searchLedgersForCombobox(supabase, companyId as string, q),
    enabled: !!companyId,
    staleTime: 30 * 1000,
  });
}

export function useCreateLedgerMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LedgerInput) => createLedger(supabase, companyId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["companies", companyId, "ledgers"] });
      queryClient.invalidateQueries({ queryKey: ["companies", companyId, "ledger-search"] });
    },
  });
}

export function useUpdateLedgerMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ledgerId, input }: { ledgerId: string; input: Partial<LedgerInput> & { isActive?: boolean } }) =>
      updateLedger(supabase, ledgerId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["companies", companyId, "ledgers"] });
      queryClient.invalidateQueries({ queryKey: ["companies", companyId, "ledger-search"] });
    },
  });
}
