import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loginUrlReturningTo } from "@/lib/utils/return-path";

// Auth guard only — no visual shell here. /companies renders its own simple
// layout; /[companyId]/... renders the full sidebar shell once membership is
// confirmed. Splitting it this way avoids one shell component branching on
// "do we have an active company yet or not".
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Carry the destination through the sign-in round trip. Without this an
    // invite link dead-ends on the dashboard and the invitee never redeems it.
    const pathname = (await headers()).get("x-pathname");
    redirect(loginUrlReturningTo(pathname));
  }

  return <>{children}</>;
}
