import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export type ImportType = "ledgers" | "opening_balances" | "vouchers";

export interface ImportBatch {
  id: string;
  importType: ImportType;
  fileName: string | null;
  status: string;
  rowCount: number;
  errorCount: number;
  createdAt: string;
  committedAt: string | null;
}

/**
 * Records what an import did.
 *
 * import_batches has existed with full RLS since 0007 and was never written
 * to, so an import that half-succeeded left no trace at all — the user saw a
 * toast and then had nothing to check against. One row per import is enough
 * to answer "what did I load, when, and did any of it fail".
 *
 * Deliberately best-effort: a failure to write the audit row must not fail
 * the import that already committed, which would be a strictly worse outcome
 * than having no record of it.
 */
export async function recordImportBatch(
  supabase: SupabaseClient<Database>,
  companyId: string,
  input: {
    importType: ImportType;
    fileName: string | null;
    rowCount: number;
    errorCount: number;
    status: "committed" | "failed";
  }
): Promise<void> {
  const { error } = await supabase.from("import_batches").insert({
    company_id: companyId,
    import_type: input.importType,
    file_name: input.fileName,
    row_count: input.rowCount,
    error_count: input.errorCount,
    status: input.status,
    committed_at: input.status === "committed" ? new Date().toISOString() : null,
  });

  if (error) {
    // Surfaced in the console rather than to the user: they've just been told
    // the import succeeded, and it did.
    console.warn("Could not record import batch:", error.message);
  }
}

export async function listRecentImports(
  supabase: SupabaseClient<Database>,
  companyId: string,
  importType: ImportType,
  limit = 5
): Promise<ImportBatch[]> {
  const { data, error } = await supabase
    .from("import_batches")
    .select("*")
    .eq("company_id", companyId)
    .eq("import_type", importType)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    importType: row.import_type as ImportType,
    fileName: row.file_name,
    status: row.status,
    rowCount: row.row_count,
    errorCount: row.error_count,
    createdAt: row.created_at,
    committedAt: row.committed_at,
  }));
}
