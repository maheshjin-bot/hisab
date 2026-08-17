import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/** What a backup file claims to be. Anything else is refused before it reaches the database. */
export const BACKUP_FORMAT = "hisab.company-backup";
export const BACKUP_VERSION = 1;

export type RestoreMode = "new" | "overwrite";

export interface BackupSummary {
  companyName: string;
  exportedAt: string | null;
  version: number;
  accountGroups: number;
  ledgers: number;
  vouchers: number;
  voucherEntries: number;
}

/**
 * A whole company as one JSON document — chart of accounts, ledgers, every
 * voucher and line, and the numbering sequences.
 *
 * Membership, invites and the audit log are deliberately excluded: they
 * reference users and history that mean nothing outside the project that
 * produced them, and a backup shouldn't be a way to move accounts between
 * companies.
 */
export async function exportCompanyBackup(
  supabase: SupabaseClient<Database>,
  companyId: string
): Promise<unknown> {
  const { data, error } = await supabase.rpc("export_company_backup", {
    p_company_id: companyId,
  });
  if (error) throw error;
  return data;
}

/**
 * Reads a backup well enough to describe it to the user before they commit to
 * restoring it — and to reject an obviously wrong file without a round trip.
 *
 * Throws with copy worth showing, since "that isn't a backup" is a normal
 * thing for a user to do with a file picker.
 */
export function summariseBackup(payload: unknown): BackupSummary {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("That file isn't a HISAB backup.");
  }

  const p = payload as Record<string, unknown>;

  if (p.format !== BACKUP_FORMAT) {
    throw new Error("That file isn't a HISAB backup.");
  }

  const version = Number(p.version ?? 0);
  if (version > BACKUP_VERSION) {
    throw new Error(
      `That backup was written by a newer version of HISAB (format ${version}). Update before restoring it.`
    );
  }

  const count = (key: string) => (Array.isArray(p[key]) ? (p[key] as unknown[]).length : 0);
  const company = (p.company ?? {}) as Record<string, unknown>;

  return {
    companyName: typeof company.name === "string" ? company.name : "Unnamed company",
    exportedAt: typeof p.exported_at === "string" ? p.exported_at : null,
    version,
    accountGroups: count("account_groups"),
    ledgers: count("ledgers"),
    vouchers: count("vouchers"),
    voucherEntries: count("voucher_entries"),
  };
}

/**
 * Rebuilds a company from a backup, either alongside the existing ones or over
 * the top of one.
 *
 * The whole thing is a single transaction inside the database: a backup that
 * turns out to be inconsistent — an unbalanced voucher, a ledger whose group
 * is missing — fails and leaves nothing behind, rather than importing half a
 * set of books.
 */
export async function restoreCompanyBackup(
  supabase: SupabaseClient<Database>,
  payload: unknown,
  mode: RestoreMode,
  targetCompanyId?: string
): Promise<string> {
  const { data, error } = await supabase.rpc("restore_company_backup", {
    p_payload: payload as Database["public"]["Functions"]["restore_company_backup"]["Args"]["p_payload"],
    p_mode: mode,
    p_target_company_id: targetCompanyId,
  });
  if (error) throw error;
  return data as string;
}

/** `hisab-sharma-enterprises-2026-08-17.json` — sortable, and obvious in a downloads folder. */
export function backupFileName(companyName: string, when = new Date()): string {
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "company";

  const stamp = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, "0"),
    String(when.getDate()).padStart(2, "0"),
  ].join("-");

  return `hisab-${slug}-${stamp}.json`;
}
