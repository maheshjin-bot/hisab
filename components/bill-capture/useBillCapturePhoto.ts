"use client";

import { useEffect, useState } from "react";
import { useSupabase } from "@/hooks/useSupabase";
import { getBillCapturePhotoUrl } from "@/lib/supabase/queries/bill-capture";

/** A local object URL for the photographed bill, revoked automatically when the component unmounts or the path changes. */
export function useBillCapturePhoto(storagePath: string) {
  const supabase = useSupabase();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    getBillCapturePhotoUrl(supabase, storagePath).then(
      (u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setUrl(u);
      },
      () => {
        if (!cancelled) setUrl(null);
      }
    );

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [supabase, storagePath]);

  return url;
}
