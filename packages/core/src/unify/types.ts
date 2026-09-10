export type Freshness = "fresh" | "stale" | "unavailable";

export type SourceKind = "messari" | "substreams";

export type Source = {
  kind: SourceKind;
  ref: string;
  block: string;
  timestamp: string;
  ageSeconds: string;
  freshness: Freshness;
};

export type HistoryPoint = {
  block: string;
  timestamp: string;
  sharePrice: string;
  tvlUsd: string | null;
  netFlowAssets: string | null;
  /**
   * Which sampling series this point came from. Required, because a `history` is a *merge*
   * of series — the Messari mappers concatenate hourly and daily snapshots — and
   * `netFlowAssets` is a per-series quantity: the hourly points' flows inside a 24 h window
   * already account for the whole window's movement, and so does the newest daily point.
   * Summing across both counts the same money twice. `risk.ts` uses this to pick one series
   * before it adds anything up; nothing else should need it.
   */
  series: "hourly" | "daily" | "block";
};

export type UnifiedVault = {
  id: string;
  kind: "yield-vault" | "lending-market" | "erc4626";
  protocol: string;
  chain: string;
  chainId: string;
  asset: { symbol: string; decimals: number } | null;
  sharePrice: string;
  tvlUsd: string | null;
  inputTokenBalance: string | null;
  depositLimit: string | null;
  history: HistoryPoint[];
  sources: Source[];
  freshness: Freshness;
};
