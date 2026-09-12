"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import {
  createVoucher,
  getInvoiceDocument,
  getVoucherById,
  listVouchers,
  softDeleteVoucher,
  updateVoucher,
  type ListVouchersParams,
  type VoucherFormInput,
} from "@/lib/supabase/queries/vouchers";

export function useVouchersQuery(companyId: string | undefined, params: ListVouchersParams) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.vouchers(companyId ?? "", params),
    queryFn: () => listVouchers(supabase, companyId as string, params),
    enabled: !!companyId,
    placeholderData: (prev) => prev,
  });
}

export function useVoucherQuery(voucherId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.voucher(voucherId ?? ""),
    queryFn: () => getVoucherById(supabase, voucherId as string),
    enabled: !!voucherId,
  });
}

/**
 * The printable invoice for one voucher.
 *
 * Keyed under the existing voucher key rather than a new entry in the key
 * factory, so the invalidation the edit mutation already performs clears the
 * printed document too — an invoice edited and then printed must not show the
 * version before the edit.
 */
export function useInvoiceDocumentQuery(companyId: string | undefined, voucherId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: [...queryKeys.voucher(voucherId ?? ""), "invoice"],
    queryFn: () => getInvoiceDocument(supabase, companyId as string, voucherId as string),
    enabled: !!companyId && !!voucherId,
  });
}

function invalidateVoucherLists(queryClient: ReturnType<typeof useQueryClient>, companyId: string) {
  queryClient.invalidateQueries({ queryKey: ["companies", companyId, "vouchers"] });
  queryClient.invalidateQueries({ queryKey: ["companies", companyId, "reports"] });
}

export function useCreateVoucherMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: VoucherFormInput) => createVoucher(supabase, input),
    onSuccess: () => invalidateVoucherLists(queryClient, companyId),
  });
}

export function useUpdateVoucherMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ voucherId, input }: { voucherId: string; input: Omit<VoucherFormInput, "companyId" | "voucherType"> }) =>
      updateVoucher(supabase, voucherId, input),
    onSuccess: (_data, variables) => {
      invalidateVoucherLists(queryClient, companyId);
      queryClient.invalidateQueries({ queryKey: queryKeys.voucher(variables.voucherId) });
    },
  });
}

export function useDeleteVoucherMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (voucherId: string) => softDeleteVoucher(supabase, voucherId),
    onSuccess: () => invalidateVoucherLists(queryClient, companyId),
  });
}
