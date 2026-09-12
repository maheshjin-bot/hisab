"use client";

import { useMemo, useState } from "react";
import { CalendarRange, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFinancialYear } from "@/hooks/useFinancialYear";
import { useGlobalShortcuts } from "@/lib/keyboard/useGlobalShortcuts";
import { parseIsoLocalDate, showsFinancialYear } from "@/lib/utils/financial-year";
import { cn } from "@/lib/utils";

/** "1 Apr 2025" — short enough to put both ends of a year on one menu row. */
function shortDate(iso: string): string {
  return parseIsoLocalDate(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Which financial year the app is showing, directly under the company name.
 *
 * This sits where the year already appeared, because that is where a user
 * looks for the answer — but the old line was a label computed from today's
 * date, which said "FY 2026-27" over a screen full of `SAL/2025-26/…`
 * vouchers and could not be argued with. Same position, now a control, and it
 * now states the year being *looked at* rather than the year it happens to be.
 *
 * It changes nothing about the books. A voucher's `financial_year_label` is
 * stamped when it is saved; all this drives is the period a report and the
 * dashboard ask for.
 */
export function FinancialYearSelect({
  companyId,
  collapsed = false,
  bindShortcut = false,
}: {
  companyId: string;
  collapsed?: boolean;
  /**
   * Only the desktop rail binds Alt+Y. The mobile drawer renders the same
   * SidebarNav, and a second document-level listener on the same combo would
   * open both copies of the menu at once — including the rail's, which is
   * `display:none` below `lg` but still portals its popup.
   */
  bindShortcut?: boolean;
}) {
  const { companySettingsKnown, usesFinancialYears, years, selected, isCurrent, select } =
    useFinancialYear(companyId);
  const [open, setOpen] = useState(false);
  const showsYear = showsFinancialYear(companySettingsKnown, usesFinancialYears);

  const bindings = useMemo(
    () =>
      bindShortcut && showsYear
        ? [
            {
              keys: "alt+y",
              description: "Change financial year",
              scope: "global" as const,
              handler: () => setOpen((o) => !o),
            },
          ]
        : [],
    [bindShortcut, showsYear]
  );
  useGlobalShortcuts(bindings);

  // A company that keeps one continuous set of books has one period and
  // nothing to switch between, so there is nothing here to render. The
  // decision is made here rather than by the sidebar because the sidebar has
  // only the company id, which is all this needs to answer it — and because
  // there is exactly one place to keep right this way.
  //
  // And nothing is rendered before the company has answered either, which is
  // the other half of the same gate. `usesFinancialYears` defaults to true
  // while the companies query is in flight — correctly, because that is what
  // every company that predates the setting is — so trusting it on its own
  // painted "FY 2026-27" over a bahi-khata for a frame. The default is right
  // and belongs where it is; the render is what has to wait.
  //
  // The hooks above it run on every render on purpose: skipping a hook on
  // some renders and not others is the one thing React will not allow, and
  // the company is not known until the first of them has answered. Alt+Y goes
  // with the menu — `bindings` is empty here — so the shortcut does not sit
  // there doing nothing.
  if (!showsYear) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            title={`${selected.label}${isCurrent ? "" : " (closed year)"} — change financial year (Alt+Y)`}
            aria-label={`Financial year: ${selected.label}. Change financial year.`}
            className={cn(
              "h-7 w-full gap-1.5 px-2 text-[11px] font-normal text-sidebar-foreground/70 hover:text-sidebar-foreground",
              collapsed ? "justify-center px-0" : "justify-start"
            )}
          />
        }
      >
        <CalendarRange className="size-3.5 shrink-0" />
        {!collapsed && (
          <>
            <span className="truncate">{selected.label}</span>
            {/* The one thing a user must not have to work out for themselves:
                whether these figures are still moving. */}
            {!isCurrent && <span className="shrink-0 text-sidebar-foreground/50">· closed</span>}
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {/* The label has to be inside a Group — Base UI's GroupLabel reads a
            context the Group provides, and throws at render without one. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal text-muted-foreground">Financial year</DropdownMenuLabel>
          {years.map((year) => {
            const active = year.startYear === selected.startYear;
            return (
              <DropdownMenuItem key={year.startYear} onClick={() => select(year.startYear)}>
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="font-medium">{year.label}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {shortDate(year.start)} – {shortDate(year.end)}
                  </span>
                </span>
                {active && <Check className="ml-auto size-3.5 shrink-0" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
