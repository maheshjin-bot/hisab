"use client";

import { use, useMemo } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Receipt, ShoppingBag } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCompanyQuery } from "@/hooks/useCompaniesQuery";
import { useLedgerBalancesQuery, useLedgerGroupsQuery, useLedgersQuery } from "@/hooks/useLedgersQuery";
import { useVouchersQuery } from "@/hooks/useVouchersQuery";
import { formatCurrency } from "@/lib/utils/currency";
import { VOUCHER_TYPE_CONFIG } from "@/lib/voucher/voucher-type-config";

interface Tile {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** The emerald/rose vocabulary the whole app uses for money in and out. */
  tone: "in" | "out" | "neutral";
}

function tiles(companyId: string): Tile[] {
  return [
    { href: `/${companyId}/m/receive`, label: "Money In", icon: ArrowDownLeft, tone: "in" },
    { href: `/${companyId}/m/give`, label: "Money Out", icon: ArrowUpRight, tone: "out" },
    { href: `/${companyId}/m/sale`, label: "Sale Bill", icon: Receipt, tone: "neutral" },
    { href: `/${companyId}/m/purchase`, label: "Purchase Bill", icon: ShoppingBag, tone: "neutral" },
  ];
}

const TONE_CLASS: Record<Tile["tone"], string> = {
  in: "bg-success/10 text-success",
  out: "bg-destructive/10 text-destructive",
  neutral: "bg-primary/10 text-primary",
};

const AMOUNT_CLASS: Record<Tile["tone"], string> = {
  in: "text-success",
  out: "text-destructive",
  neutral: "text-foreground",
};

const FLOW_ICON: Record<Tile["tone"], React.ComponentType<{ className?: string }>> = {
  in: ArrowDownLeft,
  out: ArrowUpRight,
  neutral: ArrowLeftRight,
};

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Every cash-in-hand and bank ledger with its life-to-date balance.
 *
 * Built from three reads that already exist rather than a new RPC: the
 * ledger list carries a group id but no role, the group list carries the
 * role, and the balances map is keyed by ledger id. A small business has a
 * handful of these, so an unfiltered page of 200 ledgers is one cheap call.
 */
function useCashAndBank(companyId: string) {
  const { data: groups } = useLedgerGroupsQuery(companyId);
  const { data: ledgers } = useLedgersQuery(companyId, { page: 0, pageSize: 200, sortBy: "name", sortDir: "asc" });
  const { data: balances } = useLedgerBalancesQuery(companyId);

  const rows = useMemo(() => {
    if (!groups || !ledgers || !balances) return undefined;
    const cashBankGroupIds = new Set(groups.filter((g) => g.ledgerRole === "cash_bank").map((g) => g.id));
    return ledgers.rows
      .filter((l) => l.isActive && cashBankGroupIds.has(l.groupId))
      .map((l) => ({ id: l.id, name: l.name, balance: balances.get(l.id) ?? 0 }));
  }, [groups, ledgers, balances]);

  return { rows, isLoading: rows === undefined };
}

export default function MobileHomePage({ params }: PageProps<"/[companyId]/m">) {
  const { companyId } = use(params);
  const { data: company } = useCompanyQuery(companyId);
  const { rows, isLoading } = useCashAndBank(companyId);
  const total = rows?.reduce((sum, r) => sum + r.balance, 0) ?? 0;

  const today = isoToday();
  const { data: todayVouchers, isLoading: loadingToday } = useVouchersQuery(companyId, {
    fromDate: today,
    toDate: today,
    page: 0,
    pageSize: 20,
  });

  return (
    <div className="space-y-7 p-5">
      <section>
        <p className="text-[13px] text-muted-foreground">{company?.name ?? " "}</p>
        <p className="mt-3 text-[13px] text-muted-foreground">Cash &amp; bank</p>
        {isLoading ? (
          <Skeleton className="mt-1 h-9 w-44" />
        ) : (
          // A cash or bank ledger normally sits in debit; a negative here is
          // an overdraft, which is worth the rose.
          <p className={cn("text-[32px] leading-tight font-semibold tabular-nums", total < 0 && "text-destructive")}>
            {formatCurrency(total)}
          </p>
        )}

        {/* The old full-width list moved here as a scrolling row of chips —
            still one tap from a ledger's statement, but it no longer pushes
            Today and Quick actions below the fold once there's more than one
            or two accounts. */}
        {rows && rows.length > 0 && (
          <div className="mt-3 -mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
            {rows.map((r) => (
              <Link
                key={r.id}
                href={`/${companyId}/m/ledger/${r.id}`}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12.5px] transition-colors active:bg-muted"
              >
                <span className="max-w-[8rem] truncate font-medium">{r.name}</span>
                <span className={cn("tabular-nums text-muted-foreground", r.balance < 0 && "text-destructive")}>
                  {formatCurrency(r.balance, { decimals: false })}
                </span>
              </Link>
            ))}
          </div>
        )}
        {rows && rows.length === 0 && (
          <p className="mt-2 text-[13px] text-muted-foreground">
            No cash or bank account yet — add one from the Ledger tab.
          </p>
        )}
      </section>

      <section>
        <p className="text-[13px] font-medium text-muted-foreground">Today</p>
        {loadingToday ? (
          <Skeleton className="mt-2 h-16 w-full rounded-2xl" />
        ) : todayVouchers && todayVouchers.rows.length > 0 ? (
          <div className="mt-2 space-y-2">
            {todayVouchers.rows.slice(0, 5).map((v) => {
              const config = VOUCHER_TYPE_CONFIG[v.voucherType];
              const Icon = FLOW_ICON[config.flow];
              return (
                <Link
                  key={v.id}
                  href={`/${companyId}/vouchers/${v.id}/edit`}
                  className="flex items-center gap-3 rounded-2xl border border-border p-3 transition-colors active:bg-muted"
                >
                  <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", TONE_CLASS[config.flow])}>
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{v.narration || config.label}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {config.label} · {v.voucherNumber}
                    </span>
                  </span>
                  <span className={cn("shrink-0 text-[14px] font-medium tabular-nums", AMOUNT_CLASS[config.flow])}>
                    {formatCurrency(v.totalAmount)}
                  </span>
                </Link>
              );
            })}
          </div>
        ) : (
          // Honest, not encouraging — this is proof-of-save, not a nudge.
          <p className="mt-2 text-[13px] text-muted-foreground">Nothing logged yet today.</p>
        )}
      </section>

      <section>
        <p className="mb-3 text-[13px] font-medium text-muted-foreground">Quick actions</p>
        <div className="grid grid-cols-2 gap-3">
          {tiles(companyId).map((tile) => {
            const Icon = tile.icon;
            return (
              <Link
                key={tile.href}
                href={tile.href}
                className="flex flex-col gap-4 rounded-2xl border border-border p-4 transition-colors active:bg-muted"
              >
                <span className={cn("flex size-10 items-center justify-center rounded-full", TONE_CLASS[tile.tone])}>
                  <Icon className="size-5" />
                </span>
                <span className="text-[15px] font-medium">{tile.label}</span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
