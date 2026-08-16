"use client";

import Link from "next/link";
import { Bell, CalendarClock, MailPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCompanyQuery, usePendingInvitesQuery } from "@/hooks/useCompaniesQuery";

/**
 * Replaces a popover that said "You're all caught up" unconditionally,
 * whether or not anything needed attention. A control that never does
 * anything erodes trust in the ones that do.
 *
 * Everything here is derived from data the app already loads for other
 * screens — there is no notifications table, and inventing one to fill a bell
 * would be the wrong order of work.
 */
export function NotificationsPopover({ companyId }: { companyId: string }) {
  const { data: invites } = usePendingInvitesQuery(companyId);
  const { data: company } = useCompanyQuery(companyId);

  const pendingInvites = invites?.length ?? 0;
  const lockDate = company?.lockDate ?? null;
  const count = pendingInvites > 0 ? 1 : 0;

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" />}>
        <span className="relative">
          <Bell className="size-4" />
          {count > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary"
              aria-hidden
            />
          )}
        </span>
        <span className="sr-only">
          {count > 0 ? `Notifications, ${count} needing attention` : "Notifications"}
        </span>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Notifications</PopoverTitle>
        </PopoverHeader>

        <div className="mt-2 space-y-2 text-sm">
          {pendingInvites > 0 && (
            <Link
              href={`/${companyId}/settings`}
              className="flex items-start gap-2.5 rounded-lg p-2 transition-colors hover:bg-muted"
            >
              <MailPlus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">
                <span className="font-medium">
                  {pendingInvites} invite{pendingInvites === 1 ? "" : "s"} waiting to be accepted
                </span>
                <span className="block text-xs text-muted-foreground">
                  HISAB doesn&apos;t send email — copy each link from Settings and pass it on.
                </span>
              </span>
            </Link>
          )}

          {lockDate && (
            <div className="flex items-start gap-2.5 p-2">
              <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">
                <span className="font-medium">Books locked to {lockDate}</span>
                <span className="block text-xs text-muted-foreground">
                  Accountants can&apos;t post on or before this date.
                </span>
              </span>
              <Badge variant="secondary" className="shrink-0">
                Lock
              </Badge>
            </div>
          )}

          {pendingInvites === 0 && !lockDate && (
            <p className="p-2 text-muted-foreground">
              Nothing needs your attention right now.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
