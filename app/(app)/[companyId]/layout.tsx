import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCompany } from "@/lib/supabase/queries/companies";
import { AppShell } from "@/components/layout/AppShell";

export default async function CompanyLayout({
  children,
  params,
}: LayoutProps<"/[companyId]">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // RLS is the real enforcement here — this try/catch is just a friendlier
  // redirect than an empty/broken page when someone isn't (or is no longer)
  // a member of this company.
  try {
    await getCompany(supabase, companyId);
  } catch {
    redirect("/companies");
  }

  return (
    <AppShell companyId={companyId} userEmail={user?.email ?? null}>
      {children}
    </AppShell>
  );
}
