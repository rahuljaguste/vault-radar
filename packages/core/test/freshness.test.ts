import { expect, test } from "bun:test";
import { classifyFreshness, vaultFreshness } from "../src/unify/freshness";

test("messari within 3600s is fresh, beyond is stale, error is unavailable", () => {
  expect(classifyFreshness("messari", 1000, 4600)).toBe("fresh");
  expect(classifyFreshness("messari", 1000, 4601)).toBe("stale");
  expect(classifyFreshness("messari", 1000, 1001, true)).toBe("unavailable");
});
test("substreams threshold is 300s", () => {
  expect(classifyFreshness("substreams", 1000, 1300)).toBe("fresh");
  expect(classifyFreshness("substreams", 1000, 1301)).toBe("stale");
});
test("vault freshness is the worst source; no sources is unavailable", () => {
  const s = (f: "fresh" | "stale" | "unavailable") => ({ kind: "messari" as const, ref: "x", block: "1", timestamp: "1", ageSeconds: "0", freshness: f });
  expect(vaultFreshness([s("fresh"), s("stale")])).toBe("stale");
  expect(vaultFreshness([s("fresh"), s("unavailable")])).toBe("unavailable");
  expect(vaultFreshness([])).toBe("unavailable");
});
