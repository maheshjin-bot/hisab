import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";

export interface ShortcutDescriptor {
  keys: string;
  description: string;
}

/**
 * The single source of truth for "what shortcuts exist" — feeds both the
 * actual useGlobalShortcuts() bindings (wired per-page, since handlers are
 * page-specific) and the "?" shortcuts-help overlay, so the two can never
 * drift apart.
 *
 * Every entry below is bound somewhere. Two previously weren't: alt+/ was
 * described as "Show keyboard shortcuts" while actually opening the command
 * palette, and ctrl+enter "Save" was bound nowhere at all. The overlay now
 * exists and ctrl+enter submits the voucher form, so the list is true again —
 * keep it that way when adding entries.
 */
export const GLOBAL_SHORTCUTS: ShortcutDescriptor[] = [
  ...VOUCHER_TYPE_ORDER.map((type) => ({
    keys: VOUCHER_TYPE_CONFIG[type].shortcutKey,
    description: `New ${VOUCHER_TYPE_CONFIG[type].label} voucher`,
  })),
  { keys: "ctrl+k", description: "Command palette / switch company" },
  { keys: "alt+/", description: "Command palette" },
  { keys: "?", description: "Show keyboard shortcuts" },
  { keys: "ctrl+enter", description: "Save voucher" },
  { keys: "alt+backspace", description: "Remove current line (in a voucher grid)" },
  { keys: "escape", description: "Close dialog / cancel" },
];

const KEY_LABEL: Record<string, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
};

/** Splits a normalized combo into display-ready key caps: "ctrl+enter" -> ["Ctrl", "Enter"]. */
export function formatShortcut(keys: string): string[] {
  return keys.split("+").map((part) => KEY_LABEL[part] ?? part.toUpperCase());
}
