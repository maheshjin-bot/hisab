"use client";

import { use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { useSupabase } from "@/hooks/useSupabase";

export default function MobileMorePage({ params }: PageProps<"/[companyId]/m/more">) {
  const { companyId } = use(params);
  const supabase = useSupabase();
  const router = useRouter();

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  // No theme picker: this section is deliberately always light (see
  // MobileShell), so offering the choice here would be offering something
  // that does nothing.
  const links = [
    { href: `/${companyId}/dashboard`, label: "Full site", hint: "Banking, groups, settings, everything" },
    { href: `/${companyId}/audit`, label: "History", hint: "Who changed what" },
    { href: `/${companyId}/settings`, label: "Settings", hint: "Company details, members, lock date" },
    { href: "/companies", label: "Switch company", hint: "Or set up a new one" },
  ];

  return (
    <div className="p-5">
      <h1 className="text-lg font-semibold tracking-tight">More</h1>

      <ul className="mt-4 divide-y divide-border border-y border-border">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="flex items-center gap-3 py-3.5 transition-colors active:bg-muted">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{l.label}</span>
                <span className="block truncate text-[13px] text-muted-foreground">{l.hint}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={handleSignOut}
        className="mt-6 h-12 w-full rounded-xl border border-border text-[15px] text-muted-foreground transition-colors active:bg-muted"
      >
        Sign out
      </button>
    </div>
  );
}
