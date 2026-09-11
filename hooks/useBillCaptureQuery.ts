"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import { queryKeys } from "@/lib/query-keys";
import {
  addBillCapturePage,
  billCaptureStoragePath,
  confirmBillCaptureDraft,
  createBillCaptureDraft,
  extractBillCaptureDraft,
  getBillCaptureDraft,
  listBillCaptureDrafts,
  rejectBillCaptureDraft,
  removeBillCapturePage,
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

/**
 * Creates the draft row, then uploads every file as its own page in the
 * order given — one photo is the ordinary case, but a genuinely multi-page
 * bill (a second sheet of line items, or a few photos of one long bill)
 * uploads all of them here as page 1, 2, 3…
 */
export function useUploadBillCaptureMutation(companyId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ files, vendorHint }: { files: File[]; vendorHint?: string }) => {
      const draftId = crypto.randomUUID();
      await createBillCaptureDraft(supabase, draftId, companyId, vendorHint);
      for (let i = 0; i < files.length; i++) {
        const pageNo = i + 1;
        const extension = (files[i].name.split(".").pop() || "jpg").toLowerCase();
        const path = billCaptureStoragePath(companyId, draftId, pageNo, extension);
        await uploadBillCaptureFile(supabase, path, files[i]);
        await addBillCapturePage(supabase, draftId, companyId, pageNo, path);
      }
      return draftId;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.billCaptureDrafts(companyId, undefined) }),
  });
}

/** Adds one more page to a draft that already exists — before it's been extracted or settled, from the review screen. */
export function useAddBillCapturePageMutation(companyId: string, draftId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, pageNo }: { file: File; pageNo: number }) => {
      const extension = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = billCaptureStoragePath(companyId, draftId, pageNo, extension);
      await uploadBillCaptureFile(supabase, path, file);
      await addBillCapturePage(supabase, draftId, companyId, pageNo, path);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.billCaptureDraft(draftId) }),
  });
}

export function useRemoveBillCapturePageMutation(draftId: string) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => removeBillCapturePage(supabase, pageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.billCaptureDraft(draftId) }),
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
