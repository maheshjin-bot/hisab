"use client";

import { use } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

interface ReportLink {
  href: string;
  label: string;
  hint: string;
}

/**
 * Links out to the existing report pages, which render their tables inside
 * their own horizontal scroller. The narrow ones (who-owes-me, trial
 * balance, ledger statement) read fine on a phone; daybook, P&L and the
 * balance sheet are wider and scroll sideways — a proper stacked layout for
 * those is a follow-up, not a reason to hold the rest back.
 */
function reportLinks(companyId: string): ReportLink[] {
  return [
    { href: `/${companyId}/outstanding`, label: "Who owes me", hint: "Money in and out, party by party" },
    { href: `/${companyId}/reports/daybook`, label: "Daybook", hint: "Every entry, by date" },
    { href: `/${companyId}/reports/trial-balance`, label: "Trial balance", hint: "Every balance, as of a date" },
    { href: `/${companyId}/reports/profit-loss`, label: "Profit & loss", hint: "Income against expenses" },
    { href: `/${companyId}/reports/balance-sheet`, label: "Balance sheet", hint: "What you own and owe" },
  ];
}

export default function MobileReportsPage({ params }: PageProps<"/[companyId]/m/reports">) {
  const { companyId } = use(params);

  return (
    <div className="p-5">
      <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
      <ul className="mt-4 divide-y divide-border border-y border-border">
        {reportLinks(companyId).map((r) => (
          <li key={r.href}>
            <Link href={r.href} className="flex items-center gap-3 py-3.5 transition-colors active:bg-muted">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{r.label}</span>
                <span className="block truncate text-[13px] text-muted-foreground">{r.hint}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
