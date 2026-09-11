import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Connectivity-aware navigation/prefetch/Server Action retry (see
    // components/layout/OfflineBanner.tsx) for the mobile section, entered
    // one shop-floor WiFi bar at a time. Deliberately not paired with
    // cacheComponents/partialPrefetching — those change the whole app's
    // rendering model, which is out of scope for this. This flag alone does
    // not retry client-side Supabase mutations (React Query owns those) —
    // it only covers Next's own request types.
    useOffline: true,
    // Turbopack's persistent dev cache (on by default since 16.1) only
    // evicts compiled data from memory under 'auto' when the OS reports
    // memory pressure — on a workstation with RAM to spare that never
    // triggers, so the dev server settles around 10GB+ resident even right
    // after a cold restart. 'full' evicts everything from memory on every
    // cache save instead, trading a little recompute for a much smaller
    // footprint. Dev-only knob (see turbopackFileSystemCache docs) — has no
    // effect on `next build`/`next start`.
    turbopackMemoryEviction: "full",
  },
};

export default nextConfig;
