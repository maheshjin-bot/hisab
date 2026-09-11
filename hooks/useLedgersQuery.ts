"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import {
  createAccountGroup,
  createLedger,
  deleteAccountGroup,
  getAllLedgerGroups,
  getLedgerBalances,
  getLedgerCountsByGroup,
  mergeLedgers,
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

/**
 * Life-to-date balance per ledger, for the mobile ledger list's small
 * balance figures and for telling the user a ledger can't be deactivated
 * *before* the 0017 trigger tells them the same thing as an error.
 *
 * Off by default: it aggregates every voucher entry in the company, which
 * the deliberately server-paginated ledger list has no reason to pay for on
 * each page view. Callers switch it on for the moment they need it.
 */
export function useLedgerBalancesQuery(companyId: string | undefined, enabled = true) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.ledgerBalances(companyId ?? ""),
    queryFn: () => getLedgerBalances(supabase, companyId as string),
    enabled: !!companyId && enabled,
    staleTime: 30 * 1000, // posting a voucher moves these; the trigger stays the authority
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
 * Merging touches whatever the two ledgers ever posted to — vouchers of any
 * age, any report, the dashboard's cash-flow figure — not just the ledger
 * list. Rather than name every affected key (and inevitably miss one the
 * next report adds), this invalidates the whole cache, the same blunt
 * approach UndoRecentChanges already uses for its own wide, rare, no-undo
 * mutation.
 */
export function useMergeLedgerMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceLedgerId, targetLedgerId }: { sourceLedgerId: string; targetLedgerId: string }) =>
      mergeLedgers(supabase, companyId, sourceLedgerId, targetLedgerId),
    onSuccess: () => queryClient.invalidateQueries(),
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
