mod abi;
// vault.proto declares VaultEvents/VaultMetricsList/VaultMetrics/VaultMeta/NewDepositors, all of
// which are used by the handlers below. protogen also pulls in the unrelated sf.firehose.v2 RPC
// types transitively; nothing in this package calls them. Generated code, not hand-edited:
// silence dead_code here instead of pruning generated output.
#[allow(dead_code)]
mod pb;

use std::collections::{BTreeMap, HashSet};
use std::str::FromStr;

use num_bigint::BigUint;
use num_traits::Zero;
use substreams::scalar::BigInt;
use substreams::store::{
    DeltaProto, DeltaString, Deltas, StoreAdd, StoreAddBigInt, StoreAddInt64, StoreGet,
    StoreGetBigInt, StoreGetInt64, StoreGetProto, StoreGetString, StoreNew, StoreSet,
    StoreSetIfNotExists, StoreSetIfNotExistsProto, StoreSetIfNotExistsString, StoreSetString,
};
use substreams_database_change::pb::database::DatabaseChanges;
use substreams_database_change::tables::Tables;
use substreams_ethereum::pb::eth::v2::Block;
use substreams_ethereum::rpc::RpcBatch;

use abi::erc4626::functions as f;
use pb::erc4626::v1::{log::Log as PinaxLog, Events};
use pb::vaultradar::v1::{
    NewDepositors, VaultEvent, VaultEvents, VaultMeta, VaultMetrics, VaultMetricsList,
};

/// A vault gets a fresh `totalAssets`/`totalSupply` eth_call on first sight, and then at most
/// once every this many blocks thereafter (see `store_last_call`).
const CALL_EVERY: u64 = 300;

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// Decodes a `0x...`-prefixed hex address string back into raw bytes for an eth_call target.
fn addr(v: &str) -> Vec<u8> {
    hex::decode(v.trim_start_matches("0x")).unwrap_or_default()
}

/// Deterministic per-vault phase in `[0, CALL_EVERY)`: the periodic (non-first-sight) trigger
/// used by `store_last_call`.
///
/// A `store` module is not allowed to depend on itself (Substreams rejects that as a graph
/// cycle: https://docs.substreams.dev/reference-material/manifest-and-components/inputs), so
/// `store_last_call` cannot read back "the block I last called this vault at" to throttle
/// itself. This computes a stand-in that needs no memory at all: each vault gets a fixed slot
/// mod `CALL_EVERY` derived from its own address, so the periodic trigger fires at most once
/// every `CALL_EVERY` blocks (whenever it next has an event on its slot), and different vaults
/// land on different blocks instead of all refreshing in lockstep. On its own this starves
/// rarely-touched vaults (a vault touched once a day has only a 1-in-`CALL_EVERY` chance per
/// touch of landing on its slot), so `store_last_call` also fires unconditionally on a vault's
/// first sighting — see there.
fn call_phase(vault: &str) -> u64 {
    addr(vault)
        .iter()
        .fold(0u64, |acc, b| acc.wrapping_mul(256).wrapping_add(*b as u64))
        % CALL_EVERY
}

/// assets/shares as a decimal string with 18 fractional digits; "0" when shares is zero; `None`
/// when either side fails to parse as a non-negative decimal integer.
fn ratio(assets: &str, shares: &str) -> Option<String> {
    let a = assets.parse::<BigUint>().ok()?;
    let s = shares.parse::<BigUint>().ok()?;
    if s.is_zero() {
        return Some("0".into());
    }
    let scaled = a * BigUint::from(10u128.pow(18)) / s;
    let t = scaled.to_string();
    Some(if t.len() <= 18 {
        format!("0.{}{}", "0".repeat(18 - t.len()), t)
    } else {
        let (i, f) = t.split_at(t.len() - 18);
        format!("{i}.{f}")
    })
}

