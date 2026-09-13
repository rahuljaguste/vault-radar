### Task 10: Substreams sink reader

**Files:**
- Create: `packages/core/src/substreams/reader.ts`, `packages/core/test/reader.test.ts`

**Interfaces:**
- Produces: `type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: any[] }>`; `readErc4626Vaults(q: SqlQuery, chainId: string, vaults: string[] | null, headTs: number): Promise<UnifiedVault[]>`; `readSinkCursorBlock(q, chainId): Promise<{ block: string; timestamp: string } | null>`; `makePgQuery(databaseUrl): SqlQuery` (uses `pg.Pool`).
- Tables (Task 13 defines them): `vault_latest(chain_id, vault, block, timestamp, share_price, total_assets, total_supply, net_deposited_assets, depositor_count, last_event_block)`, `vault_metrics(chain_id, vault, block, timestamp, share_price, net_flow_assets, total_assets)`, `vault_meta(chain_id, vault, asset, asset_symbol, asset_decimals, share_decimals)`, plus the sink's own `cursors(id, cursor, block_num, block_id)` table.

- [ ] **Step 1: Failing test with a fake query**

```ts
import { expect, test } from "bun:test";
import { readErc4626Vaults } from "../src/substreams/reader";
const now = 1_760_000_000;
const fake = async (text: string) => {
  if (text.includes("FROM cursors")) return { rows: [{ block_num: "1000", timestamp: String(now - 60) }] };
  if (text.includes("FROM vault_latest")) return { rows: [{ chain_id: "1", vault: "0xabc", block: "990", timestamp: String(now - 100), share_price: "1.02", total_assets: "5000", total_supply: "4900", net_deposited_assets: "4000", depositor_count: "12", last_event_block: "990", asset_symbol: "USDC", asset_decimals: "6" }] };
  if (text.includes("FROM vault_metrics")) return { rows: [{ block: "900", timestamp: String(now - 4000), share_price: "1.01", net_flow_assets: "-100", total_assets: "5100" }] };
  return { rows: [] };
};
test("reader builds erc4626 UnifiedVault with substreams source from cursor", async () => {
  const [v] = await readErc4626Vaults(fake, "1", ["0xabc"], now);
  expect(v.kind).toBe("erc4626"); expect(v.id).toBe("1:0xabc"); expect(v.sharePrice).toBe("1.02");
  expect(v.sources[0]).toMatchObject({ kind: "substreams", block: "1000", freshness: "fresh" });
  expect(v.history[0].netFlowAssets).toBe("-100"); expect(v.asset).toEqual({ symbol: "USDC", decimals: 6 });
});
```

- [ ] **Step 2: Implement**

```ts
import { Pool } from "pg";
import type { HistoryPoint, Source, UnifiedVault } from "../unify/types";
import { classifyFreshness, vaultFreshness } from "../unify/freshness";
export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: any[] }>;
export const SINK_REF = "substreams:erc4626-vault-metrics";
export function makePgQuery(databaseUrl: string): SqlQuery { const pool = new Pool({ connectionString: databaseUrl, max: 4 }); return (text, params) => pool.query(text, params); }
export async function readSinkCursorBlock(q: SqlQuery, chainId: string) {
  const { rows } = await q(`SELECT c.block_num, m.timestamp FROM cursors c LEFT JOIN LATERAL (SELECT timestamp FROM vault_metrics WHERE chain_id=$1 ORDER BY block DESC LIMIT 1) m ON true WHERE c.id LIKE $2 LIMIT 1`, [chainId, `%${chainId}%`]);
  return rows[0] ? { block: String(rows[0].block_num), timestamp: String(rows[0].timestamp) } : null;
}
export async function readErc4626Vaults(q: SqlQuery, chainId: string, vaults: string[] | null, headTs: number): Promise<UnifiedVault[]> {
  const cur = await readSinkCursorBlock(q, chainId);
  const src: Source = cur
    ? { kind: "substreams", ref: "erc4626-vault-metrics", block: cur.block, timestamp: cur.timestamp, ageSeconds: String(Math.max(0, headTs - Number(cur.timestamp))), freshness: classifyFreshness("substreams", Number(cur.timestamp), headTs) }
    : { kind: "substreams", ref: "erc4626-vault-metrics", block: "0", timestamp: "0", ageSeconds: String(headTs), freshness: "unavailable" };
  const { rows } = await q(`SELECT l.*, m.asset_symbol, m.asset_decimals FROM vault_latest l LEFT JOIN vault_meta m ON m.chain_id=l.chain_id AND m.vault=l.vault WHERE l.chain_id=$1 ${vaults ? "AND l.vault = ANY($2)" : ""} ORDER BY l.total_assets DESC NULLS LAST LIMIT 100`, vaults ? [chainId, vaults.map(v => v.toLowerCase())] : [chainId]);
  const out: UnifiedVault[] = [];
  for (const r of rows) {
    const h = await q(`SELECT block, timestamp, share_price, net_flow_assets, total_assets FROM vault_metrics WHERE chain_id=$1 AND vault=$2 AND timestamp >= $3 ORDER BY block DESC LIMIT 500`, [chainId, r.vault, String(headTs - 8 * 86400)]);
    const history: HistoryPoint[] = h.rows.map((x: any) => ({ block: String(x.block), timestamp: String(x.timestamp), sharePrice: String(x.share_price), tvlUsd: null, netFlowAssets: x.net_flow_assets == null ? null : String(x.net_flow_assets) }));
    out.push({ id: `${chainId}:${String(r.vault).toLowerCase()}`, kind: "erc4626", protocol: "erc4626", chain: chainId === "1" ? "ethereum" : chainId === "8453" ? "base" : chainId, chainId,
      asset: r.asset_symbol ? { symbol: r.asset_symbol, decimals: Number(r.asset_decimals) } : null,
      sharePrice: String(r.share_price), tvlUsd: null, inputTokenBalance: r.total_assets == null ? null : String(r.total_assets), depositLimit: null,
      history, sources: [src], freshness: vaultFreshness([src]) });
  }
  return out;
}
```

The cursor table name and columns come from `substreams-sink-sql` (`cursors` with `id`, `cursor`, `block_num`, `block_id`); confirm after Task 13 with `\d cursors` and adjust the query if the sink version differs.

- [ ] **Step 3: Run, expect pass. Export everything from `packages/core/src/index.ts`. Commit**, `git add -A && git commit -m "feat(core): Substreams sink reader with cursor-based freshness"`

