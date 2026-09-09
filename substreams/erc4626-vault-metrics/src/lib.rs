mod abi;
// vault.proto declares VaultMetricsList/VaultMetrics/VaultMeta/NewDepositors for Tasks 12/13,
// and protogen pulls in the unrelated sf.firehose.v2 RPC types transitively; both are unused
// by map_vault_events today. Generated code, not hand-edited: silence dead_code here instead.
#[allow(dead_code)]
mod pb;

use num_bigint::BigUint;
use num_traits::Zero;
use pb::erc4626::v1::{log::Log as PinaxLog, Events};
use pb::vaultradar::v1::{VaultEvent, VaultEvents};
use substreams_ethereum::pb::eth::v2::Block;

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// assets/shares as a decimal string with 18 fractional digits; "0" when shares is zero.
fn ratio(assets: &str, shares: &str) -> String {
    let a = assets.parse::<BigUint>().unwrap_or_default();
    let s = shares.parse::<BigUint>().unwrap_or_default();
    if s.is_zero() {
        return "0".into();
    }
    let scaled = a * BigUint::from(10u128.pow(18)) / s;
    let t = scaled.to_string();
    if t.len() <= 18 {
        format!("0.{}{}", "0".repeat(18 - t.len()), t)
    } else {
        let (i, f) = t.split_at(t.len() - 18);
        format!("{i}.{f}")
    }
}

#[substreams::handlers::map]
fn map_vault_events(block: Block, events: Events) -> Result<VaultEvents, substreams::errors::Error> {
    let ts = block.timestamp_seconds();
    let mut out = vec![];
    for tx in events.transactions {
        for log in tx.logs {
            let (kind, sender, owner, assets, shares) = match log.log {
                Some(PinaxLog::Deposit(d)) => ("deposit", d.sender, d.owner, d.assets, d.shares),
                Some(PinaxLog::Withdraw(w)) => ("withdraw", w.sender, w.owner, w.assets, w.shares),
                None => continue,
            };
            out.push(VaultEvent {
                vault: hex0x(&log.address),
                block: block.number,
                timestamp: ts,
                kind: kind.into(),
                sender: hex0x(&sender),
                owner: hex0x(&owner),
                implied_share_price: ratio(&assets, &shares),
                assets,
                shares,
                tx_hash: hex0x(&tx.hash),
                log_index: log.block_index,
            });
        }
    }
    Ok(VaultEvents { events: out })
}
