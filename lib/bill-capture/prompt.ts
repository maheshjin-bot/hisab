/**
 * The Gemini prompt and response shape for reading a photographed purchase
 * bill. Adapted from a similar feature seen in another accounting app, but
 * trimmed hard to what HISAB can actually use: HISAB's ledgers carry no
 * GSTIN, there is no item master to hang an HSN code on, and no tax split —
 * a Purchase Bill voucher here posts a plain description/quantity/rate/
 * discount line to whichever ledger the reviewer picks. So none of GST,
 * HSN, GSTIN, PAN, Udyam or bank-detail extraction appears below; asking
 * for fields nothing downstream can store would just be another way for the
 * model to hallucinate something confident-looking and unused.
 */

/** Gemini's own structured-output schema format — not JSON Schema; note the SCREAMING_CASE type names. */
export const BILL_CAPTURE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    // First, so every field generated after it is already conditioned on
    // this decision — see buildBillCapturePrompt's own note on why.
    looks_like_purchase_bill: { type: "BOOLEAN" },
    vendor_name: { type: "STRING", nullable: true },
    vendor_address: { type: "STRING", nullable: true },
    vendor_phone: { type: "STRING", nullable: true },
    vendor_email: { type: "STRING", nullable: true },
    bill_number: { type: "STRING", nullable: true },
    bill_date: { type: "STRING", nullable: true },
    line_items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          description: { type: "STRING" },
          unit: { type: "STRING", nullable: true },
          quantity: { type: "NUMBER", nullable: true },
          rate: { type: "NUMBER", nullable: true },
          discount_percent: { type: "NUMBER", nullable: true },
          amount: { type: "NUMBER", nullable: true },
        },
        required: ["description"],
      },
    },
    total_amount: { type: "NUMBER", nullable: true },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    note: { type: "STRING" },
  },
  required: ["looks_like_purchase_bill", "line_items", "confidence", "note"],
} as const;

const INSTRUCTIONS = `You are reading a photograph or scan of a purchase bill — a tax invoice,
bill of supply, or cash memo issued BY ANOTHER BUSINESS TO the capturing
company. It is a bill they have to pay and book as a purchase.

First judge whether this really is that kind of document
(looks_like_purchase_bill). Say false for anything else — a quotation, a
purchase order, a delivery challan, a bank advice, a handwritten note, a
photo that isn't a document at all, or the capturing company's OWN outgoing
invoice rather than one addressed to them. false is always a safe answer;
extracting confident nonsense from the wrong kind of paper is not. Still
fill in whatever fields you can even when this is false — a human will
review every field regardless, and a partially-legible wrong-type document
is still worth showing them what was read.

If a field is illegible, absent, or you are not confident, return null for
it rather than a plausible-looking guess.

- vendor_name is the SUPPLIER who issued this bill — never the capturing
  company itself, and never the customer named in a "Bill to" / "Buyer"
  block.
- vendor_address: their street address as printed, on one line, commas
  kept, including town/state/PIN if that is how it is printed — there is
  nowhere else for those to go.
- vendor_phone: their telephone number(s) as printed, separated by ", " in
  the order printed if there is more than one.
- vendor_email: their email address, exactly as printed.
- bill_number is THIS document's own printed number — "Invoice No.", "Bill
  No.", or a bare number in the header beside the date. It is the number
  the ISSUER put on this paper, never a purchase-order number and never our
  own. Null if none is printed.
- bill_date must be ISO 8601 (yyyy-mm-dd). Indian documents are written
  dd/mm/yyyy or dd-mm-yyyy — convert them; never read as mm/dd/yyyy.

Line items:
- Every distinct goods or service line you can read, description exactly as
  printed. A line survives on its description alone — if you can read what
  it is but not its numbers, still include it with those fields null, never
  drop the whole line for one unreadable cell. Never include subtotal, tax,
  discount or grand-total rows as line items.
- quantity, rate and amount as plain numbers — no currency symbol, no
  thousands separator, no unit suffix.
- unit: the unit of measure exactly as printed against that line ("Nos",
  "Mtr", "Kgs", "Pcs", "Box"). Many invoices print it stuck to the quantity
  ("120 Mtr", "8 Nos") — then unit is "Mtr" and quantity is 120. Null when
  the document prints no unit at all; never invent one from the
  description.
- discount_percent: the trade discount on THAT line, as a percentage
  number, from a column headed Disc / Disc % / Discount. Many invoices
  print a WORD there for a line with no discount — "Nett", "Net", "-" — and
  for those return null, not 0. Read 60 from "60 %". If the column gives a
  discount in RUPEES rather than a percentage, return null rather than
  converting it.
- amount is that line's own printed total, if one is printed — used only to
  cross-check the numbers above, never treated as more reliable than them.

total_amount is the final payable / grand total printed on the whole bill —
whatever it actually says, tax included if the bill charges any; do not try
to separate out or recompute any tax component.

confidence:
- "high" — clear image, you are sure what the document is, and you read
  every field it actually prints.
- "medium" — legible, but some printed fields are uncertain or unreadable.
- "low" — blurry, cropped, mostly unreadable, or you cannot tell what it
  is.
Judge confidence only on what you failed to read of what IS printed. A
field the document legitimately does not carry is not a failure and must
not lower it.

note: one or two plain sentences — what kind of document you decided this
is and why, then anything you could not read and why (blur, glare, cut off,
handwritten). Never leave it empty.

Return JSON matching the given schema only.`;

/**
 * The identity block solves "whose bill is this" — without it the model has
 * no way to tell a bill addressed TO the capturing company from one it
 * issued itself, since the two look nearly identical without knowing which
 * name in the letterhead belongs to the reader.
 *
 * `companyName` is null when it genuinely isn't known yet (there is no such
 * caller in HISAB today — every capture happens from inside a company's own
 * session — but this stays optional rather than required so a future
 * no-session entry point, if one is ever built, degrades to "classify from
 * layout alone" instead of needing its own separate prompt).
 */
export function buildBillCapturePrompt(companyName: string | null): string {
  const identity = companyName
    ? `WHOSE DESK THIS CAME FROM — the company that captured this document is "${companyName}". If that name is the SUPPLIER / "from" party, this document did not come from a supplier and is very likely not a purchase bill for them at all — say so in the note. This party is NEVER the answer to vendor_name.\n\n`
    : `WHOSE DESK THIS CAME FROM: not known on this request. Judge purely from the document's own layout.\n\n`;

  return identity + INSTRUCTIONS;
}
