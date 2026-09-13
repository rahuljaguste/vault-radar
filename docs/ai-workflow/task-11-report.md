# Task 11 report: Substreams module scaffold and `map_vault_events`

Worktree: `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/substreams`, branch `ws/substreams`.
Commit: `9799246`, "feat(substreams): erc4626-vault-metrics scaffold with map_vault_events composed from Pinax erc4626".

## What was implemented

`substreams/erc4626-vault-metrics/`, matching the brief's file layout:

- `Cargo.toml`, brief's dependency set plus one addition: `ethabi = "17"` (see Deviations).
- `substreams.yaml` (network `mainnet`) / `substreams.base.yaml` (network `base`), manifest,
  imports, protobuf config, binary, and the `map_vault_events` module exactly as specified, minus
  the `sql` import (see Deviations) and with a freshly computed `initialBlock`.
- `build.rs`, verbatim from the brief: runs `substreams_ethereum::Abigen` over `abi/erc4626.json`
  into `src/abi/erc4626.rs`.
- `rust-toolchain.toml`, `channel = "stable"`, `targets = ["wasm32-unknown-unknown"]` (brief did
  not specify content; not otherwise constrained by anything else in this repo, so this is a plain
  default for a standalone Substreams package).
- `abi/erc4626.json`, verbatim from the brief (asset, totalAssets, totalSupply, decimals, symbol).
- `proto/vaultradar/v1/vault.proto`, verbatim from the brief, including the `VaultMetricsList` /
  `VaultMetrics` / `VaultMeta` / `NewDepositors` messages that only Tasks 12-13 will use.
- `src/pb/mod.rs`, `src/pb/erc4626.v1.rs`, `src/pb/vaultradar.v1.rs`, `src/pb/sf.firehose.v2.rs`,
  `src/pb/.last_generated_hash`, output of `substreams protogen substreams.yaml
  --exclude-paths="sf/substreams,google"`, output path was the tool's own default (`src/pb`,
  confirmed via `substreams protogen --help`), committed as instructed. `sf.firehose.v2` is
  boilerplate pulled in transitively by `--include-imports`; unused by our code, harmless.
- `buf.gen.yaml`, also written by `substreams protogen` (it reuses this file on subsequent runs
  rather than regenerating it, so it's project configuration, not pure scratch output); committed
  alongside `src/pb/` for the same reproducibility reason.
- `src/abi/mod.rs`, `pub mod erc4626;`, per the brief's Step 4 instruction.
- `src/abi/erc4626.rs`, `build.rs` output, committed as instructed.
- `src/lib.rs`, the brief's Step 5 code verbatim (reformatted from the brief's dense one-line
  style to normal multi-line Rust; zero logic changes), plus a `#[allow(dead_code)]` on `mod pb;`
  (see Self-review) with a comment explaining why.
- `Cargo.lock`, committed; this package builds a final wasm artifact (cdylib), not a library
  consumed by other crates, so pinning the lockfile is the standard convention (matches other
  public Substreams example repos) and this task's "build the wasm" step needs a resolved graph.
- `docs/one-prompt.md` (repo root, not under `substreams/`), records that Step 2 was skipped per
  the controller's resolution (installing a Claude Code plugin was out of scope), preserves the
  exact one-prompt text for whoever runs it later, and notes that the SQL-sink half of that prompt
  would hit the same `sql` protodefs blocker documented below.

## Verified facts (re-checked myself, not just taken on trust)

