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
import { getFinancialYearLabel } from "@/lib/utils/financial-year";

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
          <span className="flex min-w-0 flex-col items-start gap-px">
            <span className="w-full truncate text-left text-sm leading-tight font-medium">
              {active?.name ?? "Select company"}
            </span>
            {active && (
              <span className="text-[11px] leading-tight text-muted-foreground">
                {getFinancialYearLabel(new Date(), active.financialYearStartMonth)}
              </span>
            )}
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
