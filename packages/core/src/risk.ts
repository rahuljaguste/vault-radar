import type { UnifiedVault } from "./unify/types";

export type FlagName =
  | "share_price_drawdown_1h"
  | "share_price_drawdown_24h"
  | "share_price_drawdown_7d"
  | "tvl_outflow_24h"
  | "deposit_limit_reached"
  | "stale_data";

export type Flag = { name: FlagName; value: string; threshold: string; window: string };
export type Verdict = "ok" | "watch" | "alert" | "unavailable";
export type RiskReport = {
  vaultId: string;
  flags: Flag[];
  score: number;
  verdict: Verdict;
  evidence: { source: string; block: string; timestamp: string; ageSeconds: string }[];
};

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
  if (lim && bal != null && bal >= lim) { flags.push({ name: "deposit_limit_reached", value: fmt(bal), threshold: fmt(lim), window: "now" }); score += 10; }
  score = Math.min(100, score);
  const verdict: Verdict = score >= 50 ? "alert" : score >= 20 ? "watch" : "ok";
  return { vaultId: v.id, flags, score, verdict, evidence };
}
