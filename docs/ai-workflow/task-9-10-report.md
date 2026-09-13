# Task 9 & 10 implementation report

Branch: `ws/core`, worktree `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/core`.
Commits: `c9da8f9` (Task 9), `8198ced` (Task 10), `950fdd5` (fix round 1).

## Task 9: Messari standardized subgraph layer and deployment verification gate

### What I implemented

- `packages/core/src/standardized/types.ts`, `Deployment` type only (see "Deviation" below for `SourceRef`).
- `packages/core/src/standardized/deployments.json`, registry, loaded via `registry.ts`.
- `packages/core/src/standardized/registry.ts`, `export const DEPLOYMENTS = deployments as Deployment[]`.
- `packages/core/src/standardized/templates.ts`, `META`, `YIELD_VAULTS_QUERY`, `LENDING_MARKETS_QUERY`, verbatim from the brief.
- `packages/core/src/standardized/gateway.ts`, `gatewayUrl`, `queryDeployment`, verbatim from the brief.
- `packages/core/src/standardized/map.ts`, `mapYieldVaults`, `mapLendingMarkets`, verbatim from the brief.
- `packages/core/src/standardized/index.ts`, re-exports of the five files above, plus `fetchStandardized` (deployments run concurrently via `Promise.allSettled`, `status === "down"` deployments skipped entirely, one `SourceRef` collected per attempted deployment, failures get `block: "0", timestamp: "0"` and log only `error.message`).
- `scripts/verify-deployments.ts`, verbatim from the brief, fixed the destructured field order comment (non-issue, object destructuring is order-independent) and added an explicit `Deployment[]` type annotation on the accumulator for clean strict-mode inference.
- `packages/core/src/index.ts`, added `export * from "./standardized";`.
- Test fixtures: `packages/core/test/fixtures/yield-vaults.json` (one vault, 2 hourly + 2 daily snapshots, `_meta.block.timestamp = 1760000000`), `lending-markets.json` (one market, same snapshot shape with `exchangeRate`/deposit-withdraw fields).
- `packages/core/test/standardized-map.test.ts`, the brief's two tests plus two I added: missing snapshot arrays degrade to empty history instead of throwing, and a stale-headTs case reflects in `freshness`.
- `packages/core/test/standardized-fetch.test.ts` (new, not in the brief's file list, added per the controller's explicit ask for an offline `fetchStandardized` test), asserts vault count, both `SourceRef`s (good deployment's real block, failing deployment's `block: "0"`), that only one `console.error` call happens and it carries no response body, and that a deployment already marked `"down"` is skipped with zero vaults/sources and its `fetchImpl` never invoked.

### TDD evidence

RED (before any `src/standardized/*` files existed):
```
$ bun test packages/core/test/standardized-map.test.ts packages/core/test/standardized-fetch.test.ts
error: Cannot find module '../src/standardized/map' from '.../standardized-map.test.ts'
error: Cannot find module '../src/standardized' from '.../standardized-fetch.test.ts'
 0 pass / 2 fail / 2 errors
```

GREEN (after implementation):
```
$ bun test packages/core/test/standardized-map.test.ts packages/core/test/standardized-fetch.test.ts
 6 pass
 0 fail
 22 expect() calls
```

Typecheck: `bun x tsc -p packages/core/tsconfig.json --noEmit`, clean (after the `SourceRef` fix below).

### Registry entries: added and skipped

The 8 entries from the brief were added verbatim. I fetched `https://raw.githubusercontent.com/messari/subgraphs/master/deployment/deployment.json` and searched for `decentralized-network` under the four named protocols. Added (all `status: "unverified"`, `schema: "yield-aggregator"`):

