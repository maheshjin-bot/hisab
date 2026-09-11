import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCompany } from "@/lib/supabase/queries/companies";
import { AppShell } from "@/components/layout/AppShell";
import { MobileShell } from "@/components/mobile/MobileShell";

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

  // A route nested under here can't un-wrap a parent layout's own JSX, so
  // "which chrome" has to be decided here rather than inside AppShell — the
  // mobile section (/m) gets a bottom-tab shell instead of the desktop
  // sidebar. proxy.ts stamps x-pathname on every request (see its comment),
  // which is what a server component needs to read the path at all.
  const pathname = (await headers()).get("x-pathname") ?? "";
  const isMobile = pathname === `/${companyId}/m` || pathname.startsWith(`/${companyId}/m/`);

  if (isMobile) {
    return <MobileShell companyId={companyId}>{children}</MobileShell>;
  }

  return (
    <AppShell companyId={companyId} userEmail={user?.email ?? null}>
      {children}
    </AppShell>
  );
}
