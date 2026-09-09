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
