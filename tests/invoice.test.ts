import { describe, expect, it } from "vitest";
import {
  buildInvoiceSchema,
  computeInvoiceTotals,
  discountPaise,
  invoiceLineSchema,
  lineAmountPaise,
  lineGrossPaise,
  type InvoiceLineFormValues,
} from "@/lib/voucher/invoice-schema";
import { toRpcInvoice } from "@/lib/supabase/queries/vouchers";
import { numberToWordsIndian, rupeesInWords } from "@/lib/utils/number-to-words";

const line = (over: Partial<InvoiceLineFormValues> = {}): InvoiceLineFormValues => ({
  description: "Widgets",
  revenueLedgerId: "ledger-1",
  quantity: 1,
  unit: "nos",
  rate: 0,
  discountAmount: 0,
  ...over,
});

describe("previewing what the generated line_amount will be", () => {
  it("multiplies quantity by rate and settles to paise", () => {
    expect(lineGrossPaise({ quantity: 10, rate: 100 })).toBe(100_000);
    expect(lineGrossPaise({ quantity: 2.5, rate: 40 })).toBe(10_000);
    expect(lineGrossPaise({ quantity: 1, rate: 0 })).toBe(0);
  });

  it("rounds the product once, half away from zero, exactly where the column does", () => {
    // round(1 x 33.333, 2) = 33.33
    expect(lineGrossPaise({ quantity: 1, rate: 33.333 })).toBe(3333);
    // round(1 x 33.335, 2) = 33.34 — up, not to even.
    expect(lineGrossPaise({ quantity: 1, rate: 33.335 })).toBe(3334);
    // 0.615 is the case that breaks naive float arithmetic: 0.615 * 100 is
    // 61.49999999999999 in binary, so Math.round() alone posts 0.61 where the
    // database stores 0.62.
    expect(lineGrossPaise({ quantity: 1, rate: 0.615 })).toBe(62);
    expect(lineGrossPaise({ quantity: 3, rate: 0.205 })).toBe(62);
  });

  it("keeps sub-paisa unit prices, which is what numeric(18,4) is for", () => {
    // 10,000 x 0.0850 = 850.00 exactly — rounding the rate to 0.09 at entry
    // would misprice this line by 6%.
    expect(lineGrossPaise({ quantity: 10_000, rate: 0.085 })).toBe(85_000);
    // A single unit at a sub-paisa rate still rounds to a paisa figure.
    expect(lineGrossPaise({ quantity: 1, rate: 0.0850 })).toBe(9);
  });

  it("carries three decimal places of quantity", () => {
    // 1.125 kg at 80.00 = 90.00
    expect(lineGrossPaise({ quantity: 1.125, rate: 80 })).toBe(9000);
    expect(lineGrossPaise({ quantity: 0.001, rate: 1000 })).toBe(100);
  });

  it("subtracts the discount from the already-settled line, not from the raw product", () => {
    expect(lineAmountPaise({ quantity: 10, rate: 100, discountAmount: 50 })).toBe(95_000);
    expect(lineAmountPaise({ quantity: 1, rate: 33.333, discountAmount: 0.33 })).toBe(3300);
    expect(discountPaise({ discountAmount: 12.34 })).toBe(1234);
  });

  it("lets a line come to exactly nothing, which a free sample is", () => {
    expect(lineAmountPaise({ quantity: 1, rate: 100, discountAmount: 100 })).toBe(0);
  });

  it("goes negative rather than clamping, so the form can complain about it", () => {
    // check (line_amount >= 0) would refuse this; the form should catch it
    // first, which it can only do if the arithmetic reports it honestly.
    expect(lineAmountPaise({ quantity: 1, rate: 100, discountAmount: 150 })).toBe(-5000);
  });

  it("treats an empty numeric field as zero rather than NaN", () => {
    expect(lineGrossPaise({ quantity: Number.NaN, rate: 100 })).toBe(0);
    expect(lineAmountPaise({ quantity: 1, rate: 100, discountAmount: Number.NaN })).toBe(10_000);
  });
});

