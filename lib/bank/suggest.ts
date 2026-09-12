import type { LedgerSearchResult } from "@/lib/supabase/queries/ledgers";
import type { NarrationRule, StatementDirection } from "./types";

/**
 * Turning a bank narration into a proposed account.
 *
 * Nothing here is a model — it's a normalizer, a token index and a ranking
 * rule, which is the right size for the problem. A company's statement lines
 * repeat: the same landlord, the same three suppliers, the same subscription.
 * After a user has explained a narration once, the second one should already
 * be filled in, and that is almost entirely a matter of throwing away the
 * parts of the narration that change between transactions.
 *
 * The normalizer is the contract with the database: `bank_narration_rules
 * .pattern` holds exactly what patternOf() returns, and SQL never re-derives
 * it, so there's one definition of "the same narration" and it's this one.
 */

/**
 * Rail and channel prefixes. These say how money moved, never where it went,
 * so they're noise for the purpose of identifying a counterparty — and they're
 * high-frequency noise, which makes them actively harmful to token overlap
 * scoring if left in.
 */
const RAIL_TOKENS = new Set([
  "upi", "neft", "imps", "rtgs", "ach", "achdr", "achcr", "nach", "ecs",
  "pos", "atm", "atw", "nfs", "cash", "chq", "cheque", "clg", "mmt", "inf",
  "bil", "cms", "onl", "ib", "ibft", "vps", "eba", "sbi", "tpt", "trf",
  "transfer", "payment", "paytm", "razorpay", "billdesk", "ccavenue",
  // "dr"/"cr" appear inside narrations as direction markers ("NEFT DR-...")
  // as well as in their own column, and they carry no counterparty at all.
  "dr", "cr", "debit", "credit", "card", "txn", "ref", "refno", "utr", "no", "to", "from",
  "by", "via", "the", "and", "for", "of", "a", "an", "in", "on", "at",
]);

/** Long digit runs are reference numbers; they never repeat, so they're noise. */
const REFERENCE_LIKE = /^\d{4,}$/;
const DATE_LIKE = /^\d{1,2}[-/]\d{1,2}([-/]\d{2,4})?$/;

/**
 * Splits a narration into the words that might identify a counterparty.
 *
 * Everything dropped here is dropped because it varies between two
 * transactions with the same meaning: reference numbers, dates, the rail, and
 * single characters left behind by splitting on separators.
 */
export function tokenize(narration: string): string[] {
  return narration
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)
    .filter((token) => !RAIL_TOKENS.has(token))
    .filter((token) => !REFERENCE_LIKE.test(token))
    .filter((token) => !DATE_LIKE.test(token))
    // A token that is mostly digits with a letter or two stuck on is a
    // reference in disguise — "utr123456", "ref00921".
    .filter((token) => !/^\w*?\d{4,}\w*$/.test(token));
}

/**
 * The stable key for a narration, stored on the learned rule.
 *
 * Capped at four tokens: a longer key is more precise but matches less often,
 * and the point of the rule is to fire on the *next* transaction from the same
 * counterparty, whose narration will carry a different reference and possibly
 * a different amount suffix. Sorted so two orderings of the same words produce
 * one rule rather than two.
 */
export function patternOf(narration: string): string {
  const tokens = tokenize(narration);
  if (tokens.length === 0) return "";
  // Longest first: the distinctive part of a narration is rarely its short
  // words, and the cap has to spend its four slots well.
  const ranked = [...new Set(tokens)].sort((a, b) => b.length - a.length || a.localeCompare(b));
  return ranked.slice(0, 4).sort().join(" ");
}

export interface LedgerSuggestion {
  ledgerId: string;
  /** 0..1. Above HIGH_CONFIDENCE the UI pre-selects; below it only offers. */
  confidence: number;
  reason: string;
}

/**
 * The bar for "fill this in for the user" rather than "offer it".
 *
 * Set where an exact repeat of a narration the user has already explained
 * clears it and nothing else does. A wrong pre-selection that gets posted is a
 * wrong voucher, so the asymmetry is deliberate.
 */
export const HIGH_CONFIDENCE = 0.8;

/**
 * How much of a *rule's* pattern the narration contains.
 *
 * Deliberately one-directional. The symmetric measure (Jaccard) punishes a
 * narration for carrying extra words, but carrying extra words is exactly what
 * narrations do — "RAJESH TRADERS" learned in Mumbai has to still fire on
 * "NEFT RAJESH TRADERS DELHI BRANCH", and under Jaccard that scores 0.4 and
 * misses. The question worth asking is "is the counterparty I learned present
 * here", and that is containment.
 */
function containment(narrationTokens: Set<string>, ruleTokens: Set<string>): number {
  if (ruleTokens.size === 0) return 0;
  let matched = 0;
  for (const token of ruleTokens) if (narrationTokens.has(token)) matched++;
  return matched / ruleTokens.size;
}

/**
 * How much a rule's repeated use should count for.
 *
 * Saturating rather than linear: the difference between a rule used once and
 * one used five times is real, between fifty and a hundred it isn't, and
 * without a ceiling one heavily-used rule would outrank a better-matching one
 * forever.
 */
