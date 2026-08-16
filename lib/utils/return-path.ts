/**
 * A `?next=` value arrives from the URL bar and is therefore attacker-supplied.
 * Only same-origin, path-absolute values are allowed through — anything that
 * could resolve to another origin (`//evil.com`, `/\evil.com`, `https://…`)
 * is discarded rather than sanitised, since there is no legitimate reason for
 * an internal return path to look like any of those.
 */
export function safeReturnPath(value: string | null | undefined, fallback = "/"): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  // Protocol-relative and backslash-escaped forms both resolve off-origin in
  // at least one major browser.
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}

/** Builds the login URL that returns to `path` once the visitor signs in. */
export function loginUrlReturningTo(path: string | null | undefined): string {
  const safe = safeReturnPath(path, "");
  return safe ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}