#[substreams::handlers::map]
fn map_vault_events(
    block: Block,
    events: Events,
) -> Result<VaultEvents, substreams::errors::Error> {
    let ts = block.timestamp_seconds();
    let mut out = vec![];
    for tx in events.transactions {
        for log in tx.logs {
            let (kind, sender, owner, assets, shares) = match log.log {
                Some(PinaxLog::Deposit(d)) => ("deposit", d.sender, d.owner, d.assets, d.shares),
                Some(PinaxLog::Withdraw(w)) => ("withdraw", w.sender, w.owner, w.assets, w.shares),
                None => continue,
            };
            let Some(implied_share_price) = ratio(&assets, &shares) else {
                substreams::log::info!(
                    "skipping {} event for vault {} tx {}: unparseable assets/shares ({}/{})",
                    kind,
                    hex0x(&log.address),
                    hex0x(&tx.hash),
                    assets,
                    shares
                );
                continue;
            };
            out.push(VaultEvent {
                vault: hex0x(&log.address),
                block: block.number,
                timestamp: ts,
                kind: kind.into(),
                sender: hex0x(&sender),
                owner: hex0x(&owner),
                implied_share_price,
                assets,
                shares,
                tx_hash: hex0x(&tx.hash),
                log_index: log.block_index,
            });
        }
    }
    Ok(VaultEvents { events: out })
}

#[substreams::handlers::store]
fn store_vault_seen(events: VaultEvents, s: StoreSetIfNotExistsString) {
    let mut seen = HashSet::new();
    for e in events.events {
        if !seen.insert(e.vault.clone()) {
            continue;
        }
        s.set_if_not_exists(0, e.vault.clone(), &"1".to_string());
    }
}

/// Reuses `NewDepositors`'s `{keys}` shape for a different payload: bare vault addresses seen
/// for the first time this block, not `<vault>:<owner>` depositor composite keys. Same pattern
/// as `map_new_depositors` (a `store_*_seen` set_if_not_exists store, read here in deltas mode
/// and filtered to `Create`), applied to vaults instead of depositors so `store_vault_meta`
/// below only ever attempts its eth_call batch once per vault, ever.
#[substreams::handlers::map]
fn map_new_vaults(deltas: Deltas<DeltaString>) -> Result<NewDepositors, substreams::errors::Error> {
    Ok(NewDepositors {
        keys: deltas
            .into_iter()
            .filter(|d| d.operation == substreams::pb::substreams::store_delta::Operation::Create)
            .map(|d| d.key)
            .collect(),
    })
}

/// Fetches and caches `VaultMeta` the first (and only) time a vault is seen — see
/// `map_new_vaults`. A vault whose `asset()` or `decimals()` call fails is never retried: this
/// deliberately filters out topic-matched contracts that share the Deposit/Withdraw event
/// signature but aren't actually ERC-4626 vaults, rather than polluting the store with a
/// permanent garbage entry (`set_if_not_exists` can never be corrected later).
#[substreams::handlers::store]
fn store_vault_meta(new_vaults: NewDepositors, s: StoreSetIfNotExistsProto<VaultMeta>) {
    for vault in new_vaults.keys {
        let v = addr(&vault);
        let Ok(r) = RpcBatch::new()
            .add(f::Asset {}, v.clone())
            .add(f::Decimals {}, v)
            .execute()
        else {
            continue;
        };
        let Some(asset) = RpcBatch::decode::<_, f::Asset>(&r.responses[0]) else {
            substreams::log::info!("vault {}: asset() call failed, not caching meta", vault);
            continue;
        };
        let Some(share_dec) = RpcBatch::decode::<_, f::Decimals>(&r.responses[1]) else {
            substreams::log::info!("vault {}: decimals() call failed, not caching meta", vault);
            continue;
        };
        let Ok(a) = RpcBatch::new()
            .add(f::Symbol {}, asset.clone())
            .add(f::Decimals {}, asset.clone())
            .execute()
        else {
            continue;
        };
        let Some(sym) = RpcBatch::decode::<_, f::Symbol>(&a.responses[0]) else {
            substreams::log::info!(
                "vault {}: asset {} symbol() call failed, not caching meta",
                vault,
                hex0x(&asset)
            );
            continue;
        };
        let Some(adec) = RpcBatch::decode::<_, f::Decimals>(&a.responses[1]) else {
            substreams::log::info!(
                "vault {}: asset {} decimals() call failed, not caching meta",
                vault,
                hex0x(&asset)
            );
            continue;
        };
        s.set_if_not_exists(
            0,
            format!("meta:{}", vault),
            &VaultMeta {
                vault: vault.clone(),
                asset: hex0x(&asset),
                asset_symbol: sym,
                asset_decimals: adec.to_u64() as u32,
                share_decimals: share_dec.to_u64() as u32,
            },
        );
    }
}

