"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { useCompaniesQuery } from "@/hooks/useCompaniesQuery";
import { useCompanyStore } from "@/stores/useCompanyStore";
import { cn } from "@/lib/utils";

/**
 * The company being worked on.
 *
 * The financial year used to be rendered here as a second line under the
 * name, computed from `new Date()`. It was wrong whenever the books on screen
 * weren't this year's, and there was no way to argue with it. It now lives
 * one row below as FinancialYearSelect — same place on the screen, but a
 * control that says which year is being *looked at*.
 */
export function CompanySwitcher({ activeCompanyId }: { activeCompanyId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: companies } = useCompaniesQuery();
  const setRecentCompanyId = useCompanyStore((s) => s.setRecentCompanyId);

  const active = companies?.find((c) => c.id === activeCompanyId);

  function select(companyId: string) {
    setRecentCompanyId(companyId);
    setOpen(false);
    router.push(`/${companyId}/dashboard`);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="h-auto w-full justify-between gap-2 px-2 py-2"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold text-primary">
            {active ? active.name.charAt(0).toUpperCase() : <Building2 className="size-4" />}
          </span>
          <span className="min-w-0 truncate text-left text-sm leading-tight font-medium">
            {active?.name ?? "Select company"}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search companies…" />
          <CommandList>
            <CommandEmpty>No companies found.</CommandEmpty>
            <CommandGroup>
              {companies?.map((company) => (
                <CommandItem key={company.id} value={company.name} onSelect={() => select(company.id)}>
                  <Check className={cn("size-4", company.id === activeCompanyId ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{company.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  router.push("/companies");
                }}
              >
                <Plus className="size-4" />
                Manage companies
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
