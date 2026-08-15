"use client";

import { useMemo } from "react";
import { createClient } from "@/lib/supabase/client";

/** Memoized browser Supabase client for Client Components — one instance per mount, not one per render. */
export function useSupabase() {
  return useMemo(() => createClient(), []);
}
