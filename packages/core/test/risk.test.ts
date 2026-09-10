import { expect, test } from "bun:test";
import { computeRisk } from "../src/risk";
import type { HistoryPoint, UnifiedVault } from "../src/unify/types";

const now = 1_760_000_000;
const mk = (over: Partial<UnifiedVault>): UnifiedVault => ({
  id: "1:0xv", kind: "erc4626", protocol: "morpho", chain: "ethereum", chainId: "1", asset: { symbol: "USDC", decimals: 6 },
  sharePrice: "1.00", tvlUsd: "1000000", inputTokenBalance: "1000000000000", depositLimit: null,
  history: [], sources: [{ kind: "substreams", ref: "erc4626-vault-metrics", block: "1", timestamp: String(now - 10), ageSeconds: "10", freshness: "fresh" }],
  freshness: "fresh", ...over,
});
test("healthy vault is ok with score 0", () => {
  const r = computeRisk(mk({ history: [{ block: "0", timestamp: String(now - 86400), sharePrice: "0.99", tvlUsd: "1000000", netFlowAssets: "0", series: "block" }] }), now);
  expect(r.verdict).toBe("ok"); expect(r.score).toBe(0);
});
test("3% 24h drawdown → watch (25)", () => {
  const r = computeRisk(mk({ sharePrice: "0.97", history: [{ block: "0", timestamp: String(now - 86000), sharePrice: "1.00", tvlUsd: null, netFlowAssets: "0", series: "block" }] }), now);
  expect(r.flags.map(f => f.name)).toEqual(["share_price_drawdown_24h"]);
  expect(r.score).toBe(25); expect(r.verdict).toBe("watch");
});
test("drawdown 24h plus 25% outflow → alert", () => {
  const r = computeRisk(mk({ sharePrice: "0.97", inputTokenBalance: "1000", history: [
    { block: "0", timestamp: String(now - 86000), sharePrice: "1.00", tvlUsd: null, netFlowAssets: "-250", series: "block" },
  ] }), now);
  expect(r.score).toBe(50); expect(r.verdict).toBe("alert");
});
test("1h flag skipped without hourly data, fires with it", () => {
  const withHourly = mk({ sharePrice: "0.99", history: [{ block: "0", timestamp: String(now - 3700), sharePrice: "1.00", tvlUsd: null, netFlowAssets: "0", series: "block" }] });
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
test("deposit limit flag echoes exact atomic strings beyond Number.MAX_SAFE_INTEGER", () => {
  const bigBal = "123456789012345678901234567890";
  const bigLim = "100000000000000000000000000000";
  const r = computeRisk(mk({ inputTokenBalance: bigBal, depositLimit: bigLim }), now);
  const flag = r.flags.find(f => f.name === "deposit_limit_reached");
  expect(flag?.value).toBe(bigBal);
  expect(flag?.threshold).toBe(bigLim);
});

/* ---------------------------------------------- the 24 h outflow, per series */

const point = (over: Partial<HistoryPoint> & { series: HistoryPoint["series"]; timestamp: string }): HistoryPoint => ({
  block: "0", sharePrice: "1.00", tvlUsd: null, netFlowAssets: null, ...over,
});

// The real shape of a Messari-mapped history: 24 hourly snapshots *and* 8 daily ones in one
// array. The hourly flows inside the window already telescope to the whole window's
// movement, and the newest daily point states roughly that same movement again — so summing
// across both reported about twice the real outflow. 11.5% read as 23%, crossed the 20%
// threshold, added 25 points and turned an `ok` vault into a `watch`.
test("a merged hourly+daily history reports the 24 h outflow once, not twice", () => {
  const hourly = Array.from({ length: 24 }, (_, i) =>
    point({ series: "hourly", timestamp: String(now - i * 3600), netFlowAssets: i === 23 ? null : "-5000" }),
  );
  const daily = point({ series: "daily", timestamp: String(now - 7200), netFlowAssets: "-115000" });
  const r = computeRisk(mk({ inputTokenBalance: "1000000", history: [...hourly, daily] }), now);

  // 23 hourly flows of -5000 on a balance of 1,000,000 is 11.5%: under the threshold.
  expect(r.flags.map(f => f.name)).not.toContain("tvl_outflow_24h");
  expect(r.score).toBe(0);
  expect(r.verdict).toBe("ok");
});

test("a daily-only history still flags a 25% outflow", () => {
  const r = computeRisk(
    mk({
      inputTokenBalance: "1000000",
      history: [point({ series: "daily", timestamp: String(now - 3600), netFlowAssets: "-250000" })],
    }),
    now,
  );
  const flag = r.flags.find(f => f.name === "tvl_outflow_24h");
  expect(flag?.value).toBe("0.250000");
  expect(flag?.threshold).toBe("0.200000");
  expect(flag?.window).toBe("24h");
  expect(r.score).toBe(25);
  expect(r.verdict).toBe("watch");
});

test("the finest series in the window wins: hourly is used even when daily also covers it", () => {
  // Hourly says 5%, daily says 30%. Only the hourly figure is used, so no flag.
  const r = computeRisk(
    mk({
      inputTokenBalance: "1000000",
      history: [
        point({ series: "hourly", timestamp: String(now - 3600), netFlowAssets: "-50000" }),
        point({ series: "daily", timestamp: String(now - 7200), netFlowAssets: "-300000" }),
      ],
    }),
    now,
  );
  expect(r.flags.map(f => f.name)).not.toContain("tvl_outflow_24h");
});

test("a block series (the Substreams path) keeps summing every point in the window", () => {
  // Per-block rows each carry that block's own movement, so these genuinely do add up.
  const r = computeRisk(
    mk({
      inputTokenBalance: "1000",
      history: [
        point({ series: "block", timestamp: String(now - 100), netFlowAssets: "-150" }),
        point({ series: "block", timestamp: String(now - 200), netFlowAssets: "-100" }),
      ],
    }),
    now,
  );
  const flag = r.flags.find(f => f.name === "tvl_outflow_24h");
  expect(flag?.value).toBe("0.250000");
});

test("a flow older than 24 h is outside the window and does not pull a series in", () => {
  const r = computeRisk(
    mk({
      inputTokenBalance: "1000000",
      history: [
        point({ series: "hourly", timestamp: String(now - 86400 * 2), netFlowAssets: "-500000" }),
        point({ series: "daily", timestamp: String(now - 3600), netFlowAssets: "-250000" }),
      ],
    }),
    now,
  );
  // The stale hourly point must not make "hourly" the chosen series and so hide the daily one.
  expect(r.flags.find(f => f.name === "tvl_outflow_24h")?.value).toBe("0.250000");
});