#[substreams::handlers::store]
fn store_depositor_seen(events: VaultEvents, s: StoreSetIfNotExistsString) {
    for e in events.events.iter().filter(|e| e.kind == "deposit") {
        s.set_if_not_exists(0, format!("{}:{}", e.vault, e.owner), &"1".to_string());
    }
}

#[substreams::handlers::map]
fn map_new_depositors(
    deltas: Deltas<DeltaString>,
) -> Result<NewDepositors, substreams::errors::Error> {
    Ok(NewDepositors {
        keys: deltas
            .into_iter()
            .filter(|d| d.operation == substreams::pb::substreams::store_delta::Operation::Create)
            .map(|d| d.key)
            .collect(),
    })
}

#[substreams::handlers::store]
fn store_depositor_count(n: NewDepositors, s: StoreAddInt64) {
    for k in n.keys {
        let vault = k.split(':').next().unwrap_or("").to_string();
        s.add(0, vault, 1);
    }
}

#[substreams::handlers::store]
fn store_vault_flows(events: VaultEvents, s: StoreAddBigInt) {
    for e in events.events {
        let amt = BigInt::from_str(&e.assets).unwrap_or_else(|_| BigInt::zero());
        let key = if e.kind == "deposit" {
            format!("dep:{}", e.vault)
        } else {
            format!("wd:{}", e.vault)
        };
        s.add(0, key, &amt);
    }
}

/// Refreshes a vault's cached `totalAssets`/`totalSupply`/share price via eth_call when either:
/// (a) this block contains a CREATE delta for the vault's `store_vault_meta` key
///     (`meta:<vault>`) — i.e. this is the first block the vault has ever been seen in, so
///     every vault gets at least one ground-truth reading instead of relying purely on chance
///     alignment with `call_phase`; or
/// (b) `call_phase(vault)` says this block is the vault's periodic refresh slot.
#[substreams::handlers::store]
fn store_last_call(
    events: VaultEvents,
    meta_deltas: Deltas<DeltaProto<VaultMeta>>,
    s: StoreSetString,
) {
    let first_sight: HashSet<String> = meta_deltas
        .into_iter()
        .filter(|d| d.operation == substreams::pb::substreams::store_delta::Operation::Create)
        .filter_map(|d| d.key.strip_prefix("meta:").map(str::to_string))
        .collect();
    let mut done = HashSet::new();
    for e in events.events {
        if !done.insert(e.vault.clone()) {
            continue;
        }
        let due = first_sight.contains(&e.vault) || e.block % CALL_EVERY == call_phase(&e.vault);
        if !due {
            continue;
        }
        let v = addr(&e.vault);
        let Ok(r) = RpcBatch::new()
            .add(f::TotalAssets {}, v.clone())
            .add(f::TotalSupply {}, v)
            .execute()
        else {
            continue;
        };
        let Some(ta) = RpcBatch::decode::<_, f::TotalAssets>(&r.responses[0]) else {
            substreams::log::info!(
                "vault {}: totalAssets() call failed, not refreshing",
                e.vault
            );
            continue;
        };
        let Some(tsup) = RpcBatch::decode::<_, f::TotalSupply>(&r.responses[1]) else {
            substreams::log::info!(
                "vault {}: totalSupply() call failed, not refreshing",
                e.vault
            );
            continue;
        };
        if tsup.is_zero() {
            // A zero-supply vault has no meaningful share price; writing "0" here would let
            // map_vault_metrics report it as an eth_call-verified reading instead of what it
            // actually is (no valid price to verify).
            substreams::log::info!("vault {}: totalSupply() is zero, not refreshing", e.vault);
            continue;
        }
        let price = ratio(&ta.to_string(), &tsup.to_string())
            .expect("ratio: BigInt::to_string() output is always a valid decimal integer");
        s.set(
            0,
            e.vault.clone(),
            &format!("{}|{}|{}|{}", e.block, ta, tsup, price),
        );
    }
}

