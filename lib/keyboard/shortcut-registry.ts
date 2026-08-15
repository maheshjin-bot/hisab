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
 */
export const GLOBAL_SHORTCUTS: ShortcutDescriptor[] = [
  ...VOUCHER_TYPE_ORDER.map((type) => ({
    keys: VOUCHER_TYPE_CONFIG[type].shortcutKey,
    description: `New ${VOUCHER_TYPE_CONFIG[type].label} voucher`,
  })),
  { keys: "ctrl+enter", description: "Save" },
  { keys: "ctrl+k", description: "Command palette / switch company" },
  { keys: "alt+/", description: "Show keyboard shortcuts" },
  { keys: "alt+backspace", description: "Remove current line (in a voucher grid)" },
  { keys: "escape", description: "Close dialog / cancel" },
];
