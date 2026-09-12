### Task 8: Pricing

**Files:**
- Create: `packages/core/src/pricing.ts`, `packages/core/test/pricing.test.ts`

**Interfaces:**
- Produces: `hederaScanPriceUsd(count: number): string` (e.g. `"0.0035"` for 5), `hederaScanPriceAtomic(count): string` (USDC 6 decimals, e.g. `"3500"`), `arcBucket(count): "s" | "m" | "l"`, `ARC_BUCKET_PRICE = { s: "0.003", m: "0.01", l: "0.05" }`, `TABLE_PRICE_USD = "0.03"`, `MAX_SCAN = 100`, `clampCount(raw: unknown): number | null` (integer 1..100 else null).

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { ARC_BUCKET_PRICE, arcBucket, clampCount, hederaScanPriceAtomic, hederaScanPriceUsd } from "../src/pricing";
test("hedera price is 0.001 + 0.0005n", () => {
  expect(hederaScanPriceUsd(1)).toBe("0.0015"); expect(hederaScanPriceUsd(20)).toBe("0.011");
  expect(hederaScanPriceAtomic(1)).toBe("1500"); expect(hederaScanPriceAtomic(20)).toBe("11000");
});
test("arc buckets", () => {
  expect(arcBucket(1)).toBe("s"); expect(arcBucket(5)).toBe("s"); expect(arcBucket(6)).toBe("m"); expect(arcBucket(20)).toBe("m"); expect(arcBucket(21)).toBe("l");
  expect(ARC_BUCKET_PRICE.l).toBe("0.05");
});
test("clampCount", () => {
  expect(clampCount("3")).toBe(3); expect(clampCount(0)).toBeNull(); expect(clampCount("101")).toBeNull(); expect(clampCount("x")).toBeNull();
});
```

- [ ] **Step 2: Implement**

```ts
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
```

- [ ] **Step 3: Run, expect pass. Commit** — `git add -A && git commit -m "feat(core): metered pricing for Hedera and bucketed Arc routes"`

