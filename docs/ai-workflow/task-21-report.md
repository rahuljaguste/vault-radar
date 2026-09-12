# Task 21 report: agent client library

Branch: `ws/agent` (worktree `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/agent`)
Commit: `10d8ff9` — "feat(agent): VaultRadar client with discovery verification, sealed paid scans on Hedera and Arc"

## Fix round 1

Commit: `c44f098` — "fix(agent): reject attestation-count mismatches and sealed/clear
response inconsistency; wrap arc payment failures with a clear message"

Review found three Important issues, all in `packages/agent/src/client.ts`'s `paid()`.
All three fixed, each with a covering test in `packages/agent/test/client.test.ts`.

### 1. `attestationsValid` was vacuously true for a missing attestation

`attestations.every(...)` on an empty array is `true` regardless of how many vaults
came back, so a response with vaults but zero attestations reported as verified.

Fix: `attestationsValid` now requires `attestations.length === opened.vaults.length`
**and** every attestation's `vaultId` to be present among the returned vault ids, in
addition to the existing per-attestation signature check:

```ts
const vaultIds = new Set(opened.vaults.map(v => v.id));
const attestationsValid =
  attestations.length === opened.vaults.length &&
  attestations.every(a => vaultIds.has(a.vaultId) && verifyAttestation(a, d.sigPk));
```

Test: `"attestationsValid is false when the response has fewer attestations than
vaults"` — injects `payingFetch` to return a hand-built clear body (one vault, zero
attestations, a real signed receipt) and asserts `receiptValid: true` but
`attestationsValid: false`, showing the two checks are independent.

### 2. `sealed` on the result reflected request intent, not observed reality

If the client sealed the request but the response lacked a `sealed` field (or vice
versa), the old code silently fell through to treating it as whichever shape it
expected, and still reported `sealed` from what the client *asked for*.

Fix: after obtaining the raw response (either rail), before opening/reading anything
from it:

```ts
if (env && !isSealedResponse(raw)) throw new Error("service returned a clear response to a sealed request");
if (!env && isSealedResponse(raw)) throw new Error("service returned a sealed response to a clear request");
```

Also tightened `isSealedResponse` itself: it used to just check `"sealed" in r`
(shallow key presence), which would misclassify any object with an unrelated
`sealed` key. It now additionally runs core's own `isSealed()` structural check
against that field, so the two throw-guards above rest on a real check, not a name
collision. Since sealed-ness is now asserted consistent before `opened` is
computed, the `opened` ternary simplified from `isSealedResponse(raw) && env ? ... :
...` to just `env ? ... : ...`.

Tests: `"a sealed request answered with a clear body throws..."` and `"a clear
request answered with a sealed body throws..."` — the second hand-builds a
structurally valid `Sealed` envelope (via core's real `seal()`, encrypted to the
service's own KEM key — irrelevant since the client must reject it before ever
attempting to open it) to make sure the tightened `isSealedResponse` really
recognizes a well-formed sealed envelope, not just a truthy `sealed` key.

### 3. Arc's non-200 guard was dead code and dropped the service's `reason`

`GatewayClient.pay()` throws on every non-2xx response (confirmed by reading the
installed `@circle-fin/x402-batching` `.d.ts` and its doc comments: pre-payment
`"Request failed with status ${status}"`, post-payment `"Payment failed: ${error.error
|| statusText}"`), so `paid.status !== 200` could never fire — it was unreachable —
and an unwrapped rejection gave the caller no indication the failure was
Arc-payment-specific.

Fix: removed the dead status check; added a new constructor option `arcPay?: (url,
body, headers) => Promise<ArcPayResult<ServiceResponse>>` (defaults to `payArc`
bound to `arc.privateKey`, exactly like the existing `payingFetch` override does for
Hedera); wrapped the call in try/catch and rethrow as `` `arc payment failed:
${e.message}` ``. Added a code comment noting Circle's client only reads a JSON
`{ error }` field from the service's response, not VaultRadar's own `{ reason }`
convention (`handlers/scan.ts`), so a service 4xx may surface here as a bare
status/statusText rather than the structured reason — a service-side alias is
tracked separately, not fixed here.

