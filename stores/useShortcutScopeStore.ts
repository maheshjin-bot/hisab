import { create } from "zustand";

export type ShortcutScope = "global" | "grid" | "modal";

interface ShortcutScopeState {
  activeScope: ShortcutScope;
  setScope: (scope: ShortcutScope) => void;
}

/**
 * Not persisted, not typically subscribed to via the hook — the global
 * keydown dispatcher (lib/keyboard/useGlobalShortcuts.ts) reads this
 * imperatively via `useShortcutScopeStore.getState()` on every keydown so it
 * never has to re-register the listener when scope changes. Components that
 * open a modal/dialog over the voucher grid should call `setScope('modal')`
 * on mount and restore `'grid'` (or whatever was active) on unmount.
 */
export const useShortcutScopeStore = create<ShortcutScopeState>((set) => ({
  activeScope: "global",
  setScope: (scope) => set({ activeScope: scope }),
}));
