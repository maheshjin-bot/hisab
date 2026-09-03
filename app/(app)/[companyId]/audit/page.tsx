"use client";

import { use, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AuditEntryRow } from "@/components/audit/AuditEntryRow";
import { UndoRecentChanges } from "@/components/audit/UndoRecentChanges";
import { useAuditLogQuery } from "@/hooks/useAuditQuery";
import { useCompanyRole } from "@/hooks/useCompaniesQuery";
import { AUDITED_TABLES, type AuditAction, type AuditedTable } from "@/lib/supabase/queries/audit";
import { selectItems } from "@/lib/utils/select-items";

const PAGE_SIZE = 50;

const TABLE_LABEL: Record<AuditedTable, string> = {
  vouchers: "Vouchers",
  voucher_entries: "Voucher lines",
  invoice_lines: "Invoice lines",
  ledgers: "Ledgers",
  account_groups: "Account groups",
  company_members: "Members",
  companies: "Company settings",
};

const ACTIONS: AuditAction[] = ["INSERT", "UPDATE", "DELETE"];

// Both triggers read their label from these rather than from the option that
// was clicked, so the sentinel belongs in them as much as the real values do —
// without it an unfiltered page says "all" rather than "All records".
const TABLE_ITEMS = selectItems(AUDITED_TABLES, (t) => [t, TABLE_LABEL[t]], { all: "All records" });
const ACTION_ITEMS = selectItems(ACTIONS, (a) => [a, a], { all: "All actions" });

export default function AuditPage({ params }: PageProps<"/[companyId]/audit">) {
  const { companyId } = use(params);

  const role = useCompanyRole(companyId);
  // audit_log_select already restricts this to admins and auditors; the check
  // here is only so the page explains itself instead of showing an empty
  // table to an accountant who'd have no way to know why.
  const canRead = role === "admin" || role === "auditor";

  const [tableName, setTableName] = useState<string>("all");
  const [action, setAction] = useState<string>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(0);

  const { data, isLoading } = useAuditLogQuery(canRead ? companyId : undefined, {
    tableName: tableName === "all" ? undefined : (tableName as AuditedTable),
    action: action === "all" ? undefined : (action as AuditAction),
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (role && !canRead) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="flex items-start gap-3 rounded-xl bg-card p-6 shadow-sm ring-1 ring-foreground/10">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">History is admin and auditor only</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your role is {role}. Ask an admin if you need access to the change history.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">History</h1>
        <p className="text-sm text-muted-foreground">
          Every change to vouchers, lines, ledgers and members — who, what and when.
        </p>
      </div>

      {role === "admin" && <UndoRecentChanges companyId={companyId} />}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={tableName} items={TABLE_ITEMS} onValueChange={(v) => { setTableName(v ?? "all"); setPage(0); }}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All records" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All records</SelectItem>
            {AUDITED_TABLES.map((t) => (
              <SelectItem key={t} value={t}>{TABLE_LABEL[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={action} items={ACTION_ITEMS} onValueChange={(v) => { setAction(v ?? "all"); setPage(0); }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPage(0); }} className="w-40" aria-label="From date" />
        <span className="text-sm text-muted-foreground">to</span>
        <Input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setPage(0); }} className="w-40" aria-label="To date" />
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : data?.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">
          No changes match these filters.
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-foreground/10">
          {data?.rows.map((entry) => (
            <AuditEntryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page + 1} of {pageCount} · <Badge variant="secondary">{total} changes</Badge>
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
