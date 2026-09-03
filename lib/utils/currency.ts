/**
 * All Dr/Cr arithmetic (voucher totals, CSV whole-file balance checks) must
 * happen in integer paise, never raw floats — JS floats can make
 * `100.10 + 200.20 === 300.30` false, which would produce false "unbalanced
 * voucher" errors. Convert to paise at the boundary, do all arithmetic in
 * paise, convert back only for display.
 *
 * The database is the authority on what a figure is worth. Every rounding in
 * this file therefore reproduces Postgres `numeric`, not IEEE 754: half away
 * from zero, applied to the decimal the value actually is rather than to a
 * float that has drifted off the boundary.
 */

const CODE_FIVE = 53; // "5".charCodeAt(0)

/**
 * Rounds half away from zero — Postgres `round()`'s rule, and the rule
 * `numeric(p, s)` applies when it takes a value at a wider scale.
 *
 * `Math.round` rounds half toward +Infinity instead, so it agrees on
 * positives and disagrees on every negative half: `Math.round(-0.5)` is `-0`
 * where `round(-0.5)` in Postgres is `-1`.
 *
 * Only meaningful when `value` is already exact — an integer divided by a
 * power of ten, say. A value that reached a half boundary by multiplying a
 * float has usually landed just to one side of it already; use
 * {@link scaleDecimal} for that.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Adds one to a string of decimal digits, propagating the carry. */
function carryOne(digits: string): string {
  const out = digits.split("");
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] === "9") {
      out[i] = "0";
      continue;
    }
    out[i] = String(Number(out[i]) + 1);
    return out.join("");
  }
  return `1${out.join("")}`;
}

/**
 * Scales a decimal to an exact integer at `places` decimal places, rounding
 * half away from zero — what Postgres does when a value is stored in a
 * `numeric(p, places)` column.
 *
 * DO NOT "simplify" this back to `Math.round(value * 10 ** places)`. That is
 * what it used to be, and it was wrong twice over:
 *
 *   - The multiply lands on the wrong side of the boundary. `1.005 * 100` is
 *     `100.49999999999999`, so it rounds *down* to 100 where the column holds
 *     1.01. Measured: 28,551 of 123,787 swept values disagreed with Postgres,
 *     among them 0.145, 1.255 and 33.675. At 4dp the same fault is worse than
 *     a paisa — `0.00015 * 10000` is `1.4999999999999998`, so a rate became
 *     0.0001 against the column's 0.0002, and the error then multiplied by the
 *     quantity.
 *   - `Math.round` is half-up, not half-away-from-zero, so every negative
 *     half was a paisa short: `Math.round(-0.5)` is `-0`, Postgres gives -1.
 *
 * So this never multiplies to reach the rounding decision. It reads the
 * decimal digits of the **shortest representation that round-trips to
 * `value`** — `String(value)` — and moves the point by shifting digits, which
 * cannot drift toward a boundary at all. The single digit that decides the
 * rounding is then read directly.
 *
 * The choice of *which* decimal to read is the subtle part, and it is not
 * arbitrary. A double is not a decimal, so there are two candidates:
 *
 *   - its exact binary value, which is what `toFixed` rounds. This
 *     reproduces the bug: `(1.005).toFixed(2)` is `"1.00"`, because the double
 *     really is 1.00499999999999989.
 *   - its shortest round-tripping representation, `"1.005"`, which rounds to
 *     1.01 and agrees with the column.
 *
 * The second is correct because it is literally the text that crosses the
 * wire: `JSON.stringify` emits the shortest representation, and Postgres
 * parses those digits. Reading the same digits the database will read is the
 * whole reason this agrees with `numeric`; rounding the binary value instead
 * would be rounding something Postgres never sees.
 *
 * The fast path below skips the string work when the float product is nowhere
 * near a half boundary, which is the overwhelmingly common case: a value that
 * came back from a `numeric(18,2)` column is an exact 2dp decimal, and
 * `x * 100` for such a value sits within a few ulp of an integer. It is an
 * optimisation only — it must never decide a boundary case, which is what the
 * quarter-of-an-integer test guarantees.
 */
export function scaleDecimal(value: number, places: number): number {
  // NaN stays NaN and infinities stay infinite, as `Math.round(x * 100)` did.
  if (!Number.isFinite(value)) return value * 10 ** places;
  if (value === 0) return 0;

  const factor = 10 ** places;
  const product = value * factor;
  const nearest = Math.round(product);
  // Within a quarter of an integer is at least a quarter clear of the .5
  // boundary. The exact decimal differs from `product` by a couple of ulp —
  // about 1e-13 at this magnitude — so it cannot be on the other side, and
  // the answer is `nearest` whichever rule we apply. The magnitude guard
  // keeps ulp itself far below that quarter.
  if (Math.abs(product) < 1e15 && Math.abs(product - nearest) < 0.25) return nearest;

  const negative = value < 0;
  const text = String(negative ? -value : value);
  const parsed = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(text);
  // `String` of a finite non-zero number always matches; the fallback keeps
  // this function total rather than throwing on a shape we did not foresee.
  if (!parsed) return roundHalfAwayFromZero(product);

  const fraction = parsed[2] ?? "";
  const digits = parsed[1] + fraction;
  // Digits left standing to the right of the point once the exponent, if any,
  // has moved it.
  const fractionDigits = fraction.length - (parsed[3] ? Number(parsed[3]) : 0);
  const shift = places - fractionDigits;

  let magnitude: string;
  if (shift >= 0) {
    // The value already fits the target scale: append zeros, round nothing.
    magnitude = digits + "0".repeat(shift);
  } else {
    const dropped = -shift;
    // Left-pad so there is always a digit standing at the rounding position,
    // even when the whole value is smaller than one unit of the target scale.
    const padded = dropped >= digits.length ? "0".repeat(dropped - digits.length + 1) + digits : digits;
    const cut = padded.length - dropped;
    magnitude = padded.slice(0, cut);
    // Half away from zero: the sign is carried separately, so the first
    // discarded digit being 5 or more is the whole test.
    if (padded.charCodeAt(cut) >= CODE_FIVE) magnitude = carryOne(magnitude);
  }

  const scaled = Number(magnitude);
  return negative ? -scaled : scaled;
}

/**
 * Rupees (as entered by a user or stored in Postgres `numeric`) -> integer
 * paise, rounded exactly as a `numeric(18,2)` column rounds.
 */
export function toPaise(rupees: number): number {
  return scaleDecimal(rupees, 2);
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
