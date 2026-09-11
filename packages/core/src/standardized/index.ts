import type { Deployment } from "./types";
import type { UnifiedVault } from "../unify/types";
// SourceRef already lives on receipts.ts (a receipt's `sources` field is exactly this
// per-deployment provenance list) and is re-exported from the package barrel via
// `export * from "./receipts"`; reuse it here rather than declaring a duplicate.
import type { SourceRef } from "../receipts";
import { PAGE_SIZE, queryDeployment } from "./gateway";
import { YIELD_VAULTS_QUERY, LENDING_MARKETS_QUERY } from "./templates";
import { mapYieldVaults, mapLendingMarkets } from "./map";

export * from "./types";
export * from "./registry";
export * from "./templates";
export * from "./gateway";
export * from "./map";

export async function fetchStandardized(
  deployments: Deployment[],
  apiKey: string,
  heads: Record<string, number>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }> {
  const live = deployments.filter(d => d.status !== "down");
  const settled = await Promise.allSettled(
    live.map(async d => {
      const headTs = heads[d.chainId] ?? Math.floor(Date.now() / 1000);
      const query = d.schema === "yield-aggregator" ? YIELD_VAULTS_QUERY : LENDING_MARKETS_QUERY;
      const { data, meta } = await queryDeployment(d, query, apiKey, { first: PAGE_SIZE }, fetchImpl);
      const vaults = d.schema === "yield-aggregator" ? mapYieldVaults(d, data, headTs) : mapLendingMarkets(d, data, headTs);
      const ref: SourceRef = { ref: d.deploymentId ?? d.subgraphId, chainId: d.chainId, block: meta.block, timestamp: meta.timestamp };
      return { vaults, ref };
    }),
  );

  const vaults: UnifiedVault[] = [];
  const sources: SourceRef[] = [];
  settled.forEach((result, i) => {
    const d = live[i]!;
    if (result.status === "fulfilled") {
      vaults.push(...result.value.vaults);
      sources.push(result.value.ref);
    } else {
      // Log only the error message, never a response body (which may carry API-key-adjacent
      // gateway diagnostics or arbitrarily large HTML/JSON payloads).
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`standardized fetch failed for ${d.protocol}/${d.chain}: ${message}`);
      sources.push({ ref: d.deploymentId ?? d.subgraphId, chainId: d.chainId, block: "0", timestamp: "0" });
    }
  });
  return { vaults, sources };
}
