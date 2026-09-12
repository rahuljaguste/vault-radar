### Task 12: Substreams module — stores, eth_call refresh, `map_vault_metrics`

**Files:**
- Modify: `substreams/erc4626-vault-metrics/{substreams.yaml,src/lib.rs}`

**Interfaces:**
- Produces: modules `store_vault_meta` (set-if-not-exists, key `meta:<vault>`, value proto `VaultMeta`), `store_depositor_seen` (set-if-not-exists, key `<vault>:<owner>`), `map_new_depositors` (deltas of `store_depositor_seen` → `NewDepositors{keys}`), `store_depositor_count` (add int64, key `<vault>`), `store_vault_flows` (add bigint, keys `dep:<vault>`, `wd:<vault>`), `store_last_call` (set, key `<vault>` → `<block>|<total_assets>|<total_supply>|<share_price>`), `map_vault_metrics` (output `VaultMetricsList`).

- [ ] **Step 1: Manifest additions**

```yaml
  - name: store_vault_meta
    kind: store
    updatePolicy: set_if_not_exists
    valueType: proto:vaultradar.v1.VaultMeta
    inputs: [{ map: map_vault_events }]
  - name: store_depositor_seen
    kind: store
    updatePolicy: set_if_not_exists
    valueType: string
    inputs: [{ map: map_vault_events }]
  - name: map_new_depositors
    kind: map
    inputs: [{ store: store_depositor_seen, mode: deltas }]
    output: { type: proto:vaultradar.v1.NewDepositors }
  - name: store_depositor_count
    kind: store
    updatePolicy: add
    valueType: int64
    inputs: [{ map: map_new_depositors }]
  - name: store_vault_flows
    kind: store
    updatePolicy: add
    valueType: bigint
    inputs: [{ map: map_vault_events }]
  - name: store_last_call
    kind: store
    updatePolicy: set
    valueType: string
    inputs: [{ map: map_vault_events }, { store: store_last_call }]
  - name: map_vault_metrics
    kind: map
    inputs:
      - map: map_vault_events
      - store: store_vault_meta
      - store: store_depositor_count
      - store: store_vault_flows
      - store: store_last_call
    output: { type: proto:vaultradar.v1.VaultMetricsList }
```

- [ ] **Step 2: Store handlers and eth_call**

