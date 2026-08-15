"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BookText,
  Receipt,
  FileBarChart,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CompanySwitcher } from "./CompanySwitcher";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function navItems(companyId: string): NavItem[] {
  return [
    { href: `/${companyId}/dashboard`, label: "Dashboard", icon: LayoutDashboard },
    { href: `/${companyId}/ledgers`, label: "Ledgers", icon: BookText },
    { href: `/${companyId}/vouchers`, label: "Vouchers", icon: Receipt },
  ];
}

function reportItems(companyId: string): NavItem[] {
  return [
    { href: `/${companyId}/reports/daybook`, label: "Daybook", icon: FileBarChart },
    { href: `/${companyId}/reports/ledger-statement`, label: "Ledger Statement", icon: FileBarChart },
    { href: `/${companyId}/reports/trial-balance`, label: "Trial Balance", icon: FileBarChart },
    { href: `/${companyId}/reports/profit-loss`, label: "Trading & P&L", icon: FileBarChart },
    { href: `/${companyId}/reports/balance-sheet`, label: "Balance Sheet", icon: FileBarChart },
  ];
}

function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const active = pathname === item.href || pathname?.startsWith(item.href + "/");
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function Sidebar({ companyId }: { companyId: string }) {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="p-3">
        <CompanySwitcher activeCompanyId={companyId} />
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-3">
        <div className="space-y-0.5">
          {navItems(companyId).map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </div>

        <div>
          <p className="px-2.5 pb-1 text-xs font-medium text-sidebar-foreground/50">Reports</p>
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
