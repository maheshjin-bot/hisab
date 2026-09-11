"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Camera, Plus, Receipt, ShoppingBag } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface QuickAction {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "in" | "out" | "neutral";
}

function actions(companyId: string): QuickAction[] {
  return [
    { href: `/${companyId}/m/receive`, label: "Money In", icon: ArrowDownLeft, tone: "in" },
    { href: `/${companyId}/m/give`, label: "Money Out", icon: ArrowUpRight, tone: "out" },
    { href: `/${companyId}/m/sale`, label: "Sale Bill", icon: Receipt, tone: "neutral" },
    { href: `/${companyId}/m/purchase`, label: "Purchase Bill", icon: ShoppingBag, tone: "neutral" },
    { href: `/${companyId}/m/scan`, label: "Scan Bill", icon: Camera, tone: "neutral" },
  ];
}

const TONE_CLASS: Record<QuickAction["tone"], string> = {
  in: "bg-success/10 text-success",
  out: "bg-destructive/10 text-destructive",
  neutral: "bg-primary/10 text-primary",
};

/**
 * The one action reachable from every /m screen — Reports and Ledger
 * included — except the four entry forms it itself opens, where it would
 * just be a shortcut back to the screen already on-screen (MobileShell
 * decides that, not this component).
 *
 * A floating button rather than a fifth tab: a tab is "go here and stay", this
 * is "do this and come back", and folding it into the bar would make every
 * real tab narrower for an action that isn't one.
 */
export function MobileFab({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="New entry"
        className="absolute right-4 bottom-[76px] z-10 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 transition-transform active:scale-95"
      >
        <Plus className="size-6" />
      </button>

      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-0 rounded-t-2xl border-0 p-0 pb-[calc(env(safe-area-inset-bottom)+10px)]"
      >
        <SheetHeader className="px-4 pt-3.5 pb-1">
          <SheetTitle className="text-[15px]">New entry</SheetTitle>
        </SheetHeader>
        <div className="px-2.5 pb-1.5">
          {actions(companyId).map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.href}
                href={action.href}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-xl px-2.5 py-3 transition-colors active:bg-muted"
              >
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", TONE_CLASS[action.tone])}>
                  <Icon className="size-4.5" />
                </span>
                <span className="text-[15px] font-medium">{action.label}</span>
              </Link>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
