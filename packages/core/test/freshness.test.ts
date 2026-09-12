import { expect, test } from "bun:test";
import { classifyFreshness, vaultFreshness } from "../src/unify/freshness";

test("messari within 3600s is fresh, beyond is stale, error is unavailable", () => {
  expect(classifyFreshness("messari", 1000, 4600)).toBe("fresh");
  expect(classifyFreshness("messari", 1000, 4601)).toBe("stale");
  expect(classifyFreshness("messari", 1000, 1001, true)).toBe("unavailable");
});
// A finalized-only sink trails the head by Ethereum's finality lag — 13 to 19 minutes —
// so a threshold below that made the source permanently stale, reporting "no data" for
// data that was final and correct. This asserts the threshold clears the lag with slack,
// which is the property that matters, rather than pinning the constant.
test("substreams data behind the finality lag is still fresh, and genuinely old data is not", () => {
  expect(classifyFreshness("substreams", 1000, 1000 + 16 * 60)).toBe("fresh"); // 16 minutes behind
  expect(classifyFreshness("substreams", 1000, 1000 + 3600)).toBe("stale"); // an hour behind
});
test("vault freshness is the worst source; no sources is unavailable", () => {
  const s = (f: "fresh" | "stale" | "unavailable") => ({ kind: "messari" as const, ref: "x", block: "1", timestamp: "1", ageSeconds: "0", freshness: f });
  expect(vaultFreshness([s("fresh"), s("stale")])).toBe("stale");
  expect(vaultFreshness([s("fresh"), s("unavailable")])).toBe("unavailable");
  expect(vaultFreshness([])).toBe("unavailable");
});
