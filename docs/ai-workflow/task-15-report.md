# Task 15 report: Scan and table handlers with the live data provider

## Status: DONE

## What I implemented

- `packages/service/src/handlers/scan.ts` (new), `makeScanHandler(deps)`, the shared
  handler for every `{scan, table} × {hedera, arc}` route. Implements the brief's
  Step 2 exactly, plus:
  - `getTxId`/`getPayer` types as specified; `capMs?: number` added to `HandlerDeps`
    as a test-only override of the 60s handler cap (see "Deviations" below).
  - The `Promise.race` cap timer is captured and `clearTimeout`'d in a `finally`
    block, the brief's snippet left the loser's `setTimeout` running uncancelled,
    which (a) leaves a dangling handle per request in production and (b) would have
    made every successful-path test in the suite hold the process open for up to
    60 real seconds. Fixed as part of implementing the cap, not a separate task.
  - Upstream failures (502) now `console.error` the error message only, per the
    resolution ("upstream errors return 502 ... with the error message logged
    only"); the 504 cap path logs nothing (it's a timeout, not an upstream error).
  - `opened` is typed as `SealedRequest<ScanRequest | TableRequest>` (the brief's
    snippet under-typed this as `{ request, reply_pk }`, which doesn't compile
    against `checkSealedRequest`'s real signature, see "Deviations").
- `packages/service/src/data/provider.ts`, added `LiveDataProvider implements
  DataProvider` (the `Catalog` type and `DataProvider` interface from Task 14 are
  unchanged). Constructor `(config, { fetchImpl?, sql?, now? })` per the resolution.
  - `scan(ids)`: groups by chain; per chain, fetches (60s-cached) `fetchStandardized`
    over that chain's registry deployments and filters to the requested ids, plus
    `readErc4626Vaults` when `sql` is set; merges on `id` (Messari fields win,
    sources concatenate, freshness recomputed via `vaultFreshness`); unknown ids
    don't appear.
  - `table(protocol, chainId)`: `"erc4626"` reads the substreams sink (empty result,
    not a throw, when `sql` is unset, the brief's dispatch is `protocol ===
    "erc4626" → readErc4626Vaults(sql, ...)`, which would crash on a null `sql`);
    any other protocol filters the same 60s-cached chain fetch to that one
    deployment, and its `sources` are filtered to just that deployment's ref (not
    the whole chain's) since `table()` knows its exact target up front.
  - `catalog()`: one row per `DEPLOYMENTS` entry (15 total), `vaultCount` read from
    the *unexpired* 60s cache only (0 otherwise, never triggers a fetch);
    `erc4626Chains: sql ? ["1", "8453"] : []`.
  - Chain head: viem `createPublicClient({ transport: http(rpcUrl, { fetchFn }) })
    .getBlock({ blockTag: "latest" })`, cached 15s per chain; RPC failure or an
    unconfigured chain yields `{ ts: MAX_SAFE_INTEGER, block: 0 }`, forcing every
    *messari-sourced* vault on that chain stale (see "Concerns" for a caveat on the
    substreams-sourced side of this). `fetchFn` is wired to the same injectable
    `fetchImpl` used for the subgraph gateway, so both RPC calls and gateway calls
    are mockable through one dependency.
- `packages/service/src/config.ts`, `Config.rpc` widened from `{ "1": string;
  "8453": string }` to `Record<string, string>`; `loadConfig` still defaults `"1"`/
  `"8453"` from `ETH_RPC_URL`/`BASE_RPC_URL`, then additionally copies every
  `RPC_URL_<digits>` env var into `rpc[<digits>]`, so any other chain in the
  registry (42161, 10, 137, ...) gets a real head once its own RPC is configured.
  Grepped the repo first to confirm nothing else read `config.rpc["1"]`/`["8453"]`
  directly, nothing did, so widening the type was safe.
- `packages/service/src/main.ts`, replaced the Task 14 placeholder `DataProvider`
  with `new LiveDataProvider(config, { sql: config.databaseUrl ? makePgQuery(...) :
  null })`.
- `.env.example`, three-line addition documenting `RPC_URL_<chainId>` next to the
  existing `ETH_RPC_URL`/`BASE_RPC_URL` block.
- Tests: `packages/service/test/handlers.test.ts` (new, 11 tests) and
  `packages/service/test/live-data-provider.test.ts` (new, 6 tests, beyond the
  brief's file list; see "Addition beyond the brief" below).

## TDD evidence

**RED** (`handlers.test.ts` written first, referencing not-yet-created
`../src/handlers/scan`):

```
$ bun test packages/service/test/handlers.test.ts
error: Cannot find module '../src/handlers/scan' from '.../test/handlers.test.ts'
 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [406.00ms]
```

**GREEN** (after implementing `handlers/scan.ts` and `LiveDataProvider`, and fixing
a fixture bug, see "Bugs found and fixed during implementation"):

```
$ bun test packages/service/test/handlers.test.ts
 11 pass
 0 fail
 42 expect() calls
Ran 11 tests across 1 file. [1.85s]

$ bun test packages/service/test/live-data-provider.test.ts
 6 pass
 0 fail
 35 expect() calls
Ran 6 tests across 1 file. [2.23s]

$ bun test   # whole workspace
 88 pass
 0 fail
 247 expect() calls
Ran 88 tests across 15 files. [2.91s]

$ bun x tsc -p packages/service/tsconfig.json --noEmit
(no output, exit 0)
```

Ran the full workspace suite three times in a row to rule out flakiness in the
timing-sensitive tests (the 20ms `capMs` cap test, the injectable-`now` cache TTL
test): 88/88 pass every time, ~2.9s each, no stray console output.

Did not run the root `bun run typecheck` (it also checks `packages/agent`, which
doesn't exist yet, same call Task 14 made). Ran `packages/service`'s tsconfig
directly per my instructions.

## Bugs found and fixed during implementation

1. **The brief's own Step 1 test fixture doesn't pass the brief's own Step 2
   validation.** `vault.id: "1:0xabc"` and `vaults: ["1:0xabc"]` (3 hex chars after
   `0x`) fail `VAULT_ID_RE = /^\d+:0x[0-9a-f]{40}$/i` (requires a real 20-byte
   address, 40 hex chars), the same regex the brief's own Step 2 code specifies.
   Confirmed this is the fixture, not the regex: `map.ts`, `reader.ts`, and every
   existing core test build vault ids as `${chainId}:${40-hex-char address}`.
   Fixed by using a real 40-hex-char address (`"1:0xabab...ab"`) throughout
   `handlers.test.ts` instead of the brief's shorthand. Without this fix every
   "happy path" test in the brief would 422 with `bad_vaults`.
2. **`openSealedRequest`'s return type was under-declared in the brief's snippet**
   (`{ request, reply_pk }` instead of `SealedRequest<...>`), which fails to
   typecheck against `checkSealedRequest`'s real signature (needs `payer`, `ts`,
   `req_nonce` too). Fixed by importing and using `SealedRequest<ScanRequest |
   TableRequest>`.
3. **The cap timer leak** (see "What I implemented" above), would have made
   `bun test` hang for up to 60 real seconds per successful-path test once any
   test exercised the handler's happy path, since Node/Bun don't exit while a
   `setTimeout` handle is outstanding. Found this by reasoning about the test
   suite's own runtime before writing the 504 test, not by hitting it, fixed
   proactively with `clearTimeout` in a `finally` block.
4. **My own test fake, not the implementation**: my first pass at
   `live-data-provider.test.ts` faked viem's RPC response as a plain `{ ok, status,
   json() }` object (matching the existing convention in
   `packages/core/test/standardized-fetch.test.ts`). viem's RPC client reads
   `response.headers.get(...)` and `response.body` directly, which a plain object
   doesn't have; this threw inside viem, which retried (default `retryCount: 3`)
   and only then surfaced as a generic failure, symptom was "fresh" scenarios
   coming back "stale" with no error printed, plus each test taking ~1s instead of
   milliseconds. Diagnosed with a 10-line standalone viem script logging the exact
   args passed to a custom `fetchFn` (also caught a second issue this way: viem
   normalizes the RPC URL with a trailing slash before calling fetch). Fixed by
   using real `new Response(...)` objects for the RPC fake; total suite time for
   that file dropped from ~7.5s to ~2.2s once fixed.

## Addition beyond the brief: `test/live-data-provider.test.ts`

The brief's file list only names `test/handlers.test.ts`, and that file's own tests
exercise the handler against a *stub* `DataProvider`, `LiveDataProvider` itself
(chain-head caching/fallback, the scan-time merge across sources, `table()`'s
protocol dispatch, `catalog()`'s cache-based counts) would otherwise ship with zero
test coverage, despite being named in the task title ("... with the live data
provider") and being the most substantial new logic in this task. Added 6 focused
tests, using real `DEPLOYMENTS` entries on chains 8453 (aave-v3/base, the only
deployment on that chain) and reusing `packages/core/test/fixtures/lending-
markets.json` to avoid re-deriving fixture data:
1. A working RPC head classifies a fresh subgraph vault `fresh`; a failing RPC
   forces it `stale`.
2. `scan()` merges a subgraph record and a substreams-sink record for the same
   vault: Messari's fields win, sources concatenate, freshness is recomputed.
3. `table("erc4626", ...)` reads the sink; returns empty (not a throw) with no
   `sql`.
4. `table(protocol, chainId)` for a subgraph protocol filters both vaults and
   sources to that one deployment; an unknown (protocol, chain) pair returns empty.
5. `catalog()`: 0 for an uncached deployment, the real count once `scan()`/
   `table()` has warmed that chain's cache, correct `erc4626Chains` gating.
6. The subgraph fetch is cached 60s per chain and the chain head 15s,
   independently (via the injectable `now`).

## Self-review

- **Sealed and clear paths**: both covered (`handlers.test.ts` tests 1 and 3).
- **All four 422 reasons**: `envelope_open_failed` (corrupted envelope, tampered
  nonce, same length, so `fromB64` doesn't choke on shape and the GCM tag fails
  instead), `payer_unknown` (sealed request, `getPayer` returns null),
  `checkSealedRequest`'s own reason (tested via `payer_mismatch`), and
  `bad_vaults`/`bad_table_request` (empty/malformed/oversized vault list; missing
  `protocol`/`chainId`), all four have a dedicated test.
- **504/502**: both tested, 504 via an injectable `capMs: 20` (see "Deviations"),
  502 via a rejecting `data.scan`, asserting the body is `{ reason:
  "upstream_failed" }` and exactly one `console.error` call containing the message
  (not the request body).
- **Receipt fields**: one test asserts `sealed`, `tier`, `price` (exact amount via
  `hederaScanPriceAtomic`), `payment.txId`, `sources`, and `hcs.topicId` together;
  separate tests cover Arc-rail pricing for both tiers (bucket pricing for scan,
  flat `TABLE_PRICE_USD` for table).
- **Attestations per vault**: asserted (`verifyAttestation` on the opened sealed
  body's first attestation).
- **Sealed response to `reply_pk`**: asserted (`open(j.sealed, replySecret)`
  round-trips and `j.sealed`/`j.receipt.sealed` agree).
- **No secrets or request bodies logged**: grepped every changed file for
  `console.*`, `main.ts`'s two lines are pre-existing (port/URL on boot, `err` on
  fatal startup crash, neither touched by this task); the one new line in
  `scan.ts` logs `e.message` only.
- **YAGNI**: `getChainHead`/`getChainStandardized` share one small generic
  `CacheEntry<T>` shape rather than two bespoke cache classes; `sinkSourceRef` and
  `mergeVaults` are the only two helpers `scan()`/`table()` both need, not a
  broader utility module. The one addition beyond the brief's literal file list
  (`live-data-provider.test.ts`) is testing code the brief itself scoped into this
  task, not new production surface.
- **Pristine test output**: confirmed above, three consecutive full-suite runs,
  identical pass counts, no stray output.

## Deviations from the brief's literal snippets (all disclosed above, summarized here)

1. `HandlerDeps.capMs?: number`, test-only override of the 60s cap, defaults to
   the unchanged 60,000ms in production. Without it, the 504 path is untestable
   without a real 60-second wait per test run.
2. `clearTimeout` on the cap timer in a `finally` block, correctness fix, not a
   design choice (see "Bugs found," #3).
3. `opened: SealedRequest<ScanRequest | TableRequest>` instead of the brief's
   under-typed inline shape, required for `checkSealedRequest` to typecheck.
4. `table("erc4626", chainId)` returns `{ vaults: [], sources: [] }` when `sql` is
   null instead of calling `readErc4626Vaults(null, ...)`, which would throw.
5. Two judgment calls on receipt `sources` scope, both reasoned through with no
   test asserting the alternative: `scan()` reports every source the chain-level
   `fetchStandardized` batch touched (not just the ones behind the requested
   vaults) because a requested vault whose deployment failed can't be traced back
   to that deployment after the fact, under-reporting would hide exactly the
   failure spec §7 says the receipt must show. `table()` *can* trace this precisely
   (protocol is explicit input), so it filters to the one matching deployment.

## Concerns

- **The RPC-failure sentinel (`ts: MAX_SAFE_INTEGER, block: 0`, as specified in my
  task instructions verbatim) does not force `stale` for substreams/erc4626-
  sourced vaults, only for subgraph/Messari-sourced ones.** Traced this through
  `readErc4626Vaults` (`packages/core/src/substreams/reader.ts`, not part of this
  task): it computes `ageSeconds = Math.max(0, (head.block - cursorBlock) ×
  blockTimeS)`; with `head.block = 0` and any real (positive) cursor block, that
  difference is negative and clamps to `0`, so the derived source timestamp
  becomes `head.ts - 0 = head.ts`, and `classifyFreshness` then compares
  `head.ts` against itself → `fresh`. The Messari path doesn't have this problem
  because its freshness compares the *subgraph's own real block timestamp*
  against the sentinel `head.ts`, which is always a huge gap. I did not change the
  sentinel values (they were specified exactly) or touch `packages/core` (out of
  this task's scope, and that function has its own passing test suite that
  doesn't exercise this combination), flagging for whoever owns the interaction
  between these two, since it means "chain RPC is down" currently only makes half
  of a chain's sources visibly stale.
- `LiveDataProvider`'s `scan()`/`table()` do not cancel in-flight subgraph or sink
  reads when the handler's cap fires; the spec doesn't ask for cancellation and
  wiring `AbortController` through both `fetchStandardized` and `readErc4626Vaults`
  felt out of scope for this task, but it means a slow upstream keeps running
  after the client has already gotten a 504.
- `catalog()`'s per-deployment `vaultCount` attribution relies on (protocol,
  chainId) pairs being unique across the 15-entry `DEPLOYMENTS` registry (verified
  this directly against `deployments.json`, they are, today); if a future
  registry update adds a second deployment for the same (protocol, chain) pair,
  both rows would report the same combined count rather than being split.

## Files changed

- `packages/service/src/handlers/scan.ts` (new)
- `packages/service/src/data/provider.ts` (modified, added `LiveDataProvider`)
- `packages/service/src/config.ts` (modified, generic `RPC_URL_<chainId>` support)
- `packages/service/src/main.ts` (modified, wired `LiveDataProvider`)
- `.env.example` (modified, documented `RPC_URL_<chainId>`)
- `packages/service/test/handlers.test.ts` (new)
- `packages/service/test/live-data-provider.test.ts` (new, beyond the brief's file
  list, see "Addition beyond the brief")

## Pre-review fix: RPC sentinel

Team lead's ruling on the "Concerns" item above: fix belongs in the provider, not
`packages/core`. Changed `STALE_HEAD` from `{ ts: MAX_SAFE_INTEGER, block: 0 }` to
`{ ts: MAX_SAFE_INTEGER, block: MAX_SAFE_INTEGER }` and documented why both fields
must be maximal:

```diff
-// A head this far in the future ages every source on the chain out immediately
-// (classifyFreshness compares headTs - sourceTs against a threshold measured in
-// minutes), which is exactly "force stale, never silently look fresh" for a chain
-// whose RPC is unreachable or simply not configured.
-const STALE_HEAD: Head = { ts: Number.MAX_SAFE_INTEGER, block: 0 };
+// A head this far in the future ages every subgraph (Messari) source on the chain out
+// immediately (classifyFreshness compares headTs - sourceTs against a threshold
+// measured in minutes). `block` must ALSO be maximal, not 0: readErc4626Vaults derives
+// its own synthetic source timestamp as `head.ts - max(0, (head.block - cursorBlock) *
+// blockTimeS)`. With block=0 and any real (positive) cursor block, that difference is
+// negative and clamps to 0, so the derived timestamp collapses to `head.ts` itself —
+// compared against a headTs of the same value, that reads as an age of zero, i.e.
+// "fresh", exactly backwards for an unreachable chain. Making block maximal too pushes
+// (head.block - cursorBlock) hugely positive instead, so the derived timestamp lands
+// far in the past relative to headTs and the substreams source is correctly stale.
+const STALE_HEAD: Head = { ts: Number.MAX_SAFE_INTEGER, block: Number.MAX_SAFE_INTEGER };
```

Verified the arithmetic by hand for chain 8453 (`BLOCK_TIME_S["8453"] = 2`, a cursor
block of 1000): `ageSeconds = (MAX_SAFE_INTEGER - 1000) × 2 ≈ 1.80e16`; derived
`ts = head.ts - ageSeconds ≈ -9.01e15`; `classifyFreshness` then sees `headTs - ts ≈
1.80e16`, far past the 300s substreams threshold → `"stale"` (not `"unavailable"`,
that only happens when there's no cursor row at all).

**Covering test** added to `live-data-provider.test.ts`, right after the existing
head-freshness test, uses `table("erc4626", "8453")` (not `scan()`) specifically so
it exercises `readErc4626Vaults` in isolation, with no Messari counterpart for
`mergeVaults` to recompute freshness against (a correctly-stale Messari source could
otherwise mask a wrongly-fresh sink source in a merged result):

```ts
test("a failing RPC forces the substreams-sink (erc4626) source stale too, never fresh", async () => {
  const { fetchImpl } = fakeFetch({ [RPC_URL]: rpcErrorRoute() });
  const sql: SqlQuery = async (text: string) => {
    if (text.includes("cursors_8453")) return { rows: [{ block_num: "1000" }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: FIXTURE_VAULT, share_price: "1.0", total_assets: "500" }] };
    return { rows: [] };
  };
  const provider = new LiveDataProvider(config, { fetchImpl, sql });
  const result = await provider.table("erc4626", "8453");
  expect(result.vaults).toHaveLength(1);
  expect(result.vaults[0].freshness).not.toBe("fresh");
  expect(result.vaults[0].freshness).toBe("stale");
});
```

Confirmed this test actually exercises the fix by checking it fails against the old
sentinel: temporarily reverted just the `STALE_HEAD` line to `block: 0` and reran,
`freshness` came back `"fresh"`, reproducing the exact bug the ruling described, then
restored the fix and reran to green.

**Incidental fix (same root cause, found while adding the covering test):** the new
test's first draft used `fakeFetch({})` (throws on every call, simulating an
unreachable RPC) and pushed `bun test packages/service` from ~2.3s to ~6s, viem
retries a rejected `fetchFn` call (its default `retryCount: 3`) but does not retry an
HTTP-200 response carrying a JSON-RPC application error, so a throw-based fake is far
slower than the `rpcErrorRoute()` pattern already used elsewhere in this file. Found
an existing test with the same latent issue while fixing this
(`"table('erc4626', ...) reads the substreams sink..."` called `table("erc4626", "1")`
against `fakeFetch({})`, silently retrying against chain 1's *real* default RPC URL
since `baseEnv` only overrode `BASE_RPC_URL`, not `ETH_RPC_URL`) and fixed both: added
`ETH_RPC_URL: RPC_URL` to `baseEnv` and routed that test's fake to a normal success
response instead of leaving it unrouted. Net effect: `bun test packages/service`
dropped from ~6s back to ~2.3s with one more test than before the fix.

### Commands and output

```
$ bun test packages/service
 25 pass
 0 fail
 100 expect() calls
Ran 25 tests across 3 files. [2.31s]

$ bun test
 89 pass
 0 fail
 250 expect() calls
Ran 89 tests across 15 files. [2.54s / 2.99s / 3.53s across three consecutive runs]

$ bun x tsc -p packages/service/tsconfig.json --noEmit
(no output, exit 0)
```

### Files changed (pre-review fix)

- `packages/service/src/data/provider.ts` (modified, `STALE_HEAD.block` sentinel,
  comment)
- `packages/service/test/live-data-provider.test.ts` (modified, new covering test,
  `ETH_RPC_URL` added to `baseEnv`, two tests' fake-fetch routing fixed to avoid
  viem retry latency)

## Fix round 1

Review approved the work with one Important finding and one Minor, both in
`packages/service/src/data/provider.ts`.

### Important: no test exercised the sink-only-vault branch of `mergeVaults`

`mergeVaults`'s last line, `for (const sv of erc4626) if (!claimed.has(sv.id))
merged.push(sv);` (provider.ts:85), is what makes a substreams-sink vault with no
Messari counterpart appear in `scan()`'s result at all. Every existing `sql`-backed
`scan()` test used a vault id present in *both* sources, so that line had no
regression coverage; a broken or deleted union step would have shipped silently.

**Covering test** added to `live-data-provider.test.ts`, right after the existing
same-id merge test, using a different, fabricated address absent from the `lendFx`
fixture the gateway route serves, `mergeVaults`'s Messari-side loop finds no match
for it, so it can only reach the result through the union line:

```ts
test("scan() includes a substreams-sink vault with no Messari counterpart, unmerged", async () => {
  const SINK_ONLY_VAULT = "0x" + "9".repeat(40);
  const headTs = FIXTURE_TS + 10;
  const headBlock = 1010;
  const { fetchImpl } = fakeFetch({ [RPC_URL]: rpcRoute(headTs, headBlock), [gatewayUrl(AAVE_BASE_SUBGRAPH)]: gatewayRoute(lendFx) });
  const sql: SqlQuery = async (text: string) => {
    if (text.includes("cursors_8453")) return { rows: [{ block_num: "1000" }] };
    if (text.includes("FROM vault_latest")) return { rows: [{ vault: SINK_ONLY_VAULT, share_price: "3.0", total_assets: "50" }] };
    return { rows: [] };
  };
  const provider = new LiveDataProvider(config, { fetchImpl, sql });
  const result = await provider.scan([`8453:${SINK_ONLY_VAULT}`]);

  expect(result.vaults).toHaveLength(1);
  const v = result.vaults[0];
  expect(v.id).toBe(`8453:${SINK_ONLY_VAULT}`);
  expect(v.kind).toBe("erc4626");
  expect(v.sources).toHaveLength(1);
  expect(v.sources[0].kind).toBe("substreams");
});
```

Confirmed this test actually exercises that branch: temporarily replaced the union
line with a no-op comment and reran just this test, failed with `Expected length:
1, Received length: 0` (the sink-only vault silently vanished, exactly the
regression this test exists to catch); restored the real line and reran to green.

### Minor: `sinkSourceRef` indexed into `.sources[0]` without a defensive fallback

```diff
-/** One SourceRef summarizing an erc4626 sink read, or none if it matched no vaults. */
+/**
+ * One SourceRef summarizing an erc4626 sink read, or none if it matched no vaults.
+ * `readErc4626Vaults` always attaches exactly one source to every vault it returns, so
+ * `vaults[0]?.sources[0]` should never actually be missing here — the optional chain
+ * and zeroed-out fallback exist so a future change to that invariant degrades to an
+ * honest "unknown block/timestamp" placeholder instead of throwing.
+ */
 function sinkSourceRef(chainId: string, vaults: UnifiedVault[]): SourceRef | null {
   if (!vaults.length) return null;
-  const s = vaults[0].sources[0];
-  return { ref: SINK_REF, chainId, block: s.block, timestamp: s.timestamp };
+  const s = vaults[0]?.sources[0];
+  return s ? { ref: SINK_REF, chainId, block: s.block, timestamp: s.timestamp } : { ref: SINK_REF, chainId, block: "0", timestamp: "0" };
 }
```

The existing `!vaults.length` early return is untouched (still `null`, i.e. "no
vaults matched, nothing to report"), the new fallback only covers the narrower
case of a non-empty `vaults` array whose first entry unexpectedly has no source.
No dedicated test added for this path since it's not reachable through
`readErc4626Vaults`'s current contract (confirmed by reading its implementation
again); the existing sink-related tests (both the new one above and the earlier
merge/table/RPC-failure ones) already exercise `sinkSourceRef`'s normal path.

### Commands and output

```
$ bun test packages/service
 26 pass
 0 fail
 105 expect() calls
Ran 26 tests across 3 files. [572.00ms]

$ bun test
 90 pass
 0 fail
 255 expect() calls
Ran 90 tests across 15 files. [731.00ms]

$ bun x tsc -p packages/service/tsconfig.json --noEmit
(no output, exit 0)
```

### Files changed (fix round 1)

- `packages/service/src/data/provider.ts` (modified, `sinkSourceRef` defensive
  fallback + comment)
- `packages/service/test/live-data-provider.test.ts` (modified, new covering test
  for the sink-only merge branch)
