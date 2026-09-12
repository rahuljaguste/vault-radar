### Task 11: Substreams module — scaffold and `map_vault_events`

**Files:**
- Create: `substreams/erc4626-vault-metrics/{Cargo.toml,substreams.yaml,build.rs,rust-toolchain.toml,proto/vaultradar/v1/vault.proto,abi/erc4626.json,src/lib.rs,src/pb/mod.rs}`; `docs/one-prompt.md`

**Interfaces:**
- Produces: module `map_vault_events` (input `erc4626:map_events` + `sf.ethereum.type.v2.Block`; output `proto:vaultradar.v1.VaultEvents`) with `VaultEvent { vault: string(hex), block: u64, timestamp: u64, kind: "deposit"|"withdraw", sender, owner, assets: string, shares: string, implied_share_price: string, tx_hash: string, log_index: u32 }`.

- [ ] **Step 1: Install tooling**

```bash
brew install streamingfast/tap/substreams   # or: curl -L https://github.com/streamingfast/substreams/releases/latest/download/substreams_darwin_arm64.tar.gz | tar xz && mv substreams ~/.cargo/bin/
rustup target add wasm32-unknown-unknown
substreams --version
```

Get a Substreams API token from https://thegraph.market (Substreams → API key) and export `SUBSTREAMS_API_TOKEN`. Endpoints: Ethereum `mainnet.eth.streamingfast.io:443`, Base `base-mainnet.streamingfast.io:443` (confirm both on the Market page).

- [ ] **Step 2: One-prompt attempt (recorded, optional but cheap)**

Install the skills once: `claude plugin marketplace add streamingfast/substreams-skills && claude plugin install substreams-dev@streamingfast-substreams`. In a fresh Claude Code session inside `substreams/`, give exactly one prompt (save it to `docs/one-prompt.md`): "Create a Substreams package `erc4626-vault-metrics` for Ethereum mainnet that imports the Pinax erc4626 package from https://github.com/pinax-network/substreams-evm/raw/main/spkg/erc4626-v0.1.0.spkg, maps its Deposit and Withdraw events to a VaultEvent proto with implied share price = assets/shares, and emits a SQL sink `db_out` with a `vault_events` table." Commit whatever it produces as `chore(substreams): one-prompt generation (unreviewed)` and record the screen. Then continue with the steps below on top of it, fixing as needed. If the skills are not installed within 10 minutes, skip this step.

- [ ] **Step 3: Manifest and Cargo**

`substreams.yaml`:

```yaml
specVersion: v0.1.0
package:
  name: erc4626_vault_metrics
  version: v0.1.0
  url: https://github.com/<you>/vaultradar
  doc: ERC-4626 vault share price, flows and depositor metrics composed from the Pinax erc4626 events package.
imports:
  erc4626: https://github.com/pinax-network/substreams-evm/raw/main/spkg/erc4626-v0.1.0.spkg
  sql: https://github.com/streamingfast/substreams-sink-sql/releases/download/protodefs-v1.0.7/substreams-sink-sql-protodefs-v1.0.7.spkg
protobuf:
  files: [vaultradar/v1/vault.proto]
  importPaths: [./proto]
binaries:
  default:
    type: wasm/rust-v1
    file: ./target/wasm32-unknown-unknown/release/erc4626_vault_metrics.wasm
network: mainnet
modules:
  - name: map_vault_events
    kind: map
    initialBlock: 23300000
    inputs:
      - source: sf.ethereum.type.v2.Block
      - map: erc4626:map_events
    output:
      type: proto:vaultradar.v1.VaultEvents
```

`initialBlock`: set to (current Ethereum head − 200000) at the time you run this; for Base use a second manifest `substreams.base.yaml` with `network: base` and `initialBlock` = head − 1200000.

`Cargo.toml`:

```toml
[package]
name = "erc4626_vault_metrics"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib"]
[dependencies]
substreams = "0.6"
substreams-ethereum = "0.10"
prost = "0.13"
prost-types = "0.13"
hex = "0.4"
num-bigint = "0.4"
num-traits = "0.2"
[build-dependencies]
substreams-ethereum = "0.10"
[profile.release]
lto = true
opt-level = "s"
strip = "debuginfo"
```

`build.rs`: `fn main() { substreams_ethereum::Abigen::new("ERC4626", "abi/erc4626.json").unwrap().generate().unwrap().write_to_file("src/abi/erc4626.rs").unwrap(); }`

`abi/erc4626.json` (minimal):

