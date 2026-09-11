import { Pool } from "pg";
import type { HistoryPoint, Source, UnifiedVault } from "../unify/types";
import { classifyFreshness, vaultFreshness } from "../unify/freshness";

export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: any[] }>;
export const SINK_REF = "substreams:erc4626-vault-metrics";

// Average seconds per block, used to turn a cursor's block number into an age against
// `head.block` — the per-chain cursors table tracks block progress only, not wall time.
// Falls back to Ethereum's 12s for chains without a known figure.
export const BLOCK_TIME_S: Record<string, number> = { "1": 12, "8453": 2 };

export function makePgQuery(databaseUrl: string): SqlQuery {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  return (text, params) => pool.query(text, params);
}

// Each chain's substreams-sink-sql instance writes its cursor to its own
// `cursors_<chainId>` table (the sink's `--cursors-table` flag), so one chain's lookup
// can never match another chain's row — a shared `cursors` table matched by
// `id LIKE '%<chainId>%'` risked exactly that (chain ids can be substrings of unrelated
// cursor ids or of each other). chainId is validated, not parameterized, before being
// interpolated into the table name: pg has no parameterized-identifier support, and the
// regex guard is what makes that interpolation safe against injection.
// A missing table (chain not yet indexed) or an empty one both surface as `null`, not a
// thrown error, so callers don't need to special-case "not deployed yet".
//
// Everything else that can fail here — credentials, connection refused, a pool with no
// free clients, a statement timeout — also has to surface as `null`, because the caller
// degrades to `freshness: "unavailable"` rather than failing the request. But returning
// null *silently* made a database outage indistinguishable from "this chain is not indexed
// yet", which is the difference between paging an operator and doing nothing. So anything
// that is not Postgres `42P01` (undefined table) is logged once. Only the error's own code
// and message go to the log, never the query text and never the connection string.
const PG_UNDEFINED_TABLE = "42P01";

/**
 * Drops anything URL-shaped out of a message before it is logged. A driver that echoes its
 * own DSN into an error text would otherwise put `postgres://user:password@host/db` in the
 * log, which is the one thing this must never do — and whether any given driver does that is
 * not something this function should have to know.
 */
const withoutUrls = (s: string): string => s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[redacted-url]");

export async function readSinkCursorBlock(q: SqlQuery, chainId: string): Promise<{ block: string } | null> {
  if (!/^\d+$/.test(chainId)) throw new Error(`readSinkCursorBlock: chainId must be numeric, got ${JSON.stringify(chainId)}`);
  let rows: any[];
  try {
    ({ rows } = await q(`SELECT block_num FROM cursors_${chainId} ORDER BY block_num DESC LIMIT 1`, []));
  } catch (e) {
    if ((e as { code?: unknown })?.code !== PG_UNDEFINED_TABLE) {
      console.warn(`substreams cursor read failed for chain ${chainId}: ${withoutUrls(e instanceof Error ? e.message : String(e))}`);
    }
    return null;
  }
  return rows[0] ? { block: String(rows[0].block_num) } : null;
}

/**
 * Runs one sink read, downgrading a failure to "no rows" rather than letting it escape.
 *
 * The cursor read above has always done this. The two queries below did not, which meant a
 * database that exists but has not been set up yet (`relation "vault_latest" does not
 * exist` — the state between pointing `DATABASE_URL` at a fresh instance and running
 * `substreams-sink-sql setup`) threw out of the reader and turned every request that
 * touches a sink-backed chain into a 500, including paid ones. The sink is an optional
 * second source: when it cannot answer, the right outcome is that it contributes nothing.
 *
 * A missing table is expected and silent; anything else is logged once, with the same
 * URL-scrubbing the cursor read uses.
 */
async function sinkRows(q: SqlQuery, text: string, params: unknown[], what: string): Promise<any[]> {
  try {
    const { rows } = await q(text, params);
    return rows;
  } catch (e) {
    if ((e as { code?: unknown })?.code !== PG_UNDEFINED_TABLE) {
      console.warn(`${what} failed: ${withoutUrls(e instanceof Error ? e.message : String(e))}`);
    }
    return [];
  }
}

export async function readErc4626Vaults(q: SqlQuery, chainId: string, vaults: string[] | null, head: { ts: number; block: number }): Promise<UnifiedVault[]> {
  const cur = await readSinkCursorBlock(q, chainId);
  let src: Source;
  if (cur) {
    const blockTimeS = BLOCK_TIME_S[chainId] ?? 12;
    const ageSeconds = Math.max(0, (head.block - Number(cur.block)) * blockTimeS);
    const ts = head.ts - ageSeconds;
    src = { kind: "substreams", ref: "erc4626-vault-metrics", block: cur.block, timestamp: String(ts), ageSeconds: String(ageSeconds), freshness: classifyFreshness("substreams", ts, head.ts) };
  } else {
    src = { kind: "substreams", ref: "erc4626-vault-metrics", block: "0", timestamp: "0", ageSeconds: String(head.ts), freshness: "unavailable" };
  }

  const rows = await sinkRows(
    q,
    `SELECT l.*, m.asset_symbol, m.asset_decimals FROM vault_latest l LEFT JOIN vault_meta m ON m.chain_id=l.chain_id AND m.vault=l.vault WHERE l.chain_id=$1 ${vaults ? "AND l.vault = ANY($2)" : ""} ORDER BY l.total_assets DESC NULLS LAST LIMIT 100`,
    vaults ? [chainId, vaults.map(v => v.toLowerCase())] : [chainId],
    `substreams vault read for chain ${chainId}`,
  );

  const out: UnifiedVault[] = [];
  for (const r of rows) {
    const h = await sinkRows(
      q,
      `SELECT block, timestamp, share_price, net_flow_assets, total_assets FROM vault_metrics WHERE chain_id=$1 AND vault=$2 AND timestamp >= $3 ORDER BY block DESC LIMIT 500`,
      [chainId, r.vault, String(head.ts - 8 * 86400)],
      `substreams history read for chain ${chainId}`,
    );
    // `series: "block"` — the sink writes one row per block it observed an event in, and
    // each row's `net_flow_assets` is that block's own movement, so these telescope cleanly
    // over any window with no second series mixed in.
    const history: HistoryPoint[] = h.map((x: any) => ({ block: String(x.block), timestamp: String(x.timestamp), sharePrice: String(x.share_price), tvlUsd: null, netFlowAssets: x.net_flow_assets == null ? null : String(x.net_flow_assets), series: "block" }));
    out.push({
      id: `${chainId}:${String(r.vault).toLowerCase()}`, kind: "erc4626", protocol: "erc4626", chain: chainId === "1" ? "ethereum" : chainId === "8453" ? "base" : chainId, chainId,
      asset: r.asset_symbol ? { symbol: r.asset_symbol, decimals: Number(r.asset_decimals) } : null,
      sharePrice: String(r.share_price), tvlUsd: null, inputTokenBalance: r.total_assets == null ? null : String(r.total_assets), depositLimit: null,
      history, sources: [src], freshness: vaultFreshness([src]),
    });
  }
  return out;
}
