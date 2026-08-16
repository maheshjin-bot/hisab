"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BookText,
  Receipt,
  CalendarDays,
  BookOpenText,
  Scale,
  TrendingUp,
  Landmark,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CompanySwitcher } from "./CompanySwitcher";
import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function navItems(companyId: string): NavItem[] {
  return [
    { href: `/${companyId}/dashboard`, label: "Dashboard", icon: LayoutDashboard },
    { href: `/${companyId}/ledgers`, label: "Parties & Ledgers", icon: BookText },
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

function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const active = isActiveHref(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-2.5 rounded-r-md rounded-l-sm border-l-2 px-2.5 py-1.5 text-sm transition-colors",
        active
          ? "border-primary bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "border-transparent text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 pb-1 text-xs font-medium text-sidebar-foreground/45">{children}</p>;
}

export function Sidebar({ companyId }: { companyId: string }) {
  const pathname = usePathname();

  return (
    <aside data-print-hide className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="p-3">
        <CompanySwitcher activeCompanyId={companyId} />
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-3">
        <div className="space-y-0.5">
          {navItems(companyId).map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </div>

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

        <div>
          <SectionLabel>Reports</SectionLabel>
          <div className="space-y-0.5">
            {reportItems(companyId).map((item) => (
              <NavLink key={item.href} item={item} />
            ))}
          </div>
        </div>
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <NavLink item={{ href: `/${companyId}/settings`, label: "Settings", icon: Settings }} />
      </div>
    </aside>
  );
}
