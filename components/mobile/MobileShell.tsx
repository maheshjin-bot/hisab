"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, BookText, BarChart3, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { MobileFab } from "./MobileFab";

/** The FAB opens exactly these four screens, so showing it there would just point back at itself. */
const FAB_HIDDEN_SEGMENTS = ["receive", "give", "sale", "purchase", "scan"];

interface Tab {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function tabs(companyId: string): Tab[] {
  return [
    { href: `/${companyId}/m`, label: "Home", icon: Home },
    { href: `/${companyId}/m/ledger`, label: "Ledger", icon: BookText },
    { href: `/${companyId}/m/reports`, label: "Reports", icon: BarChart3 },
    { href: `/${companyId}/m/more`, label: "More", icon: MoreHorizontal },
  ];
}

/**
 * The Home tab's href is a prefix of every other mobile route (`/m/receive`,
 * `/m/ledger`, …), so it alone needs an exact match — a startsWith check
 * would light it up everywhere. The other three tabs' own hrefs don't nest
 * inside each other, so a prefix match is exactly what "on this tab or one
 * of its detail pages" means for them.
 */
function isActiveTab(pathname: string | null, href: string, exact: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname?.startsWith(href + "/");
}

/**
 * The mobile chrome: the page, and a bottom tab bar. Rendered instead of
 * AppShell (desktop's sidebar + top bar) for everything under /m — see the
 * branch in app/(app)/[companyId]/layout.tsx.
 *
 * No top bar. Every screen already says what it is, and a phone's first
 * 56 pixels are worth more than a repeated company name — the company is on
 * Home, and switching company lives under More.
 *
 * `data-theme="light" data-mobile-app` is what makes this section white and
 * always light, whatever the phone's dark mode says; both are defined in
 * app/globals.css.
 */
export function MobileShell({ companyId, children }: { companyId: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const homeHref = `/${companyId}/m`;
  const hideFab = FAB_HIDDEN_SEGMENTS.some((seg) => pathname === `${homeHref}/${seg}`);

  return (
    <div data-theme="light" data-mobile-app className="relative flex h-full flex-col bg-background text-foreground">
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>

      {!hideFab && <MobileFab companyId={companyId} />}

      <nav
        data-print-hide
        className="grid shrink-0 grid-cols-4 border-t border-border bg-background"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {tabs(companyId).map((tab) => {
          const active = isActiveTab(pathname, tab.href, tab.href === homeHref);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                // 56px tall: comfortably past the 44px floor, thumb-first.
                "flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] transition-colors",
                active ? "font-medium text-primary" : "text-muted-foreground"
              )}
            >
              <Icon className="size-5" />
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
