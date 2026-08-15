import { useEffect } from "react";
import { useShortcutScopeStore, type ShortcutScope } from "@/stores/useShortcutScopeStore";

export interface ShortcutBinding {
  /** Normalized combo, e.g. 'alt+1', 'ctrl+enter', 'alt+/'. */
  keys: string;
  description: string;
  scope: ShortcutScope;
  handler: (e: KeyboardEvent) => void;
  preventDefault?: boolean;
}

function normalizeCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
  return parts.join("+");
}

/**
 * One document-level listener per mounted binding set. Scope is read
 * imperatively via `useShortcutScopeStore.getState()` on every keydown
 * (not a subscription) so a modal opening/closing never has to re-register
 * this listener — it just changes what the store returns.
 */
export function useGlobalShortcuts(bindings: ShortcutBinding[]) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const combo = normalizeCombo(e);
      const activeScope = useShortcutScopeStore.getState().activeScope;

      for (const binding of bindings) {
        if (binding.keys !== combo) continue;
        if (binding.scope !== "global" && binding.scope !== activeScope) continue;
        if (binding.preventDefault !== false) e.preventDefault();
        binding.handler(e);
        return;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [bindings]);
}