describe("invoice totals", () => {
  it("sums settled paise, so three lines at 33.333 come to 99.99 and not 100.00", () => {
    // This is the whole reason line_amount is a generated column: a total
    // built from the raw quantity x rate would credit round(99.999) = 100.00
    // against a party debited 99.99 and leave the books a paisa out.
    const totals = computeInvoiceTotals([
      line({ quantity: 1, rate: 33.333 }),
      line({ quantity: 1, rate: 33.333 }),
      line({ quantity: 1, rate: 33.333 }),
    ]);
    expect(totals.linePaise).toEqual([3333, 3333, 3333]);
    expect(totals.totalPaise).toBe(9999);
    expect(totals.totalPaise).not.toBe(10_000);
  });

  it("does not drift on amounts that break float addition", () => {
    // 100.10 + 200.20 !== 300.30 in floating point.
    const totals = computeInvoiceTotals([
      line({ quantity: 1, rate: 100.1 }),
      line({ quantity: 1, rate: 200.2 }),
    ]);
    expect(totals.totalPaise).toBe(30_030);
  });

  it("reports gross and discount separately so the document can show both", () => {
    const totals = computeInvoiceTotals([
      line({ quantity: 10, rate: 100, discountAmount: 50 }),
      line({ quantity: 2, rate: 250, discountAmount: 0 }),
    ]);
    expect(totals.grossPaise).toBe(150_000);
    expect(totals.discountPaise).toBe(5_000);
    expect(totals.totalPaise).toBe(145_000);
    // gross - discount is the same number as the sum of the settled lines.
    expect(totals.linePaise.reduce((a, b) => a + b, 0)).toBe(totals.totalPaise);
  });

  it("survives the partially-filled rows react-hook-form hands it mid-typing", () => {
    const totals = computeInvoiceTotals([{} as InvoiceLineFormValues, line({ quantity: 1, rate: 5 })]);
    expect(totals.totalPaise).toBe(500);
  });
});

describe("the p_invoice payload", () => {
  const invoice = {
    partyLedgerId: "party-1",
    lines: [
      { description: "  Widgets  ", revenueLedgerId: "sales-1", quantity: 10, unit: " nos ", rate: 100, discountAmount: 0 },
      { description: "Freight", revenueLedgerId: "sales-2", quantity: 1, unit: "", rate: 250.5, discountAmount: 0.5 },
    ],
  };

  it("never sends line_amount, which is a generated column", () => {
    const payload = toRpcInvoice(invoice);
    for (const line of payload.lines) {
      expect(line).not.toHaveProperty("line_amount");
      expect(Object.keys(line).sort()).toEqual([
        "description",
        "discount_amount",
        "line_order",
        "quantity",
        "rate",
        "revenue_ledger_id",
        "unit",
      ]);
    }
    // Nor anywhere else in the payload.
    expect(JSON.stringify(payload)).not.toContain("line_amount");
  });

  it("uses the keys apply_invoice() reads", () => {
    const payload = toRpcInvoice(invoice);
    expect(payload.party_ledger_id).toBe("party-1");
    expect(payload.lines[0]).toMatchObject({
      line_order: 0,
      description: "Widgets",
      revenue_ledger_id: "sales-1",
      quantity: 10,
      unit: "nos",
      rate: 100,
      discount_amount: 0,
    });
  });

  it("numbers the lines from their position when the caller doesn't", () => {
    expect(toRpcInvoice(invoice).lines.map((l) => l.line_order)).toEqual([0, 1]);
    const explicit = toRpcInvoice({
      partyLedgerId: "p",
      lines: [{ ...invoice.lines[0], lineOrder: 7 }],
    });
    expect(explicit.lines[0].line_order).toBe(7);
  });

  it("turns a blank unit into null, since the column refuses an empty string", () => {
    const payload = toRpcInvoice(invoice);
    expect(payload.lines[1].unit).toBeNull();
    expect(toRpcInvoice({ partyLedgerId: "p", lines: [{ ...invoice.lines[0], unit: undefined }] }).lines[0].unit).toBeNull();
  });

  it("sends quantity and rate as typed, leaving Postgres to settle the scale", () => {
    const payload = toRpcInvoice({
      partyLedgerId: "p",
      lines: [{ description: "d", revenueLedgerId: "l", quantity: 1.125, rate: 33.3333, discountAmount: 0 }],
    });
    expect(payload.lines[0].quantity).toBe(1.125);
    expect(payload.lines[0].rate).toBe(33.3333);
  });
});

