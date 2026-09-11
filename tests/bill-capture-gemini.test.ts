import { afterEach, describe, expect, it, vi } from "vitest";
import { extractBillCapture } from "@/lib/bill-capture/gemini";

function jsonResponse(text: string) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extractBillCapture", () => {
  it("never calls out at all, and says so plainly, when no key is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await extractBillCapture({ apiKey: undefined, prompt: "p", imageBase64: "aaaa", mimeType: "image/jpeg" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.raw).toBeNull();
    expect(result.errorNote).toMatch(/isn't switched on yet/);
  });

  it("returns the model's parsed JSON on an ordinary success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse('{"looks_like_purchase_bill":true}')));

    const result = await extractBillCapture({ apiKey: "test-key", prompt: "p", imageBase64: "aaaa", mimeType: "image/jpeg" });

    expect(result.errorNote).toBeNull();
    expect(result.raw).toEqual({ looks_like_purchase_bill: true });
  });

  it("retries a 429 on the same model before giving up on it, then succeeds on the fallback model", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse('{"note":"from the fallback model"}'));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await extractBillCapture({ apiKey: "test-key", prompt: "p", imageBase64: "aaaa", mimeType: "image/jpeg" });

    // 3 calls to exhaust the primary model's own retries, 1 more to the fallback.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(fetchSpy.mock.calls[0][0]).toContain("gemini-flash-latest");
    expect(fetchSpy.mock.calls[3][0]).toContain("gemini-flash-lite-latest");
    expect(result.raw).toEqual({ note: "from the fallback model" });
  });

  it("does not retry a non-transient error — asking a second model the identical question isn't worth a second attempt on the same one", async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchSpy);

    await extractBillCapture({ apiKey: "test-key", prompt: "p", imageBase64: "aaaa", mimeType: "image/jpeg" });

    // 1 call to the primary (no retry on 400), 1 to the fallback.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("surfaces the real upstream status and body once every model is exhausted", async () => {
    // A fresh Response per call: both the primary and fallback attempts read
    // this mock, and a Response body can only be consumed once.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("quota exceeded for this project", { status: 403 })));

    const result = await extractBillCapture({ apiKey: "test-key", prompt: "p", imageBase64: "aaaa", mimeType: "image/jpeg" });

    expect(result.raw).toBeNull();
    expect(result.errorNote).toContain("403");
    expect(result.errorNote).toContain("quota exceeded for this project");
  });

  it("reports a 200 with no usable content distinctly, naming the finish reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }), { status: 200 }))
    );

    const result = await extractBillCapture({ apiKey: "test-key", prompt: "p", imageBase64: "aaaa", mimeType: "image/jpeg" });

    expect(result.raw).toBeNull();
    expect(result.errorNote).toContain("SAFETY");
  });

  it("never lets the API key reach a returned error message, even from a thrown network failure", async () => {
    const secretKey = "AIzaSySECRET12345";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError(`fetch failed: could not reach https://generativelanguage.googleapis.com/v1beta/models/x?key=${secretKey}`))
    );

    const result = await extractBillCapture({ apiKey: secretKey, prompt: "p", imageBase64: "aaaa", mimeType: "image/jpeg" });

    expect(result.errorNote).not.toContain(secretKey);
    expect(result.errorNote).toContain("[REDACTED]");
  });

  it("never throws even when fetch itself is fundamentally broken", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(
      extractBillCapture({ apiKey: "test-key", prompt: "p", imageBase64: "aaaa", mimeType: "image/jpeg" })
    ).resolves.toMatchObject({ raw: null });
  });
});
