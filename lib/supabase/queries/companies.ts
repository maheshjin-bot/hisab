import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export type CompanyRole = "admin" | "accountant" | "auditor";

export interface Company {
  id: string;
  name: string;
  financialYearStartMonth: number;
  /**
   * False for a company that keeps one continuous set of books and one
   * numbering series that never restarts. Fixed at creation: the database
   * refuses to change it once a voucher exists, so nothing in the app offers
   * to. `financialYearStartMonth` still holds its default for such a company
   * and means nothing — nothing reads it.
   */
  usesFinancialYears: boolean;
  baseCurrency: string;
  bookBeginningDate: string;
  lockDate: string | null;
  isActive: boolean;
  /**
   * The letterhead. Nullable, because the companies that existed before
   * invoicing have none of it and must keep saving without it — an invoice
   * simply prints a thinner masthead until someone fills them in.
   */
  address: string | null;
  phone: string | null;
  email: string | null;
}

export interface CompanyMembership extends Company {
  role: CompanyRole;
}

function mapCompany(row: Database["public"]["Tables"]["companies"]["Row"]): Company {
  return {
    id: row.id,
    name: row.name,
    financialYearStartMonth: row.financial_year_start_month,
    usesFinancialYears: row.uses_financial_years,
    baseCurrency: row.base_currency,
    bookBeginningDate: row.book_beginning_date,
    lockDate: row.lock_date,
    isActive: row.is_active,
    address: row.address,
    phone: row.phone,
    email: row.email,
  };
}

/** Every company the current user is an active member of, with their role in each. */
export async function getCompaniesForUser(supabase: SupabaseClient<Database>): Promise<CompanyMembership[]> {
  const { data, error } = await supabase
    .from("company_members")
    .select("role, companies(*)")
    .eq("status", "active");

  if (error) throw error;

  return (data ?? [])
    .filter((row): row is typeof row & { companies: Database["public"]["Tables"]["companies"]["Row"] } => !!row.companies)
    .map((row) => ({ ...mapCompany(row.companies), role: row.role as CompanyRole }));
}

export async function getCompany(supabase: SupabaseClient<Database>, companyId: string): Promise<Company> {
  const { data, error } = await supabase.from("companies").select("*").eq("id", companyId).single();
  if (error) throw error;
  return mapCompany(data);
}

export interface CreateCompanyInput {
  name: string;
  bookBeginningDate: string;
  financialYearStartMonth?: number;
  baseCurrency?: string;
  /**
   * Defaults to true, matching the RPC, so a caller that says nothing creates
   * the company it always did.
   */
  usesFinancialYears?: boolean;
}

/** Creates a company, makes the caller its admin, and seeds the chart of accounts — all atomically in the RPC. */
export async function createCompany(supabase: SupabaseClient<Database>, input: CreateCompanyInput): Promise<string> {
  const { data, error } = await supabase.rpc("create_company", {
    p_name: input.name,
    p_book_beginning_date: input.bookBeginningDate,
    p_financial_year_start_month: input.financialYearStartMonth ?? 4,
    p_base_currency: input.baseCurrency ?? "INR",
    p_uses_financial_years: input.usesFinancialYears ?? true,
  });
  if (error) throw error;
  return data as string;
}

/**
 * The address block a printed invoice puts at the top.
 *
 * A blank field is stored as NULL rather than "", so the invoice masthead can
 * omit the line entirely instead of printing an empty one — and because
 * companies_email_check rejects "" outright.
 */
export interface CompanyDetailsInput {
  address: string | null;
  phone: string | null;
  email: string | null;
}

export async function updateCompanyDetails(
  supabase: SupabaseClient<Database>,
  companyId: string,
  input: CompanyDetailsInput
): Promise<void> {
  const blankToNull = (v: string | null) => (v && v.trim() ? v.trim() : null);
  const { error } = await supabase
    .from("companies")
    .update({
      address: blankToNull(input.address),
      phone: blankToNull(input.phone),
      email: blankToNull(input.email),
    })
    .eq("id", companyId);
  if (error) throw error;
}

export async function updateCompanyLockDate(
  supabase: SupabaseClient<Database>,
  companyId: string,
  lockDate: string | null
): Promise<void> {
  const { error } = await supabase.from("companies").update({ lock_date: lockDate }).eq("id", companyId);
  if (error) throw error;
}

export interface CompanyMemberRow {
  id: string;
  userId: string;
  role: CompanyRole;
  status: "active" | "revoked";
  fullName: string | null;
}

export async function listCompanyMembers(supabase: SupabaseClient<Database>, companyId: string): Promise<CompanyMemberRow[]> {
  const { data: members, error } = await supabase
    .from("company_members")
    .select("id, user_id, role, status")
    .eq("company_id", companyId)
    .order("created_at");
  if (error) throw error;
  if (!members?.length) return [];

  // company_members and profiles both reference auth.users independently —
  // no direct FK between them for PostgREST to embed-join on — so names are
  // fetched as a second pass and merged client-side instead.
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", members.map((m) => m.user_id));
  if (profilesError) throw profilesError;

  const nameByUserId = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  return members.map((r) => ({
    id: r.id,
    userId: r.user_id,
    role: r.role as CompanyRole,
    status: r.status as "active" | "revoked",
    fullName: nameByUserId.get(r.user_id) ?? null,
  }));
}

export async function inviteCompanyMember(
  supabase: SupabaseClient<Database>,
  companyId: string,
  email: string,
  role: CompanyRole
): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be signed in to invite a member");

  const { error } = await supabase
    .from("company_invites")
    .insert({ company_id: companyId, email, role, invited_by: user.id });
  if (error) throw error;
}

export async function acceptCompanyInvite(supabase: SupabaseClient<Database>, token: string): Promise<string> {
  const { data, error } = await supabase.rpc("accept_company_invite", { p_token: token });
  if (error) throw error;
  return data as string;
}

export async function updateMemberRole(supabase: SupabaseClient<Database>, memberId: string, role: CompanyRole): Promise<void> {
  const { error } = await supabase.from("company_members").update({ role }).eq("id", memberId);
  if (error) throw error;
}

/** Membership rows have no delete-by-self path in the UI — this is the admin "remove member" action; the DB refuses to remove the last active admin regardless. */
export async function revokeMember(supabase: SupabaseClient<Database>, memberId: string): Promise<void> {
  const { error } = await supabase.from("company_members").update({ status: "revoked" }).eq("id", memberId);
  if (error) throw error;
}

export interface CompanyInviteRow {
  id: string;
  email: string;
  role: CompanyRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  /** Needed to build the shareable /invite/<token> link. Only admins can read
   *  it — company_invites_select gates non-admins to their own invites. */
  token: string;
}

export async function listPendingInvites(supabase: SupabaseClient<Database>, companyId: string): Promise<CompanyInviteRow[]> {
  const { data, error } = await supabase
    .from("company_invites")
    .select("id, email, role, status, expires_at, token")
    .eq("company_id", companyId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role as CompanyRole,
    status: r.status as CompanyInviteRow["status"],
    expiresAt: r.expires_at,
    token: r.token,
  }));
}

export async function revokeInvite(supabase: SupabaseClient<Database>, inviteId: string): Promise<void> {
  const { error } = await supabase.from("company_invites").update({ status: "revoked" }).eq("id", inviteId);
  if (error) throw error;
}
