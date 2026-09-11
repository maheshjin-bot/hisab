"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { LedgerFormDialog } from "@/components/ledgers/LedgerFormDialog";
import { MOBILE_CONTROL } from "@/components/mobile/MobileField";
import { cn } from "@/lib/utils";
import { useLedgerBalancesQuery, useLedgerGroupsQuery, useLedgersQuery } from "@/hooks/useLedgersQuery";
import { balancePhrase } from "@/lib/ledgers/balance-phrase";
import { formatCurrency } from "@/lib/utils/currency";
import type { LedgerRole } from "@/lib/supabase/queries/ledgers";

/**
 * Every ledger with its balance, searchable — "how much does Sharma owe me"
 * answered without opening a report. Tapping through goes to the statement.
 *
 * The balances query sweeps the whole company, which the desktop list
 * deliberately avoids paying for on every page view; here it is the point
 * of the screen, so it's on.
 */
export default function MobileLedgerPage({ params }: PageProps<"/[companyId]/m/ledger">) {
  const { companyId } = use(params);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useLedgersQuery(companyId, {
    q: search || undefined,
    page: 0,
    pageSize: 100,
    sortBy: "name",
    sortDir: "asc",
  });
  const { data: balances } = useLedgerBalancesQuery(companyId);
  // A ledger row carries its group's name but not its role, and the role is
  // what decides whether "they owe" is a true sentence about this balance.
  const { data: groups } = useLedgerGroupsQuery(companyId);
  const roleByGroup = useMemo(
    () => new Map((groups ?? []).map((g) => [g.id, g.ledgerRole])),
    [groups]
  );

  return (
    <div className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Ledger</h1>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-opacity active:opacity-80"
        >
          <Plus className="size-4" />
          Add
        </button>
      </div>
      <LedgerFormDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} />

      <div className="relative mt-4">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          placeholder="Search parties & accounts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          className={cn(MOBILE_CONTROL, "pl-10")}
        />
      </div>

      {isLoading ? (
        <Skeleton className="mt-4 h-64 w-full" />
      ) : !data?.rows.length ? (
        <p className="mt-8 text-center text-[13px] text-muted-foreground">
          {search ? "Nothing matches that." : "No ledgers yet. Tap Add to create your cash, bank, customers and suppliers."}
        </p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-border border-y border-border">
            {data.rows.map((ledger) => {
              const balance = balances?.get(ledger.id);
              const role: LedgerRole = roleByGroup.get(ledger.groupId) ?? "other";
              const phrase = balance === undefined ? null : balancePhrase(balance, role);
              return (
                <li key={ledger.id}>
                  <Link
                    href={`/${companyId}/m/ledger/${ledger.id}`}
                    className="flex items-center gap-3 py-3.5 transition-colors active:bg-muted"
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-[15px]",
                          !ledger.isActive && "text-muted-foreground line-through"
                        )}
                      >
                        {ledger.name}
                      </span>
                      <span className="block truncate text-[13px] text-muted-foreground">{ledger.groupName}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      {!phrase ? (
                        <Skeleton className="h-4 w-20" />
                      ) : phrase.amount === 0 ? (
                        <span className="text-[15px] text-muted-foreground tabular-nums">—</span>
                      ) : (
                        <>
                          <span
                            className={cn(
                              "block text-[15px] tabular-nums",
                              phrase.isLiability && "text-destructive"
                            )}
                          >
                            {formatCurrency(phrase.amount)}
                          </span>
                          {phrase.caption && (
                            <span className="block text-[11px] text-muted-foreground">{phrase.caption}</span>
                          )}
                        </>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {data.total > data.rows.length && (
            <p className="py-3 text-center text-[13px] text-muted-foreground">
              Showing {data.rows.length} of {data.total} — search to narrow it down.
            </p>
          )}
        </>
      )}
    </div>
  );
}
