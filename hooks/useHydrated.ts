"use client";

import { useSyncExternalStore } from "react";

/** Nothing to subscribe to — the value flips once, at hydration. */
const noopSubscribe = () => () => {};

/**
 * `false` during server render and the first client render, `true` after.
 *
 * For anything whose value the server can't know — the resolved theme, a
 * localStorage-backed preference — rendering it directly is a hydration
 * mismatch, and the usual `useState(false)` + `useEffect(() => setMounted(true))`
 * dance is a setState inside an effect, which cascades a second render and is
 * what the react-hooks lint rule objects to. useSyncExternalStore expresses
 * the same thing as a value React already knows.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}
