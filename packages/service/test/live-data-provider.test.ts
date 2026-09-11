import { afterAll, beforeAll, expect, test } from "bun:test";
import { DEPLOYMENTS, gatewayUrl as coreGatewayUrl, type SqlQuery } from "@vaultradar/core";
import lendFx from "../../core/test/fixtures/lending-markets.json";
import { LiveDataProvider } from "../src/data/provider";
import { loadConfig } from "../src/config";

// LiveDataProvider pulls from the real DEPLOYMENTS registry (no injection point for
// it), so these tests target chains with exactly one registry deployment each —
// chain 8453 (aave-v3/base/lending) and chain 42161 (yearn-v2/arbitrum/yield-aggregator)
// — to avoid having to fake responses for chain 1's other nine deployments too.
const AAVE_BASE_SUBGRAPH = "D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9";
const dep = (subgraphId: string) => {
  const found = DEPLOYMENTS.find((d) => d.subgraphId === subgraphId);
  if (!found) throw new Error(`no registry entry for ${subgraphId}`);
  return found;
};
// Built from the registry entry rather than hardcoded: the provider asks for the pinned
// deployment once the verification gate has pinned one, so a fixture URL that always said
// `/subgraphs/id/...` stopped matching the moment the gate ran.
const gatewayUrl = (subgraphId: string) => coreGatewayUrl(dep(subgraphId));

/** Postgres signals an undefined table with SQLSTATE 42P01; `pg` puts it on `error.code`. */
const undefinedTable = (table: string) =>
  Object.assign(new Error(`relation "${table}" does not exist`), { code: "42P01" });

// The gate found aave-v3/base "down" — upstream stopped allocating to that deployment — and
// `fetchStandardized` skips down deployments rather than querying a dead one. Correct in
// production, but it makes this suite's fixture unreachable, since the whole file exercises
// aave-v3/base. The registry is a plain array of plain objects, so the suite flips that one
// entry to "live" while it runs and restores the gate's finding afterwards. Nothing here
// writes to deployments.json; the real status is untouched on disk.
const aaveBase = dep(AAVE_BASE_SUBGRAPH);
const realStatus = aaveBase.status;
beforeAll(() => { aaveBase.status = "live"; });
afterAll(() => { aaveBase.status = realStatus; });
const RPC_URL = "http://fake-base-rpc.test";
const FIXTURE_VAULT = String(lendFx.markets[0].id).toLowerCase(); // "0xdef0000000000000000000000000000000000d"
const FIXTURE_TS = Number(lendFx._meta.block.timestamp); // 1760000000

const baseEnv = {
  PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "77".repeat(32), PQ_KEM_SEED: "88".repeat(64),
  GRAPH_STUDIO_API_KEY: "test-key", HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1",
  HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40),
  // Both overridden to the same fake endpoint: every test controls its own RPC
  // behavior via fakeFetch, so chain 1 must not fall through to the real default
  // (ETH_RPC_URL's public endpoint) whenever a test only exercises chain 1.
  ETH_RPC_URL: RPC_URL, BASE_RPC_URL: RPC_URL,
};
const config = loadConfig(baseEnv);

// A real Response, not a plain-object stand-in: viem's RPC client reads
// response.headers.get(...) and response.body directly, which a { ok, status, json() }
// shim doesn't have — that silently throws inside viem, which retries a few times and
// then surfaces as a generic failure, masking what actually went wrong.
const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hex = (n: number) => "0x" + n.toString(16);

/**
 * A minimal fetch fake that dispatches on URL and counts calls per route. viem's http
 * transport normalizes the RPC URL with a trailing slash before calling fetch (e.g.
 * "http://host" -> "http://host/"), so routes are looked up with and without one.
 */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Record<string, number> = {};
  const fetchImpl = (async (url: unknown) => {
    const raw = String(url);
    const key = routes[raw] ? raw : raw.replace(/\/$/, "");
    calls[key] = (calls[key] ?? 0) + 1;
    const route = routes[key];
    if (!route) throw new Error(`test fake: no route for ${raw}`);
    return route();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const rpcRoute = (headTs: number, headBlock: number) => () => jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { number: hex(headBlock), timestamp: hex(headTs) } });
// An HTTP-200 JSON-RPC application error, not a transport failure, so viem's transport
// retry logic (reserved for connection/429-style failures) doesn't kick in and slow
// the test down with backoff delays.
const rpcErrorRoute = () => () => jsonResponse(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } });
const gatewayRoute = (body: unknown) => () => jsonResponse(200, { data: body });

