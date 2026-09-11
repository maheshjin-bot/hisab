/**
 * Supabase's API returns at most 1000 rows per request (the project's "Max
 * rows" setting) and cuts the rest off silently — no error, no flag, just
 * the first 1000. A statement that must show every entry pages through with
 * `.range()` until a page comes back short.
 *
 * Must not exceed the project's Max rows: a larger page would be cut to the
 * cap, come back "short", and end the loop early.
 */
export const API_PAGE_SIZE = 1000;

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += API_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + API_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < API_PAGE_SIZE) return rows;
  }
}