| protocol | chain | chainId | subgraphId |
|---|---|---|---|
| convex-finance | ethereum | 1 | `7rFZ2x6aLQ7EZsNx8F5yenk4xcqwqR3Dynf9rdixCSME` |
| aura-finance | ethereum | 1 | `EcNHwEGXq3KW1vCbHHj1iwvtf62ae5kxzEQhKtRqPygt` |
| arrakis-finance | ethereum | 1 | `GnroBYmeLLtKuHNyTNS38hzKki5n4CWaHeaMRqZpU4cr` |
| arrakis-finance | optimism | 10 | `6yqMWioX8XNx2aMDYJGnvrVQWNrZfgBzY3ee1RmkXh5Z` |
| arrakis-finance | polygon | 137 | `9YGjubD69wpCHyMMadVJv9eABKKUMWyBGYkZHVFEeWM8` |
| gamma-strategies | ethereum | 1 | `ANz3TpZdY2syZGQvGA85ANNG7KiSWdPmv55kP4H4sRPJ` |
| gamma-strategies | polygon | 137 | `AyxB5Suv1REgRZPUwbgbbqtpwftvTC46dbiHPuBQuF8y` |

Skipped (no `decentralized-network` entry, only `hosted-service`, both also `status: "dev"` in Messari's own registry): `gamma-strategies-arbitrum`, `gamma-strategies-optimism`. Total registry size: 15 entries.

### Deviation from the brief: `SourceRef`

The brief's Step-5 prose asks for a `SourceRef` shaped `{ ref, chainId, block, timestamp }` for `fetchStandardized`'s return. `packages/core/src/receipts.ts:6` already defines exactly this type (`export type SourceRef = { ref: string; chainId: string; block: string; timestamp: string }`, used by `Receipt.sources`). Declaring a second, identical `SourceRef` in `standardized/types.ts` produced a real compiler error once wired into the barrel (`TS2308: Module "./receipts" has already exported a member named 'SourceRef'`). I removed my duplicate and imported the existing type from `../receipts` inside `standardized/index.ts` instead, it's the same shape and the same purpose (provenance list for a receipt), so this is a correction, not a new type. Task 15 (or anyone) importing `SourceRef` should get it from the package barrel (already re-exported via `receipts.ts`), not from `standardized`.

### Self-review findings

- All nine named exports (`Deployment`, `DEPLOYMENTS`, `queryDeployment`, `gatewayUrl`, `YIELD_VAULTS_QUERY`, `LENDING_MARKETS_QUERY`, `mapYieldVaults`, `mapLendingMarkets`, `fetchStandardized`) are reachable from `packages/core/src/index.ts`.
- No unrequested production surface: `templates.ts`/`gateway.ts`/`map.ts` export only what the brief lists; internal helpers (`s`, `source` in `map.ts`) are unexported.
- Tests exercise real behaviour, not just shape: history-length from merged snapshot arrays, net-flow arithmetic (`withdraw - deposit`, expected `"2000.00"`, asserted exactly), freshness derived from `_meta.block.timestamp` vs `headTs` in both the fresh and stale direction, and the concurrent-fetch success/failure split.
- `console.error` only fires on the `fetchStandardized` error path and is captured/restored in the test; no stray logging elsewhere.

### Concerns

- The template field names (`hourlySnapshots`/`dailySnapshots` shape, `pricePerShare`, `exchangeRate`, etc.) are, as the brief says, best-knowledge guesses for Messari yield 1.3.1 / lending 3.1.0, I did not have gateway access to introspect the live schema, so this is unverified until `scripts/verify-deployments.ts` runs against a real `GRAPH_STUDIO_API_KEY`.
- `scripts/verify-deployments.ts` was typechecked only (`bun x tsc -p packages/core/tsconfig.json --noEmit`, clean) and never executed, per instructions, no API key was available in this environment. `docs/verification-log.md` was not created/updated; that remains an open step for whoever runs it. All 15 registry entries still have `deploymentId: null` and `status: "unverified"`.
- The yield-vault mapper's net-flow calculation merges `hourlySnapshots` then `dailySnapshots` into one array and diffs adjacent indices (`arr[i+1]`); at the hourly/daily boundary this diffs an hourly point against a daily point. This is exactly the code given in the brief (Step 5), so I implemented it as specified rather than silently changing behaviour, flagging it since it means one entry in the merged history array (the last hourly point) gets a netFlow computed against a non-adjacent-in-time daily snapshot rather than against nothing. Not covered by a dedicated assertion; only `history.length` is checked for the yield case, per the brief's own test.

## Task 10: Substreams sink reader

### What I implemented

- `packages/core/src/substreams/reader.ts`, `SqlQuery`, `SINK_REF`, `makePgQuery` (thin `pg.Pool` wrapper), `readSinkCursorBlock`, `readErc4626Vaults`, all verbatim from the brief. Added a comment on `readSinkCursorBlock` noting the `cursors` table shape is substreams-sink-sql's own bookkeeping table and that Task 13's deployment report is the source of truth once it lands.
- `packages/core/test/reader.test.ts`, the brief's test plus four I added: no-cursor row (freshness `unavailable`, block `"0"`, no crash), chain-name resolution (`"8453"` → `base`, unmapped chainId falls back to the chainId string itself), `readSinkCursorBlock` returning `null` directly, and a literal check on the `SINK_REF` constant.
- `packages/core/src/index.ts`, added `export * from "./substreams/reader";`.

### TDD evidence

RED:
```
$ bun test packages/core/test/reader.test.ts
error: Cannot find module '../src/substreams/reader' from '.../reader.test.ts'
 0 pass / 1 fail / 1 error
```

GREEN:
```
$ bun test packages/core/test/reader.test.ts
 5 pass
 0 fail
 12 expect() calls
```

Full-suite confirmation after both tasks: `bun test` → 59 pass / 0 fail / 132 expect() calls across 12 files. `bun x tsc -p packages/core/tsconfig.json --noEmit` → clean.

### Self-review findings

- All five named exports (`SqlQuery`, `SINK_REF`, `makePgQuery`, `readErc4626Vaults`, `readSinkCursorBlock`) are reachable from the package barrel.
- Vault addresses are lower-cased both for the `ANY($2)` match and for the returned `UnifiedVault.id`, so a mixed-case address from Task 13's table can't produce a duplicate vault.
- `makePgQuery` itself isn't (and can't usefully be) exercised by an offline test, it's a one-line `pg.Pool` wrapper; correctness against a live Postgres instance is Task 13's territory, consistent with the brief.

