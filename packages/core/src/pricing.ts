export const MAX_SCAN = 100;
export const TABLE_PRICE_USD = "0.03";
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
