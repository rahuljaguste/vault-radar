import { Pool } from "pg";
import type { HistoryPoint, Source, UnifiedVault } from "../unify/types";
import { classifyFreshness, vaultFreshness } from "../unify/freshness";

export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: any[] }>;
export const SINK_REF = "substreams:erc4626-vault-metrics";

export function makePgQuery(databaseUrl: string): SqlQuery {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  return (text, params) => pool.query(text, params);
}

// `cursors(id, cursor, block_num, block_id)` is substreams-sink-sql's own bookkeeping
// table, not one VaultRadar defines; this is the plan's expectation of its shape.
// Task 13's deployment report confirms or corrects the column names against the
// actual sink version once it is deployed.
export async function readSinkCursorBlock(q: SqlQuery, chainId: string): Promise<{ block: string; timestamp: string } | null> {
  const { rows } = await q(
    `SELECT c.block_num, m.timestamp FROM cursors c LEFT JOIN LATERAL (SELECT timestamp FROM vault_metrics WHERE chain_id=$1 ORDER BY block DESC LIMIT 1) m ON true WHERE c.id LIKE $2 LIMIT 1`,
    [chainId, `%${chainId}%`],
  );
  return rows[0] ? { block: String(rows[0].block_num), timestamp: String(rows[0].timestamp) } : null;
}

export async function readErc4626Vaults(q: SqlQuery, chainId: string, vaults: string[] | null, headTs: number): Promise<UnifiedVault[]> {
  const cur = await readSinkCursorBlock(q, chainId);
  const src: Source = cur
    ? { kind: "substreams", ref: "erc4626-vault-metrics", block: cur.block, timestamp: cur.timestamp, ageSeconds: String(Math.max(0, headTs - Number(cur.timestamp))), freshness: classifyFreshness("substreams", Number(cur.timestamp), headTs) }
    : { kind: "substreams", ref: "erc4626-vault-metrics", block: "0", timestamp: "0", ageSeconds: String(headTs), freshness: "unavailable" };

  const { rows } = await q(
    `SELECT l.*, m.asset_symbol, m.asset_decimals FROM vault_latest l LEFT JOIN vault_meta m ON m.chain_id=l.chain_id AND m.vault=l.vault WHERE l.chain_id=$1 ${vaults ? "AND l.vault = ANY($2)" : ""} ORDER BY l.total_assets DESC NULLS LAST LIMIT 100`,
    vaults ? [chainId, vaults.map(v => v.toLowerCase())] : [chainId],
  );

  const out: UnifiedVault[] = [];
  for (const r of rows) {
    const h = await q(
      `SELECT block, timestamp, share_price, net_flow_assets, total_assets FROM vault_metrics WHERE chain_id=$1 AND vault=$2 AND timestamp >= $3 ORDER BY block DESC LIMIT 500`,
      [chainId, r.vault, String(headTs - 8 * 86400)],
    );
    const history: HistoryPoint[] = h.rows.map((x: any) => ({ block: String(x.block), timestamp: String(x.timestamp), sharePrice: String(x.share_price), tvlUsd: null, netFlowAssets: x.net_flow_assets == null ? null : String(x.net_flow_assets) }));
    out.push({
      id: `${chainId}:${String(r.vault).toLowerCase()}`, kind: "erc4626", protocol: "erc4626", chain: chainId === "1" ? "ethereum" : chainId === "8453" ? "base" : chainId, chainId,
      asset: r.asset_symbol ? { symbol: r.asset_symbol, decimals: Number(r.asset_decimals) } : null,
      sharePrice: String(r.share_price), tvlUsd: null, inputTokenBalance: r.total_assets == null ? null : String(r.total_assets), depositLimit: null,
      history, sources: [src], freshness: vaultFreshness([src]),
    });
  }
  return out;
}
