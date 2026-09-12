import { BILL_CAPTURE_RESPONSE_SCHEMA } from "./prompt";

// Aliases, deliberately never a pinned version string — a pinned snapshot has
// been observed 404ing for a live key while the alias keeps resolving to
// whatever Google currently points it at.
const PRIMARY_MODEL = "gemini-flash-latest";
const FALLBACK_MODEL = "gemini-flash-lite-latest";

const RETRYABLE_STATUS = new Set([429, 503]);
const RETRY_DELAYS_MS = [400, 1000];

export interface GeminiExtractionResult {
  /** The model's parsed JSON, or null if every attempt on every model failed. */
  raw: unknown | null;
  /** Set only when raw is null — a plain-English reason to show the reviewer instead of a raw error page. */
  errorNote: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The API key is passed in the request URL's own query string — a common
 * pattern for this class of API, and a real credential-leak trap: a caught
 * fetch error's message routinely includes the full URL it was trying to
 * reach. Every piece of text that might end up logged passes through this
 * first, so the key can never land in a log line by accident.
 */
function redactApiKey(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("[REDACTED]") : text;
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export interface BillCaptureImage {
  base64: string;
  mimeType: string;
}

type ModelCallResult = { raw: unknown } | { error: string };

async function callGeminiModel(model: string, apiKey: string, prompt: string, images: BillCaptureImage[]): Promise<ModelCallResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [
      {
        // One text part, then every page as its own inline image part, in
        // order — Gemini reads all parts of one content block as one turn,
        // so a two-page bill is read as one document, not extracted twice.
        parts: [{ text: prompt }, ...images.map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.base64 } }))],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: BILL_CAPTURE_RESPONSE_SCHEMA,
    },
  });

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    } catch (err) {
      const message = redactApiKey(err instanceof Error ? err.message : String(err), apiKey);
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { error: `Could not reach the vision service right now: ${message}` };
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    if (!res.ok) {
      // The single most valuable line this function can produce: the real
      // upstream status and the provider's own text, verbatim (redacted).
      // Without it, "high demand, try later" and a genuine permanent
      // failure look identical to whoever reads the log.
      const text = redactApiKey(await readBodyText(res), apiKey);
      return { error: `The vision service could not process this file right now (HTTP ${res.status}): ${text}` };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { error: "The vision service returned a response that wasn't valid JSON." };
    }

    const candidate = (json as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] })
      ?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      // A 200 with nothing usable — a safety filter tripped, or the
      // response was truncated. finishReason is the actual diagnosis.
      return { error: `No readable content — the image may be unclear or not a bill (${candidate?.finishReason ?? "no finish reason given"}).` };
    }

    try {
      return { raw: JSON.parse(text) };
    } catch {
      return { error: "The vision service's response could not be parsed as JSON." };
    }
  }
}

/**
 * Never throws. Every failure mode — no key configured, a network failure,
 * a non-2xx response, an empty response, a parse failure — returns the same
 * shape of result so the caller always has something to persist and show,
 * and a reviewer is never dropped onto a raw error page for something as
 * ordinary as a blurry photo.
 */
export async function extractBillCapture(params: {
  apiKey: string | undefined;
  prompt: string;
  images: BillCaptureImage[];
}): Promise<GeminiExtractionResult> {
  if (!params.apiKey) {
    return { raw: null, errorNote: "Vision capture isn't switched on yet. Fill in the details manually below." };
  }

  try {
    const primary = await callGeminiModel(PRIMARY_MODEL, params.apiKey, params.prompt, params.images);
    if ("raw" in primary) return { raw: primary.raw, errorNote: null };

    // The fallback is a smaller model rescuing an outage, not a
    // cost-saving default — only reached once the primary is exhausted.
    const fallback = await callGeminiModel(FALLBACK_MODEL, params.apiKey, params.prompt, params.images);
    if ("raw" in fallback) return { raw: fallback.raw, errorNote: null };

    return { raw: null, errorNote: fallback.error };
  } catch (err) {
    const message = redactApiKey(err instanceof Error ? err.message : String(err), params.apiKey);
    return { raw: null, errorNote: `Could not reach the vision service right now: ${message}` };
  }
}
