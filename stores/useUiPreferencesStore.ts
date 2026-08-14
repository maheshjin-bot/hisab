import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TableDensity = "compact" | "comfortable";

interface UiPreferencesState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  tableDensity: TableDensity;
  setTableDensity: (density: TableDensity) => void;
}

export const useUiPreferencesStore = create<UiPreferencesState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      tableDensity: "compact",
      setTableDensity: (density) => set({ tableDensity: density }),
    }),
    { name: "hisab:ui-preferences" }
  )
);