### Concerns

- Same as Task 9's script: the `cursors` table shape (`id`, `cursor`, `block_num`, `block_id`) is unverified against a real `substreams-sink-sql` deployment. The code and comment both flag this as pending Task 13.
- `readSinkCursorBlock`'s `WHERE c.id LIKE $2` with `%${chainId}%` is a substring match on the cursor id, for chain IDs that are substrings of each other (none currently in the registry, but e.g. a future `"1"` vs `"100"`... `"1"` is not a substring collision risk here since chain ids in use are `1`, `8453`, `10`, `137`, `42161`, none of which is a substring of another except none are) this could match the wrong row. Carried over verbatim from the brief; flagging rather than silently changing the query shape ahead of Task 13's real-schema confirmation.

## Files changed

Task 9 (`c9da8f9`, 13 files, 373 insertions):
`packages/core/src/index.ts`, `packages/core/src/standardized/{deployments.json,gateway.ts,index.ts,map.ts,registry.ts,templates.ts,types.ts}`, `packages/core/test/fixtures/{lending-markets.json,yield-vaults.json}`, `packages/core/test/standardized-{fetch,map}.test.ts`, `scripts/verify-deployments.ts`.

Task 10 (`8198ced`, 3 files, 105 insertions):
`packages/core/src/index.ts`, `packages/core/src/substreams/reader.ts`, `packages/core/test/reader.test.ts`.

## Fix round 1 (`950fdd5`)

