### Task 9: Standardized subgraph layer and deployment verification gate

**Files:**
- Create: `packages/core/src/standardized/deployments.json`, `packages/core/src/standardized/templates.ts`, `packages/core/src/standardized/gateway.ts`, `packages/core/src/standardized/map.ts`, `packages/core/test/standardized-map.test.ts`, `packages/core/test/fixtures/yield-vaults.json`, `packages/core/test/fixtures/lending-markets.json`, `scripts/verify-deployments.ts`

**Interfaces:**
- Produces: `type Deployment = { protocol: string; chain: string; chainId: string; schema: "yield-aggregator" | "lending"; subgraphId: string; deploymentId: string | null; status: "live" | "stale" | "down" | "unverified"; headLagSeconds: number | null; verifiedAt: string | null }`; `DEPLOYMENTS: Deployment[]` (from JSON); `queryDeployment<T>(d: Deployment, query: string, apiKey: string, variables?): Promise<{ data: T; meta: { block: string; timestamp: string; hasIndexingErrors: boolean } }>`; `YIELD_VAULTS_QUERY`, `LENDING_MARKETS_QUERY` (strings, both selecting `_meta`); `mapYieldVaults(d, data, headTs): UnifiedVault[]`, `mapLendingMarkets(d, data, headTs): UnifiedVault[]`; `fetchStandardized(deployments, apiKey, heads: Record<chainId, number>, fetchImpl?): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>` where a failing deployment yields zero vaults but is recorded as a `down` source.

- [ ] **Step 1: Registry JSON**

