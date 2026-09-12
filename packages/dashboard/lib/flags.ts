/**
 * Risk flags, as the risk engine writes them and as a person reads them.
 *
 * `risk.ts` records every threshold and value as a plain ratio to six decimal places —
 * `-0.124000` is a 12.4% drawdown, `0.250000` is a 25% outflow — because that is what the
 * comparison arithmetic needs and what a signed receipt should carry. It is not what anyone
 * wants to read, and it is not what the committed demo fixture shows: that file was written
 * by hand with `-12.4%` strings, so the same flag rendered one way on the demo run and
 * another on a real one. Formatting belongs in the view, so it lives here.
 */

export type Flag = { name: string; value: string; threshold: string; window: string };

/** The flags whose values are ratios of a whole, rendered as percentages. */
const RATIO_FLAGS = new Set(["tvl_outflow_24h", "deposit_limit_reached"]);

const isRatio = (name: string): boolean => RATIO_FLAGS.has(name) || name.startsWith("share_price_drawdown") || name.startsWith("share_price_drop");

/** A flag's value as a percentage number, e.g. `-12.4`. */
export function flagPercent(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  // The engine writes ratios; the fixture wrote percentages. Accept both rather than
  // rendering a 0.12% drawdown as 0.1% or a 1240% one.
  return Math.abs(n) > 1 ? n : n * 100;
}

/** The name as words: `share_price_drop` becomes `share price drop`. */
export const flagLabel = (name: string): string => name.replace(/_/g, " ");

/** A flag as one line: `share price drop −12.4% (threshold 5.0%, window 24h)`. */
export function formatFlag(f: Flag): string {
  if (!isRatio(f.name)) return `${flagLabel(f.name)}: ${f.value}${f.window === "now" ? "" : ` (window ${f.window})`}`;
  return `${flagLabel(f.name)} ${flagPercent(f.value).toFixed(1)}% below its ${flagPercent(f.threshold).toFixed(1)}% threshold (${f.window})`;
}
