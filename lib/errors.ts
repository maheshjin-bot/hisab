import { errorMessage } from "@/lib/utils/error-message";

/**
 * Postgres error codes → copy the user can act on.
 *
 * Only codes a user can actually reach through the UI are listed. Anything
 * else falls through to the caller's fallback rather than being guessed at,
 * because a wrong explanation is worse than a generic one.
 */
const BY_CODE: Record<string, string> = {
  "23505": "That name is already used in this company.",
  "23503": "That record is still referenced elsewhere.",
  "23514": "Those values aren't valid for this record.",
  "42501": "Your role doesn't allow this change.",
  "22P02": "One of those values isn't in the format expected.",
};

/**
 * The RPCs and triggers raise in plain English already — "Cannot remove the
 * last active admin of a company", "Invite has expired", "Only an admin can
 * change a ledger's opening balance or group". Those are better than anything
 * written here, because only the database knows which one applies, so they
 * pass through verbatim.
 *
 * A raised exception arrives as code P0001 (raise_exception); anything with a
 * code outside BY_CODE that carries a message is treated the same way.
 */
const RAISED_EXCEPTION = "P0001";

function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Turns whatever a Supabase call threw into a sentence worth showing.
 *
 * `fallback` should say what the user was trying to do — "Could not save
 * ledger" — since it's what they see when the failure isn't one we recognise.
 */
export function toUserMessage(err: unknown, fallback: string): string {
  const code = errorCode(err);

  if (code === RAISED_EXCEPTION) return errorMessage(err, fallback);
  if (code && BY_CODE[code]) return BY_CODE[code];

  // Constraint violations carry a details/hint pair that names the column,
  // which reads as internals; prefer the fallback over leaking it.
  if (code && /^(23|42|22)/.test(code)) return fallback;

  return errorMessage(err, fallback);
}
