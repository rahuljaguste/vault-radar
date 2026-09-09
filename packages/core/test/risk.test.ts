import { expect, test } from "bun:test";
import { computeRisk } from "../src/risk";
import type { UnifiedVault } from "../src/unify/types";

const now = 1_760_000_000;
const mk = (over: Partial<UnifiedVault>): UnifiedVault => ({
  id: "1:0xv", kind: "erc4626", protocol: "morpho", chain: "ethereum", chainId: "1", asset: { symbol: "USDC", decimals: 6 },
  sharePrice: "1.00", tvlUsd: "1000000", inputTokenBalance: "1000000000000", depositLimit: null,
  history: [], sources: [{ kind: "substreams", ref: "erc4626-vault-metrics", block: "1", timestamp: String(now - 10), ageSeconds: "10", freshness: "fresh" }],
  freshness: "fresh", ...over,
});
test("healthy vault is ok with score 0", () => {
  const r = computeRisk(mk({ history: [{ block: "0", timestamp: String(now - 86400), sharePrice: "0.99", tvlUsd: "1000000", netFlowAssets: "0" }] }), now);
  expect(r.verdict).toBe("ok"); expect(r.score).toBe(0);
});
test("3% 24h drawdown → watch (25)", () => {
  const r = computeRisk(mk({ sharePrice: "0.97", history: [{ block: "0", timestamp: String(now - 86000), sharePrice: "1.00", tvlUsd: null, netFlowAssets: "0" }] }), now);
  expect(r.flags.map(f => f.name)).toEqual(["share_price_drawdown_24h"]);
  expect(r.score).toBe(25); expect(r.verdict).toBe("watch");
});
test("drawdown 24h plus 25% outflow → alert", () => {
  const r = computeRisk(mk({ sharePrice: "0.97", inputTokenBalance: "1000", history: [
    { block: "0", timestamp: String(now - 86000), sharePrice: "1.00", tvlUsd: null, netFlowAssets: "-250" },
  ] }), now);
  expect(r.score).toBe(50); expect(r.verdict).toBe("alert");
});
test("1h flag skipped without hourly data, fires with it", () => {
  const withHourly = mk({ sharePrice: "0.99", history: [{ block: "0", timestamp: String(now - 3700), sharePrice: "1.00", tvlUsd: null, netFlowAssets: "0" }] });
  expect(computeRisk(withHourly, now).flags[0]?.name).toBe("share_price_drawdown_1h");
});
test("stale source → unavailable regardless of numbers", () => {
  const r = computeRisk(mk({ freshness: "stale", sources: [{ kind: "messari", ref: "Qm", block: "1", timestamp: String(now - 9999), ageSeconds: "9999", freshness: "stale" }] }), now);
  expect(r.verdict).toBe("unavailable");
  expect(r.flags.some(f => f.name === "stale_data")).toBe(true);
  expect(r.evidence[0].ageSeconds).toBe("9999");
});
test("deposit limit reached adds 10", () => {
  const r = computeRisk(mk({ inputTokenBalance: "100", depositLimit: "100" }), now);
  expect(r.score).toBe(10); expect(r.flags[0].name).toBe("deposit_limit_reached");
});
