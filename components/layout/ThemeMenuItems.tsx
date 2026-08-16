"use client";

import { useTheme } from "next-themes";
import { useHydrated } from "@/hooks/useHydrated";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

/**
 * Theme choices for the account menu.
 *
 * The resolved theme isn't known on the server, so the tick marking the active
 * option can't be rendered until after mount — drawing it from `theme`
 * directly would put a tick on the wrong row until hydration caught up.
 */
export function ThemeMenuItems() {
  const { theme, setTheme } = useTheme();
  const hydrated = useHydrated();

  return (
    <>
      <DropdownMenuLabel className="font-normal text-muted-foreground">Theme</DropdownMenuLabel>
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <DropdownMenuItem
          key={value}
          // The menu stays open so the change can be seen and reconsidered.
          closeOnClick={false}
          onClick={() => setTheme(value)}
        >
          <Icon />
          {label}
          {hydrated && theme === value && <Check className="ml-auto size-3.5" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}
