"use client";

import { Cog, FilePlus2, FileX2, PencilLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { changedFields, isSystemChange, type AuditEntry } from "@/lib/supabase/queries/audit";

const ACTION_STYLE = {
  INSERT: { icon: FilePlus2, label: "Created", className: "bg-success/10 text-success" },
  UPDATE: { icon: PencilLine, label: "Edited", className: "bg-warning/10 text-warning" },
  DELETE: { icon: FileX2, label: "Deleted", className: "bg-destructive/10 text-destructive" },
} as const;

const TABLE_LABEL: Record<string, string> = {
  vouchers: "Voucher",
  voucher_entries: "Voucher line",
  invoice_lines: "Invoice line",
  ledgers: "Ledger",
  account_groups: "Account group",
  company_members: "Member",
  companies: "Company settings",
};

/**
 * Picks the most recognisable identifier from a row snapshot. The audit
 * trigger stores whole rows, so "which record was this" has to be recovered
 * from whatever the table happens to call its name.
 */
function describeRecord(entry: AuditEntry): string {
  const row = entry.newData ?? entry.oldData ?? {};
  // `description` is what an invoice line calls its name.
  const candidates = ["voucher_number", "name", "description", "narration"];
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return entry.recordId.slice(0, 8);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function AuditEntryRow({ entry }: { entry: AuditEntry }) {
  const system = isSystemChange(entry);
  const style = system
    ? { icon: Cog, label: "Recalculated", className: "bg-muted text-muted-foreground" }
    : ACTION_STYLE[entry.action];
  const Icon = style.icon;
  const changes = changedFields(entry);

  return (
    <div className={system ? "flex gap-3 p-3 text-sm opacity-70" : "flex gap-3 p-3 text-sm"}>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Badge variant="secondary" className={style.className}>{style.label}</Badge>
          <span className="text-muted-foreground">{TABLE_LABEL[entry.tableName] ?? entry.tableName}</span>
          <span className="font-medium">{describeRecord(entry)}</span>
        </div>

        {changes.length > 0 && (
          <dl className="mt-1.5 space-y-0.5">
            {changes.map(({ field, from, to }) => (
              <div key={field} className="flex flex-wrap items-baseline gap-1.5 text-xs">
                <dt className="text-muted-foreground">{field}</dt>
                <dd className="font-mono text-muted-foreground line-through">{formatValue(from)}</dd>
                <span aria-hidden className="text-muted-foreground">→</span>
                <dd className="font-mono text-foreground">{formatValue(to)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="shrink-0 text-right text-xs text-muted-foreground">
        <div>{entry.changedByName ?? "Unknown user"}</div>
        <time dateTime={entry.changedAt}>
          {new Date(entry.changedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
        </time>
      </div>
    </div>
  );
}
