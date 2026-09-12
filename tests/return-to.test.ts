import { describe, expect, it } from "vitest";
import { readReturnTo, withReturnTo } from "@/lib/utils/return-to";

describe("withReturnTo", () => {
  it("appends returnTo with a leading ? when the href has no query yet", () => {
    expect(withReturnTo("/co1/vouchers/v1/edit", "/co1/reports/daybook")).toBe(
      "/co1/vouchers/v1/edit?returnTo=%2Fco1%2Freports%2Fdaybook"
    );
  });

  it("appends with & when the href already has a query string", () => {
    expect(withReturnTo("/co1/vouchers/v1/edit?foo=bar", "/co1/reports/daybook")).toBe(
      "/co1/vouchers/v1/edit?foo=bar&returnTo=%2Fco1%2Freports%2Fdaybook"
    );
  });

  it("encodes a return path that itself carries a query string", () => {
    const back = "/co1/reports/ledger-statement?ledgerId=abc&foo=bar";
    const href = withReturnTo("/co1/vouchers/v1/edit", back);
    const params = new URL(href, "https://example.com").searchParams;
    expect(params.get("returnTo")).toBe(back);
  });
});

describe("readReturnTo", () => {
  it("accepts an ordinary same-site path", () => {
    const params = new URLSearchParams({ returnTo: "/co1/reports/daybook" });
    expect(readReturnTo(params, "/co1/vouchers")).toBe("/co1/reports/daybook");
  });

  it("falls back when there is no returnTo at all", () => {
    expect(readReturnTo(new URLSearchParams(), "/co1/vouchers")).toBe("/co1/vouchers");
  });

  it("refuses a protocol-relative value — an open-redirect attempt disguised as a path", () => {
    const params = new URLSearchParams({ returnTo: "//evil.example/phish" });
    expect(readReturnTo(params, "/co1/vouchers")).toBe("/co1/vouchers");
  });

  it("refuses an absolute URL", () => {
    const params = new URLSearchParams({ returnTo: "https://evil.example/phish" });
    expect(readReturnTo(params, "/co1/vouchers")).toBe("/co1/vouchers");
  });

  it("refuses a value that doesn't even look like a path", () => {
    const params = new URLSearchParams({ returnTo: "not-a-path" });
    expect(readReturnTo(params, "/co1/vouchers")).toBe("/co1/vouchers");
  });
});