#[substreams::handlers::map]
fn map_vault_metrics(
    events: VaultEvents,
    _meta: StoreGetProto<VaultMeta>,
    counts: StoreGetInt64,
    flows: StoreGetBigInt,
    last: StoreGetString,
) -> Result<VaultMetricsList, substreams::errors::Error> {
    let mut by_vault: BTreeMap<String, Vec<&VaultEvent>> = BTreeMap::new();
    for e in &events.events {
        by_vault.entry(e.vault.clone()).or_default().push(e);
    }
    let mut out = vec![];
    for (vault, evs) in by_vault {
        let dep = flows
            .get_last(format!("dep:{vault}"))
            .unwrap_or_else(BigInt::zero);
        let wd = flows
            .get_last(format!("wd:{vault}"))
            .unwrap_or_else(BigInt::zero);
        let net_flow: BigInt = evs.iter().fold(BigInt::zero(), |acc, e| {
            let a = BigInt::from_str(&e.assets).unwrap_or_else(|_| BigInt::zero());
            if e.kind == "deposit" {
                acc + a
            } else {
                acc - a
            }
        });
        let parts: Vec<String> = last
            .get_last(&vault)
            .map(|s| s.split('|').map(String::from).collect())
            .unwrap_or_default();
        let (src, price, ta, tsup) =
            if parts.len() == 4 && parts[0].parse::<u64>().unwrap_or(0) == evs[0].block {
                ("call", parts[3].clone(), parts[1].clone(), parts[2].clone())
            } else {
                (
                    "event",
                    evs.last().unwrap().implied_share_price.clone(),
                    String::new(),
                    String::new(),
                )
            };
        out.push(VaultMetrics {
            vault: vault.clone(),
            block: evs[0].block,
            timestamp: evs[0].timestamp,
            share_price: price,
            share_price_source: src.into(),
            total_assets: ta,
            total_supply: tsup,
            net_deposited_assets: (dep - wd).to_string(),
            net_flow_assets: net_flow.to_string(),
            depositor_count: counts.get_last(&vault).unwrap_or(0) as u64,
            last_event_block: evs[0].block,
        });
    }
    Ok(VaultMetricsList { metrics: out })
}

