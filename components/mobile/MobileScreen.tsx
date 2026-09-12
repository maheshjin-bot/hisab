"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/**
 * A sub-screen off one of the bottom tabs: a back arrow, a title, and the
 * content. The bottom tab bar stays put underneath (MobileShell renders it),
 * so "back" here is the in-page way home and the OS gesture is the other.
 *
 * The header is sticky because these screens scroll — a form on a phone with
 * the keyboard up can push its own title off the top otherwise, and then
 * there is nothing on screen saying what is being filled in.
 */
export function MobileScreen({
  title,
  backHref,
  children,
}: {
  title: string;
  backHref: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-background px-1.5 py-1.5">
        <Link
          href={backHref}
          aria-label="Back"
          className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-muted"
        >
          <ChevronLeft className="size-5" />
        </Link>
        <h1 className="truncate text-[15px] font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="flex-1 p-4">{children}</div>
    </div>
  );
}
