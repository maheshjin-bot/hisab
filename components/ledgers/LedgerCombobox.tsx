"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Plus, TriangleAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useLedgerSearchQuery } from "@/hooks/useLedgersQuery";
import { isRoleAllowed, type VoucherSideRule } from "@/lib/voucher/voucher-type-config";
import { partyTypeForRole } from "@/lib/ledgers/party-type";
import { LedgerFormDialog } from "./LedgerFormDialog";
import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";

export interface LedgerComboboxProps {
  companyId: string;
  value: string;
  displayName?: string;
  onSelect: (ledger: LedgerSearchResult) => void;
  /** Only the three fields this component actually reads — callers outside a voucher form (MergeLedgerDialog) have no `defaultRowCount`/`minRows` to supply. */
  sideRule: Pick<VoucherSideRule, "label" | "allowedRoles" | "filterMode">;
  triggerRef?: (el: HTMLElement | null) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** The "Add new ledger" row at the foot of the list. On by default. */
  allowCreate?: boolean;
  /** Replaces the trigger's own sizing — the phone forms use a taller control. */
  className?: string;
  /** Left out of the results entirely — for pickers where one ledger must not be able to choose itself, e.g. a merge target excluding the ledger being merged away. */
  excludeId?: string;
}

/**
 * The voucher grid's ledger picker. `filterMode:'hard'` excludes
 * non-matching ledgers outright; `'soft'` shows everything but ranks
 * matching-role ledgers first and flags the rest with a warning icon —
 * catches real edge cases a hard block would wrongly forbid.
 *
 * The last row creates a ledger in place — Tally's Alt+C, and on a phone the
 * only way to get a first ledger at all, since a new company seeds groups but
 * no ledgers. The dialog opens on the kind this field expects and with the
 * search text as the name, and the new ledger is selected on save.
 */
export function LedgerCombobox({
  companyId,
  value,
  displayName,
  onSelect,
  sideRule,
  triggerRef,
  onKeyDown,
  autoFocus,
  placeholder,
  allowCreate = true,
  className,
  excludeId,
}: LedgerComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // What the user just picked. Without this the trigger keeps showing its
  // placeholder after a selection, because the form stores only the ledger id
  // and the caller has no name to hand back — so choosing a ledger looked
  // like it had done nothing at all.
  const [picked, setPicked] = useState<LedgerSearchResult | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const { data: searchResults, isFetching } = useLedgerSearchQuery(companyId, query);
  const results = excludeId ? searchResults?.filter((l) => l.id !== excludeId) : searchResults;

  const ranked = [...(results ?? [])].sort((a, b) => {
    if (sideRule.allowedRoles === "any") return 0;
    const aMatch = isRoleAllowed(sideRule, a.ledgerRole) ? 0 : 1;
    const bMatch = isRoleAllowed(sideRule, b.ledgerRole) ? 0 : 1;
    return aMatch - bMatch;
  });

  const visible = sideRule.filterMode === "hard" ? ranked.filter((l) => isRoleAllowed(sideRule, l.ledgerRole)) : ranked;

  function handleSelect(ledger: LedgerSearchResult) {
    setPicked(ledger);
    onSelect(ledger);
    setOpen(false);
    setQuery("");
  }

  function openCreate() {
    setCreateName(query.trim());
    // The popover closes first so the dialog isn't fighting its focus trap.
    setOpen(false);
    setCreateOpen(true);
  }

  // `displayName` is the caller's initial label when editing an existing
  // voucher; a fresh pick supersedes it. If the field is cleared from outside,
  // neither applies and the placeholder returns.
  const label = value ? (picked?.name ?? displayName) : undefined;

  // A multi-role field ("Customer" allows debtor or cash_bank) offers its
  // first, primary role; an "any" field leaves the question open.
  const suggestedType = sideRule.allowedRoles === "any" ? undefined : (partyTypeForRole(sideRule.allowedRoles[0]) ?? undefined);

  return (
    <>
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
              className={cn(
                "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                className
              )}
            />
          }
        >
          <span className={cn("truncate text-left", !label && "text-muted-foreground")}>
            {label || placeholder || "Select ledger…"}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder={`Search ${sideRule.label.toLowerCase()}…`} value={query} onValueChange={setQuery} />
            <CommandList>
              {/* Not CommandEmpty: the "add" row below is itself an item, so
                  the list is never empty as far as cmdk is concerned. */}
              {visible.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {isFetching ? "Searching…" : "No ledgers found."}
                </p>
              )}
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
              {allowCreate && (
                // Pinned to the bottom of the scrolling list rather than
                // flowing after it — with the full ledger list this row used
                // to sit past a couple of screens' worth of results, behind a
                // scrollbar this popover hides, so there was nothing on
                // screen suggesting it was there at all. Sticking it keeps it
                // visible no matter how many ledgers match.
                <div className="sticky bottom-0 bg-popover">
                  {visible.length > 0 && <CommandSeparator />}
                  <CommandGroup>
                    <CommandItem value="__create__" onSelect={openCreate} className="text-primary">
                      <Plus className="size-4" />
                      <span className="flex-1 truncate">{query.trim() ? `Add “${query.trim()}”` : "Add new ledger…"}</span>
                    </CommandItem>
                  </CommandGroup>
                </div>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {allowCreate && (
        <LedgerFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          companyId={companyId}
          initialName={createName}
          initialPartyType={suggestedType}
          onCreated={handleSelect}
        />
      )}
    </>
  );
}