/// Builds the SQL sink's `DatabaseChanges` for one block: an append-only `vault_metrics` history
/// row per touched vault this block, an upserted `vault_latest` snapshot per touched vault, and a
/// `vault_meta` row the one time each vault's metadata is first cached.
///
/// `vault_latest` uses `upsert_row` (native `OPERATION_UPSERT`, backed by Postgres
/// `INSERT ... ON CONFLICT DO UPDATE`), not `create_row`/`update_row`: a vault's very first touch
/// needs an insert and every touch after that needs an update against the same `(chain_id,
/// vault)` primary key, and `db_out` has no cheap local signal for which case it is. This is why
/// the crate is pinned to 2.1.1 rather than the 1.x line — see Cargo.toml and the manifest's
/// `database_change` import comment for the (real, compile-error-verified) reason 1.x can't do
/// this at all.
//
// `db_out` is this package's only handler with a plain `String` argument (the `params: string`
// input, i.e. `chain_id`). `substreams-macro` 0.6.4 expands any `String`-typed handler parameter
// to `let chain_id: String = ManuallyDrop::new(unsafe { String::from_raw_parts(ptr, len, len) })
// .to_string();` inside the generated `pub extern "C" fn` wrapper (confirmed by reading
// substreams-macro-0.6.4/src/handler.rs's `is_string` branch directly) — an inner `unsafe` block
// operating on a raw pointer, inside an outer function that isn't itself marked `unsafe`. Every
// other handler here decodes its arguments via `substreams::proto::decode_ptr`, a safe function
// call with no caller-visible `unsafe`, so this is the first (and only) function in the crate to
// hit clippy's `not_unsafe_ptr_arg_deref`. `cargo build` succeeds and the generated code is sound
// standard FFI string marshalling (the pointer/length pair comes straight from the Substreams
// WASM host, exactly like every other decoded argument) — this is a macro/lint interaction we
// don't control the generated code for, not a real unsafety finding. A function-level
// `#[allow(...)]` here cannot fix it: `build_map_handler` in the macro never forwards the
// original function's attributes onto the generated wrapper item, so the lint is suppressed
// crate-wide instead, in Cargo.toml's `[lints.clippy]` table (see the comment there).
#[substreams::handlers::map]
fn db_out(
    chain_id: String,
    m: VaultMetricsList,
    meta: Deltas<DeltaProto<VaultMeta>>,
) -> Result<DatabaseChanges, substreams::errors::Error> {
    let mut t = Tables::new();
    for x in m.metrics {
        let history = t.create_row(
            "vault_metrics",
            [
                ("chain_id", chain_id.clone()),
                ("vault", x.vault.clone()),
                ("block", x.block.to_string()),
            ],
        );
        history
            .set("timestamp", x.timestamp)
            .set("share_price", &x.share_price)
            .set("share_price_source", &x.share_price_source)
            .set("net_deposited_assets", &x.net_deposited_assets)
            .set("net_flow_assets", &x.net_flow_assets)
            .set("depositor_count", x.depositor_count)
            .set("last_event_block", x.last_event_block);
        // total_assets/total_supply are only populated when map_vault_metrics sourced this row
        // from an eth_call; an empty string means "no call this block" and must land as SQL NULL.
        if !x.total_assets.is_empty() {
            history.set("total_assets", &x.total_assets);
        }
        if !x.total_supply.is_empty() {
            history.set("total_supply", &x.total_supply);
        }

        let key = [("chain_id", chain_id.clone()), ("vault", x.vault.clone())];
        let latest = t.upsert_row("vault_latest", key);
        latest
            .set("block", x.block)
            .set("timestamp", x.timestamp)
            .set("share_price", &x.share_price)
            .set("net_deposited_assets", &x.net_deposited_assets)
            .set("depositor_count", x.depositor_count)
            .set("last_event_block", x.last_event_block);
        // Unlike vault_metrics above, skipping .set() here on an event-sourced (empty) reading
        // does NOT null out a previous call-sourced value already in vault_latest: the sink's
        // upsert only assigns columns present in this change (`ON CONFLICT DO UPDATE SET
        // total_assets=EXCLUDED.total_assets, ...` simply omits total_assets/total_supply from
        // that list when we never called .set), so an older figure is left in place rather than
        // cleared. That's the desired behavior for a "latest known state" table — call-sourced
        // reads happen roughly every 300 blocks (see store_last_call), so always nulling this on
        // the many event-sourced blocks in between would make the column useless for a live
        // dashboard. Verified against a real Postgres instance: two upserts on the same primary
        // key produce exactly one row holding the most recent explicitly-set values.
        if !x.total_assets.is_empty() {
            latest.set("total_assets", &x.total_assets);
        }
        if !x.total_supply.is_empty() {
            latest.set("total_supply", &x.total_supply);
        }
    }

    for d in meta
        .into_iter()
        .filter(|d| d.operation == substreams::pb::substreams::store_delta::Operation::Create)
    {
        let v = d.new_value;
        t.create_row(
            "vault_meta",
            [("chain_id", chain_id.clone()), ("vault", v.vault.clone())],
        )
        .set("asset", &v.asset)
        .set("asset_symbol", &v.asset_symbol)
        .set("asset_decimals", v.asset_decimals)
        .set("share_decimals", v.share_decimals);
    }

    Ok(t.to_database_changes())
}
