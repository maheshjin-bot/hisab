/**
 * Pulls a displayable message off whatever a Supabase call threw.
 *
 * PostgrestError is a plain object, not an Error instance, so the common
 * `err instanceof Error ? err.message : fallback` idiom silently discards
 * every message the database raises — including the plain-English ones the
 * RPCs go out of their way to write.
 *
 * This does not attempt to translate Postgres error codes into user-facing
 * copy; that's a separate job.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
