### Task 13: Substreams module, SQL sink, Neon, publish

**Files:**
- Create: `substreams/erc4626-vault-metrics/schema.sql`, `substreams/erc4626-vault-metrics/README.md`
- Modify: `substreams.yaml` (add `db_out`), `src/lib.rs`

- [ ] **Step 1: schema.sql**

```sql
CREATE TABLE IF NOT EXISTS vault_metrics (
  chain_id TEXT NOT NULL, vault TEXT NOT NULL, block BIGINT NOT NULL, timestamp BIGINT NOT NULL,
  share_price NUMERIC NOT NULL, share_price_source TEXT NOT NULL, total_assets NUMERIC, total_supply NUMERIC,
  net_deposited_assets NUMERIC, net_flow_assets NUMERIC, depositor_count BIGINT, last_event_block BIGINT,
  PRIMARY KEY (chain_id, vault, block));
CREATE TABLE IF NOT EXISTS vault_latest (
  chain_id TEXT NOT NULL, vault TEXT NOT NULL, block BIGINT NOT NULL, timestamp BIGINT NOT NULL,
  share_price NUMERIC NOT NULL, total_assets NUMERIC, total_supply NUMERIC, net_deposited_assets NUMERIC,
  depositor_count BIGINT, last_event_block BIGINT, PRIMARY KEY (chain_id, vault));
CREATE TABLE IF NOT EXISTS vault_meta (
  chain_id TEXT NOT NULL, vault TEXT NOT NULL, asset TEXT, asset_symbol TEXT, asset_decimals INT, share_decimals INT,
  PRIMARY KEY (chain_id, vault));
CREATE INDEX IF NOT EXISTS vault_metrics_ts ON vault_metrics (chain_id, vault, timestamp DESC);
```

- [ ] **Step 2: `db_out` module**

Manifest:

```yaml
  - name: db_out
    kind: map
    inputs:
      - params: string
      - map: map_vault_metrics
      - store: store_vault_meta
        mode: deltas
    output: { type: proto:sf.substreams.sink.database.v1.DatabaseChanges }
params:
  db_out: "1"
sink:
  module: db_out
  type: sf.substreams.sink.sql.v1.Service
  config:
    schema: "./schema.sql"
    engine: postgres
```

Handler (chain id from params):

```rust
use substreams_database_change::pb::database::DatabaseChanges; use substreams_database_change::tables::Tables;
#[substreams::handlers::map]
fn db_out(chain_id: String, m: VaultMetricsList, meta: Deltas<substreams::store::DeltaProto<VaultMeta>>) -> Result<DatabaseChanges, substreams::errors::Error> {
    let mut t = Tables::new();
    for x in m.metrics {
        t.create_row("vault_metrics", [("chain_id", chain_id.clone()), ("vault", x.vault.clone()), ("block", x.block.to_string())])
            .set("timestamp", x.timestamp).set("share_price", &x.share_price).set("share_price_source", &x.share_price_source)
            .set("total_assets", &x.total_assets).set("total_supply", &x.total_supply).set("net_deposited_assets", &x.net_deposited_assets)
            .set("net_flow_assets", &x.net_flow_assets).set("depositor_count", x.depositor_count).set("last_event_block", x.last_event_block);
        t.update_row("vault_latest", [("chain_id", chain_id.clone()), ("vault", x.vault.clone())])
            .set("block", x.block).set("timestamp", x.timestamp).set("share_price", &x.share_price).set("total_assets", &x.total_assets)
            .set("total_supply", &x.total_supply).set("net_deposited_assets", &x.net_deposited_assets).set("depositor_count", x.depositor_count).set("last_event_block", x.last_event_block);
    }
    for d in meta.deltas { let v = d.new_value;
        t.create_row("vault_meta", [("chain_id", chain_id.clone()), ("vault", v.vault.clone())]).set("asset", &v.asset).set("asset_symbol", &v.asset_symbol).set("asset_decimals", v.asset_decimals).set("share_decimals", v.share_decimals); }
    Ok(t.to_database_changes())
}
```

Add `substreams-database-change = "2"` to Cargo. Empty strings for `total_assets`/`total_supply` must be written as NULL: skip `.set` when the string is empty.

- [ ] **Step 3: Sink to Neon**

```bash
brew install streamingfast/tap/substreams-sink-sql
substreams build          # produces erc4626-vault-metrics-v0.1.0.spkg
substreams-sink-sql setup "$DATABASE_URL" ./erc4626-vault-metrics-v0.1.0.spkg
substreams-sink-sql run "$DATABASE_URL" ./erc4626-vault-metrics-v0.1.0.spkg -e mainnet.eth.streamingfast.io:443 --params db_out=1 --final-blocks-only
```

Run Base with the Base manifest and `--params db_out=8453` into the same database. Keep both sinks running on the service host (Task 20 adds them to the Fly machine as background processes, or run them from your laptop for the demo). Verify: `psql "$DATABASE_URL" -c "SELECT chain_id, count(*) FROM vault_latest GROUP BY 1"` and `\d cursors`; adjust Task 10's cursor query if the table differs.

Hosted sink (preferred if it works within 30 minutes): on thegraph.market, Hosted Sinks → New → upload/point at the published package → Postgres → paste the Neon URL → deploy. Either path consumes live data through The Graph Market.

- [ ] **Step 4: Publish**

`substreams registry login` (GitHub) then `substreams registry publish ./erc4626-vault-metrics-v0.1.0.spkg`. Record the substreams.dev URL in `substreams/erc4626-vault-metrics/README.md` with: what the package does, module graph, how it composes Pinax `erc4626`, how to sink it, and the `initialBlock` policy.

- [ ] **Step 5: Commit**, `git add -A && git commit -m "feat(substreams): SQL sink, Neon deployment, package published to substreams.dev"`

