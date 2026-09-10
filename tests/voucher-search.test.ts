import { describe, expect, it } from "vitest";
import { buildVoucherSearchFilter } from "@/lib/supabase/queries/vouchers";

describe("buildVoucherSearchFilter", () => {
  it("matches narration or voucher number, both case-insensitively", () => {
    expect(buildVoucherSearchFilter("rent")).toBe("narration.ilike.%rent%,voucher_number.ilike.%rent%");
  });

  it("carries ordinary typed text through unchanged", () => {
    // Not this function's job to validate or normalise what was typed — that
    // is PostgREST's `ilike`, same as every other search box in the app.
    expect(buildVoucherSearchFilter("INV-042")).toBe("narration.ilike.%INV-042%,voucher_number.ilike.%INV-042%");
  });

  it("escapes a comma, the one character that breaks .or()'s grammar", () => {
    // An unescaped comma here splits the intended clause into pieces
    // PostgREST can't parse and the request fails with a 400 — confirmed
    // against the live project, not assumed. Percent-encoding it here is
    // what lets a narration like "Rent for Jan, Feb, Mar" be searched at
    // all rather than breaking the whole query the moment it's typed.
    expect(buildVoucherSearchFilter("Jan, Feb")).toBe("narration.ilike.%Jan%2C Feb%,voucher_number.ilike.%Jan%2C Feb%");
  });

  it("leaves a period and parentheses literal — verified they do not break the filter", () => {
    // Unlike the comma, these look like filter syntax but are not: a period
    // or unbalanced parentheses inside an ilike value were confirmed live to
    // parse cleanly, alone and combined, so escaping them would only mangle
    // an ordinary search term ("Rent (Jan)", "Q1.2026") for no protection.
    expect(buildVoucherSearchFilter("Rent (Jan)")).toBe("narration.ilike.%Rent (Jan)%,voucher_number.ilike.%Rent (Jan)%");
    expect(buildVoucherSearchFilter("Q1.2026")).toBe("narration.ilike.%Q1.2026%,voucher_number.ilike.%Q1.2026%");
  });
});
