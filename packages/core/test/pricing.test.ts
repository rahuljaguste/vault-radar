import { expect, test } from "bun:test";
import { ARC_BUCKET_PRICE, arcBucket, clampCount, hederaScanPriceAtomic, hederaScanPriceUsd } from "../src/pricing";
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
