"use client";

import { use, useState } from "react";
import { toast } from "sonner";
import { UserPlus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { InviteLinkButton } from "@/components/settings/InviteLinkButton";
import { BackupRestoreSection } from "@/components/settings/BackupRestoreSection";
import {
  useCompaniesQuery,
  useCompanyMembersQuery,
  useCompanyQuery,
  useInviteMemberMutation,
  usePendingInvitesQuery,
  useRevokeInviteMutation,
  useRevokeMemberMutation,
  useUpdateCompanyDetailsMutation,
  useUpdateLockDateMutation,
  useUpdateMemberRoleMutation,
} from "@/hooks/useCompaniesQuery";
import type { Company, CompanyRole } from "@/lib/supabase/queries/companies";
import { toUserMessage } from "@/lib/errors";

const ROLE_LABEL: Record<CompanyRole, string> = { admin: "Admin", accountant: "Accountant", auditor: "Auditor" };

/**
 * What goes at the top of a printed invoice.
 *
 * Kept out of the read-only Company block above because these three are the
 * only company fields a user is meant to change, and because they are useless
 * until someone does: a company created before invoicing existed prints an
 * invoice with a name and nothing else. Remounted on company change (the key
 * at the call site) so switching companies reseeds the inputs rather than
 * carrying the previous one's address across.
 */
function LetterheadSection({
  companyId,
  company,
  disabled,
}: {
  companyId: string;
  company: Company;
  disabled: boolean;
}) {
  const updateDetails = useUpdateCompanyDetailsMutation(companyId);
  const [address, setAddress] = useState(company.address ?? "");
  const [phone, setPhone] = useState(company.phone ?? "");
  const [email, setEmail] = useState(company.email ?? "");

  const dirty =
    address !== (company.address ?? "") || phone !== (company.phone ?? "") || email !== (company.email ?? "");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    try {
      await updateDetails.mutateAsync({ address, phone, email });
      toast.success("Invoice header saved");
    } catch (err) {
      // companies_email_check is the realistic failure here — a typed address
      // that isn't one.
      toast.error(toUserMessage(err, "Could not save the invoice header"));
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-3 rounded-xl bg-card p-4 shadow-sm ring-1 ring-foreground/10">
      <div>
        <h2 className="text-sm font-medium">Invoice header</h2>
        <p className="text-sm text-muted-foreground">
          Printed at the top of every invoice and bill, under the company name.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="company-address">Address</FieldLabel>
          <Textarea
            id="company-address"
            rows={3}
            disabled={disabled}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={"12 Nehru Road\nKolkata 700001"}
          />
          <FieldDescription>Line breaks are kept as typed.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="company-phone">Phone</FieldLabel>
          <Input id="company-phone" disabled={disabled} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="company-email">Email</FieldLabel>
          <Input id="company-email" type="email" disabled={disabled} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>

      {!disabled && (
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!dirty || updateDetails.isPending}>
            {updateDetails.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}

export default function SettingsPage({ params }: PageProps<"/[companyId]/settings">) {
  const { companyId } = use(params);

  const { data: company, isLoading: loadingCompany } = useCompanyQuery(companyId);
  const { data: memberships } = useCompaniesQuery();
  const myRole = memberships?.find((m) => m.id === companyId)?.role;
  const isAdmin = myRole === "admin";

  const { data: members, isLoading: loadingMembers } = useCompanyMembersQuery(companyId);
  const { data: invites } = usePendingInvitesQuery(companyId);

  const updateLockDate = useUpdateLockDateMutation(companyId);
  const updateRole = useUpdateMemberRoleMutation(companyId);
  const revokeMember = useRevokeMemberMutation(companyId);
  const revokeInvite = useRevokeInviteMutation(companyId);
  const inviteMember = useInviteMemberMutation(companyId);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<CompanyRole>("accountant");

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    try {
      await inviteMember.mutateAsync({ email: inviteEmail, role: inviteRole });
      toast.success(`Invited ${inviteEmail}`);
      setInviteEmail("");
    } catch (err) {
      toast.error(toUserMessage(err, "Could not send invite"));
    }
  }

  async function handleRoleChange(memberId: string, role: CompanyRole) {
    try {
      await updateRole.mutateAsync({ memberId, role });
    } catch (err) {
      toast.error(toUserMessage(err, "Could not update role"));
    }
  }

  async function handleRevokeMember(memberId: string) {
    try {
      await revokeMember.mutateAsync(memberId);
      toast.success("Member removed");
    } catch (err) {
      toast.error(toUserMessage(err, "Could not remove member"));
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Company details, the books lock date, and who has access.</p>
      </div>

      <section className="space-y-3 rounded-xl bg-card p-4 shadow-sm ring-1 ring-foreground/10">
        <h2 className="text-sm font-medium">Company</h2>
        {loadingCompany ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">Name</p>
              <p className="font-medium">{company?.name}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Base currency</p>
              <p className="font-medium">{company?.baseCurrency}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Book beginning date</p>
              <p className="font-medium">{company?.bookBeginningDate}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Financial year starts</p>
              <p className="font-medium">
                {company && new Date(2000, company.financialYearStartMonth - 1).toLocaleString("en-IN", { month: "long" })}
              </p>
            </div>
            <Field className="col-span-2">
              <FieldLabel htmlFor="lock-date">Lock date</FieldLabel>
              <Input
                id="lock-date"
                type="date"
                disabled={!isAdmin}
                value={company?.lockDate ?? ""}
                onChange={(e) => updateLockDate.mutate(e.target.value || null)}
                className="w-48"
              />
              <FieldDescription>
                Accountants can&apos;t create or edit vouchers dated on or before this date. Admins are never restricted.
              </FieldDescription>
            </Field>
          </div>
        )}
      </section>

      {company && <LetterheadSection key={company.id} companyId={companyId} company={company} disabled={!isAdmin} />}

      <section className="space-y-3 rounded-xl bg-card p-4 shadow-sm ring-1 ring-foreground/10">
        <h2 className="text-sm font-medium">Members</h2>
        {loadingMembers ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <div className="divide-y">
            {members?.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-2 text-sm">
                <span>{m.fullName ?? "Unnamed member"}</span>
                <div className="flex items-center gap-2">
                  {isAdmin ? (
                    <Select value={m.role} onValueChange={(v) => v && handleRoleChange(m.id, v as CompanyRole)}>
                      <SelectTrigger size="sm" className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(ROLE_LABEL) as CompanyRole[]).map((r) => (
                          <SelectItem key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="secondary">{ROLE_LABEL[m.role]}</Badge>
                  )}
                  {isAdmin && (
                    <Button variant="ghost" size="icon-sm" onClick={() => handleRevokeMember(m.id)} className="text-muted-foreground">
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {invites && invites.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">Pending invites</p>
            {isAdmin && (
              <p className="pb-1 text-xs text-muted-foreground">
                HISAB doesn&apos;t send email yet — copy each link and pass it on yourself.
              </p>
            )}
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{inv.email}</span>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{ROLE_LABEL[inv.role]}</Badge>
                  {isAdmin && (
                    <>
                      <InviteLinkButton token={inv.token} email={inv.email} />
                      <Button variant="ghost" size="icon-sm" onClick={() => revokeInvite.mutate(inv.id)} className="text-muted-foreground" title={`Revoke invite for ${inv.email}`} aria-label={`Revoke invite for ${inv.email}`}>
                        <X className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {isAdmin && (
          <form onSubmit={handleInvite} className="flex items-end gap-2 border-t pt-3">
            <Field className="flex-1">
              <FieldLabel htmlFor="invite-email">Invite by email</FieldLabel>
              <Input id="invite-email" type="email" required value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
            </Field>
            <Select value={inviteRole} onValueChange={(v) => v && setInviteRole(v as CompanyRole)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ROLE_LABEL) as CompanyRole[]).map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={inviteMember.isPending}>
              <UserPlus data-icon="inline-start" />
              Invite
            </Button>
          </form>
        )}
      </section>

      <BackupRestoreSection
        companyId={companyId}
        companyName={company?.name ?? "this company"}
        isAdmin={isAdmin}
      />
    </div>
  );
}
