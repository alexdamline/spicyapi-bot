/**
 * Money is kept as integer nano-dollars (1 USD = 1e9) so that sums never drift the way binary
 * floats do. SpicyAPI returns amounts as decimal strings with up to nine decimal places, which maps
 * onto this unit exactly.
 */
export type Nanos = number;

export const NANOS_PER_USD = 1_000_000_000;

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Parses a non-negative USD decimal string ("0.01", "1", "0.000425"). Returns undefined when it is not one. */
export function parseUsd(value: unknown): Nanos | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value * NANOS_PER_USD);
  }
  if (typeof value !== "string") return undefined;
  const match = DECIMAL.exec(value.trim());
  if (!match) return undefined;
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").slice(0, 9).padEnd(9, "0");
  const nanos = whole * NANOS_PER_USD + Number(fraction);
  return Number.isSafeInteger(nanos) ? nanos : undefined;
}

/** Same as parseUsd, but throws with a readable message. Used for configuration values. */
export function requireUsd(value: string, label: string): Nanos {
  const parsed = parseUsd(value);
  if (parsed === undefined) throw new Error(`${label} must be a dollar amount such as 0.50 (got "${value}")`);
  return parsed;
}

/**
 * Formats an amount for people: at least two decimals, more when the amount needs them
 * ($0.01, $0.0225, $1.50), and never more than six.
 */
export function formatUsd(nanos: Nanos): string {
  const sign = nanos < 0 ? "-" : "";
  const abs = Math.abs(Math.round(nanos));
  const whole = Math.floor(abs / NANOS_PER_USD);
  let fraction = String(abs % NANOS_PER_USD).padStart(9, "0").slice(0, 6);
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${sign}$${whole}.${fraction}`;
}
