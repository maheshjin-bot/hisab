"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard,
  BookText,
  FolderTree,
  Receipt,
  Settings,
  Building2,
  CalendarDays,
  BookOpenText,
  Scale,
  TrendingUp,
  Landmark,
  Plus,
} from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/useCommandPaletteStore";
import { useShortcutScopeStore, type ShortcutScope } from "@/stores/useShortcutScopeStore";
import { useGlobalShortcuts } from "@/lib/keyboard/useGlobalShortcuts";
import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";

/**
 * The Ctrl+K / Alt+/ command palette — always mounted once in AppShell.
 * Also doubles as the single registration point for the app-wide (non-grid)
 * keyboard shortcuts documented in lib/keyboard/shortcut-registry.ts, since
 * this is the one component guaranteed to be mounted on every authenticated
 * page.
 */
export function CommandPalette({ companyId }: { companyId: string }) {
  const router = useRouter();
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const scopeBeforeOpen = useRef<ShortcutScope>("global");

  // Memoized: useGlobalShortcuts re-subscribes its document keydown listener
  // whenever this array's reference changes, so a fresh literal every render
  // would tear down and re-add a global listener on every render.
  const shortcutBindings = useMemo(
    () => [
      { keys: "ctrl+k", description: "Command palette", scope: "global" as const, handler: () => setOpen(true) },
      { keys: "alt+/", description: "Command palette", scope: "global" as const, handler: () => setOpen(true) },
      ...VOUCHER_TYPE_ORDER.map((type) => ({
        keys: VOUCHER_TYPE_CONFIG[type].shortcutKey,
        description: `New ${VOUCHER_TYPE_CONFIG[type].label} voucher`,
        scope: "global" as const,
        handler: () => router.push(`/${companyId}/vouchers/new/${type}`),
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- companyId/router/setOpen are stable for the component's lifetime
    [companyId]
  );

  useGlobalShortcuts(shortcutBindings);

  // Voucher grid navigation (Tab/Enter/Backspace) must not fire while the
  // palette is open, so park the shortcut scope in "modal" for the duration
  // and restore whatever was active beforehand (usually "grid" if opened
  // from mid-voucher-entry).
  useEffect(() => {
    if (open) {
      scopeBeforeOpen.current = useShortcutScopeStore.getState().activeScope;
      useShortcutScopeStore.getState().setScope("modal");
    } else {
      useShortcutScopeStore.getState().setScope(scopeBeforeOpen.current);
    }
  }, [open]);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Jump to a page or start a new voucher"
    >
      <CommandInput placeholder="Search pages, new voucher…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="New voucher">
          {VOUCHER_TYPE_ORDER.map((type) => {
            const config = VOUCHER_TYPE_CONFIG[type];
            return (
              <CommandItem
                key={type}
                value={`new ${config.label} voucher`}
                onSelect={() => go(`/${companyId}/vouchers/new/${type}`)}
              >
                <Plus />
                New {config.label}
                <CommandShortcut>{config.shortcutKey.replace("+", " ").toUpperCase()}</CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Go to">
          <CommandItem value="dashboard home" onSelect={() => go(`/${companyId}/dashboard`)}>
            <LayoutDashboard />
            Dashboard
          </CommandItem>
          <CommandItem value="parties ledgers master" onSelect={() => go(`/${companyId}/ledgers`)}>
            <BookText />
            Parties & Ledgers
          </CommandItem>
          <CommandItem value="account groups chart of accounts" onSelect={() => go(`/${companyId}/groups`)}>
            <FolderTree />
            Account Groups
          </CommandItem>
          <CommandItem value="vouchers register list" onSelect={() => go(`/${companyId}/vouchers`)}>
            <Receipt />
            Vouchers
          </CommandItem>
          <CommandItem value="daybook report" onSelect={() => go(`/${companyId}/reports/daybook`)}>
            <CalendarDays />
            Daybook
          </CommandItem>
          <CommandItem value="ledger statement report" onSelect={() => go(`/${companyId}/reports/ledger-statement`)}>
            <BookOpenText />
            Ledger Statement
          </CommandItem>
          <CommandItem value="trial balance report" onSelect={() => go(`/${companyId}/reports/trial-balance`)}>
            <Scale />
            Trial Balance
          </CommandItem>
          <CommandItem value="trading profit loss report" onSelect={() => go(`/${companyId}/reports/profit-loss`)}>
            <TrendingUp />
            Trading & P&L
          </CommandItem>
          <CommandItem value="balance sheet report" onSelect={() => go(`/${companyId}/reports/balance-sheet`)}>
            <Landmark />
            Balance Sheet
          </CommandItem>
          <CommandItem value="settings company members" onSelect={() => go(`/${companyId}/settings`)}>
            <Settings />
            Settings
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Company">
          <CommandItem value="switch manage companies" onSelect={() => go("/companies")}>
            <Building2 />
            Manage companies
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
