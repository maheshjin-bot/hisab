"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import {
  billCaptureStoragePath,
  confirmBillCaptureDraft,
  createBillCaptureDraft,
  extractBillCaptureDraft,
  getBillCaptureDraft,
  listBillCaptureDrafts,
  rejectBillCaptureDraft,
  uploadBillCaptureFile,
  type BillCaptureStatus,
} from "@/lib/supabase/queries/bill-capture";

export function useBillCaptureDraftsQuery(companyId: string | undefined, status?: BillCaptureStatus) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.billCaptureDrafts(companyId ?? "", status),
    queryFn: () => listBillCaptureDrafts(supabase, companyId as string, status),
    enabled: !!companyId,
  });
}

export function useBillCaptureDraftQuery(draftId: string | undefined) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: queryKeys.billCaptureDraft(draftId ?? ""),
    queryFn: () => getBillCaptureDraft(supabase, draftId as string),
    enabled: !!draftId,
  });
}

/** Uploads the photo, then creates the draft row — in that order, so the row is never created pointing at a path nothing has landed at yet. */
export function useUploadBillCaptureMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, vendorHint }: { file: File; vendorHint?: string }) => {
      const draftId = crypto.randomUUID();
      const extension = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = billCaptureStoragePath(companyId, draftId, extension);
      await uploadBillCaptureFile(supabase, path, file);
      return createBillCaptureDraft(supabase, draftId, companyId, path, vendorHint);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.billCaptureDrafts(companyId, undefined) }),
  });
}

export function useExtractBillCaptureMutation(draftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => extractBillCaptureDraft(draftId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.billCaptureDraft(draftId) }),
  });
}

export function useRejectBillCaptureMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, reason }: { draftId: string; reason: string }) => rejectBillCaptureDraft(supabase, draftId, reason),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.billCaptureDraft(variables.draftId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.billCaptureDrafts(companyId, undefined) });
    },
  });
}

export function useConfirmBillCaptureMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, voucherId }: { draftId: string; voucherId: string }) => confirmBillCaptureDraft(supabase, draftId, voucherId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.billCaptureDraft(variables.draftId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.billCaptureDrafts(companyId, undefined) });
    },
  });
}
