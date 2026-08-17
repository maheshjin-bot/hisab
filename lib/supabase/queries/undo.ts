import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export interface RevertPreviewRow {
  tableName: string;
  action: "INSERT" | "UPDATE" | "DELETE";
  entries: number;
  earliest: string;
  latest: string;
}

/**
 * How far back an undo can reach.
 *
 * Only offsets from now, never an arbitrary from–to window. Undoing a slice
 * out of the middle of a history is incoherent: a voucher created inside the
 * window and edited after it would have its creation undone while the edit
 * survives, leaving an edit against a row that no longer exists. Undo only
 * makes sense as a tail — put the books back to how they stood at time T.
 */
export const UNDO_PRESETS = [
  { id: "1h", label: "Last hour", hours: 1 },
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "3d", label: "Last 3 days", hours: 72 },
  { id: "7d", label: "Last 7 days", hours: 168 },
] as const;

export type UndoPresetId = (typeof UNDO_PRESETS)[number]["id"];

/** Start of the given local date, as the instant to rewind to. */
export function sinceFromDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

export function sinceFromHours(hours: number, now = new Date()): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

/** What an undo would touch, so it can be shown before anything changes. */
export async function previewRevert(
  supabase: SupabaseClient<Database>,
  companyId: string,
  since: Date
): Promise<RevertPreviewRow[]> {
  const { data, error } = await supabase.rpc("preview_revert_since", {
    p_company_id: companyId,
    p_since: since.toISOString(),
  });
  if (error) throw error;

  return ((data ?? []) as {
    table_name: string;
    action: string;
    entries: number;
    earliest: string;
    latest: string;
  }[]).map((r) => ({
    tableName: r.table_name,
    action: r.action as RevertPreviewRow["action"],
    entries: Number(r.entries),
    earliest: r.earliest,
    latest: r.latest,
  }));
}

/** Applies the undo. Returns how many recorded changes were rolled back. */
export async function revertChangesSince(
  supabase: SupabaseClient<Database>,
  companyId: string,
  since: Date
): Promise<number> {
  const { data, error } = await supabase.rpc("revert_company_changes_since", {
    p_company_id: companyId,
    p_since: since.toISOString(),
  });
  if (error) throw error;
  return Number(data ?? 0);
}

const TABLE_LABEL: Record<string, string> = {
  vouchers: "Vouchers",
  voucher_entries: "Voucher lines",
  ledgers: "Ledgers",
  account_groups: "Account groups",
};

const ACTION_LABEL: Record<string, string> = {
  INSERT: "created",
  UPDATE: "edited",
  DELETE: "deleted",
};

/** "3 vouchers created" — what will be undone, in the user's terms. */
export function describePreviewRow(row: RevertPreviewRow): string {
  const table = TABLE_LABEL[row.tableName] ?? row.tableName;
  return `${row.entries} ${table.toLowerCase()} ${ACTION_LABEL[row.action] ?? row.action.toLowerCase()}`;
}

export function totalPreviewEntries(rows: RevertPreviewRow[]): number {
  return rows.reduce((sum, r) => sum + r.entries, 0);
}