test("a working RPC head classifies a fresh subgraph vault as fresh; a failing RPC forces it stale", async () => {
  const headTs = FIXTURE_TS + 10;
  const fresh = fakeFetch({ [RPC_URL]: rpcRoute(headTs, 1000), [gatewayUrl(AAVE_BASE_SUBGRAPH)]: gatewayRoute(lendFx) });
  const freshProvider = new LiveDataProvider(config, { fetchImpl: fresh.fetchImpl, sql: null });
  const freshResult = await freshProvider.scan([`8453:${FIXTURE_VAULT}`]);
  expect(freshResult.vaults).toHaveLength(1);
  expect(freshResult.vaults[0].freshness).toBe("fresh");
  expect(freshResult.vaults[0].sharePrice).toBe(lendFx.markets[0].exchangeRate);
  expect(freshResult.sources).toEqual([{ ref: AAVE_BASE_SUBGRAPH, chainId: "8453", block: "19000000", timestamp: String(FIXTURE_TS) }]);

  // A fresh LiveDataProvider instance (its own empty caches) so the failing head isn't
  // masked by the previous instance's 15s head cache.
  const failing = fakeFetch({ [RPC_URL]: rpcErrorRoute(), [gatewayUrl(AAVE_BASE_SUBGRAPH)]: gatewayRoute(lendFx) });
  const failingProvider = new LiveDataProvider(config, { fetchImpl: failing.fetchImpl, sql: null });
  const staleResult = await failingProvider.scan([`8453:${FIXTURE_VAULT}`]);
  expect(staleResult.vaults[0].freshness).toBe("stale");
});

test("vaultList lists cached ids and survives a sink database that was never set up", async () => {
  // `/v1/vaults?chainId=` reads the sink's `vault_latest` ids in addition to the cached
  // Messari ones. Before `substreams-sink-sql setup` has run that table does not exist, and
  // the unguarded query turned the whole route into a 500 — including for the cached Messari
  // ids it could have answered with.
  const headTs = FIXTURE_TS + 10;
  const { fetchImpl } = fakeFetch({ [RPC_URL]: rpcRoute(headTs, 1000), [gatewayUrl(AAVE_BASE_SUBGRAPH)]: gatewayRoute(lendFx) });
  const sql: SqlQuery = async (text: string) => {
    if (text.includes("FROM vault_latest")) throw undefinedTable("vault_latest");
    return { rows: [] };
  };
  const provider = new LiveDataProvider(config, { fetchImpl, sql });
  await provider.scan([`8453:${FIXTURE_VAULT}`]); // warms the chain cache the list reads from

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const list = await provider.vaultList("8453");
    expect(list.map(e => e.id)).toContain(`8453:${FIXTURE_VAULT}`);
    expect(list.every(e => e.protocol === "aave-v3")).toBe(true);
    // Silent: a table that was never created is the expected pre-setup state, not a fault.
    // If this test ever starts passing because the error was swallowed as something else,
    // this assertion is what notices.
    expect(warnings).toEqual([]);
  } finally { console.warn = realWarn; }
});

test("a failing RPC forces the substreams-sink (erc4626) source stale too, never fresh", async () => {
  // rpcErrorRoute makes client.getBlock() reject, exactly like an unreachable RPC, so
  // getChainHead's catch branch fires. Uses table() (not scan()) so this exercises
  // readErc4626Vaults in isolation, with no Messari counterpart to merge against —
  // otherwise a correctly-stale Messari source could mask a wrongly-fresh sink source
  // in the merged result's recomputed freshness.
  const { fetchImpl } = fakeFetch({ [RPC_URL]: rpcErrorRoute() });
  const sql: SqlQuery = async (text: string) => {
    if (text.includes("cursors_8453")) return { rows: [{ block_num: "1000" }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: FIXTURE_VAULT, share_price: "1.0", total_assets: "500" }] };
    return { rows: [] };
  };
  const provider = new LiveDataProvider(config, { fetchImpl, sql });
  const result = await provider.table("erc4626", "8453");
  expect(result.vaults).toHaveLength(1);
  expect(result.vaults[0].freshness).not.toBe("fresh");
  expect(result.vaults[0].freshness).toBe("stale");
});

