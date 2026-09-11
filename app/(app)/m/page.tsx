import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCompaniesForUser } from "@/lib/supabase/queries/companies";

/**
 * The mobile section's company-agnostic entry point — what the mobilehisab…
 * short link, a home-screen PWA icon, or any bookmark without a company id
 * baked in lands on. The exact mobile analogue of the root `/` page, which
 * does the same thing for desktop: auth is already guaranteed by the (app)
 * layout above this (it redirects to /login, preserving ?next=/m, before
 * this ever renders), so all that's left is picking a company.
 *
 * Static "m" and the dynamic "[companyId]" segment coexist fine at the same
 * level — a request for exactly "/m" only ever matches this file, never
 * "[companyId]" trying to capture the literal string "m".
 */
export default async function MobileEntryPage() {
  const supabase = await createClient();
  const companies = await getCompaniesForUser(supabase);

  if (companies.length === 0) {
    redirect("/companies");
  }

  redirect(`/${companies[0].id}/m`);
}