```json
[
 {"type":"function","name":"asset","inputs":[],"outputs":[{"name":"","type":"address"}],"stateMutability":"view"},
 {"type":"function","name":"totalAssets","inputs":[],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
 {"type":"function","name":"totalSupply","inputs":[],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
 {"type":"function","name":"decimals","inputs":[],"outputs":[{"name":"","type":"uint8"}],"stateMutability":"view"},
 {"type":"function","name":"symbol","inputs":[],"outputs":[{"name":"","type":"string"}],"stateMutability":"view"}
]
```

`proto/vaultradar/v1/vault.proto`:

```proto
syntax = "proto3";
package vaultradar.v1;
message VaultEvents { repeated VaultEvent events = 1; }
message VaultEvent {
  string vault = 1; uint64 block = 2; uint64 timestamp = 3; string kind = 4;
  string sender = 5; string owner = 6; string assets = 7; string shares = 8;
  string implied_share_price = 9; string tx_hash = 10; uint32 log_index = 11;
}
message VaultMetricsList { repeated VaultMetrics metrics = 1; }
message VaultMetrics {
  string vault = 1; uint64 block = 2; uint64 timestamp = 3; string share_price = 4; string share_price_source = 5;
  string total_assets = 6; string total_supply = 7; string net_deposited_assets = 8; string net_flow_assets = 9;
  uint64 depositor_count = 10; uint64 last_event_block = 11;
}
message VaultMeta { string vault = 1; string asset = 2; string asset_symbol = 3; uint32 asset_decimals = 4; uint32 share_decimals = 5; }
message NewDepositors { repeated string keys = 1; }
```

- [ ] **Step 4: Generate protobuf bindings**

Run: `substreams protogen substreams.yaml --exclude-paths="sf/substreams,google"` → writes `src/pb/…` including `erc4626.v1` (Pinax) and `vaultradar.v1`. Add `src/pb/mod.rs` as generated. Add `mod abi;` with `pub mod erc4626;` in `src/abi/mod.rs`.

- [ ] **Step 5: `map_vault_events`**

`src/lib.rs`:

```rust
mod abi; mod pb;
use pb::erc4626::v1::{Events, log::Log as PinaxLog};
use pb::vaultradar::v1::{VaultEvent, VaultEvents};
use substreams_ethereum::pb::eth::v2::Block;
use num_bigint::BigUint; use num_traits::Zero;

fn hex0x(b: &[u8]) -> String { format!("0x{}", hex::encode(b)) }
/// assets/shares as a decimal string with 18 fractional digits; "0" when shares is zero.
fn ratio(assets: &str, shares: &str) -> String {
    let a = assets.parse::<BigUint>().unwrap_or_default(); let s = shares.parse::<BigUint>().unwrap_or_default();
    if s.is_zero() { return "0".into(); }
    let scaled = a * BigUint::from(10u128.pow(18)) / s;
    let t = scaled.to_string();
    if t.len() <= 18 { format!("0.{}{}", "0".repeat(18 - t.len()), t) } else { let (i, f) = t.split_at(t.len() - 18); format!("{i}.{f}") }
}

#[substreams::handlers::map]
fn map_vault_events(block: Block, events: Events) -> Result<VaultEvents, substreams::errors::Error> {
    let ts = block.timestamp_seconds(); let mut out = vec![];
    for tx in events.transactions {
        for log in tx.logs {
            let (kind, sender, owner, assets, shares) = match log.log {
                Some(PinaxLog::Deposit(d)) => ("deposit", d.sender, d.owner, d.assets, d.shares),
                Some(PinaxLog::Withdraw(w)) => ("withdraw", w.sender, w.owner, w.assets, w.shares),
                None => continue,
            };
            out.push(VaultEvent { vault: hex0x(&log.address), block: block.number, timestamp: ts, kind: kind.into(),
                sender: hex0x(&sender), owner: hex0x(&owner), implied_share_price: ratio(&assets, &shares),
                assets, shares, tx_hash: hex0x(&tx.hash), log_index: log.block_index });
        }
    }
    Ok(VaultEvents { events: out })
}
```

- [ ] **Step 6: Build and run against The Graph Market**

```bash
cargo build --target wasm32-unknown-unknown --release
substreams run -e mainnet.eth.streamingfast.io:443 substreams.yaml map_vault_events -s 23300000 -t +50
```

Expected: JSON output with events whose `implied_share_price` is near 1.0 for stable vaults. If the Pinax import fails to resolve, download the spkg to `deps/erc4626-v0.1.0.spkg` and reference it by relative path.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(substreams): erc4626-vault-metrics scaffold with map_vault_events composed from Pinax erc4626"`