test("scan merges the subgraph record with the substreams-sink record for the same vault: Messari fields win, sources concatenate, freshness is recomputed", async () => {
  const headTs = FIXTURE_TS + 10;
  const headBlock = 1010; // 10 blocks ahead of the cursor's 1000; chain 8453 is 2s/block -> 20s age, well under substreams' 300s threshold.
  const { fetchImpl } = fakeFetch({ [RPC_URL]: rpcRoute(headTs, headBlock), [gatewayUrl(AAVE_BASE_SUBGRAPH)]: gatewayRoute(lendFx) });
  const sql: SqlQuery = async (text: string) => {
    if (text.includes("cursors_8453")) return { rows: [{ block_num: "1000" }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: FIXTURE_VAULT, share_price: "1.0", total_assets: "500" }] };
    return { rows: [] };
  };
  const provider = new LiveDataProvider(config, { fetchImpl, sql });
  const result = await provider.scan([`8453:${FIXTURE_VAULT}`]);

  expect(result.vaults).toHaveLength(1);
  const v = result.vaults[0];
  // Messari's fields win: protocol/kind come from the subgraph record, not "erc4626".
  expect(v.protocol).toBe("aave-v3");
  expect(v.kind).toBe("lending-market");
  expect(v.sharePrice).toBe(lendFx.markets[0].exchangeRate);
  // Both sources are present and freshness was recomputed from their union.
  expect(v.sources.map(s => s.kind).sort()).toEqual(["messari", "substreams"]);
  expect(v.freshness).toBe("fresh");
  // The receipt-level sources list carries both provenance refs.
  expect(result.sources.some(s => s.ref === AAVE_BASE_SUBGRAPH)).toBe(true);
  expect(result.sources.some(s => s.ref === "substreams:erc4626-vault-metrics")).toBe(true);
});

test("scan() includes a substreams-sink vault with no Messari counterpart, unmerged", async () => {
  // A different address from FIXTURE_VAULT, and absent from the lendFx fixture the
  // gateway route serves: mergeVaults's messari-side loop finds no match for it, so
  // this exercises the union side of the merge (the erc4626-only "for (const sv of
  // erc4626) if (!claimed.has(sv.id))" branch), not the same-id merge path the
  // previous test covers.
  const SINK_ONLY_VAULT = "0x" + "9".repeat(40);
  const headTs = FIXTURE_TS + 10;
  const headBlock = 1010;
  const { fetchImpl } = fakeFetch({ [RPC_URL]: rpcRoute(headTs, headBlock), [gatewayUrl(AAVE_BASE_SUBGRAPH)]: gatewayRoute(lendFx) });
  const sql: SqlQuery = async (text: string) => {
    if (text.includes("cursors_8453")) return { rows: [{ block_num: "1000" }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: SINK_ONLY_VAULT, share_price: "3.0", total_assets: "50" }] };
    return { rows: [] };
  };
  const provider = new LiveDataProvider(config, { fetchImpl, sql });
  const result = await provider.scan([`8453:${SINK_ONLY_VAULT}`]);

  expect(result.vaults).toHaveLength(1);
  const v = result.vaults[0];
  expect(v.id).toBe(`8453:${SINK_ONLY_VAULT}`);
  expect(v.kind).toBe("erc4626");
  expect(v.sources).toHaveLength(1);
  expect(v.sources[0].kind).toBe("substreams");
});

test("table('erc4626', ...) reads the substreams sink; without a sql pool it returns empty instead of throwing", async () => {
  // erc4626 table never calls fetchStandardized, so no gateway route is needed, but
  // getChainHead(chainId) still runs unconditionally at the top of table() — route
  // RPC_URL to a normal success (this test doesn't assert on freshness) rather than
  // leaving it unrouted, which would make viem retry a failure a few times first.
  const { fetchImpl } = fakeFetch({ [RPC_URL]: rpcRoute(FIXTURE_TS + 10, 1000) });
  const sql: SqlQuery = async (text: string) => {
    if (text.includes("cursors_1")) return { rows: [{ block_num: "100" }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: FIXTURE_VAULT, share_price: "2.0", total_assets: "10" }] };
    return { rows: [] };
  };
  const withSql = new LiveDataProvider(config, { fetchImpl, sql });
  const result = await withSql.table("erc4626", "1");
  expect(result.vaults).toHaveLength(1);
  expect(result.vaults[0].id).toBe(`1:${FIXTURE_VAULT}`);
  expect(result.sources).toEqual([expect.objectContaining({ ref: "substreams:erc4626-vault-metrics", chainId: "1" })]);

  const withoutSql = new LiveDataProvider(config, { fetchImpl, sql: null });
  expect(await withoutSql.table("erc4626", "1")).toEqual({ vaults: [], sources: [] });
});