Review of Tasks 9-10 found two Important findings, both inherited verbatim from the briefs rather than introduced during implementation. Both are fixed in this commit.

### Finding 1: yield net flow diffed across the hourly/daily boundary (`map.ts`)

**Problem.** `mapYieldVaults` concatenated `[...hourlySnapshots, ...dailySnapshots]` into one array and diffed each point against `arr[i+1]` by array position. With hourly timestamps all more recent than daily ones (the realistic case), this put the *oldest* hourly point next to the *newest* daily point in the array, so that point's `netFlowAssets` was computed across a ~23-hour gap instead of the ~1-hour gaps between its real hourly neighbours. The merged array also wasn't guaranteed to stay timestamp-descending in general (a daily snapshot can time-stamp later than the oldest hourly one).

**Fix.** Added `yieldSeriesHistory(points, fallbackPrice)` (`packages/core/src/standardized/map.ts:34`), which diffs each point only against the next-older point in the *same* series (hourly array processed alone, daily array processed alone); the oldest point of each series now correctly gets `netFlowAssets: null` because there is no older same-series point to diff against, not because it happens to be the last array element post-merge. `mapYieldVaults` now builds `history` by concatenating the two already-independently-diffed series and sorting the result with a new `byTimestampDesc` comparator. Added the symmetric `lendingSeriesHistory` helper and applied the same build-per-series-then-sort shape to `mapLendingMarkets`, even though lending's per-point deposit/withdraw fields never needed diffing, the brief's own instruction was to keep the two mappers structurally consistent, and the sort is what actually matters there (lending's flows are correct at every point regardless of merge order, but the merged array's *order* had the same unguaranteed-sort defect).

**Covering tests** (`packages/core/test/standardized-map.test.ts`):
- `"yield net flow is diffed within each series ... never across the hourly/daily boundary"`, asserts, using the existing 2-hourly/2-daily fixture: the newest hourly point's flow (`"400000000"`, hourly[0] vs hourly[1]); the oldest hourly point is `null` (and the comment spells out the wrong value, `"4500000000"`, the old bug would have produced there, computed against the newest daily point); the newest daily point's flow (`"5000000000"`, daily[0] vs daily[1]); the oldest daily point is `null`; and a loop confirming the full merged `history` array is non-increasing by timestamp.
- `"lending history stays timestamp-descending after merging hourly and daily series"`, asserts the merged lending history's timestamps and per-point net flows in one shot (`["2000.00", "-500.00", "20000.00", "-5000.00"]`).

No fixture changes were needed; the existing `yield-vaults.json`/`lending-markets.json` fixtures already have hourly timestamps newer than daily ones, which is exactly the shape that exposed the original bug.

### Finding 2: substring-matched shared cursor table (`reader.ts`)

**Problem.** `readSinkCursorBlock` queried a single shared `cursors` table with `WHERE c.id LIKE $2` and `$2 = '%<chainId>%'`. Since `chainId` is a bare number, this substring match could attach the wrong chain's cursor row whenever one chain id is a substring of another cursor id (or of another chain id, e.g. `"1"` is a substring of `"10"`, `"100"`, any cursor id containing a literal `1`).

**Ruling from the team lead:** each chain's substreams sink writes its cursor to its own `cursors_<chainId>` table (the sink's `--cursors-table` flag), so the fix is to query that table directly by exact name instead of pattern-matching inside a shared one.

