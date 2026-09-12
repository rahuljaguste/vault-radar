### Task 7: Risk engine

**Files:**
- Create: `packages/core/src/risk.ts`, `packages/core/test/risk.test.ts`

**Interfaces:**
- Produces: `type Flag = { name: "share_price_drawdown_1h" | "share_price_drawdown_24h" | "share_price_drawdown_7d" | "tvl_outflow_24h" | "deposit_limit_reached" | "stale_data"; value: string; threshold: string; window: string }`; `type Verdict = "ok" | "watch" | "alert" | "unavailable"`; `type RiskReport = { vaultId: string; flags: Flag[]; score: number; verdict: Verdict; evidence: { source: string; block: string; timestamp: string; ageSeconds: string }[] }`; `computeRisk(v: UnifiedVault, nowTs: number): RiskReport`.
- Rules (spec §5.3): drawdown = (latest − earliest-within-window)/earliest-within-window, negative means drop; thresholds 0.005/0.02/0.05; weights 30/25/20; the 1 h flag only evaluates if a history point at least 1 h and at most 2 h old exists, otherwise skipped; outflow = −(sum of netFlowAssets over 24 h)/current balance where available, else from tvl history; threshold 0.20, weight 25; deposit limit weight 10; score capped 100; `ok` < 20, `watch` 20–49, `alert` ≥ 50; any source not `fresh` → `stale_data` flag and verdict `unavailable`.

- [ ] **Step 1: Failing tests**

```ts
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
```

- [ ] **Step 2: Run, expect failure. Step 3: Implement**

```ts
import type { UnifiedVault } from "./unify/types";
export type FlagName = "share_price_drawdown_1h" | "share_price_drawdown_24h" | "share_price_drawdown_7d" | "tvl_outflow_24h" | "deposit_limit_reached" | "stale_data";
export type Flag = { name: FlagName; value: string; threshold: string; window: string };
export type Verdict = "ok" | "watch" | "alert" | "unavailable";
export type RiskReport = { vaultId: string; flags: Flag[]; score: number; verdict: Verdict; evidence: { source: string; block: string; timestamp: string; ageSeconds: string }[] };

const WINDOWS: { name: FlagName; min: number; max: number; threshold: number; weight: number; label: string }[] = [
  { name: "share_price_drawdown_1h", min: 3600, max: 7200, threshold: 0.005, weight: 30, label: "1h" },
  { name: "share_price_drawdown_24h", min: 3600 * 20, max: 3600 * 30, threshold: 0.02, weight: 25, label: "24h" },
  { name: "share_price_drawdown_7d", min: 86400 * 6, max: 86400 * 8, threshold: 0.05, weight: 20, label: "7d" },
];
const num = (s: string | null | undefined) => (s == null ? null : Number(s));
const fmt = (n: number) => n.toFixed(6);

export function computeRisk(v: UnifiedVault, nowTs: number): RiskReport {
  const evidence = v.sources.map(s => ({ source: `${s.kind}:${s.ref}`, block: s.block, timestamp: s.timestamp, ageSeconds: s.ageSeconds }));
  const flags: Flag[] = [];
  if (v.freshness !== "fresh") {
    flags.push({ name: "stale_data", value: v.freshness, threshold: "fresh", window: "now" });
    return { vaultId: v.id, flags, score: 0, verdict: "unavailable", evidence };
  }
  const cur = num(v.sharePrice)!;
  let score = 0;
  for (const w of WINDOWS) {
    const pts = v.history.filter(h => { const age = nowTs - Number(h.timestamp); return age >= w.min && age <= w.max; });
    if (!pts.length) continue;
    const ref = num(pts.sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0].sharePrice)!;
    const drop = (ref - cur) / ref;
    if (drop >= w.threshold) { flags.push({ name: w.name, value: fmt(drop), threshold: fmt(w.threshold), window: w.label }); score += w.weight; }
  }
  const bal = num(v.inputTokenBalance);
  const flows = v.history.filter(h => nowTs - Number(h.timestamp) <= 86400 && h.netFlowAssets != null).map(h => Number(h.netFlowAssets));
  if (bal && flows.length) {
    const out = -flows.reduce((a, b) => a + b, 0) / bal;
    if (out >= 0.2) { flags.push({ name: "tvl_outflow_24h", value: fmt(out), threshold: "0.200000", window: "24h" }); score += 25; }
  }
  const lim = num(v.depositLimit);
  if (lim && bal != null && bal >= lim) { flags.push({ name: "deposit_limit_reached", value: v.inputTokenBalance!, threshold: v.depositLimit!, window: "now" }); score += 10; }
  score = Math.min(100, score);
  const verdict: Verdict = score >= 50 ? "alert" : score >= 20 ? "watch" : "ok";
  return { vaultId: v.id, flags, score, verdict, evidence };
}
```

- [ ] **Step 4: Run, expect 6 pass. Commit** — `git add -A && git commit -m "feat(core): risk engine with unavailable-on-stale rule"`

