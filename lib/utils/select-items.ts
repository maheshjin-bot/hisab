/**
 * THE LABEL A SELECT'S TRIGGER SHOWS.
 *
 * Base UI's `<Select.Value>` does not read the chosen `<Select.Item>`'s
 * children. It resolves the label from the `items` map handed to
 * `<Select.Root>`, and with no map — or with a value the map doesn't cover —
 * it falls back to printing the raw value. That is how the Parties & Ledgers
 * group filter came to show `952bbb4d-32bb-40b9…` where a group's name
 * belonged: nothing was wrong with the option list, only with what the trigger
 * had to work from. A Select whose values happen to *be* their labels looks
 * correct by accident; every other one needs `items`.
 *
 * These two build that map, and cover the two ways it tends to go wrong: a
 * list that hasn't loaded yet, and a sentinel option ("all") that belongs to
 * the filter rather than to the data behind it.
 */

/**
 * Builds a value → label map from the same list the options are rendered from.
 *
 * `fixed` carries the entries that aren't in the list — the "All groups"
 * sentinel of a filter, say. A still-loading list is not an error: the fixed
 * entries alone are a perfectly good map until the rest arrives.
 */
export function selectItems<T>(
  rows: readonly T[] | null | undefined,
  toEntry: (row: T) => readonly [value: string, label: string],
  fixed?: Record<string, string>,
): Record<string, string> {
  const items: Record<string, string> = { ...fixed };
  for (const row of rows ?? []) {
    const [value, label] = toEntry(row);
    items[value] = label;
  }
  return items;
}

/**
 * Covers the selected value while its list is still loading.
 *
 * An edit form opens on the id it is editing long before the query naming that
 * id comes back, and for those few frames Base UI would print the id itself.
 * Pointing the unresolved value at the placeholder makes the trigger read like
 * an unanswered control instead — which is what it is, as far as the user can
 * tell. Once the list arrives the value resolves for real and this does
 * nothing.
 */
export function itemsWithPending(
  items: Record<string, string>,
  value: string | null | undefined,
  placeholder: string,
): Record<string, string> {
  if (!value || Object.prototype.hasOwnProperty.call(items, value)) return items;
  return { ...items, [value]: placeholder };
}