Tests:
- `"scan on the arc rail pays via the injected arcPay: bucket URL, payer address,
  and the sealed round trip all check out"` — the injected `arcPay` opens the
  incoming sealed request with the *service's* KEM secret key (exactly what the real
  service does) to recover the client's ephemeral `reply_pk`, then seals a real
  matching reply to it, so the Arc branch's open/verify path runs for real. Asserts
  the request went to the `s` bucket URL (`${base}/arc/v1/scan/s`, 1 vault) and that
  the sealed request's `payer` field equals `arcAddress(TEST_ARC_KEY)`.
- `"an arcPay rejection is wrapped as a clear 'arc payment failed' error, not
  silently swallowed"` — injected `arcPay` rejects with `"Payment failed:
  insufficient funds"` (mirroring `GatewayClient.pay()`'s own message shape);
  asserts the client rethrows `"arc payment failed: Payment failed: insufficient
  funds"`.

### Regression-test verification

For each of the three fixes, before finalizing I reverted just that fix (via `Edit`,
restored immediately after) and reran `bun test packages/agent` to confirm the new
test actually fails against the old code, not just that it passes against the new
code:

- Reverting `attestationsValid` to the old vacuous `.every()` → the new test failed
  with `Expected: false / Received: true`, as expected.
- Removing both sealed/clear mismatch throws → both new tests failed (with
  unrelated `TypeError`s from trying to read fields off the wrong shape), confirming
  the throws — not some other code path — are what the tests depend on.
- Removing the Arc try/catch wrapper → the rejection test failed with `Received
  message: "Payment failed: insufficient funds"` (missing the `"arc payment
  failed: "` prefix), confirming the wrapping is what the test checks.

All three were restored and the full suite re-verified green afterward.

### Commands and output

```
$ bun test packages/agent
 15 pass
 0 fail
 43 expect() calls
Ran 15 tests across 1 file.

$ bun test
 116 pass
 0 fail
 349 expect() calls
Ran 116 tests across 18 files.

$ bun x tsc -p packages/agent/tsconfig.json --noEmit
(clean, no output)
```

No other files touched in this round (only `packages/agent/src/client.ts` and
`packages/agent/test/client.test.ts`); `packages/service` and `packages/core` are
unaffected.

Note on paths: the brief at the path given in the task message
(`/Users/rahuljaguste/pq/ethonline-20206/.superpowers/sdd/2026-09-09-vaultradar/task-21-brief.md`)
did not exist there — `.superpowers/sdd/` content is per-checkout (gitignored) and this
top-level checkout only has briefs 1–17. I found the real Task 21 (and 19, 22, 23) briefs
under `.worktrees/core/.superpowers/sdd/2026-09-09-vaultradar/` and worked from those, plus
`docs/architecture.md`'s sequence diagram (for the exact ERC-8004 `getMetadata(agentId,
"pq.sig.pubhash")` call shape, which neither brief spells out) and `task-22-brief.md` (to
confirm the exact consumer contract for `Decision`/`RunRequest`/`RunRecord`/`PaidResult`).

## What I implemented

- `packages/agent/src/client.ts` — `VaultRadarClient`: `discover()` (fetches and
  zod-validates the agent card, checks its ML-DSA-65 self-signature against the
  **untouched** wire object, cross-checks `pq.sig.pub_hash` against every ERC-8004
  identity via `readPqHash`), `quote()`, `scan()`, `table()`, and a shared private
  `paid()` path that seals (or not), pays on the chosen rail, opens/verifies the
  sealed reply (or reads the clear one), and verifies the receipt and every
  attestation. Exports `AgentCard`, `Discovery`, `PaidResult`, `VaultRadarClientOpts`,
  `PayingFetch`.
- `packages/agent/src/rails/hedera.ts` — `payingFetchHedera()` (x402 fetch wrapper via
  `@x402/fetch` + `@x402/hedera/exact/client`), `txIdFromResponse()` (reads the
  `PAYMENT-RESPONSE` header).
- `packages/agent/src/rails/arc.ts` — `payArc()` (Circle Gateway nanopayments),
  `arcAddress()` (derives a payer address from a raw key with no network call).
- `packages/agent/src/erc8004.ts` — `readPqHashOnChain()`: the default `readPqHash`
  implementation, a viem `readContract` against the ERC-8004 IdentityRegistry
  (`0x8004A818BFB912233c491871b3d84c89A494BD9e`) calling
  `getMetadata(agentId, "pq.sig.pubhash")`, decoding the returned bytes as UTF-8 to
  recover the hash string. Chain table: `296` → Hashio, `5042002` → Arc testnet RPC.
  Never throws — unknown chain, bad agentId, RPC/revert all yield `null`.
- `packages/agent/src/runs.ts` — `saveRun()`/`listRuns()` (synchronous, per the
  brief's literal `saveRun(dir, run): string` signature) plus `Decision`,
  `RunRequest`, `RunRecord` typed to match `packages/dashboard/lib/types.ts`'s
  `RunRecord` **exactly**, field for field (diffed by hand against that file).
- `packages/agent/src/index.ts` — barrel re-exporting client/rails/runs/erc8004.
- `packages/service/src/index.ts` (new) + `packages/service/package.json`
  (`"exports"` entry) — re-exports exactly `buildApp`, `makeScanHandler`,
  `loadConfig`, `loadKeys`, `LiveDataProvider`, and types `HandlerDeps`,
  `DataProvider`, `Catalog`, `Config`, `ServiceKeys` — nothing more, per spec.
- `packages/agent/package.json`, `tsconfig.json` per the brief plus
  `@vaultradar/service` workspace devDependency and the package `exports` field
  (mirroring `@vaultradar/core`'s pattern).

## Deliberate deviations from the brief's literal pseudocode

1. **Constructor takes `payingFetch` directly** (per the controller's resolution)
   instead of the brief's test hack (`(c as any).payingFetch = ...`). Tests inject
   `payingFetch: fetch` and never touch a private field.
2. **Fixed a real bug in the brief's `scan()`/`table()` pseudocode**: it read
   `this.disc!` (non-null assertion) to build the request URL *before* `paid()`'s
   own `this.disc ?? await this.discover()` would have populated it — calling
   `scan()` without a prior `discover()` would throw on `null.card`. I factored a
   shared `private ensureDiscovery()` and call it from `discover`-needing entry
   points (`scan`, `table`, `paid`) so a bare `client.scan(...)` with no prior
   `discover()` call works correctly (and is exercised by every scan/table test).
3. **`payArc`'s return type is the library's real `PayResult<T>`**, not the brief's
   hand-sketched `{ data, amount: string, formattedAmount, transaction }`. The
   installed `@circle-fin/x402-batching@3.4.0` types (checked directly in
   `node_modules`) show `amount: bigint` (atomic units) and an additional
   `status: number`. Importing the library's own type instead of a hand-rolled
   duplicate avoids the type-vs-reality drift I'd have shipped otherwise, and let
   me add a `status !== 200` guard on the Arc path matching the Hedera path's rigor.
4. **`AgentCard` is zod-validated defensively** before any field is read, but the
   ML-DSA-65 signature check runs against the **raw, untouched** fetch response
   object, not the zod-parsed copy — so verification reflects exactly the bytes the
   service sent, with zero risk of a reconstructed-object / key-reordering
   discrepancy affecting the crypto check. (I traced `canonicalBytes` in
   `packages/core/src/canonical.ts` to confirm it sorts keys recursively, so this
   extra care isn't strictly load-bearing today, but it removes the whole question.)

## TDD evidence

Wrote `packages/agent/test/client.test.ts` first against the not-yet-existing
`../src/client`, `../src/erc8004`, `../src/runs`. First run failed on missing
modules; after implementing, first green-ish run surfaced two real bugs the tests
caught:

- `ConnectionRefused`/`FailedToOpenSocket` on scan/table: my test's `PUBLIC_URL`
  (`http://svc.test`) didn't match the port the in-process server actually listened
  on. `VaultRadarClient` correctly follows the card's *declared* endpoint URLs
  (real client behavior), so the test needed to reserve a free port first and bake
  it into `PUBLIC_URL` before building the config/app. Fixed in the test, not the
  client.
