import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database.types";
import { buildBillCapturePrompt } from "@/lib/bill-capture/prompt";
import { extractBillCapture, type BillCaptureImage } from "@/lib/bill-capture/gemini";
import { normalizeBillCaptureExtraction } from "@/lib/bill-capture/normalize";

/**
 * The one Gemini call in this whole feature, and it happens here — at review
 * time, not at upload time — precisely so a photo nobody ever opens costs
 * nothing. Runs entirely server-side: the API key is a server-only env var
 * and never reaches the client, and the image is downloaded from Storage
 * under the caller's own session, so RLS decides what this route can even
 * read before a single byte reaches the model.
 */
export async function POST(request: Request) {
  let body: { draftId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const draftId = typeof body.draftId === "string" ? body.draftId : null;
  if (!draftId) {
    return NextResponse.json({ error: "draftId is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // RLS (bill_capture_drafts_select) is what actually enforces "only a
  // member of this company can read this row" — this route makes no
  // separate membership check of its own.
  const { data: draft, error: draftError } = await supabase
    .from("bill_capture_drafts")
    .select("id, company_id, status, bill_capture_pages(page_no, storage_path)")
    .eq("id", draftId)
    .single();

  if (draftError || !draft) {
    return NextResponse.json({ error: "Capture not found" }, { status: 404 });
  }

  // Re-extraction is a deliberate, supported action ("the photo was
  // blurry, try again") on a pending draft — but a confirmed or rejected
  // one is terminal (the trigger would refuse the write anyway; this just
  // avoids spending an API call on a draft nothing can do with the result).
  if (draft.status !== "pending_review") {
    return NextResponse.json({ error: `This capture is already ${draft.status} and can't be re-read` }, { status: 409 });
  }

  const pages = [...(draft.bill_capture_pages ?? [])].sort((a, b) => a.page_no - b.page_no);
  if (pages.length === 0) {
    return NextResponse.json({ error: "This capture has no pages to read yet" }, { status: 409 });
  }

  const { data: company } = await supabase.from("companies").select("name").eq("id", draft.company_id).single();

  const images: BillCaptureImage[] = [];
  for (const page of pages) {
    const { data: fileBlob, error: downloadError } = await supabase.storage.from("bill-captures").download(page.storage_path);
    if (downloadError || !fileBlob) {
      return NextResponse.json({ error: `Could not read page ${page.page_no} of the uploaded photos` }, { status: 500 });
    }
    images.push({ base64: Buffer.from(await fileBlob.arrayBuffer()).toString("base64"), mimeType: fileBlob.type || "image/jpeg" });
  }

  const { raw, errorNote } = await extractBillCapture({
    apiKey: process.env.GEMINI_API_KEY,
    prompt: buildBillCapturePrompt(company?.name ?? null),
    images,
  });

  // extractBillCapture never throws, so there is always something to save —
  // either the model's own JSON, or a synthetic low-confidence result
  // carrying the plain-English reason it couldn't be read.
  const extraction = raw
    ? normalizeBillCaptureExtraction(raw)
    : normalizeBillCaptureExtraction({ confidence: "low", note: errorNote, line_items: [] });

  const { error: updateError } = await supabase
    .from("bill_capture_drafts")
    // Cast, not re-typed: BillCaptureExtraction is a concrete interface, and
    // Postgres's jsonb column has no schema of its own to check it against —
    // the same reason normalize.ts's own input side is `unknown`.
    .update({ extracted_json: extraction as unknown as Json, extracted_at: new Date().toISOString() })
    .eq("id", draftId);

  if (updateError) {
    return NextResponse.json({ error: "Could not save the extraction" }, { status: 500 });
  }

  return NextResponse.json({ extraction });
}
