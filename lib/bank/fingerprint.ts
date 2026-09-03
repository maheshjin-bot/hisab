import type { StatementDirection } from "./types";

/**
 * The duplicate guard for re-imported statements.
 *
 * Users re-download overlapping periods constantly — "last 90 days" pulled
 * twice a month — so an import that can't recognise a transaction it has
 * already seen doubles every entry in the overlap. The fingerprint is what
 * `bank_statement_lines`' unique index is built on, so the second upload of
 * the same transaction is simply skipped.
 *
 * It is a readable composite string, not a hash. A hash collision here would
 * silently *drop* a real transaction — the worst possible failure for this
 * feature — and there is no space pressure that would justify accepting even a
 * small chance of it. The string is also inspectable when a user asks why a
 * line was treated as a duplicate.
 */

/** The narration's share of the fingerprint. Bounded so one long line can't dominate the key. */
const MAX_LENGTH = 120;
/**
 * How much of the bound is spent on the end of the narration rather than the
 * start. A NEFT/RTGS line spends its opening on the counterparty's registered
 * name, branch and IFSC — all of which two different transfers to the same
 * payee share — and only reaches the UTR that tells them apart at the very
 * end. Keeping a tail is what stops those two collapsing into one fingerprint.
 */
const TAIL_LENGTH = 40;
/**
 * Marks the elision, so a fingerprint shown to a user reads as shortened
 * rather than as the whole narration. Cannot be forged from a narration: the
 * normalizer below strips everything that is not a letter, number or mark.
 */
const ELISION = "~";

/**
 * Reduces a narration to the part that stays stable between two exports of the
 * same transaction.
 *
 * The unstable parts are whitespace and case (portals re-wrap differently) and
 * trailing padding. Bank reference numbers are deliberately *kept* — they're
 * the strongest identity signal a statement line has.
 *
 * Letters are matched by Unicode property, not by A-Z. A statement narrated in
 * Devanagari, Tamil or Gujarati is ordinary for this app's users, and an
 * ASCII-only class reduced every one of those narrations to the empty string —
 * which took the strongest component out of the fingerprint and left two
 * unrelated payments of the same amount on the same day indistinguishable.
 * Combining marks are kept with their letters (\p{M}) so Indic text normalizes
 * to words rather than shattering into bare consonants.
 */
export function fingerprintNarration(narration: string): string {
  const normalized = narration
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();

  if (normalized.length <= MAX_LENGTH) return normalized;

  const head = normalized.slice(0, MAX_LENGTH - TAIL_LENGTH - ELISION.length);
  return `${head}${ELISION}${normalized.slice(-TAIL_LENGTH)}`;
}

export function buildFingerprint(input: {
  txnDate: string;
  direction: StatementDirection;
  amountPaise: number;
  narration: string;
  occurrenceIndex: number;
}): string {
  const parts = [
    input.txnDate,
    input.direction === "withdrawal" ? "W" : "D",
    String(input.amountPaise),
    fingerprintNarration(input.narration),
    String(input.occurrenceIndex),
  ];
  return parts.join("|");
}

/**
 * Numbers otherwise-identical transactions within a file.
 *
 * Two ₹49 subscription charges on the same day with the same narration are two
 * real transactions, not a duplicate — they differ only by their position in
 * the group. Counting within the group rather than within the file is what
 * makes the index stable across two uploads that cover different periods but
 * share this day.
 */
export function assignOccurrenceIndexes<T extends {
  txnDate: string;
  direction: StatementDirection;
  amountPaise: number;
  narration: string;
}>(lines: T[]): (T & { occurrenceIndex: number })[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const key = [
      line.txnDate,
      line.direction,
      line.amountPaise,
      fingerprintNarration(line.narration),
    ].join("|");
    const occurrenceIndex = seen.get(key) ?? 0;
    seen.set(key, occurrenceIndex + 1);
    return { ...line, occurrenceIndex };
  });
}
