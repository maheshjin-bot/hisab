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

/**
 * Reduces a narration to the part that stays stable between two exports of the
 * same transaction.
 *
 * The unstable parts are whitespace and case (portals re-wrap differently) and
 * trailing padding. Bank reference numbers are deliberately *kept* — they're
 * the strongest identity signal a statement line has.
 */
export function fingerprintNarration(narration: string): string {
  return narration
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .slice(0, 120);
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
