"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGlobalShortcuts } from "@/lib/keyboard/useGlobalShortcuts";
import { GLOBAL_SHORTCUTS, formatShortcut } from "@/lib/keyboard/shortcut-registry";
import { useShortcutScopeStore, type ShortcutScope } from "@/stores/useShortcutScopeStore";

/**
 * The help overlay GLOBAL_SHORTCUTS was written to feed, and which never
 * existed — so two of its entries had drifted into describing behaviour the
 * app didn't have.
 *
 * Opens on "?", which is Shift+/ on most layouts. Both spellings are bound
 * because the combo normalizer includes the shift modifier when the key
 * itself already implies it.
 */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const scopeBeforeOpen = useRef<ShortcutScope>("global");

  const bindings = useMemo(
    () =>
      ["shift+?", "?"].map((keys) => ({
        keys,
        description: "Show keyboard shortcuts",
        scope: "global" as const,
        handler: () => setOpen(true),
      })),
    []
  );

  useGlobalShortcuts(bindings);

  // Same contract the command palette follows: park the scope in "modal" so
  // the voucher grid's Tab/Enter handling doesn't fire behind the dialog,
  // then restore whatever was active before.
  useEffect(() => {
    const store = useShortcutScopeStore.getState();
    if (open) {
      scopeBeforeOpen.current = store.activeScope;
      store.setScope("modal");
    } else if (store.activeScope === "modal") {
      store.setScope(scopeBeforeOpen.current);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ? at any time to bring this back.</DialogDescription>
        </DialogHeader>

        <dl className="max-h-[60vh] divide-y overflow-y-auto text-sm">
          {GLOBAL_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="flex items-center justify-between gap-4 py-2">
              <dt className="text-muted-foreground">{shortcut.description}</dt>
              <dd className="flex shrink-0 gap-1">
                {formatShortcut(shortcut.keys).map((key) => (
                  <kbd
                    key={key}
                    className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                  >
                    {key}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
