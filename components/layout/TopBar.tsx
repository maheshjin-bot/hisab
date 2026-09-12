"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, LogOut, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSupabase } from "@/hooks/useSupabase";
import { useCommandPaletteStore } from "@/stores/useCommandPaletteStore";
import { ThemeMenuItems } from "./ThemeMenuItems";
import { MobileSidebar } from "./MobileSidebar";
import { DensityMenuItems } from "./DensityMenuItems";
import { NotificationsPopover } from "./NotificationsPopover";
import { VOUCHER_TYPE_CONFIG, VOUCHER_TYPE_ORDER } from "@/lib/voucher/voucher-type-config";

export function TopBar({ companyId, userEmail }: { companyId: string; userEmail: string | null }) {
  const supabase = useSupabase();
  const router = useRouter();
  const setPaletteOpen = useCommandPaletteStore((s) => s.setOpen);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const initial = (userEmail ?? "?").charAt(0).toUpperCase();

  return (
    <header data-print-hide className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur-sm">
      <MobileSidebar companyId={companyId} />

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="flex h-8 w-full max-w-72 items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-foreground"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">Search ledgers, vouchers…</span>
        <kbd className="hidden shrink-0 items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="sm" className="shadow-sm transition-shadow hover:shadow-md hover:shadow-primary/30" />}
          >
            <Plus data-icon="inline-start" />
            New Voucher
            <ChevronDown className="size-3.5 opacity-70" data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {VOUCHER_TYPE_ORDER.map((type) => {
              const config = VOUCHER_TYPE_CONFIG[type];
              return (
                <DropdownMenuItem key={type} render={<Link href={`/${companyId}/vouchers/new/${type}`} />}>
                  {config.label}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {config.shortcutKey.replace("+", " ").toUpperCase()}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <NotificationsPopover companyId={companyId} />

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="rounded-full" />}>
            <Avatar size="sm">
              <AvatarFallback className="bg-accent text-accent-foreground">{initial}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {userEmail && (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{userEmail}</DropdownMenuLabel>
              </DropdownMenuGroup>
            )}
            <DropdownMenuSeparator />
            <ThemeMenuItems />
            <DropdownMenuSeparator />
            <DensityMenuItems />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
