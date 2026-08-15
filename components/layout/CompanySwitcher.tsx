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
            className="w-full justify-between px-2.5"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <Building2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{active?.name ?? "Select company"}</span>
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
