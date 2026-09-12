"use client";

import { useEffect, useState } from "react";
import { useSupabase } from "@/hooks/useSupabase";
import { getBillCapturePhotoUrl } from "@/lib/supabase/queries/bill-capture";

/** Local object URLs for every photographed page, in the order given, revoked automatically when the component unmounts or the set of paths changes. */
export function useBillCapturePhotos(storagePaths: string[]): string[] {
  const supabase = useSupabase();
  const [urls, setUrls] = useState<string[]>([]);
  // Paths as one string is what actually needs to trigger a re-fetch — an
  // array literal is a new reference every render even with the same
  // contents, which would otherwise re-download every page on every render.
  const key = storagePaths.join("|");

  useEffect(() => {
    let cancelled = false;
    let objectUrls: string[] = [];

    Promise.all(storagePaths.map((path) => getBillCapturePhotoUrl(supabase, path))).then(
      (fetched) => {
        if (cancelled) {
          fetched.forEach((u) => URL.revokeObjectURL(u));
          return;
        }
        objectUrls = fetched;
        setUrls(fetched);
      },
      () => {
        if (!cancelled) setUrls([]);
      }
    );

    return () => {
      cancelled = true;
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is storagePaths' own content identity
  }, [supabase, key]);

  return urls;
}
