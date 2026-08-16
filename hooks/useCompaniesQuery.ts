"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import {
  acceptCompanyInvite,
  createCompany,
  getCompaniesForUser,
  getCompany,
  inviteCompanyMember,
  listCompanyMembers,
  listPendingInvites,
  revokeInvite,
  revokeMember,
  updateCompanyLockDate,
  updateMemberRole,
  type CompanyRole,
  type CreateCompanyInput,
} from "@/lib/supabase/queries/companies";

export function useCompaniesQuery() {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.companies(),
    queryFn: () => getCompaniesForUser(supabase),
  });
}

export function useCompanyQuery(companyId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.company(companyId ?? ""),
    queryFn: () => getCompany(supabase, companyId as string),
    enabled: !!companyId,
  });
}

export function useCompanyMembersQuery(companyId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.companyMembers(companyId ?? ""),
    queryFn: () => listCompanyMembers(supabase, companyId as string),
    enabled: !!companyId,
  });
}

export function useCreateCompanyMutation() {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCompanyInput) => createCompany(supabase, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies() });
    },
  });
}

export function useUpdateLockDateMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lockDate: string | null) => updateCompanyLockDate(supabase, companyId, lockDate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.company(companyId) });
    },
  });
}

export function useInviteMemberMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: CompanyRole }) =>
      inviteCompanyMember(supabase, companyId, email, role),
    onSuccess: () => {
      // Inviting someone creates a pending invite, not a member — they
      // aren't a member until they accept. Invalidating companyMembers here
      // was a bug: the new invite would save correctly but never appear in
      // the UI, since nothing had told the invites list to refetch.
      queryClient.invalidateQueries({ queryKey: queryKeys.companyInvites(companyId) });
    },
  });
}

export function usePendingInvitesQuery(companyId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.companyInvites(companyId ?? ""),
    queryFn: () => listPendingInvites(supabase, companyId as string),
    enabled: !!companyId,
  });
}

export function useUpdateMemberRoleMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: CompanyRole }) => updateMemberRole(supabase, memberId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyMembers(companyId) });
    },
  });
}

export function useRevokeMemberMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => revokeMember(supabase, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyMembers(companyId) });
    },
  });
}

export function useRevokeInviteMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => revokeInvite(supabase, inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyInvites(companyId) });
    },
  });
}

export function useAcceptInviteMutation() {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => acceptCompanyInvite(supabase, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies() });
    },
  });
}
