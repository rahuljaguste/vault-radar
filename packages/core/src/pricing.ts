export const MAX_SCAN = 100;
/**
 * Flat price of the `table` tier on both rails (spec §5.5). The tier exists as a
 * *privacy* product: it buys every vault of one protocol so the vendor never learns
 * which vault is held, and the spec states it must never be cheaper than a sealed
 * `scan`. A metered scan of the maximum `MAX_SCAN` vaults costs
 * `hederaScanPriceUsd(100)` = 0.051 USD, so the previous 0.03 made `table` the cheaper
 * of the two for any scan above 58 vaults — inverting the premium the spec describes and
 * letting a caller buy whole-protocol data for less than the narrower request.
 * `pricing.test.ts` pins the crossover as a property: `hederaScanPriceUsd(MAX_SCAN)`
 * must stay strictly below `TABLE_PRICE_USD` at every count.
 */
export const TABLE_PRICE_USD = "0.06";
export const ARC_BUCKET_PRICE = { s: "0.003", m: "0.01", l: "0.05" } as const;
export function clampCount(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_SCAN ? n : null;
}
export function hederaScanPriceAtomic(count: number): string { return String(1000 + 500 * count); }
export function hederaScanPriceUsd(count: number): string {
  const atomic = 1000 + 500 * count; return (atomic / 1e6).toString();
}
export const arcBucket = (count: number): "s" | "m" | "l" => (count <= 5 ? "s" : count <= 20 ? "m" : "l");
