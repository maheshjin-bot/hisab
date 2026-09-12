import type { MatchCandidate } from "./types";
import { signedPaiseOf } from "./types";
import { tokenize } from "./suggest";

/**
 * Reconciling statement lines against vouchers that are already in the books.
 *
 * A statement line is one of two things: a transaction the company has already
 * recorded (a cheque written last week that has now cleared), or one it hasn't
 * (a bank charge). Telling those apart is the whole job — posting the first
 * kind again duplicates it, and missing the second kind leaves the books
 * short.
 *
 * The rule this module is built around: **an uncertain match is worse than no
 * match.** A wrong match hides a real discrepancy, which is precisely what a
 * reconciliation exists to expose, and it does so invisibly. So a line with
 * two equally good candidates is returned as unmatched with both offered,
 * never resolved by a tie-break.
 */

/** How far a voucher's date may sit from the statement date and still be the same event. */
export const DEFAULT_DATE_WINDOW_DAYS = 7;

export interface MatchableLine {
  id: string;
  txnDate: string;
  narration: string;
  withdrawalPaise: number;
  depositPaise: number;
}

export interface LineMatch {
  lineId: string;
  /** Set only when exactly one candidate was clearly best. */
  matched: MatchCandidate | null;
  /** Everything within the window and the exact amount, best first. */
  candidates: MatchCandidate[];
  reason: string;
}

function daysBetween(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86_400_000;
}

/** 0..1 overlap of the meaningful words in a statement line and a voucher narration. */
function narrationAffinity(lineNarration: string, voucherNarration: string | null): number {
  if (!voucherNarration) return 0;
  const lineTokens = new Set(tokenize(lineNarration));
  const voucherTokens = tokenize(voucherNarration);
  if (lineTokens.size === 0 || voucherTokens.length === 0) return 0;
  const matched = voucherTokens.filter((token) => lineTokens.has(token)).length;
  return matched / voucherTokens.length;
}

interface ScoredCandidate {
  candidate: MatchCandidate;
  dayGap: number;
  affinity: number;
  score: number;
}

function scoreCandidates(
  line: MatchableLine,
  candidates: MatchCandidate[],
  windowDays: number
): ScoredCandidate[] {
  const target = signedPaiseOf(line);

  return candidates
    // Amount is matched exactly, in paise, and with the sign included. A
    // ₹5,000 payment and a ₹5,000 receipt on the same day are not each other,
    // and "close enough" amounts are a different transaction, not this one.
    .filter((candidate) => candidate.bankAmountPaise === target)
    .map((candidate) => {
      const dayGap = daysBetween(line.txnDate, candidate.voucherDate);
      const affinity = narrationAffinity(line.narration, candidate.narration);
      return {
        candidate,
        dayGap,
        affinity,
        // Date proximity dominates: among vouchers of the identical amount,
        // the one dated the same day is the one that cleared. Narration only
        // separates candidates the dates can't.
        score: (windowDays + 1 - dayGap) * 10 + affinity * 5,
      };
    })
    .filter((scored) => scored.dayGap <= windowDays)
    .sort((a, b) => b.score - a.score);
}

export interface MatchOptions {
  windowDays?: number;
}

/**
 * Matches a batch of statement lines against candidate vouchers.
 *
 * Assignment is greedy over the whole batch rather than line by line: every
 * (line, voucher) pair is scored first, and the strongest pairs claim their
 * voucher before weaker ones get to look. Line-by-line would let the first
 * line in the file take a voucher dated a week away that belongs, exactly, to
 * a line further down.
 *
 * A voucher is claimed at most once — the database enforces the same thing
 * with a unique index, because two lines reconciled to one payment makes a rec
 * that balances while a real transaction is missing.
 */
export function matchStatementLines(
  lines: MatchableLine[],
  candidates: MatchCandidate[],
  options: MatchOptions = {}
): LineMatch[] {
  const windowDays = options.windowDays ?? DEFAULT_DATE_WINDOW_DAYS;

  const scoredByLine = new Map<string, ScoredCandidate[]>();
  for (const line of lines) {
    scoredByLine.set(line.id, scoreCandidates(line, candidates, windowDays));
  }

  const pairs = [...scoredByLine.entries()].flatMap(([lineId, scored]) =>
    scored.map((entry) => ({ lineId, ...entry }))
  );
  // Strongest pair first; the line id breaks ties so the result is the same on
  // every run over the same input.
  pairs.sort((a, b) => b.score - a.score || a.lineId.localeCompare(b.lineId));

  const claimedVouchers = new Set<string>();
  const resolved = new Map<string, MatchCandidate>();

  for (const pair of pairs) {
    if (resolved.has(pair.lineId)) continue;
    if (claimedVouchers.has(pair.candidate.voucherId)) continue;

    // Ambiguity check, against this line's own remaining options: if a second
    // unclaimed voucher scores just as well, nothing here can tell them apart
    // and the user has to.
    const alternatives = (scoredByLine.get(pair.lineId) ?? []).filter(
      (other) =>
        other.candidate.voucherId !== pair.candidate.voucherId &&
        !claimedVouchers.has(other.candidate.voucherId)
    );
    if (alternatives.some((other) => other.score === pair.score)) continue;

    resolved.set(pair.lineId, pair.candidate);
    claimedVouchers.add(pair.candidate.voucherId);
  }

  return lines.map((line) => {
    const scored = scoredByLine.get(line.id) ?? [];
    const matched = resolved.get(line.id) ?? null;
    return {
      lineId: line.id,
      matched,
      candidates: scored.map((entry) => entry.candidate),
      reason: describe(matched, scored, claimedVouchers),
    };
  });
}

/**
 * The line's own explanation of its result.
 *
 * `claimed` is not optional detail: a candidate another line has taken is not
 * a choice this line can be offered. Branching on the scored list alone told a
 * line to "pick one" of two vouchers that were both already gone — an
 * instruction that fails when followed, because the unique index on
 * matched_voucher_id exists precisely so a voucher cannot explain two lines.
 * What the user needs to hear in that case is the actual finding of the
 * reconciliation: the books are a voucher short for this line.
 */
function describe(
  matched: MatchCandidate | null,
  scored: ScoredCandidate[],
  claimed: Set<string>
): string {
  if (matched) {
    const gap = scored.find((entry) => entry.candidate.voucherId === matched.voucherId)?.dayGap ?? 0;
    if (gap === 0) return `Same amount and date as ${matched.voucherNumber}`;
    return `Same amount as ${matched.voucherNumber}, ${gap} day${gap === 1 ? "" : "s"} apart`;
  }

  const available = scored.filter((entry) => !claimed.has(entry.candidate.voucherId));
  if (available.length > 1) return `${available.length} vouchers of this amount are equally close — pick one`;
  // Left free by a tie that a later, lower-scoring pair then resolved in
  // another line's favour. The voucher is still open, but it was never this
  // line's on the evidence, so it is offered rather than asserted.
  if (available.length === 1) {
    return "A voucher of this amount is still unmatched, but it fits another line just as well — confirm it yourself";
  }
  if (scored.length > 1) {
    return `${scored.length} vouchers of this amount are in the books, but other lines matched them first`;
  }
  if (scored.length === 1) return "A voucher of this amount exists but another line matched it first";
  return "No voucher in the books matches this amount";
}
