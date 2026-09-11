"use client";

import { cn } from "@/lib/utils";

/**
 * One labelled control on a phone form: a small quiet label over a 48px-tall
 * control, and its error underneath in words.
 *
 * The desktop's Field/FieldLabel pair is built for a dense two- or
 * three-column grid; these screens are one column and want more air and a
 * bigger tap target, so they get their own rather than fighting the other
 * with overrides at every call site.
 */
export function MobileField({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** The shared look of a phone-sized control: 48px, hairline border, white. */
export const MOBILE_CONTROL =
  "h-12 w-full rounded-xl border border-input bg-background px-3.5 text-[15px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40";
