import { createPublicClient, http } from "viem";
import {
  DEPLOYMENTS,
  fetchStandardized,
  readErc4626Vaults,
  readSinkRows,
  vaultFreshness,
  SINK_REF,
  type UnifiedVault,
  type SourceRef,
  type SqlQuery,
} from "@vaultradar/core";
import type { Config } from "../config";
import type { Metrics } from "../metrics";

export type Catalog = { protocols: { protocol: string; chain: string; status: string; vaultCount: number }[]; erc4626Chains: string[] };
export type VaultListEntry = { id: string; protocol: string; kind: string };

export interface DataProvider {
  catalog(): Promise<Catalog>;
  scan(vaultIds: string[]): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>;
  table(protocol: string, chainId: string): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>;
  /**
   * Optional so the many inline stub `DataProvider` objects across the existing test
   * suite (which predate this method) keep type-checking without every one of them
   * growing an implementation — `admin.ts`'s `/v1/vaults` route calls this via optional
   * chaining and falls back to an empty list when it's absent.
   */
  vaultList?(chainId: string): Promise<VaultListEntry[]>;
}

type Head = { ts: number; block: number };
type ChainResult = { vaults: UnifiedVault[]; sources: SourceRef[] };
type CacheEntry<T> = { value: T; expiresAt: number };

const HEAD_TTL_S = 15;
const CHAIN_TTL_S = 60;
// A head this far in the future ages every subgraph (Messari) source on the chain out
// immediately (classifyFreshness compares headTs - sourceTs against a threshold
// measured in minutes). `block` must ALSO be maximal, not 0: readErc4626Vaults derives
// its own synthetic source timestamp as `head.ts - max(0, (head.block - cursorBlock) *
// blockTimeS)`. With block=0 and any real (positive) cursor block, that difference is
// negative and clamps to 0, so the derived timestamp collapses to `head.ts` itself —
// compared against a headTs of the same value, that reads as an age of zero, i.e.
// "fresh", exactly backwards for an unreachable chain. Making block maximal too pushes
// (head.block - cursorBlock) hugely positive instead, so the derived timestamp lands
// far in the past relative to headTs and the substreams source is correctly stale.
const STALE_HEAD: Head = { ts: Number.MAX_SAFE_INTEGER, block: Number.MAX_SAFE_INTEGER };

export type LiveDataProviderDeps = { fetchImpl?: typeof fetch; sql?: SqlQuery | null; now?: () => number; metrics?: Metrics };

/** `GET /v1/vaults?chainId=` (admin.ts) caps the combined Messari-cached + sink id list
 * at this many entries. */
const VAULT_LIST_LIMIT = 500;

/**
 * Groups vault ids of the form "<chainId>:<address>" by chain, lower-casing both parts
 * so this is safe to call directly (e.g. from tests) even though the handler already
 * lower-cases before calling scan(). Malformed entries (no ":") are dropped — the
 * handler's bad_vaults check is what rejects those before scan() is ever reached; this
 * is just defense in depth, not a second validation layer.
 */
function groupByChain(ids: string[]): Map<string, string[]> {
  const byChain = new Map<string, string[]>();
  for (const raw of ids) {
    const id = raw.toLowerCase();
    const sep = id.indexOf(":");
    if (sep < 0) continue;
    const chainId = id.slice(0, sep);
    const address = id.slice(sep + 1);
    const addresses = byChain.get(chainId);
    if (addresses) addresses.push(address);
    else byChain.set(chainId, [address]);
  }
  return byChain;
}

/**
 * Merges subgraph-derived (Messari) vaults with substreams-sink (erc4626) vaults for
 * the same chain. A vault present in both keeps the Messari record's fields (protocol
 * metadata, richer history) but reports both sources' provenance, and freshness is
 * recomputed from the union since the two sources can disagree about how fresh the
 * data is.
 */
function mergeVaults(messari: UnifiedVault[], erc4626: UnifiedVault[]): UnifiedVault[] {
  const byId = new Map(erc4626.map(v => [v.id, v] as const));
  const merged: UnifiedVault[] = [];
  const claimed = new Set<string>();
  for (const mv of messari) {
    const sv = byId.get(mv.id);
    if (sv) {
      const sources = [...mv.sources, ...sv.sources];
      merged.push({ ...mv, sources, freshness: vaultFreshness(sources) });
      claimed.add(mv.id);
    } else {
      merged.push(mv);
    }
  }
  for (const sv of erc4626) if (!claimed.has(sv.id)) merged.push(sv);
  return merged;
}

