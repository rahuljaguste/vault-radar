import { createPublicClient, http } from "viem";
import {
  DEPLOYMENTS,
  fetchStandardized,
  readErc4626Vaults,
  vaultFreshness,
  SINK_REF,
  type UnifiedVault,
  type SourceRef,
  type SqlQuery,
} from "@vaultradar/core";
import type { Config } from "../config";

export type Catalog = { protocols: { protocol: string; chain: string; status: string; vaultCount: number }[]; erc4626Chains: string[] };

export interface DataProvider {
  catalog(): Promise<Catalog>;
  scan(vaultIds: string[]): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>;
  table(protocol: string, chainId: string): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>;
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

export type LiveDataProviderDeps = { fetchImpl?: typeof fetch; sql?: SqlQuery | null; now?: () => number };

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
  private readonly headCache = new Map<string, CacheEntry<Head>>();
  private readonly chainCache = new Map<string, CacheEntry<ChainResult>>();

  constructor(private readonly config: Config, deps: LiveDataProviderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sql = deps.sql ?? null;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
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
    return result;
  }

  private async getChainHead(chainId: string): Promise<Head> {
    const cached = this.headCache.get(chainId);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const rpcUrl = this.config.rpc[chainId];
    let head: Head;
    if (!rpcUrl) {
      head = STALE_HEAD;
    } else {
      try {
        const client = createPublicClient({ transport: http(rpcUrl, { fetchFn: this.fetchImpl }) });
        const block = await client.getBlock({ blockTag: "latest" });
        head = { ts: Number(block.timestamp), block: Number(block.number) };
      } catch {
        head = STALE_HEAD;
      }
    }
    this.headCache.set(chainId, { value: head, expiresAt: this.now() + HEAD_TTL_S });
    return head;
  }
}
