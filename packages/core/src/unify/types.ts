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