/**
 * One SourceRef summarizing an erc4626 sink read, or none if it matched no vaults.
 * `readErc4626Vaults` always attaches exactly one source to every vault it returns, so
 * `vaults[0]?.sources[0]` should never actually be missing here — the optional chain
 * and zeroed-out fallback exist so a future change to that invariant degrades to an
 * honest "unknown block/timestamp" placeholder instead of throwing.
 */
function sinkSourceRef(chainId: string, vaults: UnifiedVault[]): SourceRef | null {
  if (!vaults.length) return null;
  const s = vaults[0]?.sources[0];
  return s ? { ref: SINK_REF, chainId, block: s.block, timestamp: s.timestamp } : { ref: SINK_REF, chainId, block: "0", timestamp: "0" };
}

/**
 * Live DataProvider: subgraph deployments via `fetchStandardized` (cached 60s per
 * chain), plus — when a Postgres pool is configured — the ERC-4626 substreams sink via
 * `readErc4626Vaults`. Chain heads come from a per-chain RPC call (viem `getBlock`),
 * cached 15s; an unreachable or unconfigured RPC yields a head that forces every
 * source on that chain `stale` rather than guessing a timestamp (spec §7: "Chain head
 * RPC failure: every source on that chain stale").
 */
export class LiveDataProvider implements DataProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly sql: SqlQuery | null;
  private readonly now: () => number;
  private readonly metrics: Metrics | null;
  private readonly headCache = new Map<string, CacheEntry<Head>>();
  private readonly chainCache = new Map<string, CacheEntry<ChainResult>>();

  constructor(private readonly config: Config, deps: LiveDataProviderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sql = deps.sql ?? null;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.metrics = deps.metrics ?? null;
  }

  async catalog(): Promise<Catalog> {
    const protocols = DEPLOYMENTS.map(d => {
      const cached = this.peekChain(d.chainId);
      const vaultCount = cached ? cached.vaults.filter(v => v.protocol === d.protocol).length : 0;
      return { protocol: d.protocol, chain: d.chain, status: d.status, vaultCount };
    });
    return { protocols, erc4626Chains: this.sql ? ["1", "8453"] : [] };
  }

  async scan(vaultIds: string[]): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }> {
    const byChain = groupByChain(vaultIds);
    const vaults: UnifiedVault[] = [];
    const sources: SourceRef[] = [];

    for (const [chainId, addresses] of byChain) {
      const head = await this.getChainHead(chainId);
      const chainResult = await this.getChainStandardized(chainId, head.ts);
      sources.push(...chainResult.sources);

      const wanted = new Set(addresses.map(a => `${chainId}:${a}`));
      const messariVaults = chainResult.vaults.filter(v => wanted.has(v.id));

      if (this.sql) {
        const erc4626Vaults = await readErc4626Vaults(this.sql, chainId, addresses, head);
        const ref = sinkSourceRef(chainId, erc4626Vaults);
        if (ref) sources.push(ref);
        vaults.push(...mergeVaults(messariVaults, erc4626Vaults));
      } else {
        vaults.push(...messariVaults);
      }
    }
    return { vaults, sources };
  }

  async table(protocol: string, chainId: string): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }> {
    const head = await this.getChainHead(chainId);

    if (protocol === "erc4626") {
      if (!this.sql) return { vaults: [], sources: [] };
      const vaults = await readErc4626Vaults(this.sql, chainId, null, head);
      const ref = sinkSourceRef(chainId, vaults);
      return { vaults, sources: ref ? [ref] : [] };
    }

    const chainResult = await this.getChainStandardized(chainId, head.ts);
    const vaults = chainResult.vaults.filter(v => v.protocol === protocol);
    const dep = DEPLOYMENTS.find(d => d.protocol === protocol && d.chainId === chainId);
    const ref = dep ? dep.deploymentId ?? dep.subgraphId : null;
    const sources = ref ? chainResult.sources.filter(s => s.ref === ref) : [];
    return { vaults, sources };
  }

  private peekChain(chainId: string): ChainResult | undefined {
    const cached = this.chainCache.get(chainId);
    return cached && cached.expiresAt > this.now() ? cached.value : undefined;
  }

  private async getChainStandardized(chainId: string, headTs: number): Promise<ChainResult> {
    const cached = this.peekChain(chainId);
    if (cached) return cached;
    const deployments = DEPLOYMENTS.filter(d => d.chainId === chainId);
    const result = await fetchStandardized(deployments, this.config.graphApiKey, { [chainId]: headTs }, this.fetchImpl);
    this.chainCache.set(chainId, { value: result, expiresAt: this.now() + CHAIN_TTL_S });
    // Recorded only on an actual fetch (this cache-miss branch), not on every cache hit
    // `getChainStandardized` serves — otherwise `lastQueriedAt` would advance on every
    // read regardless of whether anything was actually queried.
    this.recordDeploymentOutcomes(deployments, headTs, result);
    return result;
  }

  /**
   * Best-effort per-deployment health for the admin metrics endpoint (spec §13.1).
   * `fetchStandardized` (packages/core) already queries each deployment on a chain
   * independently via `Promise.allSettled`, but only surfaces failures as a
   * `console.error` plus a zeroed-out `SourceRef` (`block: "0", timestamp: "0"`) —
   * changing that shared helper to report structured outcomes is out of this task's
   * scope, so this infers ok/fail from the same zeroed-out signal instead. A
   * legitimately fresh deployment could in principle also read block "0" (a subgraph
   * with no indexed block yet), which would misclassify as a failure — an acceptable,
   * rare imprecision for a best-effort observability signal, not a correctness-critical
   * one.
   */
  private recordDeploymentOutcomes(deployments: typeof DEPLOYMENTS, headTs: number, result: ChainResult): void {
    if (!this.metrics) return;
    for (const d of deployments) {
      const ref = d.deploymentId ?? d.subgraphId;
      const source = result.sources.find(s => s.ref === ref);
      const ok = !!source && source.block !== "0";
      const lagSeconds = ok && source ? Math.max(0, headTs - Number(source.timestamp)) : null;
      this.metrics.recordDeployment({ protocol: d.protocol, chain: d.chain, chainId: d.chainId }, { ok, lagSeconds, error: ok ? null : "query_failed" });
    }
  }

  private async getChainHead(chainId: string): Promise<Head> {
    const cached = this.headCache.get(chainId);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const rpcUrl = this.config.rpc[chainId];
    let head: Head;
    let ok: boolean;
    if (!rpcUrl) {
      head = STALE_HEAD;
      ok = false;
    } else {
      try {
        const client = createPublicClient({ transport: http(rpcUrl, { fetchFn: this.fetchImpl }) });
        const block = await client.getBlock({ blockTag: "latest" });
        head = { ts: Number(block.timestamp), block: Number(block.number) };
        ok = true;
      } catch {
        head = STALE_HEAD;
        ok = false;
      }
    }
    this.headCache.set(chainId, { value: head, expiresAt: this.now() + HEAD_TTL_S });
    // Same cache-miss-only reasoning as recordDeploymentOutcomes above.
    this.metrics?.recordHead(chainId, head, ok);
    return head;
  }

  /**
   * `GET /v1/vaults?chainId=` (admin.ts): every vault id this provider already knows
   * about for a chain, from the cached Messari-derived catalog (never triggers a fetch —
   * `peekChain` only reads whatever is already cached from a prior `scan`/`table` call)
   * plus, when a sink database is configured, the substreams sink's own `vault_latest`
   * ids. Deliberately a much lighter query than `readErc4626Vaults`: this only needs ids,
   * not full vault objects, freshness, or history, so it skips the per-vault history
   * queries and the chain-head dependency entirely.
   */
  async vaultList(chainId: string): Promise<VaultListEntry[]> {
    const out: VaultListEntry[] = [];
    const seen = new Set<string>();
    const cached = this.peekChain(chainId);
    if (cached) {
      for (const v of cached.vaults) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        out.push({ id: v.id, protocol: v.protocol, kind: v.kind });
      }
    }
    if (this.sql && out.length < VAULT_LIST_LIMIT) {
      // Guarded like every other sink read: before `substreams-sink-sql setup` has run,
      // `vault_latest` does not exist and this query would otherwise throw out of the
      // route as a 500 instead of listing the cached Messari ids it already has.
      const rows = await readSinkRows(
        this.sql,
        `SELECT vault FROM vault_latest WHERE chain_id=$1 ORDER BY total_assets DESC NULLS LAST LIMIT $2`,
        [chainId, VAULT_LIST_LIMIT - out.length],
        `substreams vault list read for chain ${chainId}`,
      );
      for (const r of rows) {
        const id = `${chainId}:${String(r.vault).toLowerCase()}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, protocol: "erc4626", kind: "erc4626" });
      }
    }
    return out.slice(0, VAULT_LIST_LIMIT);
  }
}
