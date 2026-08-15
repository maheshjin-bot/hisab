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
  updateCompanyLockDate,
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
      queryClient.invalidateQueries({ queryKey: queryKeys.companyMembers(companyId) });
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
