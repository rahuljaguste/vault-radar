import type { HistoryPoint, UnifiedVault } from "./unify/types";

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
const isPlainInt = (s: string) => /^\d+$/.test(s);
// bal/lim are Number()-parsed above for the outflow ratio and the >= check,
// which loses precision for atomic balances beyond Number.MAX_SAFE_INTEGER
// (e.g. an 18-decimal token). The deposit-limit flag both compares and
// echoes these values, so compare the raw strings exactly via BigInt when
// both are plain non-negative integers (the normal case for atomic-unit
// balances); fall back to the Number comparison used elsewhere only if
// either string isn't a plain integer.
const gteExact = (a: string, b: string): boolean => (isPlainInt(a) && isPlainInt(b) ? BigInt(a) >= BigInt(b) : Number(a) >= Number(b));

/** Finest series first: the one with the most points inside a 24 h window wins the tie. */
const SERIES_PREFERENCE: HistoryPoint["series"][] = ["hourly", "daily", "block"];

/**
 * The last 24 hours' flows, taken from exactly ONE sampling series.
 *
 * `history` is a merge. The Messari mappers concatenate a vault's hourly and daily
 * snapshots into one array (`standardized/map.ts`), and each series' `netFlowAssets`
 * describes that series' own sampling interval — the ~23 hourly flows inside the window
 * telescope to roughly the 24 h change, and the newest daily point states roughly that same
 * change again. Adding them together reported about twice the real movement: an 11% outflow
 * read as 22%, crossed the 20% threshold, added 25 points, and turned an `ok` vault into a
 * `watch` (or a `watch` into an `alert`, which makes the agent emit `withdraw`). Spec §5.3
 * asks for "the 24 h change" — one figure, from one series.
 *
 * Finest available series wins, so resolution is never thrown away: hourly if any hourly
 * point inside the window carries a flow, else daily, else block (the Substreams path, which
 * is per block and was always self-consistent).
 *
 * Share-price drawdowns are left merged on purpose: each window picks a single reference
 * point and compares it to the current price, so having more candidate points to choose from
 * is harmless — nothing is summed.
 */
function flows24h(v: UnifiedVault, nowTs: number): number[] {
  const inWindow = v.history.filter(h => nowTs - Number(h.timestamp) <= 86400 && h.netFlowAssets != null);
  const series = SERIES_PREFERENCE.find(s => inWindow.some(h => h.series === s));
  if (!series) return [];
  return inWindow.filter(h => h.series === series).map(h => Number(h.netFlowAssets));
}

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
  const flows = flows24h(v, nowTs);
  if (bal && flows.length) {
    const out = -flows.reduce((a, b) => a + b, 0) / bal;
    if (out >= 0.2) { flags.push({ name: "tvl_outflow_24h", value: fmt(out), threshold: "0.200000", window: "24h" }); score += 25; }
  }
  const lim = num(v.depositLimit);
  if (lim && bal != null && gteExact(v.inputTokenBalance!, v.depositLimit!)) { flags.push({ name: "deposit_limit_reached", value: v.inputTokenBalance!, threshold: v.depositLimit!, window: "now" }); score += 10; }
  score = Math.min(100, score);
  const verdict: Verdict = score >= 50 ? "alert" : score >= 20 ? "watch" : "ok";
  return { vaultId: v.id, flags, score, verdict, evidence };
}