function hitWeight(hitCount: number): number {
  return Math.min(hitCount, 10) / 10;
}

export interface SuggestOptions {
  bankLedgerId: string;
  rules: NarrationRule[];
  /** Used for the name-matching fallback that carries the first import, before any rule exists. */
  ledgers?: LedgerSearchResult[];
}

/**
 * Proposes the other side of the entry for one statement line.
 *
 * Three sources, in descending order of how much they deserve to be trusted:
 *
 *  1. An exact pattern match on a rule the user taught this account.
 *  2. A partial token overlap with a rule — the same counterparty, a slightly
 *     different narration.
 *  3. The narration naming a ledger outright. This is what makes the very
 *     first import useful, when there are no rules at all: a company whose
 *     books already contain "Bharti Airtel" doesn't need to be taught that
 *     "NEFT/BHARTI AIRTEL LTD/..." belongs there.
 */
export function suggestLedger(
  line: { narration: string; withdrawalPaise: number; depositPaise: number },
  options: SuggestOptions
): LedgerSuggestion | null {
  const direction: StatementDirection = line.withdrawalPaise > 0 ? "withdrawal" : "deposit";
  const pattern = patternOf(line.narration);
  const tokens = new Set(tokenize(line.narration));

  const candidates: LedgerSuggestion[] = [];
  const consider = (candidate: LedgerSuggestion) => candidates.push(candidate);

  for (const rule of options.rules) {
    if (rule.direction !== direction) continue;
    // A rule scoped to another bank account says nothing about this one; a
    // rule with no scope applies everywhere.
    if (rule.bankLedgerId !== null && rule.bankLedgerId !== options.bankLedgerId) continue;

    const ruleTokens = new Set(rule.pattern.split(" ").filter(Boolean));

    if (pattern !== "" && rule.pattern === pattern) {
      // Certainty comes from the user having posted this exact narration
      // before; repetition raises it from "probably" to "yes".
      consider({
        ledgerId: rule.contraLedgerId,
        confidence: Math.min(0.85 + hitWeight(rule.hitCount) * 0.15, 1),
        reason: rule.isManual
          ? "Matches a rule you set up"
          : `You posted this description to that account ${rule.hitCount === 1 ? "once" : `${rule.hitCount} times`} before`,
      });
      continue;
    }

    const overlap = containment(tokens, ruleTokens);
    const matchedTokens = overlap * ruleTokens.size;
    // Two tokens in common, or a single-token rule matched outright. One token
    // out of three is a coincidence, not a counterparty.
    if (overlap >= 0.6 && (matchedTokens >= 2 || ruleTokens.size === 1)) {
      consider({
        ledgerId: rule.contraLedgerId,
        // Capped below HIGH_CONFIDENCE on purpose: a partial match is a
        // suggestion to look at, never something to post unread.
        confidence: Math.min(0.4 + overlap * 0.35 + hitWeight(rule.hitCount) * 0.05, 0.79),
        reason: "Similar to a description you've posted before",
      });
    }
  }

  const byName = suggestByLedgerName(tokens, options.ledgers ?? [], options.bankLedgerId);
  if (byName) consider(byName);

  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) =>
    candidate.confidence > best.confidence ? candidate : best
  );
}

/**
 * Falls back to the chart of accounts itself: does the narration contain the
 * name of a ledger?
 *
 * Scored on how much of the *ledger's* name the narration covers, not the
 * other way round — a narration is long and full of rail noise, so requiring
 * it to look like the ledger name would match nothing.
 */
function suggestByLedgerName(
  tokens: Set<string>,
  ledgers: LedgerSearchResult[],
  bankLedgerId: string
): LedgerSuggestion | null {
  let best: LedgerSuggestion | null = null;

  for (const ledger of ledgers) {
    if (ledger.id === bankLedgerId) continue;
    // Another bank or cash account is where a transfer goes, and transfers
    // look like everything else in a narration. Leave those to the user.
    if (ledger.ledgerRole === "cash_bank") continue;

    const nameTokens = tokenize(ledger.name);
    if (nameTokens.length === 0) continue;

    const matched = nameTokens.filter((token) => tokens.has(token)).length;
    const coverage = matched / nameTokens.length;
    // A single common word in common ("services", "traders") is not a match.
    if (coverage < 1 && matched < 2) continue;
    if (coverage < 0.6) continue;

    const confidence = Math.min(0.35 + coverage * 0.35, 0.7);
    if (!best || confidence > best.confidence) {
      best = { ledgerId: ledger.id, confidence, reason: `The description names "${ledger.name}"` };
    }
  }

  return best;
}

/**
 * Applies suggestions to a batch of lines in one pass.
 *
 * Returned as a map rather than mutated onto the lines so the caller can keep
 * server state and derived state apart.
 */
export function suggestForLines<T extends { id: string; narration: string; withdrawalPaise: number; depositPaise: number }>(
  lines: T[],
  options: SuggestOptions
): Map<string, LedgerSuggestion> {
  const suggestions = new Map<string, LedgerSuggestion>();
  for (const line of lines) {
    const suggestion = suggestLedger(line, options);
    if (suggestion) suggestions.set(line.id, suggestion);
  }
  return suggestions;
}
