# Task 19 + 27 report: Arc rail via Circle Gateway; admin metrics endpoint

Worktree: `.worktrees/service`, branch `ws/service`.
Commits: `9fe94f8` (Task 19), `db4ceb4` (Task 27).

Note on process: `task-19-brief.md` does not exist in this sdd directory (only
`task-27-brief.md` does, task 19's brief was apparently never generated as a separate
file). I recovered Task 19's full spec from `docs/superpowers/plans/2026-09-09-vaultradar.md`
lines 1875-1932 ("### Task 19: Arc rail via Circle Gateway"), cross-checked against
`progress.md`'s rulings (the Task 21 review note carrying the `error` alias requirement
forward, and the Task 22+23 note carrying the CAIP-2 `hello-x402.ts` fix forward), both of
which matched the team lead's dispatch message exactly.

## Task 19: Arc rail via Circle Gateway

### What I implemented

- `src/rails/arc.ts`, `mountArcRail(app, deps)` registers `POST /arc/v1/scan/{s,m,l}`
  at `$0.003`/`$0.01`/`$0.05` and `POST /arc/v1/table` at `$0.03`, each behind
  `gateway.require(price)` from `createGatewayMiddleware`. A `validateBucket(bucket)`
  pre-middleware (mounted *before* `gateway.require`) rejects a missing/invalid
  `X-VR-Count` as 400 `bad_count` or a count outside the route's bucket as 422
  `bucket_mismatch`. Exports `arcPayerFromRequest`/`arcTxIdFromRequest` reading off
  `req.payment`.
- `src/util/http.ts`, new `errBody(reason)` helper returning `{reason, error: reason}`.
  Applied to every 4xx body in `handlers/scan.ts` (`envelope_open_failed`,
  `payer_unknown`, the dynamic `checkSealedRequest` reason, `bad_vaults`,
  `bad_table_request`) and `rails/hedera.ts`'s `validateScanRequest`
  (`bad_count`/`malformed_envelope`), plus arc.ts's own two pre-payment bodies. Left the
  handler's two 5xx bodies (`handler_cap`/`upstream_failed`) untouched, the brief's
  instruction was scoped to 4xx specifically, and Circle's client only reads `.error` on
  a non-2xx *paid* response, which those two codes never are on this rail's design (see
  below).
- `src/app.ts`, removed the `@ts-expect-error` guard; `mountArcRail` is wired with the
  same `onSettled` composition pattern as the Hedera rail (`hcs.enqueue` + the caller's
  own hook, both run).
- `src/main.ts`, `rails.arc` now gates on `Boolean(config.arc.sellerAddress)`, matching
  Hedera's `Boolean(config.hedera.payToAccountId)` gate.
- `scripts/hello-arc.ts`, new client script per the plan's sketch, adapted to actually
  run: fetches the agent card, optionally deposits into Gateway, builds a sealed scan
  request, pays via `GatewayClient.pay`, verifies the receipt, opens the sealed reply.
- `scripts/hello-x402.ts`, fixed the Hedera signer's `network` to CAIP-2
  (`"hedera:testnet"`, was `"testnet"`), the fix Task 22+23's review carried forward.
- `packages/service/package.json`, added `@x402/evm` as an explicit dependency (see
  "a real bug I found" below).

### The hook path, and a factual correction to the plan

