"use client";

import { useOffline } from "next/offline";

/**
 * Mounted once in the root layout so it covers desktop and mobile alike.
 * Requires `experimental.useOffline` in next.config.ts — without it this
 * hook always returns false and the banner never renders.
 *
 * Deliberately just a signal, not a promise that work will be saved: a
 * Supabase mutation made through React Query while offline still fails on
 * its own terms (see next.config.ts's comment). This only covers Next's own
 * navigation/prefetch/Server Action retry.
 */
export function OfflineBanner() {
  const isOffline = useOffline();

  if (!isOffline) return null;

  return (
    <div
      role="status"
      className="shrink-0 bg-warning px-4 py-1.5 text-center text-xs font-medium text-warning-foreground"
    >
      You are offline. Some pages will wait to load until the connection
      returns — anything you save here may not actually go through, so check
      before relying on it.
    </div>
  );
}
