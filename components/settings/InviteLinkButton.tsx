"use client";

import { useState } from "react";
import { Check, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Nothing in HISAB sends email yet, so a pending invite is unreachable unless
 * the admin can hand the link over themselves. This is that link.
 *
 * The origin is read at click time rather than at render: it isn't known
 * during SSR, and baking it into markup would mean a hydration mismatch.
 */
export function InviteLinkButton({ token, email }: { token: string; email: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/invite/${token}`;

    try {
      // Undefined on http:// origins other than localhost — a real case for
      // anyone running this on a LAN address during setup.
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Invite link copied", { description: `Send it to ${email}.` });
    } catch {
      toast.error("Couldn't copy automatically", { description: url, duration: 15000 });
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={copy}
      className="text-muted-foreground"
      title={`Copy invite link for ${email}`}
      aria-label={`Copy invite link for ${email}`}
    >
      {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
    </Button>
  );
}
