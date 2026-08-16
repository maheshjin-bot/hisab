"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";

/** A true segmented control (Tally/Vyapar F4-F9 muscle memory, Stripe-grade chrome) — not underline tabs. */
export function VoucherTypeTabs({ companyId, active }: { companyId: string; active: VoucherType }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl bg-muted p-1">
      {VOUCHER_TYPE_ORDER.map((type) => {
        const config = VOUCHER_TYPE_CONFIG[type];
        const isActive = type === active;
        return (
          <Link
            key={type}
            href={`/${companyId}/vouchers/new/${type}`}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all",
              isActive ? "bg-card text-foreground shadow-sm ring-1 ring-foreground/10" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {config.label}
            <kbd
              className={cn(
                "rounded px-1 py-0.5 font-mono text-[10px]",
                isActive ? "bg-muted text-muted-foreground" : "text-muted-foreground/50"
              )}
            >
              {config.shortcutKey.replace("alt+", "⌥")}
            </kbd>
          </Link>
        );
      })}
    </div>
  );
}
