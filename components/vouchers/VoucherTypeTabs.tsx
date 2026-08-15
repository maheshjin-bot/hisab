"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";
import type { VoucherType } from "@/lib/supabase/queries/vouchers";

export function VoucherTypeTabs({ companyId, active }: { companyId: string; active: VoucherType }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b">
      {VOUCHER_TYPE_ORDER.map((type) => {
        const config = VOUCHER_TYPE_CONFIG[type];
        return (
          <Link
            key={type}
            href={`/${companyId}/vouchers/new/${type}`}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              type === active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {config.label}
            <kbd className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {config.shortcutKey.replace("+", " ").toUpperCase()}
            </kbd>
          </Link>
        );
      })}
    </div>
  );
}
