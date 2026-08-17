"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSupabase } from "./useSupabase";
import {
  exportCompanyBackup,
  restoreCompanyBackup,
  type RestoreMode,
} from "@/lib/supabase/queries/backup";

export function useExportBackupMutation(companyId: string) {
  const supabase = useSupabase();
  return useMutation({
    mutationFn: () => exportCompanyBackup(supabase, companyId),
  });
}

export function useRestoreBackupMutation() {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      payload,
      mode,
      targetCompanyId,
    }: {
      payload: unknown;
      mode: RestoreMode;
      targetCompanyId?: string;
    }) => restoreCompanyBackup(supabase, payload, mode, targetCompanyId),
    onSuccess: () => {
      // A restore rewrites essentially everything, and an overwrite changes
      // rows the cache is already holding — so drop the lot rather than try to
      // enumerate what moved.
      queryClient.invalidateQueries();
    },
  });
}
