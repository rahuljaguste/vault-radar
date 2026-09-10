import { expect, test } from "bun:test";
import yieldFx from "./fixtures/yield-vaults.json";
import lendFx from "./fixtures/lending-markets.json";
import { mapLendingMarkets, mapYieldVaults } from "../src/standardized/map";
import type { Deployment } from "../src/standardized/types";

const d = (schema: "yield-aggregator" | "lending"): Deployment => ({
  protocol: "p", chain: "ethereum", chainId: "1", schema, subgraphId: "S", deploymentId: "Qm1", status: "live", headLagSeconds: 0, verifiedAt: null,
});

test("yield vault maps to UnifiedVault with history and source", () => {
  const [v] = mapYieldVaults(d("yield-aggregator"), yieldFx, Number(yieldFx._meta.block.timestamp) + 10);
  expect(v.kind).toBe("yield-vault");
  expect(v.sharePrice).toBe("1.05");
  expect(v.id).toMatch(/^1:0x/);
  expect(v.history.length).toBe(4);
  expect(v.sources[0]).toMatchObject({ kind: "messari", ref: "Qm1", freshness: "fresh" });
  expect(v.asset).toEqual({ symbol: "USDC", decimals: 6 });
});

test("lending market uses exchangeRate and net flow from withdraw−deposit", () => {
  const [m] = mapLendingMarkets(d("lending"), lendFx, Number(lendFx._meta.block.timestamp) + 10);
  expect(m.kind).toBe("lending-market");
  expect(m.sharePrice).toBe(lendFx.markets[0].exchangeRate);
  expect(m.history[0].netFlowAssets).not.toBeNull();
  expect(m.history[0].netFlowAssets).toBe("2000.00");
});

test("lending history stays timestamp-descending after merging hourly and daily series", () => {
  const [m] = mapLendingMarkets(d("lending"), lendFx, Number(lendFx._meta.block.timestamp) + 10);
  expect(m.history.map(h => h.timestamp)).toEqual(["1759999900", "1759996300", "1759913600", "1759827200"]);
  expect(m.history.map(h => h.netFlowAssets)).toEqual(["2000.00", "-500.00", "20000.00", "-5000.00"]);
});

// Which series a point came from has to survive the merge, because `risk.ts` sums flows over
// a 24 h window and the two series each already account for that whole window — summing
// across them double-counts. The label is how it picks one.
test("every mapped point carries the series it came from", () => {
  const [m] = mapLendingMarkets(d("lending"), lendFx, Number(lendFx._meta.block.timestamp) + 10);
  expect(m.history.map(h => h.series)).toEqual(["hourly", "hourly", "daily", "daily"]);

  const [v] = mapYieldVaults(d("yield-aggregator"), yieldFx, Number(yieldFx._meta.block.timestamp) + 10);
  expect(v.history.map(h => h.series)).toEqual(["hourly", "hourly", "daily", "daily"]);
});

test("yield net flow is diffed within each series (hourly-vs-hourly, daily-vs-daily), never across the hourly/daily boundary", () => {
  const [v] = mapYieldVaults(d("yield-aggregator"), yieldFx, Number(yieldFx._meta.block.timestamp) + 10);
  expect(v.history.map(h => h.timestamp)).toEqual(["1759999900", "1759996300", "1759913600", "1759827200"]);
  // Newest hourly point diffs against the previous (older) hourly point, same series.
  expect(v.history[0].netFlowAssets).toBe("400000000");
  // Oldest hourly point has no older hourly point to diff against: null, NOT a value
  // computed against the newest daily point (999500000000 - 995000000000 = 4500000000
  // is what the old cross-series-by-array-position bug would have produced here).
  expect(v.history[1].netFlowAssets).toBeNull();
  // Newest daily point diffs against the previous (older) daily point, same series.
  expect(v.history[2].netFlowAssets).toBe("5000000000");
  // Oldest daily point has no older daily point to diff against.
  expect(v.history[3].netFlowAssets).toBeNull();
  for (let i = 1; i < v.history.length; i++) {
    expect(Number(v.history[i - 1].timestamp)).toBeGreaterThanOrEqual(Number(v.history[i].timestamp));
  }
});

test("missing snapshot arrays degrade to empty history instead of throwing", () => {
  const noSnaps = { ...yieldFx, vaults: [{ ...yieldFx.vaults[0], hourlySnapshots: undefined, dailySnapshots: undefined }] };
  const [v] = mapYieldVaults(d("yield-aggregator"), noSnaps, Number(yieldFx._meta.block.timestamp) + 10);
  expect(v.history).toEqual([]);
});

test("stale block on a live deployment is reflected in freshness, not thrown", () => {
  const farFuture = Number(yieldFx._meta.block.timestamp) + 100000;
  const [v] = mapYieldVaults(d("yield-aggregator"), yieldFx, farFuture);
  expect(v.sources[0].freshness).toBe("stale");
  expect(v.freshness).toBe("stale");
});
