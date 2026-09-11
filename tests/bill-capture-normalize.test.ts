import { describe, expect, it } from "vitest";
import {
  normalizeBillCaptureExtraction,
  toDiscountPercentOrNull,
  toEmailOrNull,
  toIsoDateOrNull,
  toNumberOrNull,
  toStringOrNull,
} from "@/lib/bill-capture/normalize";

describe("toStringOrNull", () => {
  it("trims and turns blank into null", () => {
    expect(toStringOrNull("  Ramesh Traders  ")).toBe("Ramesh Traders");
    expect(toStringOrNull("   ")).toBeNull();
    expect(toStringOrNull(null)).toBeNull();
    expect(toStringOrNull(42)).toBeNull();
  });
});

describe("toNumberOrNull", () => {
  it("accepts a finite number or a numeric string", () => {
    expect(toNumberOrNull(100)).toBe(100);
    expect(toNumberOrNull("100.50")).toBe(100.5);
  });

  it("refuses NaN, Infinity, and garbage", () => {
    expect(toNumberOrNull(NaN)).toBeNull();
    expect(toNumberOrNull(Infinity)).toBeNull();
    expect(toNumberOrNull("twelve")).toBeNull();
    expect(toNumberOrNull(null)).toBeNull();
  });
});

describe("toIsoDateOrNull", () => {
  it("accepts a real ISO date", () => {
    expect(toIsoDateOrNull("2026-04-05")).toBe("2026-04-05");
  });

  it("refuses a date that JS would otherwise silently roll forward", () => {
    // new Date("2026-02-31") rolls forward to March 3rd rather than erroring.
    expect(toIsoDateOrNull("2026-02-31")).toBeNull();
  });

  it("refuses the wrong shape entirely", () => {
    expect(toIsoDateOrNull("05/04/2026")).toBeNull();
    expect(toIsoDateOrNull("not a date")).toBeNull();
  });
});

describe("toDiscountPercentOrNull", () => {
  it("accepts 0 through 100", () => {
    expect(toDiscountPercentOrNull(0)).toBe(0);
    expect(toDiscountPercentOrNull(60)).toBe(60);
    expect(toDiscountPercentOrNull(100)).toBe(100);
  });

  it("refuses anything outside that range — a rupee figure mistaken for a percent, most commonly", () => {
    expect(toDiscountPercentOrNull(101)).toBeNull();
    expect(toDiscountPercentOrNull(-5)).toBeNull();
    expect(toDiscountPercentOrNull(6279)).toBeNull();
  });

  it("treats a non-numeric column value ('Nett', '-') as no discount recorded, not zero", () => {
    expect(toDiscountPercentOrNull("Nett")).toBeNull();
  });
});

describe("toEmailOrNull", () => {
  it("accepts an ordinary email", () => {
    expect(toEmailOrNull("accounts@ramesh.com")).toBe("accounts@ramesh.com");
  });

  it("refuses something that merely looks nearby", () => {
    expect(toEmailOrNull("accounts@ramesh")).toBeNull();
    expect(toEmailOrNull("not an email")).toBeNull();
  });
});

describe("normalizeBillCaptureExtraction", () => {
  it("maps a well-formed response through", () => {
    const result = normalizeBillCaptureExtraction({
      looks_like_purchase_bill: true,
      vendor_name: "Ramesh Traders",
      vendor_address: "12 MG Road, Surat",
      vendor_phone: "9998887770",
      vendor_email: "accounts@ramesh.com",
      bill_number: "INV-042",
      bill_date: "2026-04-05",
      line_items: [
        { description: "Cotton fabric", unit: "Mtr", quantity: 100, rate: 50, discount_percent: 10, amount: 4500 },
      ],
      total_amount: 4500,
      confidence: "high",
      note: "Clear photo of a purchase invoice.",
    });

    expect(result).toEqual({
      looksLikePurchaseBill: true,
      vendorName: "Ramesh Traders",
      vendorAddress: "12 MG Road, Surat",
      vendorPhone: "9998887770",
      vendorEmail: "accounts@ramesh.com",
      billNumber: "INV-042",
      billDate: "2026-04-05",
      lineItems: [{ description: "Cotton fabric", unit: "Mtr", quantity: 100, rate: 50, discountPercent: 10, amount: 4500 }],
      totalAmount: 4500,
      confidence: "high",
      note: "Clear photo of a purchase invoice.",
    });
  });

  it("never throws on a response that isn't even an object, and returns a safe, low-confidence fallback", () => {
    expect(normalizeBillCaptureExtraction(null)).toMatchObject({ looksLikePurchaseBill: false, lineItems: [], confidence: "low" });
    expect(normalizeBillCaptureExtraction("garbage")).toMatchObject({ confidence: "low" });
    expect(normalizeBillCaptureExtraction(undefined)).toMatchObject({ confidence: "low" });
  });

  it("a line survives on its description alone — unreadable numbers become null, never drop the line", () => {
    const result = normalizeBillCaptureExtraction({
      looks_like_purchase_bill: true,
      line_items: [{ description: "Steel rod", quantity: "unclear", rate: null, amount: undefined }],
      confidence: "medium",
      note: "One line's numbers were smudged.",
    });
    expect(result.lineItems).toEqual([
      { description: "Steel rod", unit: null, quantity: null, rate: null, discountPercent: null, amount: null },
    ]);
  });

  it("drops a line with no legible description at all", () => {
    const result = normalizeBillCaptureExtraction({
      looks_like_purchase_bill: true,
      line_items: [{ description: "", quantity: 5 }, { description: "   ", quantity: 6 }],
      confidence: "low",
      note: "Barely legible.",
    });
    expect(result.lineItems).toEqual([]);
  });

  it("falls back to low confidence for a stray/unexpected confidence value", () => {
    const result = normalizeBillCaptureExtraction({ confidence: "very sure", note: "x", line_items: [] });
    expect(result.confidence).toBe("low");
  });

  it("falls back to a stated note when the model left it empty", () => {
    const result = normalizeBillCaptureExtraction({ confidence: "low", note: "", line_items: [] });
    expect(result.note).not.toBe("");
  });
});
