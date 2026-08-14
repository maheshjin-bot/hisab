import { create } from "zustand";
import { persist } from "zustand/middleware";

interface CompanyState {
  /**
   * Convenience only — NOT the source of truth for "current company". That's
   * always the `[companyId]` URL segment, so switches survive refresh and are
   * shareable. This just drives the `/` route's redirect default.
   */
  recentCompanyId: string | null;
  setRecentCompanyId: (companyId: string) => void;
}

export const useCompanyStore = create<CompanyState>()(
  persist(
    (set) => ({
      recentCompanyId: null,
      setRecentCompanyId: (companyId) => set({ recentCompanyId: companyId }),
    }),
    { name: "hisab:recent-company" }
  )
);
