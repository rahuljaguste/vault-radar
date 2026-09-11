import type { Deployment } from "./types";
import type { HistoryPoint, Source, UnifiedVault } from "../unify/types";
import { classifyFreshness, vaultFreshness } from "../unify/freshness";

type Meta = { block: { number: number | string; timestamp: number | string }; hasIndexingErrors: boolean };

const s = (x: unknown) => (x == null ? null : String(x));

// Atomic-unit balances are expected to be integer strings, but a subgraph can return a
// decimal or scientific-notation value (or a number, or garbage). `BigInt()` throws on all
// of those, and because mapping runs inside `fetchStandardized`'s `Promise.allSettled`, one
// such vault would reject the whole deployment's worth of data. Parsing defensively keeps
// the failure local: the point simply has no computable net flow.
const toBigInt = (x: unknown): bigint | null => {
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return Number.isInteger(x) ? BigInt(x) : null;
  if (typeof x === "string" && /^-?\d+$/.test(x)) return BigInt(x);
  return null;
};

// Both query templates fetch each series (hourly, daily) individually ordered newest
// first; after mapping each series to HistoryPoints, the two arrays are concatenated
// and must be re-sorted by timestamp so the merged history stays newest-first overall
// (hourly and daily coverage windows are not guaranteed to interleave cleanly at the
// boundary — a daily snapshot can be timestamped later than the oldest hourly one).
const byTimestampDesc = (a: HistoryPoint, b: HistoryPoint) => Number(b.timestamp) - Number(a.timestamp);

function source(d: Deployment, meta: Meta, headTs: number): Source {
  const ts = Number(meta.block.timestamp);
  return {
    kind: "messari",
    ref: d.deploymentId ?? d.subgraphId,
    block: String(meta.block.number),
    timestamp: String(ts),
    ageSeconds: String(Math.max(0, headTs - ts)),
    freshness: classifyFreshness("messari", ts, headTs, meta.hasIndexingErrors),
  };
}

// Diffs each point in a single series (hourly-only or daily-only, as fetched — already
// ordered newest-first) against the next-older point in that SAME series. The oldest
// point of the series has no older sibling to diff against and gets netFlowAssets:
// null. Diffing must stay within one series: merging hourly+daily first and diffing by
// array position (the previous behaviour) paired the oldest hourly point against the
// newest daily point — points ~23h apart despite ~1h gaps everywhere else in the series.
function yieldSeriesHistory(points: any[], series: HistoryPoint["series"], fallbackPrice: unknown): HistoryPoint[] {
  return points.map((h: any, i: number, arr: any[]) => {
    const prev = arr[i + 1];
    const curBal = toBigInt(h.inputTokenBalance);
    const prevBal = toBigInt(prev?.inputTokenBalance);
    const flow = prev && curBal !== null && prevBal !== null ? String(curBal - prevBal) : null;
    return { block: String(h.blockNumber), timestamp: String(h.timestamp), sharePrice: String(h.pricePerShare ?? fallbackPrice), tvlUsd: s(h.totalValueLockedUSD), netFlowAssets: flow, series };
  });
}

export function mapYieldVaults(d: Deployment, data: any, headTs: number): UnifiedVault[] {
  const src = source(d, data._meta, headTs);
  return (data.vaults ?? []).map((v: any): UnifiedVault => {
    const history: HistoryPoint[] = [
      ...yieldSeriesHistory(v.hourlySnapshots ?? [], "hourly", v.pricePerShare),
      ...yieldSeriesHistory(v.dailySnapshots ?? [], "daily", v.pricePerShare),
    ].sort(byTimestampDesc);
    return {
      id: `${d.chainId}:${String(v.id).toLowerCase()}`, kind: "yield-vault", protocol: d.protocol, chain: d.chain, chainId: d.chainId,
      asset: v.inputToken ? { symbol: v.inputToken.symbol, decimals: Number(v.inputToken.decimals) } : null,
      sharePrice: String(v.pricePerShare ?? "1"), tvlUsd: s(v.totalValueLockedUSD), inputTokenBalance: s(v.inputTokenBalance), depositLimit: s(v.depositLimit),
      history, sources: [src], freshness: vaultFreshness([src]),
    };
  });
}

// Lending snapshots carry their own per-point deposit/withdraw totals, so (unlike the
// yield series) there is no adjacent-point diffing to keep within-series — each point's
// netFlowAssets stands alone. Still built per series (not from a pre-merged array) for
// symmetry with yieldSeriesHistory and because the merge+sort below is what actually
// keeps the combined history newest-first, not the per-point computation.
function lendingSeriesHistory(points: any[], series: HistoryPoint["series"], fallbackPrice: unknown): HistoryPoint[] {
  return points.map((h: any) => {
    const dep = Number(h.hourlyDepositUSD ?? h.dailyDepositUSD ?? 0);
    const wd = Number(h.hourlyWithdrawUSD ?? h.dailyWithdrawUSD ?? 0);
    return { block: String(h.blockNumber), timestamp: String(h.timestamp), sharePrice: String(h.exchangeRate ?? fallbackPrice ?? "1"), tvlUsd: s(h.totalValueLockedUSD), netFlowAssets: (dep - wd).toFixed(2), series };
  });
}

export function mapLendingMarkets(d: Deployment, data: any, headTs: number): UnifiedVault[] {
  const src = source(d, data._meta, headTs);
  return (data.markets ?? []).map((m: any): UnifiedVault => {
    const history: HistoryPoint[] = [
      ...lendingSeriesHistory(m.hourlySnapshots ?? [], "hourly", m.exchangeRate),
      ...lendingSeriesHistory(m.dailySnapshots ?? [], "daily", m.exchangeRate),
    ].sort(byTimestampDesc);
    // inputTokenBalance is set to totalDepositBalanceUSD (both USD) so the tvl-outflow
    // ratio computed by risk.ts stays USD/USD instead of mixing atomic units with USD.
    return {
      id: `${d.chainId}:${String(m.id).toLowerCase()}`, kind: "lending-market", protocol: d.protocol, chain: d.chain, chainId: d.chainId,
      asset: m.inputToken ? { symbol: m.inputToken.symbol, decimals: Number(m.inputToken.decimals) } : null,
      sharePrice: String(m.exchangeRate ?? "1"), tvlUsd: s(m.totalValueLockedUSD), inputTokenBalance: s(m.totalDepositBalanceUSD), depositLimit: null,
      history, sources: [src], freshness: vaultFreshness([src]),
    };
  });
}
