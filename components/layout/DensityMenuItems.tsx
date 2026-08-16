"use client";

import { Check, Rows2, Rows3 } from "lucide-react";
import { useHydrated } from "@/hooks/useHydrated";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { useUiPreferencesStore, type TableDensity } from "@/stores/useUiPreferencesStore";

const OPTIONS: { value: TableDensity; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "compact", label: "Compact", icon: Rows3 },
  { value: "comfortable", label: "Comfortable", icon: Rows2 },
];

/**
 * Row-height preference for every table in the app.
 *
 * The value is persisted in localStorage, so the server renders the default
 * and the tick can only be trusted after mount — same reason as the theme
 * menu.
 */
export function DensityMenuItems() {
  const density = useUiPreferencesStore((s) => s.tableDensity);
  const setDensity = useUiPreferencesStore((s) => s.setTableDensity);
  const hydrated = useHydrated();

  return (
    <>
      <DropdownMenuLabel className="font-normal text-muted-foreground">Table density</DropdownMenuLabel>
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <DropdownMenuItem key={value} closeOnClick={false} onClick={() => setDensity(value)}>
          <Icon />
          {label}
          {hydrated && density === value && <Check className="ml-auto size-3.5" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}