describe("the invoice form's schema", () => {
  const schema = buildInvoiceSchema();
  const form = (lines: InvoiceLineFormValues[]) => ({
    voucherDate: "2026-04-01",
    partyLedgerId: "party-1",
    lines,
  });

  it("accepts an ordinary invoice", () => {
    expect(schema.safeParse(form([line({ quantity: 10, rate: 100 })])).success).toBe(true);
  });

  it("needs a party, a line, a description and a ledger on every line", () => {
    expect(schema.safeParse({ ...form([line({ rate: 100 })]), partyLedgerId: "" }).success).toBe(false);
    expect(schema.safeParse(form([])).success).toBe(false);
    expect(invoiceLineSchema.safeParse(line({ description: "" })).success).toBe(false);
    expect(invoiceLineSchema.safeParse(line({ revenueLedgerId: "" })).success).toBe(false);
  });

  it("refuses a quantity of zero or less", () => {
    expect(invoiceLineSchema.safeParse(line({ quantity: 0 })).success).toBe(false);
    expect(invoiceLineSchema.safeParse(line({ quantity: -1 })).success).toBe(false);
  });

  it("refuses a discount larger than the line it discounts", () => {
    // check (line_amount >= 0) would refuse this too, but as an error naming
    // no line — so the form has to catch it first.
    expect(schema.safeParse(form([line({ quantity: 1, rate: 100, discountAmount: 150 })])).success).toBe(false);
    expect(schema.safeParse(form([line({ quantity: 1, rate: 100, discountAmount: 100 })])).success).toBe(false);
  });

  it("refuses an invoice that comes to nothing, as the generator does", () => {
    expect(schema.safeParse(form([line({ quantity: 1, rate: 0 })])).success).toBe(false);
    // ...but a free line alongside a charged one is perfectly ordinary.
    expect(
      schema.safeParse(form([line({ quantity: 1, rate: 0 }), line({ quantity: 1, rate: 100 })])).success
    ).toBe(true);
  });
});

describe("amounts in words, Indian numbering", () => {
  it("groups by lakh and crore, never million", () => {
    expect(numberToWordsIndian(100000)).toBe("One Lakh");
    expect(numberToWordsIndian(1000000)).toBe("Ten Lakh");
    expect(numberToWordsIndian(10000000)).toBe("One Crore");
    expect(numberToWordsIndian(12345678)).toBe("One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight");
    expect(numberToWordsIndian(1234567890)).toBe(
      "One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety"
    );
  });

  it("handles the awkward small numbers", () => {
    expect(numberToWordsIndian(0)).toBe("Zero");
    expect(numberToWordsIndian(15)).toBe("Fifteen");
    expect(numberToWordsIndian(20)).toBe("Twenty");
    expect(numberToWordsIndian(101)).toBe("One Hundred One");
    expect(numberToWordsIndian(1000)).toBe("One Thousand");
  });

  it("writes out a total from its paise", () => {
    expect(rupeesInWords(9999)).toBe("Rupees Ninety Nine and Ninety Nine Paise Only");
    expect(rupeesInWords(100000)).toBe("Rupees One Thousand Only");
    expect(rupeesInWords(12345678)).toBe(
      "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only"
    );
  });

  it("drops the paise when there are none, since 'Zero Paise' reads as a fault", () => {
    expect(rupeesInWords(50000)).toBe("Rupees Five Hundred Only");
    expect(rupeesInWords(0)).toBe("Rupees Zero Only");
  });
});