- `expect(r.txId).toBe("0.0.42@1.0")` failed (`received: null`). This was my own
  wrong assumption: `txId` on the result comes from the `PAYMENT-RESPONSE` HTTP
  header, which only real x402 payment middleware sets — absent in this
  no-middleware test — so `null` is correct. Fixed the assertion to check
  `r.txId === null` and `r.receipt.payment.txId === "0.0.42@1.0"` instead (the
  handler's txId does reach the signed receipt; the client surfaces it untouched).

After both fixes: 10/10 pass in `packages/agent`, 111/111 across the whole
workspace (18 files), both `tsc --noEmit` runs clean (agent and service; ran
core's too for completeness — clean).

```
bun test packages/agent   → 10 pass, 0 fail, 30 expect() calls
bun test                  → 111 pass, 0 fail, 336 expect() calls, 18 files
bun x tsc -p packages/agent/tsconfig.json --noEmit    → clean
bun x tsc -p packages/service/tsconfig.json --noEmit  → clean
bun x tsc -p packages/core/tsconfig.json --noEmit     → clean
```

Test coverage against the required behaviors: `discover()` verifies the card and
`onChain[0].matches === true`; a mismatching `readPqHash` yields `matches: false`;
`scan()` round-trips sealing + receipt + attestation verification (sealed and
`seal:false` both); `table()` works; `quote()` reflects configured rails; a rail
with no matching wallet configured throws a clear, typed error (exercises the
`payerFor` guard for real, without ever constructing a `GatewayClient`);
`readPqHashOnChain` returns `null` for an unconfigured chain with zero network
calls; `saveRun`/`listRuns` round-trip through a real temp directory, including a
missing-directory case for `listRuns`.

## Files changed

- `packages/agent/package.json`, `packages/agent/tsconfig.json` (new)
- `packages/agent/src/client.ts`, `src/erc8004.ts`, `src/index.ts`,
  `src/rails/hedera.ts`, `src/rails/arc.ts`, `src/runs.ts` (new)
- `packages/agent/test/client.test.ts` (new)
- `packages/service/src/index.ts` (new)
- `packages/service/package.json` (added `"exports"` — one line)
- `bun.lock` (updated: fresh install, this worktree had no `node_modules` at all
  before this task — 1440 packages installed workspace-wide, not agent-specific)

## Self-review

- Every export in the brief's Interfaces block exists with the stated signature —
  checked one by one against the actual source (see above); `payArc`'s signature
  matches structurally (superset via the real library type, see deviation #3).
- `RunRecord`/`RunRequest`/`Decision` diffed field-by-field against
  `packages/dashboard/lib/types.ts`'s copy: identical.
- No private key is ever logged (no `console.*` calls anywhere in the new code) or
  persisted (`RunRecord` has no key-shaped field anywhere in its type).
- Sealing, receipt verification, attestation verification, and the on-chain hash
  comparison are all exercised through real code paths (not stubbed out) — see TDD
  evidence above. The one thing intentionally *not* exercised is the live Hedera/Arc
  network calls inside `payingFetchHedera`/`payArc` themselves, per the brief's own
  scoping ("not exercised by tests (no network)").

## Concerns

1. **zod peer-dependency warning**: `bun install` printed
   `warn: incorrect peer dependency "zod@3.25.76"` — `@anthropic-ai/claude-agent-sdk`
   wants `zod@^4.0.0` as a peer, but the resolved version (satisfying `@x402/core`,
   my own `^3.23.0`, etc.) is `3.25.x`. Not a problem for this task (I don't import
   the Claude Agent SDK), but Task 23 (which does) should check whether the SDK's
   `tool()` zod-schema types actually need v4 at compile time.
2. **`ensureDiscovery()` doesn't dedupe concurrent calls**: if `scan()` and `table()`
   are both called before any `discover()`, each triggers its own independent
   `discover()` (two card fetches, two on-chain reads) rather than sharing one
   in-flight promise. Both produce equivalent valid results; this is a minor
   inefficiency, not a correctness bug, and I left it unoptimized since nothing in
   the brief or tests calls for it.
3. The ERC-8004 metadata key (`"pq.sig.pubhash"`) and registry address came from
   `docs/architecture.md`'s sequence diagram and the plan doc, not from either
   task-21/22 brief directly — both sources agree, but worth a second pair of eyes
   given it's load-bearing for on-chain identity verification and I couldn't find a
   third, independent confirmation (e.g. an actual deployment/registration script)
   in the repo yet.
