/** Groups rows by a derived key, preserving first-seen group order (used to cluster CSV rows into one voucher, etc.). */
export function groupRowsBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return groups;
}
