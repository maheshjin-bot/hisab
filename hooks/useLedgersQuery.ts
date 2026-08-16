"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import {
  createAccountGroup,
  createLedger,
  deleteAccountGroup,
  getAllLedgerGroups,
  getLedgerCountsByGroup,
  searchLedgers,
  searchLedgersForCombobox,
  updateAccountGroup,
  updateLedger,
  type AccountGroupInput,
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

/**
 * Every mutation below invalidates the same three keys: the group list, the
 * ledger list (rows carry a joined groupName) and the combobox search (its
 * options carry ledgerRole, which drives per-voucher-type filtering).
 */
function invalidateGroups(queryClient: ReturnType<typeof useQueryClient>, companyId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.ledgerGroups(companyId) });
  queryClient.invalidateQueries({ queryKey: ["companies", companyId, "ledgers"] });
  queryClient.invalidateQueries({ queryKey: ["companies", companyId, "ledger-search"] });
}

export function useLedgerCountsByGroupQuery(companyId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: ["companies", companyId ?? "", "ledger-counts-by-group"],
    queryFn: () => getLedgerCountsByGroup(supabase, companyId as string),
    enabled: !!companyId,
  });
}

export function useCreateAccountGroupMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AccountGroupInput & { parentGroupId: string }) =>
      createAccountGroup(supabase, companyId, input),
    onSuccess: () => invalidateGroups(queryClient, companyId),
  });
}

export function useUpdateAccountGroupMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, input }: { groupId: string; input: Partial<AccountGroupInput> }) =>
      updateAccountGroup(supabase, groupId, input),
    onSuccess: () => invalidateGroups(queryClient, companyId),
  });
}

export function useDeleteAccountGroupMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => deleteAccountGroup(supabase, groupId),
    onSuccess: () => invalidateGroups(queryClient, companyId),
  });
}