The plan (and the team lead's dispatch, hedging correctly) assumed Circle's Gateway
middleware settles *after* the handler, the same as `@x402/express`, and asked me to wire
`onSettled` from `gateway.onAfterSettle` using a receipt read off `res.locals.receipt`,
falling back to a per-request correlation map if the hook context doesn't carry the
response.

I traced the actual installed `@circle-fin/x402-batching@3.4.0`'s compiled
`dist/server/index.js` (`createGatewayMiddleware`'s `require: (price) => async (req, res,
next) => {...}`, lines ~966-1163) and found the real sequence is:

```
runVerifyLifecycle  (calls facilitator /v1/x402/verify)
runSettleLifecycle  (calls facilitator /v1/x402/settle)
req.payment = {...}
next()              <- the route handler runs *here*, after both verify and settle
```

This is confirmed by the package's own doc comment on `GatewayMiddleware`: "with this
transport middleware, settlement happens inline before `next()` runs." Two consequences:

1. `gateway.onAfterSettle`'s hook context (`SettleResultContext`, from
   `dist/hooks-BKkPP7ic.d.ts`) is `{ paymentPayload, requirements, result }`, no
   reference to `req`/`res` at all, so it structurally cannot read `res.locals.receipt`
   regardless of timing.
2. Even setting that aside: settlement completes *before* `next()`, i.e. before the route
   handler runs at all, so `res.locals.receipt` is unset at the exact moment
   `onAfterSettle` fires even in principle.

Per the team lead's own contingency ("keep a TTL map... if the hook context doesn't carry
the response, read the hook context types to decide, and explain"), I did not use
`gateway.onAfterSettle` for the `onSettled`/HCS wiring. Instead I wrap the handler
per-route (mirroring `rails/hedera.ts`'s `mountTier`), reading `res.locals.receipt` right
after `await handler(req, res)` resolves. This needs **no TTL correlation map at all**,
unlike Hedera: since verify+settle already happened earlier in the exact same request by
the time the wrapped handler resolves, `req.payment` and the handler's own
`res.locals.receipt` are simultaneously available with nothing async in between to
correlate across.

The same settle-before-handler fact is also why `validateBucket` has to run *before*
`gateway.require`, not inside the handler (as Hedera's analogous `bad_vaults` check does,
merely as defense-in-depth there): Circle's money has already moved by the time a
handler-level check could reject the request, and there is no settlement-reversal path in
this flow. This part matches what the team lead's dispatch already specified.

### A real bug I found: missing `@x402/evm`

`@circle-fin/x402-batching`'s `/server` entrypoint has an eager top-level import of
`@x402/evm/exact/server` (`GatewayEvmScheme extends ExactEvmScheme`). `@x402/evm` is
declared as an **optional peer dependency** in Circle's `package.json`
(`peerDependenciesMeta: {"@x402/evm": {"optional": true}}`), which `bun install` does not
auto-install, and it was not present anywhere in this repo's `node_modules` (confirmed by
search) despite `packages/agent` also depending on `@circle-fin/x402-batching`. Since the
import is eager (module-load-time, not lazy), any `import("./rails/arc")`, including in
production, would fail before ever reaching `createGatewayMiddleware`. Added
`"@x402/evm": "2.25.0"` (matching the other pinned `@x402/*` versions) to
`packages/service/package.json` and ran `bun install`; this is a real fix, not a
test-only workaround, discovered because the first test run failed with `Cannot find
module '@x402/evm/exact/server'`.

### Tests

`packages/service/test/arc-rail.test.ts` (new, 8 tests, all passing):
- Unpaid `POST /arc/v1/scan/s` with `X-VR-Count: 1` → 402, `payment-required` header
  decodes (manually, not via `@x402/core/http`'s decoder, see in-file comment for why)
  to `accepts[0].network === "eip155:5042002"`.
- Missing `X-VR-Count` → 400 `bad_count` (with `error` alias), before any facilitator
  call.
- Out-of-range `X-VR-Count` → 400 `bad_count`, before any facilitator call.
- Count outside the route's bucket → 422 `bucket_mismatch` (with `error` alias), before
  any facilitator call.
- Table route has no bucket check and reaches the facilitator normally.
- **A full paid round trip**, using the real `GatewayClient`/`BatchEvmScheme` with a
  throwaway local private key against a fake Circle facilitator (`/v1/x402/supported`,
  `/v1/x402/verify`, `/v1/x402/settle`, the exact paths traced above): asserts 200, a
  receipt in the body, and `onSettled` firing with the settled transaction id.
- A failed settle after a successful verify: asserts the client's `pay()` call rejects
  and `onSettled` never fires.
- `arcPayerFromRequest`/`arcTxIdFromRequest` unit tests.

The team lead's dispatch flagged the paid-path test as possibly impractical given the
compiled middleware. It is practical: `BatchEvmScheme.createPaymentPayload` signs the
EIP-3009 authorization via pure local EIP-712 signing (viem's `signTypedData` on a
`privateKeyToAccount` signer), confirmed by reading `dist/client/index.js`, with no RPC
call anywhere in the payment-construction path. The only network calls `GatewayClient.pay`
makes are the two HTTP round trips to whatever URL it's paying, which in the test is the
locally-mounted rail. So I implemented the full round trip rather than reporting
`DONE_WITH_CONCERNS` on it.

`packages/service/test/hedera-rail.test.ts`, updated three pre-existing exact-match
(`toEqual`) assertions on `validateScanRequest`'s 400 bodies to include the new `error`
alias (`bad_count`/`malformed_envelope`); these would otherwise have failed once the alias
was added.

Full output:
```
bun test packages/service   -> 87 pass, 1 skip, 0 fail (after both commits; 69 pass after Task 19 alone)
bun test                    -> 177 pass, 1 skip, 0 fail (after both commits; 159 pass after Task 19 alone)
bun x tsc -p packages/service/tsconfig.json --noEmit  -> clean, exit 0
```
The 1 skip is the pre-existing `LIVE=1`-gated `hedera-rail.live.test.ts`, unaffected by
either task.

### Exact live commands (not run, no live credentials in this environment)

```bash
# One-time: fund an Arc testnet EVM account with USDC from faucet.circle.com (Arc testnet),
# then deposit into Gateway and pay for one scan:
SERVICE_URL=https://<deployed-service> \
AGENT_ARC_KEY=0x<ecdsa-hex> \
VAULT=1:0x<vault-address> \
DEPOSIT=2 \
bun run packages/service/scripts/hello-arc.ts

# Subsequent runs (Gateway balance already funded, no DEPOSIT):
SERVICE_URL=https://<deployed-service> \
AGENT_ARC_KEY=0x<ecdsa-hex> \
VAULT=1:0x<vault-address> \
bun run packages/service/scripts/hello-arc.ts
```
Expected: a deposit result (first run only), then `paid 0.003`, a transaction hash
resolvable on `https://testnet.arcscan.app`, `receipt ok: true`.

### Files changed (Task 19)
- New: `packages/service/src/rails/arc.ts`, `packages/service/src/util/http.ts`,
  `packages/service/scripts/hello-arc.ts`, `packages/service/test/arc-rail.test.ts`
- Modified: `packages/service/src/app.ts`, `packages/service/src/main.ts`,
  `packages/service/src/handlers/scan.ts`, `packages/service/src/rails/hedera.ts`,
  `packages/service/scripts/hello-x402.ts`, `packages/service/test/hedera-rail.test.ts`,
  `packages/service/package.json`, `bun.lock`

### Self-review (Task 19)
- Every route exists with the exact path and price: `/arc/v1/scan/s` $0.003, `/scan/m`
  $0.01, `/scan/l` $0.05, `/arc/v1/table` $0.03, yes, `ARC_BUCKET_PRICE`/`TABLE_PRICE_USD`
  from `@vaultradar/core`, not hardcoded.
- `@ts-expect-error` removed from `app.ts`, yes.
- `error` alias present on every 4xx from the shared handler and both rails, yes (listed
  above); 5xx left alone per the literal scope.
- Nothing secret logged, `hello-arc.ts` logs the payer's public address and a
  transaction hash only, matching `hello-x402.ts`'s existing style; no keys logged
  anywhere.
- Tests pristine, yes, 0 failures.

### Concerns (Task 19)
- The live end-to-end run (real Arc testnet, real Gateway deposit, real settlement) is
  untested, no credentials available in this environment. The offline paid-path test
  exercises the identical client library and identical server-side code path against a
  fake facilitator, so confidence is high, but a live run has not happened. Recommend
  running the commands above once Arc testnet credentials exist, per the plan's original
  go/no-go gate.
- `recordDeployment`'s per-deployment ok/fail inference (Task 27, see below) is a
  heuristic, not a structural fact from `packages/core`, flagged in detail there.

## Task 27: Service metrics endpoint and settlement tracking

### What I implemented

- `src/metrics.ts` (new), `Metrics` class: `requests`/`settlements` counters,
  `recordRequest(tier, status, verdicts?)`, `recordSettlement(rail, amount)`,
  `recordDeployment(ref, outcome)`, `recordHead(chainId, head, ok)`, and
  `snapshot(deps): Promise<AdminMetrics>`. Rail health probes (30s TTL) and the
  ERC-8004 identity check (10min TTL) are cached **inside** `Metrics` itself (not in
  `admin.ts`), so the whole thing is unit-testable without Express, this is what let
  `metrics.test.ts` exercise the caching behavior directly with an injected clock.
- `src/admin.ts` (new), `mountAdmin(app, deps)`: `GET /v1/admin/metrics` (503
  `admin_disabled` when `ADMIN_TOKEN` unset, checked first, since no token comparison is
  meaningful without one configured; 401 `unauthorized` with `error` alias on a
  missing/wrong bearer token; 200 with the snapshot otherwise) and the free
  `GET /v1/vaults?chainId=` (CORS-enabled, `{chainId, vaults: [{id, protocol, kind}]}`,
  400 `bad_chain_id` if the query param is missing). Bundled both into one file since
  neither warranted its own.
- `src/handlers/scan.ts`, `makeScanHandler` now returns a thin wrapper around the
  original handler (renamed to `handler` internally) that calls
  `d.metrics?.recordRequest(tier, res.statusCode, verdicts)` after every response,
  reading the per-vault verdicts off a new `res.locals.verdicts` (stashed right next to
  the existing `res.locals.receipt`). None of the handler's own early-return branches
  needed touching.
- `src/rails/hedera.ts`, `onAfterSettle` now calls
  `deps.metrics?.recordSettlement("hedera", ctx.requirements.amount)` unconditionally, at
  the top of the hook (ahead of the txKey correlation try/catch): the settlement itself
  already happened by the time this fires, regardless of whether this rail's own receipt
  correlation succeeds.
- `src/rails/arc.ts`, the route wrapper now calls
  `deps.metrics?.recordSettlement("arc", req.payment.amount)` unconditionally, before
  invoking the handler (settlement already happened before the handler runs on this
  rail, see Task 19 above).
- `src/hcs.ts`, `HcsQueue` gained `submittedCount`/`failedCount`/`lastSeq` and a
  `stats()` method returning `{pending, submitted, failed, lastSequence}`.
- `src/data/provider.ts`, `LiveDataProvider` takes an optional `metrics` dep; records a
  deployment outcome and a chain-head outcome on every actual query (cache-miss only, not
  on every cache hit, otherwise `lastQueriedAt` would advance on a read that queried
  nothing). Also gained `vaultList(chainId)`, added as an **optional** method on the
  `DataProvider` interface so the many inline stub objects across the existing test suite
  keep type-checking without modification.
- `src/config.ts` / `.env.example`, `ADMIN_TOKEN` / `Config.adminToken`.
- `src/app.ts`, constructs a default `Metrics` (overridable via `BuildAppDeps.metrics`,
  for tests), threads it into both rails and `mountAdmin`; also added an overridable
  `readPqHash` dep (defaults to the real one) for the same reason.
- `src/main.ts`, constructs `Metrics` once and passes the **same instance** to both
  `LiveDataProvider`'s constructor and `buildApp`, necessary because otherwise the
  provider's deployment/head recordings would land in a different `Metrics` instance than
  the one `mountAdmin` reads from.
- `packages/service/package.json`, added `zod` as a devDependency (used only in
  `admin.test.ts`'s schema validation; confirmed it does **not** resolve as a phantom
  dependency under this repo's bun install layout, `packages/service` has its own
  `node_modules`, not a flat hoisted one, so this was a required addition, not
  belt-and-suspenders).

### A design decision the brief didn't fully specify: what `ref` is

The brief's interface line (`recordDeployment(ref, outcome)`) doesn't spell out `ref`'s
type. I made it `{protocol, chain, chainId}` (a small struct), since spec §13.1's
`deployments` array needs all three fields per entry and there was no other place to get
them from a bare string key without adding a parse-back step. Documented in `metrics.ts`.

### A heuristic I want to flag clearly: per-deployment ok/fail

`packages/core`'s `fetchStandardized` already queries each deployment independently via
`Promise.allSettled`, but only surfaces a failure as a `console.error` plus a zeroed-out
`SourceRef` (`block: "0", timestamp: "0"`), it does not return structured per-deployment
outcomes to its caller, and changing that shared helper was out of this task's file list
(`packages/core` isn't listed as a file to modify). So `data/provider.ts` infers
ok/fail from that same zeroed-out signal: `ok = source exists && source.block !== "0"`.
This is a reasonable best-effort signal for an admin observability view, but it is not
structurally guaranteed, a legitimately fresh deployment that happens to read block "0"
(e.g. a subgraph with no indexed block yet) would misclassify as failed. Documented in
code; flagging here because it is a real (if narrow) inaccuracy, not a hidden one.

### Tests

`packages/service/test/metrics.test.ts` (new, 11 tests): counter increments
(`recordRequest`'s tier/rejected4xx/verdict buckets, `recordSettlement`'s per-rail
accumulation), `snapshot()`'s full shape with string numerics, `uptimeSeconds`
monotonicity under an injected clock, health-probe caching (30s TTL, verified by
advancing the injected clock across the boundary) and its "never throws, reports
`healthy:false`" behavior on both a throwing fetch and a non-2xx response, identity
caching (10min TTL) and its mismatch/throw-degradation behavior, `recordDeployment`/
`recordHead` surfacing correctly (including that a second call replaces rather than
accumulates), and `HcsQueue.stats()` flowing through.

`packages/service/test/admin.test.ts` (new, 7 tests): 503 when `ADMIN_TOKEN` is unset
regardless of the request; 401 for missing/wrong/malformed bearer token and 200 for the
right one when it is set; the full response shape validated against a `.strict()` zod
schema built field-for-field from spec §13.1 (so an extra, missing, or renamed field
fails the test); the rail-health-probe-never-throws behavior verified through the full
mounted route (not just at the `Metrics` unit level); `/v1/vaults` happy path
(CORS header present, correct shape), its 400 on a missing `chainId`, and its fallback
to an empty list when the injected `DataProvider` has no `vaultList` method at all.

Full output (after both commits):
```
bun test packages/service   -> 87 pass, 1 skip, 0 fail
bun test                    -> 177 pass, 1 skip, 0 fail
bun x tsc -p packages/service/tsconfig.json --noEmit  -> clean, exit 0
```

### Exact commands to check a running instance

```bash
# Assumes ADMIN_TOKEN is set in the running service's environment.
curl -s https://<deployed-service>/v1/admin/metrics \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# Public, no token:
curl -s "https://<deployed-service>/v1/vaults?chainId=1" | jq .
```

### Files changed (Task 27)
- New: `packages/service/src/metrics.ts`, `packages/service/src/admin.ts`,
  `packages/service/test/metrics.test.ts`, `packages/service/test/admin.test.ts`
- Modified: `packages/service/src/handlers/scan.ts`, `packages/service/src/rails/hedera.ts`,
  `packages/service/src/rails/arc.ts`, `packages/service/src/hcs.ts`,
  `packages/service/src/data/provider.ts`, `packages/service/src/app.ts`,
  `packages/service/src/main.ts`, `packages/service/src/config.ts`, `.env.example`,
  `packages/service/package.json`, `bun.lock`

### Self-review (Task 27)
- `Metrics` class matches the brief's interface field-for-field; `mountAdmin`'s deps
  match `{config, metrics, hcs, keys, data, readPqHash}` plus an additional `rails` flag
  (needed to know which rails' health to probe, the brief's own spec text says "Rail
  health probes hit each facilitator's supported-kinds endpoint", which requires knowing
  which rails are enabled; threaded through rather than re-derived from raw config so
  there's one source of truth, same as `BuildAppDeps.rails` already is for the rails
  themselves).
- JSON shape matches spec §13.1 exactly, verified by a `.strict()` zod schema in
  `admin.test.ts`, not just spot-checked.
- Nothing secret logged, no new logging added at all in this task; `ADMIN_TOKEN` itself
  is never logged or echoed anywhere (compared only, never printed).
- Tests pristine, yes, 0 failures, full monorepo included.

### Concerns (Task 27)
- The per-deployment ok/fail heuristic (above) is real but narrow; the correct fix is a
  `packages/core` change to `fetchStandardized` to return structured per-deployment
  outcomes, which is out of this task's scope.
- `settlements.hedera.revenueAtomic` sums whatever atomic amount each settlement reports
  regardless of asset (HBAR tinybars on the `-hbar` variant vs. USDC-atomic on the
  default route), this mirrors an ambiguity already present in the spec's shape itself
  (one `asset` field, one `revenueAtomic` counter, but two possible units in production
  if both Hedera routes see real traffic). Not something this task's brief asked to
  resolve, and the display `asset` field always reflects the *configured* default-route
  token regardless.
- Live check not run (no `ADMIN_TOKEN`/deployed instance in this environment), command
  given above for when one exists.

## Fix round 1

Merge (`8cccb6e`): merged `main` (a4a26e1) into `ws/service`. `.env.example` resolved by
taking main's compacted superset (it already carried `ADMIN_TOKEN` and `DEPOSIT`, so
nothing needed re-adding). `bun.lock` auto-merged with no conflict. Main split
`HcsQueue`'s public surface into an `HcsSink` interface; `admin.ts`/`metrics.ts` typed
their `hcs` dependency against `HcsQueue` directly, which no longer compiled, added
`stats()` to `HcsSink` and retyped both against the interface. `bun run typecheck` then
surfaced one more break the merge introduced: `packages/agent/test/harness.ts`'s inline
`HcsSink` fake was missing `stats()` too (main wrote it against the interface before
`stats()` existed); gave it a fixed stub. Verified clean before committing the merge:
`bun test packages/core packages/service` 151 pass/1 skip, `bun test` 305 pass/1 skip,
`bun run typecheck` clean.

Fix commit (`b76f5c5`) addresses all three findings, the minor, and the cross-package
test:

**Finding 1 (pre-payment split).** `packages/core/src/envelope.ts`'s `checkSealedRequest`
is now the composition of three new exported functions:
`checkSealedRequestPrePayment(p, {now, count?, seen})` (ts window, nonce-not-seen,
count), `checkSealedRequestPayer(p, payer)`, and `commitNonce(p, seen, now)`. One
deliberate behavior change from the pre-split implementation: the tie-break order
between `count_mismatch` and `payer_mismatch` when a request fails both simultaneously
flips (count is now checked first, since it moved into the pre-payment phase), checked
against the existing test suite and confirmed nothing exercises that specific
double-failure case, so nothing broke. Added 6 new core tests exercising each split
function independently, plus one confirming the composed `checkSealedRequest` still only
commits the nonce once every check passes (so a failing payer check never burns a nonce a
legitimate retry could still use).

`rails/arc.ts` gained a `preValidateSealed(tier, deps)` middleware, mounted on every arc
route (scan and table) ahead of `gateway.require`: for a sealed body it opens the
envelope and runs `checkSealedRequestPrePayment`, returning 422 (`envelope_open_failed`
or the specific pre-payment reason) before any payment starts, and stashes the opened
plaintext on `res.locals.opened`. A clear body skips it entirely. `handlers/scan.ts`
checks for that stash: when present, it runs only `checkSealedRequestPayer` +
`commitNonce` against the already-opened plaintext instead of re-opening it or
re-running the pre-payment check; when absent (the Hedera rail, which has no
settle-before-handler ordering problem), it takes the original unsplit
`checkSealedRequest` path, byte-for-byte unchanged.

Documented the resulting `payer_mismatch`-after-settlement-is-not-refunded caveat in both
files and in `README.md`'s Arc section, which I also corrected: it previously claimed
"the batch settles after the response," which is backwards (this is exactly the fact
Task 19's report already established from the compiled Circle SDK; the README just
hadn't been updated to match). Did not touch the section's stale `<<FILL:...>>`
placeholders or its now-also-stale "not yet mounted" line beyond what directly
contradicted my own edit, those are the docs workstream's fill pass, not this task's.

Tests (`test/arc-rail.test.ts`, 5 new): stale ts, count-vs-header mismatch, and a
corrupted envelope each 422 before any facilitator call is made; a nonce committed by one
successful paid round trip is rejected as a replay on resubmission with the facilitator
call counts unchanged; a valid sealed request still completes the full paid round trip
and the reply opens correctly with `replySecret`.

**Finding 2 (unguarded amount parsing).** `Metrics.recordSettlement(rail, amount, asset?)`
now validates `amount` against `/^\d+$/` before parsing, no-opping (incrementing a new
`recordingErrors` field, never throwing) on anything else. Both rails additionally call
it from its own dedicated `try/catch`, separate from, and ahead of, the existing
receipt-correlation/`onSettled` logic, so metrics recording is structurally isolated
from the business outcome regardless of what `recordSettlement`'s implementation does in
the future, not only because it happens not to throw today.

One deviation from the finding's literal text, flagged explicitly: it specified "a
decimal check for USD" for the Arc branch. `req.payment.amount` (Arc's actual input) is
`parsePrice(price)` inside Circle's own compiled middleware,
`Math.round(dollars * 1e6).toString()`, i.e. always a non-negative *integer* string,
never a decimal dollar string, confirmed against the same compiled source Task 19's
report already traced in detail. A decimal-format validator on that branch would reject
100% of real input. Used `/^\d+$/` on both branches instead; documented the reasoning
directly in `metrics.ts` next to the regex.

Tests: `metrics.test.ts` (2 new), malformed input on both rails is a no-op, counted in
`recordingErrors`, not thrown, and a valid call still works after a prior malformed one.
`hedera-rail.test.ts` and `arc-rail.test.ts` (1 new each), a `Metrics` subclass whose
`recordSettlement` unconditionally throws, injected into a real mounted rail, still lets
a genuine settled payment reach 200/`onSettled` (Hedera) and 200 without a 500 (Arc),
proving the isolation holds end-to-end, not just at the unit level.

**Finding 3 (HBAR settlements mislabeled as USDC revenue).** `recordSettlement` takes the
settled requirement's `asset`; an HBAR-priced settlement (`asset === "0.0.0"`, matching
`rails/hedera.ts`'s `hbarPrice`) still increments `settlements.hedera.count` but is
excluded from `revenueAtomic`. `rails/hedera.ts`'s `onAfterSettle` now passes
`ctx.requirements.asset` through. Reworded the comments on `metrics.ts`'s
`settlements.arc` field and `recordSettlement` itself to state this explicitly rather
than the prior (technically true but incomplete) "kept as a raw running sum" framing.
Per the finding's own note that a `note` string isn't allowed by the strict §13.1 shape,
the caveat lives in code comments only, no schema change.

Tests: `metrics.test.ts` (2 new), an HBAR settlement increments count and leaves
`revenueAtomic` at `0n`, and a subsequent USDC settlement still accumulates normally on
top of it; a Hedera settlement with no `asset` argument at all (the pre-Finding-3 call
shape) still accumulates `revenueAtomic` unchanged, confirming the new optional
parameter doesn't silently change behavior for a caller that omits it.

**Minor.** `app.ts`'s two identical `onSettled` composition closures (one per rail) are
now one shared `const` above both `if (deps.rails?...)` blocks.

**Cross-package test.** `admin.test.ts` gained a test asserting a real mounted app's
`/v1/admin/metrics` response satisfies `packages/dashboard/lib/admin.ts`'s
`isAdminMetrics` guard. That function is not exported from its module, and
`packages/service` has no dependency on `@vaultradar/dashboard`, there is no package-name
import path to it at all. A relative-path import would fare no better: dashboard's
`tsconfig.json` sets `jsx: "react-jsx"`, `lib: ["dom", "dom.iterable", "esnext"]`, and a
`"next"` TypeScript language-service plugin, none of which belong in `packages/service`'s
own typecheck, and the file also imports a sibling `./service` module that resolves
`NEXT_PUBLIC_*`-flavored config. Per the review's own pre-authorized fallback, I copied
`isAdminMetrics`'s logic (and its `isRecord` helper) verbatim into the test with a
comment citing exactly this and noting the source line range, rather than attempting the
cross-package dependency wiring.

### Commands and output (fix round 1)

```
bun test packages/core packages/service   -> 168 pass, 1 skip, 0 fail
bun test                                  -> 322 pass, 1 skip, 0 fail
bun run typecheck                         -> clean, exit 0
```
(The four console lines `bun test` prints from `packages/dashboard/test/scan.test.ts`
, "policy unusable", "socket hang up", "invalid private key", each with `[redacted]`
where a key would be, are expected output from that suite's own error-path fixtures,
not failures; present before this fix round too.)

### Files changed (fix round 1)
- Merge commit: `.env.example`, `bun.lock`, `packages/service/src/{admin,app,hcs,index,metrics,wellknown}.ts`,
  `packages/agent/test/harness.ts`, plus every file main brought in from Tasks 21-28
  (agent client/policy/CLI, dashboard portfolio/admin views), not separately reviewed
  here since it is main's own already-reviewed content, just fast-forwarded in.
- Fix commit: `README.md`, `packages/core/src/envelope.ts`,
  `packages/core/test/envelope.test.ts`, `packages/service/src/app.ts`,
  `packages/service/src/handlers/scan.ts`, `packages/service/src/metrics.ts`,
  `packages/service/src/rails/arc.ts`, `packages/service/src/rails/hedera.ts`,
  `packages/service/test/{admin,arc-rail,hedera-rail,metrics}.test.ts`

### Self-review (fix round 1)
- All three findings addressed with the exact behavior described (with one flagged,
  evidence-based deviation on Finding 2's regex, explained above and in code).
- Minor and cross-package test both done.
- `checkSealedRequest`'s existing callers/tests keep working unchanged, verified, not
  assumed: the full pre-existing `envelope.test.ts` suite (9 tests) passes unmodified
  against the refactored implementation.
- Nothing secret logged, no new logging statements were added anywhere in this fix
  round (checked via diff).
- Tests pristine, 0 failures, core+service and full monorepo both green, typecheck
  clean.

### Concerns (fix round 1)
- Finding 2's literal "decimal check for USD" instruction was not implemented as
  written; see the detailed, evidence-based reasoning above. If the reviewer had a
  different scenario in mind (e.g. a future rail that genuinely settles in decimal
  dollars), the validator would need a rail-specific format rather than one shared
  regex, flagging so this can be revisited if that reviewer's intent was in fact
  different from what I inferred.
- The merge brought in Tasks 21-28's content (agent client, dashboard portfolio/admin
  views) as already-reviewed work from `main`; I did not re-review it, only fixed the
  two compile breaks it caused against this branch's own code.

### Fix round 1, addendum (`9cd3540`)

The reviewer clarified that their prior Finding 3 message had a garbled sentence: no new
response field (confirmed already true, `recordingErrors` was never part of
`AdminMetrics`), no README edit for this finding (that caveat belongs to the docs pass;
my earlier README edit was for Finding 1's payer_mismatch caveat, which *was* explicitly
requested there, verified the two are unrelated and I hadn't conflated them), and the
one actually-missing piece was a code comment in `admin.ts` itself. Added it directly
above the `metrics.snapshot()` call, stating that `revenueAtomic` counts USDC-priced
Hedera settlements only. The behavior, `metrics.ts`'s own comment, and the test were
already correct from the prior commit. Verified: `tsc --noEmit` clean,
`bun test packages/service/test/{admin,metrics}.test.ts` 23 pass/0 fail.