test("table(protocol, chainId) for a subgraph protocol filters both vaults and sources to that one deployment", async () => {
  const headTs = FIXTURE_TS + 10;
  const { fetchImpl } = fakeFetch({ [RPC_URL]: rpcRoute(headTs, 1000), [gatewayUrl(AAVE_BASE_SUBGRAPH)]: gatewayRoute(lendFx) });
  const provider = new LiveDataProvider(config, { fetchImpl, sql: null });

  const match = await provider.table("aave-v3", "8453");
  expect(match.vaults).toHaveLength(1);
  expect(match.vaults[0].protocol).toBe("aave-v3");
  expect(match.sources).toEqual([{ ref: AAVE_BASE_SUBGRAPH, chainId: "8453", block: "19000000", timestamp: String(FIXTURE_TS) }]);

  // Registry has no such (protocol, chain) pair: no crash, nothing returned.
  const noMatch = await provider.table("nonexistent-protocol", "8453");
  expect(noMatch).toEqual({ vaults: [], sources: [] });
});

test("catalog() reports zero vaultCount for an uncached deployment, and the real count once scan()/table() has warmed that chain's cache", async () => {
  const headTs = FIXTURE_TS + 10;
  const { fetchImpl } = fakeFetch({ [RPC_URL]: rpcRoute(headTs, 1000), [gatewayUrl(AAVE_BASE_SUBGRAPH)]: gatewayRoute(lendFx) });
  const provider = new LiveDataProvider(config, { fetchImpl, sql: null });

  const before = await provider.catalog();
  const baseRow = before.protocols.find(p => p.protocol === "aave-v3" && p.chain === "base");
  expect(baseRow).toEqual({ protocol: "aave-v3", chain: "base", status: dep(AAVE_BASE_SUBGRAPH).status, vaultCount: 0 });
  expect(before.protocols).toHaveLength(15); // one row per registry deployment
  expect(before.erc4626Chains).toEqual([]);

  await provider.table("aave-v3", "8453"); // warms chain 8453's 60s cache
  const after = await provider.catalog();
  expect(after.protocols.find(p => p.protocol === "aave-v3" && p.chain === "base")).toEqual({ protocol: "aave-v3", chain: "base", status: dep(AAVE_BASE_SUBGRAPH).status, vaultCount: 1 });
  // A chain never touched stays uncached.
  expect(after.protocols.find(p => p.chain === "ethereum" && p.protocol === "aave-v3")?.vaultCount).toBe(0);

  const withSql = new LiveDataProvider(config, { fetchImpl, sql: async () => ({ rows: [] }) });
  expect((await withSql.catalog()).erc4626Chains).toEqual(["1", "8453"]);
});

test("the subgraph fetch is cached 60s per chain and the chain head is cached 15s, independently", async () => {
  let t = 1_000_000;
  const now = () => t;
  const headTs = FIXTURE_TS + 10;
  const { fetchImpl, calls } = fakeFetch({ [RPC_URL]: rpcRoute(headTs, 1000), [gatewayUrl(AAVE_BASE_SUBGRAPH)]: gatewayRoute(lendFx) });
  const provider = new LiveDataProvider(config, { fetchImpl, sql: null, now });
  const gw = gatewayUrl(AAVE_BASE_SUBGRAPH);

  await provider.scan([`8453:${FIXTURE_VAULT}`]);
  expect(calls[RPC_URL]).toBe(1);
  expect(calls[gw]).toBe(1);

  t += 10; // within both the 15s head TTL and the 60s chain TTL
  await provider.scan([`8453:${FIXTURE_VAULT}`]);
  expect(calls[RPC_URL]).toBe(1);
  expect(calls[gw]).toBe(1);

  t += 20; // head TTL (15s) has expired; chain TTL (60s) has not
  await provider.scan([`8453:${FIXTURE_VAULT}`]);
  expect(calls[RPC_URL]).toBe(2);
  expect(calls[gw]).toBe(1);

  t += 45; // now 75s after the first call: both TTLs have expired
  await provider.scan([`8453:${FIXTURE_VAULT}`]);
  expect(calls[RPC_URL]).toBe(3);
  expect(calls[gw]).toBe(2);
});