**Fix** (`packages/core/src/substreams/reader.ts`):
- `readSinkCursorBlock(q, chainId)` now validates `chainId` against `/^\d+$/` (throwing otherwise, this is what makes interpolating `chainId` directly into the table name safe, since `pg` has no parameterized-identifier support) and runs `SELECT block_num FROM cursors_${chainId} ORDER BY block_num DESC LIMIT 1`. It returns `{ block: string } | null`, no `timestamp`, since the old query's `LEFT JOIN LATERAL` into `vault_metrics` for a timestamp is gone along with the shared table. A thrown query error (missing table, chain not yet indexed) is caught and treated the same as an empty result: `null`.
- `readErc4626Vaults` now takes `head: { ts: number; block: number }` instead of a bare `headTs: number`, since cursor age is no longer read off a timestamp column but derived from the block delta: `ageSeconds = max(0, (head.block - cursorBlock) × BLOCK_TIME_S[chainId])`, `timestamp = String(head.ts - ageSeconds)`, freshness via `classifyFreshness("substreams", head.ts - ageSeconds, head.ts)`. The new exported `BLOCK_TIME_S = { "1": 12, "8453": 2 }` (default `12` for other chains) supplies the seconds-per-block figure. The `vault_metrics` history-window query still uses `head.ts` directly (that table's `timestamp` column is untouched by this fix).

**Covering tests** (`packages/core/test/reader.test.ts`, rewritten):
- Main test renamed to reflect the per-chain table; asserts the resulting source's `block`, `timestamp`, and `ageSeconds` (`"60"`, reproducing the old fixture's 60s-stale scenario via `head.block` 5 blocks ahead of a cursor at block 1000 on chain `"1"` at 12s/block) and, via a `calls` array pushed inside the fake, that no query text ever contains `"LIKE"` and that one does contain `"cursors_1"`.
- `'chain id "1"'s cursor lookup never touches chain id "10"'s cursor table'`, a fake that flags `cursors10Touched` if its query text ever contains `"cursors_10"`; calling with chainId `"1"` leaves the flag `false`.
- `"a missing cursor table ... yields unavailable freshness and block 0, not a crash"`, fake throws `relation "cursors_1" does not exist` from the cursor query; asserts the result is `{ block: "0", timestamp: "0", freshness: "unavailable" }` and the vault's own `freshness` is `"unavailable"`, with no unhandled rejection.
- `"no matching vault_meta row leaves asset null"`, `vault_latest` row omits `asset_symbol`/`asset_decimals`; asserts `v.asset === null`.
- `"chain name resolves 8453 to base, an unmapped chainId falls back to itself, and BLOCK_TIME_S defaults to 12s"`, checks the `BLOCK_TIME_S` constant's exact value, then exercises both a known chain (`"8453"`, 2s/block) and an unmapped one (`"999"`, default 12s/block) in the same test, asserting both `chain` and the derived `ageSeconds`.
- `"readSinkCursorBlock rejects a non-numeric chainId ..."`, `await expect(readSinkCursorBlock(q, "1; drop table cursors_1")).rejects.toThrow()`.
- `"readSinkCursorBlock returns null when the cursor table is empty"`, unchanged from before, still valid under the new query shape.

### Verification

```
$ bun test packages/core/test/standardized-map.test.ts packages/core/test/reader.test.ts
 14 pass
 0 fail
 43 expect() calls
Ran 14 tests across 2 files.

$ bun test
 64 pass
 0 fail
 150 expect() calls
Ran 64 tests across 12 files.

$ bun x tsc -p packages/core/tsconfig.json --noEmit
(no output — clean)
```

Grepped `packages/core/src` for any other caller of `readErc4626Vaults`/`readSinkCursorBlock` before changing their signatures; none exist outside the test file (no `service`/`agent` packages exist yet in this worktree to check).

### Concerns carried forward

- `BLOCK_TIME_S` is a static table (`{"1": 12, "8453": 2}`, default 12). Real Ethereum/Base block times drift slightly (Ethereum's post-Dencun ~12.0s is stable; Base's ~2s is also stable under normal conditions), so this is a reasonable approximation, but it means `ageSeconds` is an estimate, not a measurement, worth noting for anyone tuning the `substreams` freshness threshold (currently 300s in `unify/freshness.ts`) against it.
- The `cursors_<chainId>` table name and the `--cursors-table` sink flag are still the plan's expectation, per the team lead's ruling, not something confirmed against a running sink; Task 13's deployment report remains the source of truth, and the code comment says so.
