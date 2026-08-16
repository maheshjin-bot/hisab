"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarNav } from "./Sidebar";

/**
 * The sidebar as a drawer, for viewports below `lg` where the fixed rail
 * doesn't fit. Renders the same SidebarNav as the desktop rail, so the two
 * can't drift apart.
 */
export function MobileSidebar({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Open navigation" />
        }
      >
        <Menu className="size-4" />
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-72 max-w-[85vw] border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-72"
      >
        {/* Required for the dialog's accessible name; the drawer is visually
            just the nav, so it's not shown. */}
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarNav
          // Remounted per route so the drawer never reopens showing the
          // previous page as active.
          key={pathname}
          companyId={companyId}
          onNavigate={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}
