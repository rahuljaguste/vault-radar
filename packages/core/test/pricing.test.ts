import { expect, test } from "bun:test";
import { ARC_BUCKET_PRICE, MAX_SCAN, TABLE_PRICE_USD, arcBucket, clampCount, hederaScanPriceAtomic, hederaScanPriceUsd } from "../src/pricing";
test("hedera price is 0.001 + 0.0005n", () => {
  expect(hederaScanPriceUsd(1)).toBe("0.0015"); expect(hederaScanPriceUsd(20)).toBe("0.011");
  expect(hederaScanPriceAtomic(1)).toBe("1500"); expect(hederaScanPriceAtomic(20)).toBe("11000");
});
test("hedera price at max scan has no exponent notation", () => {
  expect(hederaScanPriceUsd(100)).toBe("0.051");
});
test("arc buckets", () => {
  expect(arcBucket(1)).toBe("s"); expect(arcBucket(5)).toBe("s"); expect(arcBucket(6)).toBe("m"); expect(arcBucket(20)).toBe("m"); expect(arcBucket(21)).toBe("l");
  expect(ARC_BUCKET_PRICE.l).toBe("0.05");
});
test("clampCount", () => {
  expect(clampCount("3")).toBe(3); expect(clampCount(0)).toBeNull(); expect(clampCount("101")).toBeNull(); expect(clampCount("x")).toBeNull();
});
test("the table tier is never cheaper than a scan, at any count the service will price", () => {
  // The spec's privacy premium (§5.5): `table` hides the holding from the vendor, so it
  // must cost more than naming the holding outright. Compared in integer micro-USD
  // because these are decimal strings and a float compare of "0.051" vs "0.06" is not
  // the contract being asserted.
  const micro = (usd: string) => Math.round(Number(usd) * 1e6);
  expect(micro(hederaScanPriceUsd(MAX_SCAN))).toBeLessThan(micro(TABLE_PRICE_USD));
  // A property over the whole domain, not just the endpoint: the metered price is
  // monotonic in count, so this additionally pins that the crossover does not exist.
  for (let n = 1; n <= MAX_SCAN; n++) {
    expect(micro(hederaScanPriceUsd(n))).toBeLessThan(micro(TABLE_PRICE_USD));
  }
  // Both Arc scan buckets stay under it too, for the same reason.
  for (const price of Object.values(ARC_BUCKET_PRICE)) expect(micro(price)).toBeLessThan(micro(TABLE_PRICE_USD));
});