- `substreams info` on the downloaded Pinax spkg confirms module `map_events`, input
  `sf.ethereum.type.v2.Block`, output `proto:erc4626.v1.Events`, matches the brief exactly (the
  package's own embedded doc text says `erc4626.flows.v1.Events`, but the actual declared output
  type is `erc4626.v1.Events`; the brief's stated fact, not the doc text, is correct).
- Generated `src/pb/erc4626.v1.rs` confirms the exact Rust shape: `Events{transactions}`,
  `Transaction{hash, from, to: Option<Vec<u8>>, logs}`, `Log{address, ordinal, topics, data, call,
  block_index, log: Option<log::Log>}`, `log::Log::{Deposit(Deposit), Withdraw(Withdraw)}`,
  `Deposit{sender,owner,assets,shares}`, `Withdraw{sender,receiver,owner,assets,shares}`, the
  brief's Step 5 code needed no field-name changes.
- All brief-pinned crate versions resolve as specified with no bump needed: `substreams "0.6"` →
  0.6.4, `substreams-ethereum "0.10"` → 0.10.6, `prost`/`prost-types "0.13"` → 0.13.5, `hex "0.4"`
  → 0.4.3, `num-bigint "0.4"` → 0.4.8, `num-traits "0.2"` → 0.2.19 (all checked against crates.io
  before writing Cargo.toml).
- Ethereum head at implementation time: block 25,942,379 → `initialBlock = 25742000` (head -
  200,000, rounded down to a multiple of 1000). Base head: block 51,099,244 → `initialBlock =
  49899000` (head - 1,200,000, rounded down).

## Deviations from the brief (both required, not optional polish)

1. **Added `ethabi = "17"` to `Cargo.toml` dependencies.** The brief's dependency list didn't
   include it, but the Abigen-generated `src/abi/erc4626.rs` calls `ethabi::encode`,
   `ethabi::decode`, and `ethabi::ParamType` directly by crate name, this doesn't compile without
   `ethabi` as a direct dependency, only as a transitive one. Pinned to `"17"` (not the newer
   `"18"` on crates.io) specifically to match the `17.2.0` that `substreams-ethereum` 0.10 already
   pulls in transitively, confirmed via `Cargo.lock` that only one `ethabi` version is in the
   dependency graph.

2. **Dropped the `sql` protodefs import from both manifests.** This is a real external blocker,
   not a workaround I should be quiet about. `imports.sql:
   https://github.com/streamingfast/substreams-sink-sql/releases/download/protodefs-v1.0.7/substreams-sink-sql-protodefs-v1.0.7.spkg`
   fails `substreams protogen` under the currently-installed `substreams` CLI (1.22.0, Sept 2026)
   with:
   ```
   Failure: could not reparse image: proto: google.protobuf.FieldOptions: unable to resolve
   extension 2200: file "sf/substreams/sink/sql/v1/deprecated.proto" has a name conflict over
   sf.substreams.sink.sql.v1.Service
   ```
   I isolated this: it reproduces with **only** the `sql` import present (no `erc4626`, no other
   imports, minimal manifest), it is entirely internal to that spkg, not a collision with
   anything in this package. I confirmed via `gh release list --repo streamingfast/substreams-sink-sql`
   that `protodefs-v1.0.7` (2023-11-20) is the newest protodefs release that exists, there is no
   newer version to switch to. Given Task 11's `map_vault_events` module doesn't reference the sql
   package at all (only a future `db_out` module in Task 13 would), I removed the unused, broken
   import rather than leave the package unable to `protogen`/build, and left a comment in both
   manifests plus a note here for Task 13: the actively-maintained path for building
   `sf.substreams.sink.sql.v1.DatabaseChanges` is the `substreams-database-change` crate
   (crates.io, latest `4.0.0`), which sidesteps this spkg entirely. Task 13 should either use that
   crate, or re-check for a newer protodefs release before reintroducing the `sql` import.

3. **`initialBlock: 25742000` (mainnet) / `49899000` (base)**, not the brief's example
   `23300000`, computed fresh per the controller's explicit instructions, not copied from the
   brief.

## Built and ran

```
brew install streamingfast/tap/substreams        # installed 1.22.0, no prior install existed
substreams --version                             # substreams version 1.22.0
substreams protogen substreams.yaml --exclude-paths="sf/substreams,google"
                                                  # succeeded after dropping `sql` import
CARGO_INCREMENTAL=0 cargo build --target wasm32-unknown-unknown --release
                                                  # Finished `release` profile, 0 warnings
substreams pack substreams.yaml -o ./erc4626-vault-metrics-v0.1.0.spkg       # succeeded
substreams pack substreams.base.yaml -o ./erc4626-vault-metrics-base-v0.1.0.spkg  # succeeded
substreams info <both spkgs>                     # module graph confirmed correct on both
                                                  # (map_vault_events -> erc4626:map_events,
                                                  # correct initialBlock/network on each)
```

Both packed `.spkg` files were deleted afterward (they're git-ignored via `*.spkg` and are
build output, reproducible by anyone with the two `substreams pack` commands above).

`cargo fmt -- --check`: clean for every hand-written file (`src/lib.rs`, `src/abi/mod.rs`,
`build.rs`); the only diffs are in the two *generated* files (`src/abi/erc4626.rs` from
`build.rs`, and, none actually, `src/pb/*.rs` carry a `// @generated` header that rustfmt skips
automatically). I did not reformat `src/abi/erc4626.rs`; it will be regenerated bit-for-bit by
`build.rs` on the next build regardless, so hand-formatting it would just be undone.

`cargo clippy --target wasm32-unknown-unknown --release`: 16 warnings total, **all** of them in
generated files (`src/abi/erc4626.rs`, `src/pb/sf.firehose.v2.rs`), grepped the full output to
confirm zero warnings point at any hand-written file.

## Live run against The Graph Market, skipped

`SUBSTREAMS_API_TOKEN` is not set in this environment (confirmed via `env | grep
SUBSTREAMS_API_TOKEN`), so Step 6's live check was not run, per the controller's resolution notes.
Exact command to run once a token is available (get one from https://thegraph.market → Substreams
→ API key):

```bash
export SUBSTREAMS_API_TOKEN=<token>
cd substreams/erc4626-vault-metrics
substreams run -e mainnet.eth.streamingfast.io:443 substreams.yaml map_vault_events -s 25742000 -t +50
```

Expect JSON `VaultEvent` records with `implied_share_price` near `1.0` for stable, un-fee'd
vaults. For Base: swap the endpoint to `base-mainnet.streamingfast.io:443`, the manifest to
`substreams.base.yaml`, and `-s` to `49899000`.

## Step 2 (one-prompt attempt), skipped

Per the controller's resolution (installing a Claude Code plugin was explicitly out of scope),
this step was not attempted. `docs/one-prompt.md` records this, preserves the exact prompt text
for later use, and flags that the SQL-sink half of that prompt would hit the same `protodefs-v1.0.7`
blocker documented above.

## Self-review

- **Completeness against the brief:** all Step 3-7 deliverables present; module name
  `map_vault_events`, output `proto:vaultradar.v1.VaultEvents`, proto package `vaultradar.v1`,
  and package name `erc4626_vault_metrics` all match the brief exactly, as required (Tasks 12-13
  depend on these names).
- **Naming:** unchanged from the brief throughout; no renames.
- **YAGNI:** the proto file defines four messages Task 11 doesn't use yet
  (`VaultMetricsList`/`VaultMetrics`/`VaultMeta`/`NewDepositors`), but the brief specifies the
  full proto file verbatim for Tasks 12-13 to build on, so this isn't scope creep, it's the
  brief's own file content. I did not add any Rust code, manifest modules, or store logic beyond
  `map_vault_events` itself.
- **Build warnings:** zero from `cargo build`; zero from `cargo clippy` outside generated files
  (verified by grep, see above). The `#[allow(dead_code)]` on `mod pb;` in `src/lib.rs` is the one
  place I touched hand-written code to suppress noise from *committed-but-forward-looking*
  generated proto messages, flagging it explicitly in case the reviewer would rather Task 12
  remove that attribute once it starts using those types (at which point the warnings would
  disappear on their own for the vaultradar ones; the `sf.firehose.v2` ones would remain, since
  nothing in this package will ever use them, they're inert transitive protogen output).
- **Things I did not touch:** `README.md` for the package (explicitly Task 13's deliverable per
  the plan) and `schema.sql` (also Task 13).

## Concerns for the controller / next tasks

1. **`sql` protodefs import is broken and removed** (see Deviation 2). Task 13 needs a plan for
   `DatabaseChanges` that doesn't route through `substreams-sink-sql-protodefs-v1.0.7.spkg`. I
   recommend the `substreams-database-change` crate (crates.io v4.0.0), this is the standard,
   actively-maintained path and avoids re-hitting this exact wall.
2. **`package.url` is a placeholder** (`https://github.com/rahuljaguste/vaultradar`), this repo
   has no git remote configured yet (`git remote -v` was empty), so I used the LICENSE holder's
   name as a reasonable guess. Cosmetic only (manifest metadata, not load-bearing), but worth
   fixing once a real remote exists.
3. **Live run (Step 6) and one-prompt attempt (Step 2) are both unexecuted**, per explicit
   resolution from the controller, not an oversight. Commands to complete both are above and in
   `docs/one-prompt.md`.
4. **`package.doc` is deprecated**, `substreams pack` warns `README (package.doc) not found` /
   `Description (package.description) is not set` on every pack. This is expected: the brief's
   manifest uses `doc:` (which I kept, since the brief specified it verbatim), and a
   `README.md` for the package is explicitly Task 13's file to create. Not a defect, just
   surfacing the tool's own warning so it isn't mistaken for something Task 11 broke.