```rust
use substreams::store::{StoreAddBigInt, StoreAddInt64, StoreGet, StoreGetBigInt, StoreGetInt64, StoreGetProto, StoreGetString, StoreNew, StoreSet, StoreSetIfNotExists, StoreSetIfNotExistsProto, StoreSetIfNotExistsString, StoreSetString, Deltas, DeltaString};
use substreams::scalar::BigInt;
use substreams_ethereum::rpc::RpcBatch;
use pb::vaultradar::v1::{NewDepositors, VaultMeta, VaultMetrics, VaultMetricsList};
use abi::erc4626::functions as f;
const CALL_EVERY: u64 = 300;

fn addr(v: &str) -> Vec<u8> { hex::decode(v.trim_start_matches("0x")).unwrap_or_default() }

#[substreams::handlers::store]
fn store_vault_meta(events: VaultEvents, s: StoreSetIfNotExistsProto<VaultMeta>) {
    let mut seen = std::collections::HashSet::new();
    for e in events.events { if !seen.insert(e.vault.clone()) { continue; }
        let v = addr(&e.vault);
        let r = RpcBatch::new().add(f::Asset {}, v.clone()).add(f::Decimals {}, v.clone()).execute();
        let Ok(r) = r else { continue };
        let asset = RpcBatch::decode::<_, f::Asset>(&r.responses[0]).unwrap_or_default();
        let share_dec = RpcBatch::decode::<_, f::Decimals>(&r.responses[1]).unwrap_or(18u8.into());
        let a = RpcBatch::new().add(f::Symbol {}, asset.clone()).add(f::Decimals {}, asset.clone()).execute();
        let (sym, adec) = match a { Ok(a) => (RpcBatch::decode::<_, f::Symbol>(&a.responses[0]).unwrap_or_default(), RpcBatch::decode::<_, f::Decimals>(&a.responses[1]).unwrap_or(18u8.into())), Err(_) => (String::new(), 18u8.into()) };
        s.set_if_not_exists(0, format!("meta:{}", e.vault), &VaultMeta { vault: e.vault.clone(), asset: hex0x(&asset), asset_symbol: sym, asset_decimals: adec.to_u64() as u32, share_decimals: share_dec.to_u64() as u32 });
    }
}
#[substreams::handlers::store]
fn store_depositor_seen(events: VaultEvents, s: StoreSetIfNotExistsString) {
    for e in events.events.iter().filter(|e| e.kind == "deposit") { s.set_if_not_exists(0, format!("{}:{}", e.vault, e.owner), &"1".to_string()); }
}
#[substreams::handlers::map]
fn map_new_depositors(deltas: Deltas<DeltaString>) -> Result<NewDepositors, substreams::errors::Error> {
    Ok(NewDepositors { keys: deltas.deltas.into_iter().filter(|d| d.operation == substreams::pb::substreams::store_delta::Operation::Create).map(|d| d.key).collect() })
}
#[substreams::handlers::store]
fn store_depositor_count(n: NewDepositors, s: StoreAddInt64) { for k in n.keys { let vault = k.split(':').next().unwrap_or("").to_string(); s.add(0, vault, 1); } }
#[substreams::handlers::store]
fn store_vault_flows(events: VaultEvents, s: StoreAddBigInt) {
    for e in events.events { let amt = BigInt::from_str(&e.assets).unwrap_or(BigInt::zero());
        let key = if e.kind == "deposit" { format!("dep:{}", e.vault) } else { format!("wd:{}", e.vault) }; s.add(0, key, &amt); }
}
#[substreams::handlers::store]
fn store_last_call(events: VaultEvents, prev: StoreGetString, s: StoreSetString) {
    let mut done = std::collections::HashSet::new();
    for e in events.events { if !done.insert(e.vault.clone()) { continue; }
        let last_block = prev.get_last(&e.vault).and_then(|v| v.split('|').next().and_then(|b| b.parse::<u64>().ok())).unwrap_or(0);
        if e.block.saturating_sub(last_block) < CALL_EVERY { continue; }
        let v = addr(&e.vault);
        let Ok(r) = RpcBatch::new().add(f::TotalAssets {}, v.clone()).add(f::TotalSupply {}, v).execute() else { continue };
        let ta = RpcBatch::decode::<_, f::TotalAssets>(&r.responses[0]).unwrap_or_default();
        let tsup = RpcBatch::decode::<_, f::TotalSupply>(&r.responses[1]).unwrap_or_default();
        let price = ratio(&ta.to_string(), &tsup.to_string());
        s.set(0, e.vault.clone(), &format!("{}|{}|{}|{}", e.block, ta, tsup, price));
    }
}
#[substreams::handlers::map]
fn map_vault_metrics(events: VaultEvents, _meta: StoreGetProto<VaultMeta>, counts: StoreGetInt64, flows: StoreGetBigInt, last: StoreGetString) -> Result<VaultMetricsList, substreams::errors::Error> {
    let mut by_vault: std::collections::BTreeMap<String, Vec<&VaultEvent>> = Default::default();
    for e in &events.events { by_vault.entry(e.vault.clone()).or_default().push(e); }
    let mut out = vec![];
    for (vault, evs) in by_vault {
        let dep = flows.get_last(format!("dep:{vault}")).unwrap_or(BigInt::zero()); let wd = flows.get_last(format!("wd:{vault}")).unwrap_or(BigInt::zero());
        let net_flow: BigInt = evs.iter().fold(BigInt::zero(), |acc, e| { let a = BigInt::from_str(&e.assets).unwrap_or(BigInt::zero()); if e.kind == "deposit" { acc + a } else { acc - a } });
        let lc = last.get_last(&vault); let parts: Vec<String> = lc.map(|s| s.split('|').map(String::from).collect()).unwrap_or_default();
        let (src, price, ta, tsup) = if parts.len() == 4 && parts[0].parse::<u64>().unwrap_or(0) == evs[0].block { ("call", parts[3].clone(), parts[1].clone(), parts[2].clone()) } else { ("event", evs.last().unwrap().implied_share_price.clone(), String::new(), String::new()) };
        out.push(VaultMetrics { vault: vault.clone(), block: evs[0].block, timestamp: evs[0].timestamp, share_price: price, share_price_source: src.into(),
            total_assets: ta, total_supply: tsup, net_deposited_assets: (dep - wd).to_string(), net_flow_assets: net_flow.to_string(),
            depositor_count: counts.get_last(&vault).unwrap_or(0) as u64, last_event_block: evs[0].block });
    }
    Ok(VaultMetricsList { metrics: out })
}
```

Compile errors around store trait names are expected on first build: consult `substreams` 0.6 docs (`substreams::store`) and fix the imports; the logic above is the contract.

- [ ] **Step 3: Run**

`substreams run -e mainnet.eth.streamingfast.io:443 substreams.yaml map_vault_metrics -s <initialBlock> -t +400` → metrics with `share_price_source: "call"` appearing for vaults touched after 300 blocks.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(substreams): vault stores, eth_call share-price refresh, map_vault_metrics"`

