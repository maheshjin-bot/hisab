import type { BillCaptureLineItem } from "./normalize";
import type { InvoiceLineInput } from "@/lib/supabase/queries/vouchers";

/** Common suffixes an Indian trade name carries that name-drift usually adds or drops rather than typos — stripped after punctuation is gone, so "& Co." and "Pvt. Ltd." match as the plain words they are. */
const NAME_SUFFIXES = /\b(private limited|pvt ltd|public limited|ltd|llp|co|enterprises?|traders?|industries)\b/g;

/** Lowercase, strip punctuation, then drop the common suffix noise — real-world name drift is mostly a legal suffix or word order, not single-character typos, so this is deliberately not edit-distance. */
export function normalizeNameForMatch(name: string): string {
  const bare = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return bare.replace(NAME_SUFFIXES, " ").replace(/\s+/g, " ").trim();
}

export interface LedgerMatchCandidate {
  id: string;
  name: string;
}

export interface LedgerMatch extends LedgerMatchCandidate {
  /** 1 = exact (after normalizing), down to a token-overlap fraction. 0 candidates never appear in the result. */
  score: number;
}

/**
 * Ranks existing ledgers against a name read off a bill. This is the
 * weakest tier this app has to work with — HISAB ledgers carry no GSTIN, so
 * there is no stronger signal available the way there would be for a
 * GST-registered party. Always a suggestion, never an auto-select; the
 * reviewer sees the ranked list and picks, same as any other combobox.
 */
export function matchLedgersByName(candidates: LedgerMatchCandidate[], vendorName: string | null): LedgerMatch[] {
  const query = vendorName ? normalizeNameForMatch(vendorName) : "";
  if (!query) return [];

  const queryTokens = new Set(query.split(" ").filter(Boolean));

  return candidates
    .map((c) => {
      const candidateName = normalizeNameForMatch(c.name);
      let score: number;
      if (candidateName === query) {
        score = 1;
      } else if (candidateName.includes(query) || query.includes(candidateName)) {
        score = 0.85;
      } else {
        const candidateTokens = candidateName.split(" ").filter(Boolean);
        const overlap = candidateTokens.filter((t) => queryTokens.has(t)).length;
        score = candidateTokens.length > 0 ? overlap / Math.max(candidateTokens.length, queryTokens.size) : 0;
      }
      return { id: c.id, name: c.name, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * `quantity * rate * discountPercent / 100`, rounded to paise — the one
 * conversion this whole feature does that the source it was adapted from
 * didn't need: that app stored a line's discount as the percentage Indian
 * invoices actually print, HISAB stores it as the rupee amount
 * (`invoice_lines.discount_amount`), so the AI is asked for the printed
 * percent and this is where it becomes the number the database wants.
 *
 * Left at 0 rather than guessed when quantity or rate wasn't read — a wrong
 * discount is worse than none, and the reviewer sees the line's own numbers
 * right there to fix by hand.
 */
export function discountPercentToAmount(quantity: number | null, rate: number | null, discountPercent: number | null): number {
  if (discountPercent === null || quantity === null || rate === null) return 0;
  return Math.round(quantity * rate * discountPercent) / 100;
}

/** Converts one normalized capture line, plus the ledger the reviewer chose for it, into exactly the shape createVoucher()'s invoice payload expects. */
export function toInvoiceLineInput(line: BillCaptureLineItem, revenueLedgerId: string, lineOrder: number): InvoiceLineInput {
  return {
    description: line.description,
    revenueLedgerId,
    quantity: line.quantity ?? 1,
    unit: line.unit,
    rate: line.rate ?? 0,
    discountAmount: discountPercentToAmount(line.quantity, line.rate, line.discountPercent),
    lineOrder,
  };
}
