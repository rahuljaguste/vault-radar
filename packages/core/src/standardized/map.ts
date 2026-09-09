import type { Deployment } from "./types";
import type { HistoryPoint, Source, UnifiedVault } from "../unify/types";
import { classifyFreshness, vaultFreshness } from "../unify/freshness";

type Meta = { block: { number: number | string; timestamp: number | string }; hasIndexingErrors: boolean };

const s = (x: unknown) => (x == null ? null : String(x));

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

export function mapYieldVaults(d: Deployment, data: any, headTs: number): UnifiedVault[] {
  const src = source(d, data._meta, headTs);
  return (data.vaults ?? []).map((v: any): UnifiedVault => {
    const pts = [...(v.hourlySnapshots ?? []), ...(v.dailySnapshots ?? [])];
    const history: HistoryPoint[] = pts.map((h: any, i: number, arr: any[]) => {
      const prev = arr[i + 1];
      const flow = prev && h.inputTokenBalance != null && prev.inputTokenBalance != null
        ? String(BigInt(h.inputTokenBalance) - BigInt(prev.inputTokenBalance))
        : null;
      return { block: String(h.blockNumber), timestamp: String(h.timestamp), sharePrice: String(h.pricePerShare ?? v.pricePerShare), tvlUsd: s(h.totalValueLockedUSD), netFlowAssets: flow };
    });
    return {
      id: `${d.chainId}:${String(v.id).toLowerCase()}`, kind: "yield-vault", protocol: d.protocol, chain: d.chain, chainId: d.chainId,
      asset: v.inputToken ? { symbol: v.inputToken.symbol, decimals: Number(v.inputToken.decimals) } : null,
      sharePrice: String(v.pricePerShare ?? "1"), tvlUsd: s(v.totalValueLockedUSD), inputTokenBalance: s(v.inputTokenBalance), depositLimit: s(v.depositLimit),
      history, sources: [src], freshness: vaultFreshness([src]),
    };
  });
}

export function mapLendingMarkets(d: Deployment, data: any, headTs: number): UnifiedVault[] {
  const src = source(d, data._meta, headTs);
  return (data.markets ?? []).map((m: any): UnifiedVault => {
    const pts = [...(m.hourlySnapshots ?? []), ...(m.dailySnapshots ?? [])];
    const history: HistoryPoint[] = pts.map((h: any) => {
      const dep = Number(h.hourlyDepositUSD ?? h.dailyDepositUSD ?? 0);
      const wd = Number(h.hourlyWithdrawUSD ?? h.dailyWithdrawUSD ?? 0);
      return { block: String(h.blockNumber), timestamp: String(h.timestamp), sharePrice: String(h.exchangeRate ?? m.exchangeRate ?? "1"), tvlUsd: s(h.totalValueLockedUSD), netFlowAssets: (dep - wd).toFixed(2) };
    });
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
