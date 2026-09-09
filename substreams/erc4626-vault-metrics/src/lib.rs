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
fn store_vault_meta(events: VaultEvents, s: StoreSetIfNotExistsProto<VaultMeta>) {
    let mut seen = HashSet::new();
    for e in events.events {
        if !seen.insert(e.vault.clone()) {
            continue;
        }
        let v = addr(&e.vault);
        let Ok(r) = RpcBatch::new()
            .add(f::Asset {}, v.clone())
            .add(f::Decimals {}, v)
            .execute()
        else {
            continue;
        };
        let asset = RpcBatch::decode::<_, f::Asset>(&r.responses[0]).unwrap_or_default();
        let share_dec = RpcBatch::decode::<_, f::Decimals>(&r.responses[1])
            .unwrap_or_else(|| BigInt::from(18u64));
        let (sym, adec) = match RpcBatch::new()
            .add(f::Symbol {}, asset.clone())
            .add(f::Decimals {}, asset.clone())
            .execute()
        {
            Ok(a) => (
                RpcBatch::decode::<_, f::Symbol>(&a.responses[0]).unwrap_or_default(),
                RpcBatch::decode::<_, f::Decimals>(&a.responses[1])
                    .unwrap_or_else(|| BigInt::from(18u64)),
            ),
            Err(_) => (String::new(), BigInt::from(18u64)),
        };
        s.set_if_not_exists(
            0,
            format!("meta:{}", e.vault),
            &VaultMeta {
                vault: e.vault.clone(),
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
        let ta =
            RpcBatch::decode::<_, f::TotalAssets>(&r.responses[0]).unwrap_or_else(BigInt::zero);
        let tsup =
            RpcBatch::decode::<_, f::TotalSupply>(&r.responses[1]).unwrap_or_else(BigInt::zero);
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
