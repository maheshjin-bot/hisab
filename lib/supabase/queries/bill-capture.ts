import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import type { BillCaptureExtraction } from "@/lib/bill-capture/normalize";

export type BillCaptureStatus = "pending_review" | "confirmed" | "rejected";

export interface BillCaptureDraft {
  id: string;
  companyId: string;
  storagePath: string;
  extraction: BillCaptureExtraction | null;
  extractedAt: string | null;
  status: BillCaptureStatus;
  confirmedVoucherId: string | null;
  rejectedReason: string | null;
  rejectedAt: string | null;
  vendorHint: string | null;
  note: string | null;
  createdAt: string;
}

function mapDraft(row: Database["public"]["Tables"]["bill_capture_drafts"]["Row"]): BillCaptureDraft {
  return {
    id: row.id,
    companyId: row.company_id,
    storagePath: row.storage_path,
    // Cast, not re-validated: this came back out of our own column, written
    // by normalizeBillCaptureExtraction() in the first place.
    extraction: (row.extracted_json as unknown as BillCaptureExtraction | null) ?? null,
    extractedAt: row.extracted_at,
    status: row.status as BillCaptureStatus,
    confirmedVoucherId: row.confirmed_voucher_id,
    rejectedReason: row.rejected_reason,
    rejectedAt: row.rejected_at,
    vendorHint: row.vendor_hint,
    note: row.note,
    createdAt: row.created_at,
  };
}

/**
 * The draft row only — a fresh upload with nothing read from it yet.
 * Storage upload happens separately, straight from the browser to Supabase
 * Storage. `id` is supplied by the caller rather than left to the column's
 * own default, because the storage path is built from it (see
 * billCaptureStoragePath) and the upload has to happen before or alongside
 * this insert — the path and the row need to agree on the same id from the
 * start, not be reconciled afterwards.
 */
export async function createBillCaptureDraft(
  supabase: SupabaseClient<Database>,
  id: string,
  companyId: string,
  storagePath: string,
  vendorHint?: string
): Promise<string> {
  const { data, error } = await supabase
    .from("bill_capture_drafts")
    .insert({ id, company_id: companyId, storage_path: storagePath, vendor_hint: vendorHint?.trim() || null })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function getBillCaptureDraft(supabase: SupabaseClient<Database>, draftId: string): Promise<BillCaptureDraft> {
  const { data, error } = await supabase.from("bill_capture_drafts").select("*").eq("id", draftId).single();
  if (error) throw error;
  return mapDraft(data);
}

export async function listBillCaptureDrafts(
  supabase: SupabaseClient<Database>,
  companyId: string,
  status?: BillCaptureStatus
): Promise<BillCaptureDraft[]> {
  let query = supabase.from("bill_capture_drafts").select("*").eq("company_id", companyId).order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapDraft);
}

/** Calls the server-side extraction route — never the model directly; the API key never reaches the browser. */
export async function extractBillCaptureDraft(draftId: string): Promise<BillCaptureExtraction> {
  const res = await fetch("/api/bill-capture/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draftId }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Could not read this bill");
  return body.extraction as BillCaptureExtraction;
}

export async function rejectBillCaptureDraft(supabase: SupabaseClient<Database>, draftId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from("bill_capture_drafts")
    .update({ rejected_at: new Date().toISOString(), rejected_reason: reason.trim() })
    .eq("id", draftId);
  if (error) throw error;
}

/** The one and only way status can ever become 'confirmed' — see the trigger in migration 0030. Call this only after createVoucher() has already succeeded. */
export async function confirmBillCaptureDraft(supabase: SupabaseClient<Database>, draftId: string, voucherId: string): Promise<void> {
  const { error } = await supabase.from("bill_capture_drafts").update({ confirmed_voucher_id: voucherId }).eq("id", draftId);
  if (error) throw error;
}

const BUCKET = "bill-captures";

/** Deterministic path: company/draft/original — a retried upload overwrites the same object instead of leaving an orphan. */
export function billCaptureStoragePath(companyId: string, draftId: string, fileExtension: string): string {
  return `${companyId}/${draftId}/original.${fileExtension}`;
}

export async function uploadBillCaptureFile(supabase: SupabaseClient<Database>, path: string, file: File): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
}

/**
 * The bucket is private, so a plain public URL (an anonymous GET with no
 * Authorization header) would just get refused by Storage's own RLS — this
 * downloads the bytes through the authenticated client instead and hands
 * back a local object URL. Callers must revoke it (`URL.revokeObjectURL`)
 * once they're done with it, the same as any other object URL.
 */
export async function getBillCapturePhotoUrl(supabase: SupabaseClient<Database>, path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return URL.createObjectURL(data);
}
