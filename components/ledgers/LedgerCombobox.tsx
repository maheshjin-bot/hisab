"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, TriangleAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useLedgerSearchQuery } from "@/hooks/useLedgersQuery";
import { isRoleAllowed, type VoucherSideRule } from "@/lib/voucher/voucher-type-config";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";

export interface LedgerComboboxProps {
  companyId: string;
  value: string;
  displayName?: string;
  onSelect: (ledger: LedgerSearchResult) => void;
  sideRule: VoucherSideRule;
  triggerRef?: (el: HTMLElement | null) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  autoFocus?: boolean;
  placeholder?: string;
}

/**
 * The voucher grid's ledger picker. `filterMode:'hard'` excludes
 * non-matching ledgers outright; `'soft'` shows everything but ranks
 * matching-role ledgers first and flags the rest with a warning icon —
 * catches real edge cases a hard block would wrongly forbid.
 */
export function LedgerCombobox({ companyId, value, displayName, onSelect, sideRule, triggerRef, onKeyDown, autoFocus, placeholder }: LedgerComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: results, isFetching } = useLedgerSearchQuery(companyId, query);

  const ranked = [...(results ?? [])].sort((a, b) => {
    if (sideRule.allowedRoles === "any") return 0;
    const aMatch = isRoleAllowed(sideRule, a.ledgerRole) ? 0 : 1;
    const bMatch = isRoleAllowed(sideRule, b.ledgerRole) ? 0 : 1;
    return aMatch - bMatch;
  });

  const visible = sideRule.filterMode === "hard" ? ranked.filter((l) => isRoleAllowed(sideRule, l.ledgerRole)) : ranked;

  function handleSelect(ledger: LedgerSearchResult) {
    onSelect(ledger);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            ref={triggerRef}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpen(true);
                return;
              }
              onKeyDown?.(e);
            }}
            autoFocus={autoFocus}
            className="flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <span className={cn("truncate text-left", !displayName && "text-muted-foreground")}>
          {displayName || placeholder || "Select ledger…"}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder={`Search ${sideRule.label.toLowerCase()}…`} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{isFetching ? "Searching…" : "No ledgers found."}</CommandEmpty>
            <CommandGroup>
              {visible.map((ledger) => {
                const flagged = sideRule.filterMode === "soft" && !isRoleAllowed(sideRule, ledger.ledgerRole);
                return (
                  <CommandItem key={ledger.id} value={ledger.id} onSelect={() => handleSelect(ledger)}>
                    <Check className={cn("size-4", ledger.id === value ? "opacity-100" : "opacity-0")} />
                    <span className="flex-1 truncate">{ledger.name}</span>
                    <span className="text-xs text-muted-foreground">{ledger.groupName}</span>
                    {flagged && <TriangleAlert className="size-3.5 text-warning" />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
