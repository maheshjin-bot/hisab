/**
 * All Dr/Cr arithmetic (voucher totals, CSV whole-file balance checks) must
 * happen in integer paise, never raw floats — JS floats can make
 * `100.10 + 200.20 === 300.30` false, which would produce false "unbalanced
 * voucher" errors. Convert to paise at the boundary, do all arithmetic in
 * paise, convert back only for display.
 */

/** Rupees (as entered by a user or stored in Postgres `numeric`) -> integer paise. */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Integer paise -> rupees, for display or before sending to Postgres. */
export function fromPaise(paise: number): number {
  return paise / 100;
}

export function sumPaise(paiseAmounts: number[]): number {
  return paiseAmounts.reduce((total, p) => total + p, 0);
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrFormatterNoDecimals = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Formats rupees using Indian digit grouping (₹10,00,000.00, not ₹1,000,000.00). */
export function formatCurrency(rupees: number, opts?: { decimals?: boolean }): string {
  return (opts?.decimals === false ? inrFormatterNoDecimals : inrFormatter).format(rupees);
}

/** Formats a signed rupee movement with an explicit Dr/Cr suffix, e.g. "₹1,250.00 Dr". */
export function formatWithDrCr(rupees: number): string {
  const type = rupees < 0 ? "Cr" : "Dr";
  return `${formatCurrency(Math.abs(rupees))} ${type}`;
}