Start with these entries (subgraph IDs from Messari's manifest; `deploymentId` filled by the verify script):

```json
[
  { "protocol": "aave-v3", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "aave-v3", "chain": "base", "chainId": "8453", "schema": "lending", "subgraphId": "D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "compound-v3", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "spark", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "morpho-aave-v3", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "FKe6ANnWmGPE6hajGLoTgPrVF2jYPHiRu2Jwcg9ZmG9A", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "euler", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "95nyAWFFaiz6gykko3HtBCyhRuP5vZzuKYsZiLxHxLhr", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "yearn-v2", "chain": "ethereum", "chainId": "1", "schema": "yield-aggregator", "subgraphId": "FDLuaz69DbMADuBjJDEcLnTuPnjhZqNbFVrkNiBLGkEg", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "yearn-v2", "chain": "arbitrum", "chainId": "42161", "schema": "yield-aggregator", "subgraphId": "G3JZhmKKHC4mydRzD6kSz5fCWve5WDYYCyTFSJyv3SD5", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null }
]
```

Add more yield-aggregator entries (Convex, Aura, Arrakis, Gamma) by looking up their network subgraph IDs in `https://github.com/messari/subgraphs/blob/master/deployment/deployment.json` (search the protocol name, take `services.decentralized-network.query-id`). Skip any without a network ID.

- [ ] **Step 2: Templates** (confirm field names with introspection in Step 5; adjust only if the gateway rejects a field)

```ts
export const META = `_meta { block { number timestamp } hasIndexingErrors }`;
export const YIELD_VAULTS_QUERY = `query($first: Int!) { ${META}
  vaults(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id name inputToken { id symbol decimals } outputToken { id symbol }
    pricePerShare outputTokenPriceUSD totalValueLockedUSD inputTokenBalance outputTokenSupply depositLimit
    hourlySnapshots: hourlySnapshots(first: 24, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp pricePerShare totalValueLockedUSD inputTokenBalance }
    dailySnapshots: dailySnapshots(first: 8, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp pricePerShare totalValueLockedUSD inputTokenBalance }
  } }`;
export const LENDING_MARKETS_QUERY = `query($first: Int!) { ${META}
  markets(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id name inputToken { id symbol decimals } outputToken { id symbol }
    exchangeRate totalValueLockedUSD totalDepositBalanceUSD totalBorrowBalanceUSD inputTokenBalance
    hourlySnapshots(first: 24, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp exchangeRate totalValueLockedUSD totalDepositBalanceUSD hourlyDepositUSD hourlyWithdrawUSD }
    dailySnapshots(first: 8, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp exchangeRate totalValueLockedUSD totalDepositBalanceUSD dailyDepositUSD dailyWithdrawUSD }
  } }`;
```

If `hourlySnapshots`/`dailySnapshots` are not fields on `Vault`/`Market` in the introspected schema, replace with top-level queries `vaultHourlySnapshots(where: { vault_in: $ids }, ...)` and group by vault id in the mapper.

- [ ] **Step 3: Gateway client**

```ts
import type { Deployment } from "./types";
export type Meta = { block: string; timestamp: string; hasIndexingErrors: boolean };
export function gatewayUrl(d: Deployment): string {
  return d.deploymentId ? `https://gateway.thegraph.com/api/deployments/id/${d.deploymentId}` : `https://gateway.thegraph.com/api/subgraphs/id/${d.subgraphId}`;
}
export async function queryDeployment<T>(d: Deployment, query: string, apiKey: string, variables: Record<string, unknown> = { first: 50 }, fetchImpl: typeof fetch = fetch, timeoutMs = 20000): Promise<{ data: T; meta: Meta }> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(gatewayUrl(d), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query, variables }), signal: ctl.signal });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const j = (await res.json()) as { data?: T & { _meta: { block: { number: number; timestamp: number }; hasIndexingErrors: boolean } }; errors?: { message: string }[] };
    if (j.errors?.length || !j.data) throw new Error(`graphql: ${j.errors?.map(e => e.message).join("; ") ?? "no data"}`);
    const m = j.data._meta;
    return { data: j.data, meta: { block: String(m.block.number), timestamp: String(m.block.timestamp), hasIndexingErrors: m.hasIndexingErrors } };
  } finally { clearTimeout(t); }
}
```

Put `Deployment` in `packages/core/src/standardized/types.ts` and load JSON in `registry.ts`: `export const DEPLOYMENTS = deployments as Deployment[];`.

- [ ] **Step 4: Failing mapper tests with fixtures**

Create `test/fixtures/yield-vaults.json` with one vault (id `0xabc...`, `pricePerShare: "1.05"`, two hourly snapshots and two daily snapshots) and `_meta`; `lending-markets.json` similarly with `exchangeRate`. Test:

```ts
import { expect, test } from "bun:test";
import yieldFx from "./fixtures/yield-vaults.json";
import lendFx from "./fixtures/lending-markets.json";
import { mapLendingMarkets, mapYieldVaults } from "../src/standardized/map";
const d = (schema: "yield-aggregator" | "lending") => ({ protocol: "p", chain: "ethereum", chainId: "1", schema, subgraphId: "S", deploymentId: "Qm1", status: "live" as const, headLagSeconds: 0, verifiedAt: null });
test("yield vault maps to UnifiedVault with history and source", () => {
  const [v] = mapYieldVaults(d("yield-aggregator"), yieldFx, Number(yieldFx._meta.block.timestamp) + 10);
  expect(v.kind).toBe("yield-vault"); expect(v.sharePrice).toBe("1.05"); expect(v.id).toMatch(/^1:0x/);
  expect(v.history.length).toBe(4); expect(v.sources[0]).toMatchObject({ kind: "messari", ref: "Qm1", freshness: "fresh" });
});
test("lending market uses exchangeRate and net flow from withdraw−deposit", () => {
  const [m] = mapLendingMarkets(d("lending"), lendFx, Number(lendFx._meta.block.timestamp) + 10);
  expect(m.kind).toBe("lending-market"); expect(m.sharePrice).toBe(lendFx.markets[0].exchangeRate);
  expect(m.history[0].netFlowAssets).not.toBeNull();
});
```

- [ ] **Step 5: Implement `map.ts`**

```ts
import type { Deployment } from "./types";
import type { HistoryPoint, Source, UnifiedVault } from "../unify/types";
import { classifyFreshness, vaultFreshness } from "../unify/freshness";
type Meta = { block: { number: number | string; timestamp: number | string }; hasIndexingErrors: boolean };
const s = (x: unknown) => (x == null ? null : String(x));
function source(d: Deployment, meta: Meta, headTs: number): Source {
  const ts = Number(meta.block.timestamp);
  return { kind: "messari", ref: d.deploymentId ?? d.subgraphId, block: String(meta.block.number), timestamp: String(ts), ageSeconds: String(Math.max(0, headTs - ts)), freshness: classifyFreshness("messari", ts, headTs, meta.hasIndexingErrors) };
}
export function mapYieldVaults(d: Deployment, data: any, headTs: number): UnifiedVault[] {
  const src = source(d, data._meta, headTs);
  return (data.vaults ?? []).map((v: any): UnifiedVault => {
    const pts = [...(v.hourlySnapshots ?? []), ...(v.dailySnapshots ?? [])];
    const history: HistoryPoint[] = pts.map((h: any, i: number, arr: any[]) => {
      const prev = arr[i + 1];
      const flow = prev && h.inputTokenBalance != null && prev.inputTokenBalance != null ? String(BigInt(h.inputTokenBalance) - BigInt(prev.inputTokenBalance)) : null;
      return { block: String(h.blockNumber), timestamp: String(h.timestamp), sharePrice: String(h.pricePerShare ?? v.pricePerShare), tvlUsd: s(h.totalValueLockedUSD), netFlowAssets: flow };
    });
    return { id: `${d.chainId}:${String(v.id).toLowerCase()}`, kind: "yield-vault", protocol: d.protocol, chain: d.chain, chainId: d.chainId,
      asset: v.inputToken ? { symbol: v.inputToken.symbol, decimals: Number(v.inputToken.decimals) } : null,
      sharePrice: String(v.pricePerShare ?? "1"), tvlUsd: s(v.totalValueLockedUSD), inputTokenBalance: s(v.inputTokenBalance), depositLimit: s(v.depositLimit),
      history, sources: [src], freshness: vaultFreshness([src]) };
  });
}
export function mapLendingMarkets(d: Deployment, data: any, headTs: number): UnifiedVault[] {
  const src = source(d, data._meta, headTs);
  return (data.markets ?? []).map((m: any): UnifiedVault => {
    const pts = [...(m.hourlySnapshots ?? []), ...(m.dailySnapshots ?? [])];
    const history: HistoryPoint[] = pts.map((h: any) => {
      const dep = Number(h.hourlyDepositUSD ?? h.dailyDepositUSD ?? 0), wd = Number(h.hourlyWithdrawUSD ?? h.dailyWithdrawUSD ?? 0);
      return { block: String(h.blockNumber), timestamp: String(h.timestamp), sharePrice: String(h.exchangeRate ?? m.exchangeRate ?? "1"), tvlUsd: s(h.totalValueLockedUSD), netFlowAssets: (dep - wd).toFixed(2) };
    });
    return { id: `${d.chainId}:${String(m.id).toLowerCase()}`, kind: "lending-market", protocol: d.protocol, chain: d.chain, chainId: d.chainId,
      asset: m.inputToken ? { symbol: m.inputToken.symbol, decimals: Number(m.inputToken.decimals) } : null,
      sharePrice: String(m.exchangeRate ?? "1"), tvlUsd: s(m.totalValueLockedUSD), inputTokenBalance: s(m.totalDepositBalanceUSD), depositLimit: null,
      history, sources: [src], freshness: vaultFreshness([src]) };
  });
}
```

Note for lending: `inputTokenBalance` is set to `totalDepositBalanceUSD` and net flow is in USD so the outflow ratio stays consistent (USD/USD).

Then `fetchStandardized` in `standardized/index.ts`: for each deployment with `status !== "down"`, pick the query by schema, call `queryDeployment`, map, collect `SourceRef`s; on error push a source ref with `block: "0"` and mark nothing (vaults empty) but include `{ ref, chainId, block: "0", timestamp: "0" }` in `sources` and log the error message without the body.

- [ ] **Step 6: Verification gate script `scripts/verify-deployments.ts`**

```ts
import { DEPLOYMENTS } from "../packages/core/src/standardized/registry";
import { queryDeployment } from "../packages/core/src/standardized/gateway";
import { writeFileSync } from "node:fs";
const key = process.env.GRAPH_STUDIO_API_KEY!; if (!key) throw new Error("GRAPH_STUDIO_API_KEY missing");
const Q = `{ _meta { block { number timestamp } hasIndexingErrors deployment } }`;
const now = Math.floor(Date.now() / 1000);
const out = [];
for (const d of DEPLOYMENTS) {
  try {
    const { meta, data } = await queryDeployment<{ _meta: { deployment: string } }>(d, Q, key, {});
    const lag = now - Number(meta.timestamp);
    out.push({ ...d, deploymentId: data._meta.deployment, headLagSeconds: lag, status: meta.hasIndexingErrors ? "down" : lag <= 3600 ? "live" : "stale", verifiedAt: String(now) });
    console.log(`${d.protocol}/${d.chain}: ${out.at(-1)!.status} lag=${lag}s deployment=${data._meta.deployment}`);
  } catch (e) { out.push({ ...d, status: "down", headLagSeconds: null, verifiedAt: String(now) }); console.log(`${d.protocol}/${d.chain}: down (${(e as Error).message})`); }
}
writeFileSync("packages/core/src/standardized/deployments.json", JSON.stringify(out, null, 2) + "\n");
console.log(`live: ${out.filter(x => x.status === "live").length} / ${out.length}`);
```

Run: `GRAPH_STUDIO_API_KEY=... bun run verify-deployments`. Record the live count in `docs/verification-log.md` with the date. Note: `_meta.deployment` returns the `Qm...` deployment hash; subsequent queries pin it.

- [ ] **Step 7: Run unit tests (offline), expect pass. Commit**, `git add -A && git commit -m "feat(core): Messari standardized query layer, mappers, deployment verification gate"`

