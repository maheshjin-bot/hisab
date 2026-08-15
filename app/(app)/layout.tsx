import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
    redirect("/login");
  }

  return <>{children}</>;
}
