"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BookText,
  FolderTree,
  Receipt,
  CalendarDays,
  BookOpenText,
  Scale,
  TrendingUp,
  Landmark,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CompanySwitcher } from "./CompanySwitcher";
import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";
import { useUiPreferencesStore } from "@/stores/useUiPreferencesStore";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function navItems(companyId: string): NavItem[] {
  return [
    { href: `/${companyId}/dashboard`, label: "Dashboard", icon: LayoutDashboard },
    { href: `/${companyId}/ledgers`, label: "Parties & Ledgers", icon: BookText },
    { href: `/${companyId}/groups`, label: "Account Groups", icon: FolderTree },
    { href: `/${companyId}/vouchers`, label: "Vouchers", icon: Receipt },
  ];
}

function reportItems(companyId: string): NavItem[] {
  return [
    { href: `/${companyId}/reports/daybook`, label: "Daybook", icon: CalendarDays },
    { href: `/${companyId}/reports/ledger-statement`, label: "Ledger Statement", icon: BookOpenText },
    { href: `/${companyId}/reports/trial-balance`, label: "Trial Balance", icon: Scale },
    { href: `/${companyId}/reports/profit-loss`, label: "Trading & P&L", icon: TrendingUp },
    { href: `/${companyId}/reports/balance-sheet`, label: "Balance Sheet", icon: Landmark },
  ];
}

/** Flow -> the same emerald/rose/slate vocabulary used for Dr/Cr status elsewhere in the app. */
const FLOW_DOT_CLASS: Record<"in" | "out" | "neutral", string> = {
  in: "bg-success",
  out: "bg-destructive",
  neutral: "bg-muted-foreground/50",
};

function isActiveHref(pathname: string | null, href: string) {
  return pathname === href || pathname?.startsWith(href + "/");
}

function NavLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = isActiveHref(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      // The label is the accessible name when it's visible; when collapsed to
      // icons the title carries it instead.
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-r-md rounded-l-sm border-l-2 px-2.5 py-1.5 text-sm transition-colors",
        collapsed && "justify-center px-0",
        active
          ? "border-primary bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "border-transparent text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 pb-1 text-xs font-medium text-sidebar-foreground/45">{children}</p>;
}

/**
 * The sidebar's contents, without the <aside> shell — rendered both in the
 * desktop rail and inside the mobile drawer, so the two can never drift.
 *
 * `onNavigate` closes the drawer after a link is followed; on desktop it's
 * omitted, since there's nothing to close.
 */
export function SidebarNav({
  companyId,
  collapsed = false,
  onNavigate,
}: {
  companyId: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <>
      <div className={cn("p-3", collapsed && "px-2")}>
        {/* The switcher needs its full width to show a company name; collapsed
            it would be an unreadable sliver, so the rail drops it and the
            company stays reachable from the command palette. */}
        {!collapsed && <CompanySwitcher activeCompanyId={companyId} />}
      </div>

      <nav className={cn("flex-1 space-y-5 overflow-y-auto pb-3", collapsed ? "px-2" : "px-3")}>
        <div className="space-y-0.5">
          {navItems(companyId).map((item) => (
            <NavLink key={item.href} item={item} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>

        {/* Voucher types are dots rather than icons, so a collapsed rail of
            them would be unreadable. They stay one click away in the top bar's
            New Voucher menu and in the command palette. */}
        {!collapsed && (
          <div>
            <SectionLabel>New voucher</SectionLabel>
            <div className="space-y-0.5">
              {VOUCHER_TYPE_ORDER.map((type) => {
                const config = VOUCHER_TYPE_CONFIG[type];
                const href = `/${companyId}/vouchers/new/${type}`;
                const active = isActiveHref(pathname, href);
                return (
                  <Link
                    key={type}
                    href={href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2.5 rounded-r-md rounded-l-sm border-l-2 py-1 pr-2 pl-2.5 text-[13px] transition-colors",
                      active
                        ? "border-primary bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "border-transparent text-sidebar-foreground/65 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    )}
                  >
                    <span className={cn("size-1.5 shrink-0 rounded-full", FLOW_DOT_CLASS[config.flow])} />
                    <span className="flex-1 truncate">{config.label}</span>
                    <kbd className="shrink-0 font-mono text-[10px] text-sidebar-foreground/40">
                      {config.shortcutKey.replace("alt+", "⌥")}
                    </kbd>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        <div>
          {!collapsed && <SectionLabel>Reports</SectionLabel>}
          <div className="space-y-0.5">
            {reportItems(companyId).map((item) => (
              <NavLink key={item.href} item={item} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      </nav>

      <div className={cn("space-y-0.5 border-t border-sidebar-border p-3", collapsed && "px-2")}>
        <NavLink
          item={{ href: `/${companyId}/audit`, label: "History", icon: History }}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
        <NavLink
          item={{ href: `/${companyId}/settings`, label: "Settings", icon: Settings }}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </div>
    </>
  );
}

/** The desktop rail. Hidden below lg, where AppShell renders a drawer instead. */
export function Sidebar({ companyId }: { companyId: string }) {
  const collapsed = useUiPreferencesStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiPreferencesStore((s) => s.toggleSidebar);

  return (
    <aside
      data-print-hide
      className={cn(
        "hidden h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex",
        collapsed ? "w-14" : "w-64"
      )}
    >
      <SidebarNav companyId={companyId} collapsed={collapsed} />

      <div className={cn("border-t border-sidebar-border p-2", !collapsed && "px-3")}>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleSidebar}
          className={cn("w-full text-sidebar-foreground/70", collapsed && "px-0")}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {!collapsed && <span className="ml-1.5">Collapse</span>}
        </Button>
      </div>
    </aside>
  );
}
