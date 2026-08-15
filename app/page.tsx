import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCompaniesForUser } from "@/lib/supabase/queries/companies";

export default async function RootPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const companies = await getCompaniesForUser(supabase);

  if (companies.length === 0) {
    redirect("/companies");
  }

  redirect(`/${companies[0].id}/dashboard`);
}
