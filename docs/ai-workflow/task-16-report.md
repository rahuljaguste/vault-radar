# Task 16 report: Hedera x402 rail via Blocky402, payer capture, hello-x402 client

## Status: DONE_WITH_CONCERNS

## What I implemented

- `packages/service/src/rails/hedera.ts` (new) — `mountHederaRail(app, deps)` registers
  `POST /hedera/v1/scan` (USDC, dynamic per-count price), `POST /hedera/v1/scan-hbar`
  (HBAR tinybars, dynamic per-count), `POST /hedera/v1/table` (USDC flat at
  `TABLE_PRICE_USD`) via `paymentMiddleware`/`x402ResourceServer` from `@x402/express`
  and `@x402/core/server`, with `ExactHederaScheme` from `@x402/hedera/exact/server`.
  Exports exactly the four names the brief's interface specifies:
  `hederaPayerFromRequest`, `hederaTxIdFromRequest`, `decodeHederaPayment`,
  `mountHederaRail`.
- `packages/service/src/app.ts` — removed the `@ts-expect-error` line above the Hedera
  dynamic import (left the Arc one untouched, as instructed); `tsc` now compiles clean.
- `packages/service/test/hedera-rail.test.ts` (new, 9 tests, no network) — payer/tx-id
  decoding from a real (locally-frozen, unsubmitted) Hedera transaction; all three
  routes' pricing observed through real 402 responses against a fake local
  facilitator; input-validation failure modes.
- `packages/service/scripts/hello-x402.ts` (new) — the day-one de-risking client
  script, per the brief's Step 3, with two small type corrections (below).
- `packages/service/test/hedera-rail.live.test.ts` (new) — `test.skipIf(process.env.LIVE
  !== "1")`, mirrors the hello-x402 flow as assertions against a real facilitator +
  `LiveDataProvider`. Cannot run in this environment (see "Cannot run now").
- `packages/service/package.json` / `bun.lock` — added `@x402/fetch@2.25.0` as a
  dependency. **This was missing entirely** — neither `package.json` nor the lockfile
  had it, and `hello-x402.ts` (and the live test) need `wrapFetchWithPayment`,
  `x402Client`, `decodePaymentResponseHeader` from it. Confirmed on the npm registry
  at the same `2.25.0` pin as the other `@x402/*` packages before adding; its own only
  dependency is `@x402/core@~2.25.0`, already present. `bun install` resolved it
  cleanly (518 packages, 17 newly resolved).
- Root `.env.example` — appended `AGENT_HEDERA_ACCOUNT_ID=`, `AGENT_HEDERA_KEY=`,
  `SERVICE_URL=http://localhost:8787`, `VAULT=`.

I did **not** touch `packages/service/src/main.ts` (still passes `rails: {}`) — it
wasn't in this task's file list or my instructions, and flipping `hedera: true` on
unconditionally would register live payment routes with whatever `HEDERA_*` config
happens to be set (including the empty-string defaults `loadConfig` falls back to),
which felt like a decision for whoever wires deployment config, not this task. Same
call Task 14 flagged for its own scope. Left as a concern below.

## The payload field name

Confirmed **`transaction`**, with no fallback needed, from three independent points of
evidence in the installed `@x402/hedera@2.25.0` package (not by adding `DEBUG_X402`
logging — the brief's fallback plan for confirming this — since static evidence was
already conclusive):

1. The public type: `dist/cjs/index.d.ts` — `type ExactHederaPayloadV2 = { transaction:
   string }`, and an exported `extractTransactionFromPayload(payload:
   ExactHederaPayloadV2): string` utility built exactly for this purpose.
2. The runtime validator inside that utility (`dist/cjs/index.js:134`):
   `if (!payload || typeof payload.transaction !== "string" || ...) throw new
   Error("invalid_exact_hedera_payload_transaction"); return payload.transaction;`
3. The client's own construction site (`dist/cjs/exact/client/index.js`, decompiled from
   the shipped build): `const payload = { transaction }; return { x402Version, payload
   };` inside `ExactHederaScheme.createPaymentPayload`.

Given this, `decodeHederaPayment` uses `@x402/hedera`'s own exported
`extractTransactionFromPayload` + `inspectHederaTransaction` (also exported, built for
exactly this decode-and-inspect purpose) instead of the brief's snippet, which reached
into `Transaction.fromBytes(...).tokenTransfers ?? tx._tokenTransfers` (a private-ish
fallback). `inspectHederaTransaction` returns a normalized `{ transactionId,
hbarTransfers: {accountId, amount}[], tokenTransfers: Record<tokenId, {accountId,
amount}[]> }` — I derive the payer as the first account with a negative `amount`
(`BigInt(amount) < 0n`) across the token transfers, falling back to HBAR transfers.
This is the same logic the brief specified, just built on the SDK's own public,
typed, tested utility rather than reaching past it.

## Settlement observation: which hook path, and why

**Used the hook path, not the brief's `res.json`-wrapper fallback.** Both hooks exist in
the installed 2.25.0 `@x402/core`:

```
// dist/cjs/x402Client-pTJv8yPe.d.ts:480, :503
onAfterVerify(hook: AfterVerifyHook): x402ResourceServer;
onAfterSettle(hook: AfterSettleHook): x402ResourceServer;
// :316, :336
type AfterVerifyHook = (context: VerifyResultContext) => Promise<void | {...}>;
type AfterSettleHook = (context: SettleResultContext) => Promise<void>;
// VerifyResultContext extends VerifyContext { result: DeepReadonly<VerifyResponse> }
// SettleResultContext extends SettleContext { result: DeepReadonly<SettleResponse> }
// VerifyResponse = { isValid; payer?: string; ... }
// SettleResponse = { success; transaction: string; network; payer?; ... }
```

Design: `onAfterVerify` records `ctx.result.payer` into a module-level `Map<string,
string>` keyed by the base64 transaction string extracted from `ctx.paymentPayload.payload`
(the same value `decodeHederaPayment` derives independently from the request header,
via the identical `extractTransactionFromPayload`). `decodeHederaPayment` prefers this
map over its own transfer-list derivation. `onAfterSettle` looks up a receipt in a
second `Map<string, Receipt>`, keyed the same way, and calls `deps.onSettled?.(receipt,
ctx.result.transaction)`. The receipt map is filled by a wrapper around each route
handler that runs `res.locals.receipt = ...` and stores it right after
`makeScanHandler`'s handler resolves.

**Why this is race-free**, traced through `@x402/express@2.25.0`'s compiled
`dist/cjs/index.js` (`paymentMiddlewareFromHTTPServer`):

1. `ExactHederaScheme.paymentFlows.default.default === "authorization"` (confirmed in
   `@x402/hedera/exact/server`'s compiled source), and per `x402ResourceServer
   .verifyPayment`'s doc comment, the `authorization` flow verifies **before** the route
   handler runs. So `onAfterVerify` always populates the payer map before
   `hederaPayerFromRequest` is ever asked for that same request's payer.
2. The middleware monkey-patches `res.writeHead/write/end/flushHeaders` to buffer
   output and resolves an internal `endPromise` only when the (buffered) `res.end`
   fires — which happens transitively when the route handler calls `res.json(...)`.
   My wrapper's `await handler(req, res)` resumes at that same point (a microtask
   continuation of the same promise chain).
3. Only *after* that does the middleware call `processSettlement`, which calls
   `HTTPFacilitatorClient.settle` — a real `fetch()` to `{facilitatorUrl}/settle`. A
   `fetch` can never resolve within the same microtask-drain pass; it requires at
   least one macrotask/I-O turn. My wrapper's synchronous `receiptByTxKey.set(...)` (a
   microtask-scheduled continuation) is therefore always visible before
   `onAfterSettle` — which only fires after that `fetch` returns — can possibly look
   it up. This isn't "usually fine," it's a structural ordering guarantee of the
   library's own buffering design plus JS's microtask/macrotask semantics.

I did not need the `res.json`-wrapper / `PAYMENT-RESPONSE`-header fallback the brief
described for the case where no after-settle hook exists, since one does.

## Correction to the brief: price-function throws surface as 500, not 4xx

The brief instructed "throw a descriptive error when missing or out of range so the
middleware returns a 4xx." I implemented the throw exactly as directed (it's the only
mechanism the SDK exposes for a price function to reject bad input), but traced the
actual resulting status by reading `@x402/express@2.25.0`'s compiled
`processHTTPRequest`/`buildPaymentRequirementsFromOptions`: there is no `try/catch`
around `await option.price(context)` anywhere in that call chain. The exception
propagates out of `processHTTPRequest` to the Express wrapper's own outer `catch`,
which calls `sendInternalError` — `console.error(error); res.status(500).json({error:
"Internal Server Error"})`. **A thrown price-function error is a 500, not a 4xx, in
this SDK version.** This is a limitation of `@x402/express` 2.25.0, not of this
implementation — the throw is still the correct and only way to reject the request.
Covered by a dedicated test (`hedera-rail.test.ts`) that asserts the real, observed
500 rather than a guessed 4xx, so this doesn't silently bit-rot if the library's
behavior changes.

Two of my tests deliberately trigger this path; both temporarily swap `console.error`
to a no-op, since the 500 comes with the library's own unconditional
`console.error(error)` inside `sendInternalError` (confirmed in its source) — not my
code logging anything. The logged value is always one of my own literal validation
strings ("X-VR-Count must be 1..100", "malformed sealed envelope"), never a request
body or secret.

## Test commands and output

```
$ bun test packages/service/test/hedera-rail.test.ts
 9 pass
 0 fail
 21 expect() calls
Ran 9 tests across 1 file. [2.06s]

$ bun test packages/service    # x3 consecutive runs, no flakiness
 35 pass
 1 skip   (the LIVE=1-gated test, correctly skipped)
 0 fail
 126 expect() calls
Ran 36 tests across 5 files.

$ bun test                     # whole workspace, no regressions
 110 pass
 1 skip
 0 fail
 327 expect() calls
Ran 111 tests across 19 files.

$ bun x tsc -p packages/service/tsconfig.json --noEmit
(no output, exit 0)
```

## What the tests cover

- **(a) `decodeHederaPayment`**: builds a real `TransferTransaction` with the Hiero SDK
  (`addTokenTransfer` ×2, `setTransactionId(TransactionId.generate(feePayerAccount))`,
  `setNodeAccountIds([AccountId.fromString("0.0.3")])`, `.freeze()` — no network
  needed), base64s `toBytes()`, wraps it in a v2 `PaymentPayload` and encodes with
  `encodePaymentSignatureHeader`. Asserts the decoded payer equals the debited account
  and is *not* the fee-payer account (deliberately different accounts in the fixture,
  so the test can't pass by accident if `decodeHederaPayment` used
  `transactionId.accountId` — the fee payer — instead of the transfer list). Also
  covers: no payment header → `{payer: null, txId: null}`; a garbage header → same,
  never throws.
- **(b)/(c) mounted rail via a fake local facilitator** (a tiny Express app answering
  `GET /supported`, `POST /verify`, `POST /settle` on `127.0.0.1`, since
  `HTTPFacilitatorClient` calls the global `fetch` directly with no injection point —
  confirmed by reading its compiled source, so an in-process fetch-fake doesn't work
  here and a real local HTTP server does): every route's unpaid 402 response, decoded
  via `decodePaymentRequiredHeader`, checked against the *atomic* amount the SDK
  actually derives (traced against `@x402/hedera`'s `parsePrice`/`convertToTokenAmount`
  and `@x402/core`'s `parseMoney` — by hand, then confirmed by the passing test):
  scan @ count 1 → `1500`, count 5 → `3500`, HBAR @ count 5 → asset `0.0.0` amount
  `5000000` (exactly the brief's literal value), table → `30000`. I chose to assert
  the post-conversion atomic amounts (what a real client actually sees) rather than
  the pre-conversion `"$0.0035"` string the brief mentions for the count-5 case, since
  that string is never observable outside this module's own unexported closure —
  asserting the real 402 body additionally proves the price functions are correctly
  *wired into* `paymentMiddleware`, which a closure-level unit test wouldn't. Also:
  missing `X-VR-Count` → 500 (see correction above); a body carrying `ct` but failing
  `isSealed` → 500 (envelope validation).
  `syncFacilitatorOnStart` needed no adjustment — confirmed by reading the compiled
  middleware that it's fire-and-forget at creation and only awaited lazily on the
  first protected-route request, so a fast local fake facilitator never blocks
  startup or these tests.

## Cannot run now

`hello-x402.ts` and `hedera-rail.live.test.ts` need real Hedera testnet accounts (both
associated with `0.0.429274`, agent funded from `faucet.circle.com`) and a reachable
Blocky402 facilitator — none of which exist in this sandboxed environment. Exact
commands for later:

```bash
# one-time: associate both accounts with 0.0.429274 (TokenAssociateTransaction or the
# Hedera portal), fund AGENT_HEDERA_ACCOUNT_ID with testnet USDC from faucet.circle.com

SERVICE_URL=http://localhost:8787 \
AGENT_HEDERA_ACCOUNT_ID=0.0.x AGENT_HEDERA_KEY=<ecdsa-hex> VAULT=1:0x... \
bun run packages/service/scripts/hello-x402.ts

LIVE=1 PQ_SIG_SEED=<hex32> PQ_KEM_SEED=<hex64> \
HEDERA_PAYTO_ACCOUNT_ID=0.0.x HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=<hex> \
HEDERA_FACILITATOR_URL=https://api.testnet.blocky402.com \
AGENT_HEDERA_ACCOUNT_ID=0.0.y AGENT_HEDERA_KEY=<ecdsa-hex> VAULT=1:0x... \
bun test packages/service/test/hedera-rail.live.test.ts
```

Expected per the brief: `status 200`, a `payment-response` header decoding to a
Hedera transaction id, `receipt ok: true`. Then look the transaction id up on HashScan
testnet and paste the URL into `docs/verification-log.md` (that file doesn't exist yet
in this repo — I didn't create a placeholder for it since I have no real content to
put there yet).

## Self-review

- **Every route registered with the exact full path**: `POST /hedera/v1/scan`,
  `POST /hedera/v1/scan-hbar`, `POST /hedera/v1/table` — present identically in both
  the `paymentMiddleware` routes object and the three `mountTier(...)` calls that wire
  the actual handlers; verified by the passing per-route pricing tests.
- **Price functions validate input**: `countFromCtx` throws on a missing/out-of-range
  `X-VR-Count` (via `clampCount`); `validateEnvelope` throws on a body that looks like
  a sealed envelope (`ct`/`kem` present) but fails `isSealed`. Both covered.
- **Payer never guessed**: derived either from the facilitator's own verified result
  (`onAfterVerify`) or from the actual negative-transfer entry in the decoded
  transaction — never hardcoded or assumed from `transactionId`.
- **No payload or secret logged**: grepped `hedera.ts` — zero `console.*` calls.
  `hello-x402.ts`'s `console.log` calls print only its own request's outcome (status,
  txId, a signature-verification boolean, a 300-char preview of its own decrypted
  response) — a CLI tool reporting its own results, not a server logging inbound
  traffic; no private key or raw payload ever printed.
- **The `@ts-expect-error` for hedera removed**: confirmed in the diff; the Arc one is
  untouched.
- **Tests pristine**: 9/9 new, 35/35 service-wide (1 intentional skip), 110/110
  workspace-wide, three consecutive runs with no flakiness, no stray console output.

## Concerns

- **`main.ts` still passes `rails: {}`**, so this rail isn't live until something (a
  future task, or a config-gated check in `main.ts`) flips `hedera: true`. Deliberately
  out of this task's file list; flagging so it isn't missed, same as Task 14 did for
  the same line.
- **`bun.lock` also picked up an unrelated pre-existing rename**: `packages/dashboard`'s
  `package.json` `name` was already changed to `@vaultradar/dashboard` in the Task 24
  commit (`f04d0f7`), but the lockfile was never re-synced until my `bun install` run
  for `@x402/fetch` happened to catch it up. Not something I changed — `git diff
  packages/dashboard/package.json` is empty — just noting it so the extra lockfile
  hunks in this commit aren't mistaken for something this task touched.
- **The brief's assumed 4xx for bad pricing input is actually a 500** — see the
  dedicated section above. Implemented as directed (the throw); the resulting status
  is the SDK's behavior, not a choice I made.
- `verifiedPayerByTxKey` / `receiptByTxKey` are module-level `Map`s (matching the
  brief's own pseudocode, which used a module-level `WeakMap` the same way). Safe in
  practice — Hedera transaction ids are unique to the nanosecond, both maps are
  cleaned up in `onAfterSettle`, and a request that never settles (abandoned payment)
  leaves at most one stale entry per abandoned request rather than growing
  unboundedly under normal operation — but there's no TTL/cap if a client repeatedly
  starts payments it never completes. Not addressed, since the brief didn't ask for
  one and `makeScanHandler`'s own nonce store has the same shape of tradeoff.

## Files changed

- `packages/service/src/rails/hedera.ts` (new)
- `packages/service/src/app.ts` (modified — removed the Hedera `@ts-expect-error`)
- `packages/service/test/hedera-rail.test.ts` (new)
- `packages/service/test/hedera-rail.live.test.ts` (new)
- `packages/service/scripts/hello-x402.ts` (new)
- `packages/service/package.json` (modified — added `@x402/fetch@2.25.0`)
- `bun.lock` (modified — new dependency + an unrelated pre-existing rename sync, see
  Concerns)
- `.env.example` (modified — appended the four hello-x402 variables)

## Pre-review fix: request validation

Ruling on the "brief assumed 4xx, SDK actually returns 500" concern: a 500 for a bad
`X-VR-Count` isn't acceptable for a public API. Fixed by rejecting invalid input
*before* it ever reaches `paymentMiddleware`, instead of relying on the price
function's throw.

### Diff summary

`packages/service/src/rails/hedera.ts`:

- Added a module-level `validateScanRequest(req, res, next)` middleware: 400
  `{ reason: "bad_count" }` when `clampCount(req.header("x-vr-count"))` is null; 400
  `{ reason: "malformed_envelope" }` when the body has `ct`/`kem` but fails
  `isSealed`; otherwise `next()`.
- Mounted it with `app.use(["/hedera/v1/scan", "/hedera/v1/scan-hbar"],
  validateScanRequest)`, immediately before `app.use(paymentMiddleware(...))`. Not
  mounted on `/hedera/v1/table` — its price is a flat string, not a function, so it
  never read `X-VR-Count` or validated the envelope in the first place.
- Left `validateEnvelope`/`countFromCtx` inside the price-function closures unchanged
  (still throwing) — kept as a defensive fallback per the ruling; through the mounted
  rail they're now unreachable with invalid input, since the new middleware always
  intercepts first.

`packages/service/test/hedera-rail.test.ts`:

- `fakeFacilitator()` now tracks `calls: { supported, verify, settle }` counts and
  returns them, so tests can assert a rejected request never reached the facilitator.
- Removed the two tests documenting the old 500 behavior (they tested a code path
  the fix makes unreachable through the public routes — no longer added value once
  the middleware is the thing actually guarding those routes).
- Added three tests: missing `X-VR-Count` → 400 `bad_count`; an out-of-range count
  (`"0"`, on `/hedera/v1/scan-hbar`, to also cover the second mounted route) → 400
  `bad_count`; a body with `ct` failing `isSealed` → 400 `malformed_envelope`. Each
  asserts `fac.calls.verify === 0`.

The console-suppression scaffolding from the removed tests is gone too — with no
throw reaching `@x402/express`'s `sendInternalError`, there's nothing left to log.

### Commands and output

```
$ bun test packages/service/test/hedera-rail.test.ts
 10 pass
 0 fail
 27 expect() calls
Ran 10 tests across 1 file. [524.00ms]

$ bun test packages/service   # x3 consecutive runs, no flakiness
 36 pass
 1 skip
 0 fail
 132 expect() calls
Ran 37 tests across 5 files.

$ bun test                    # whole workspace, no regressions
 111 pass
 1 skip
 0 fail
 333 expect() calls
Ran 112 tests across 19 files.

$ bun x tsc -p packages/service/tsconfig.json --noEmit
(no output, exit 0)
```

### Files changed (pre-review fix)

- `packages/service/src/rails/hedera.ts` (modified — `validateScanRequest` middleware)
- `packages/service/test/hedera-rail.test.ts` (modified — facilitator call tracking;
  replaced the two 500-path tests with three 400-path tests)

## Fix round 1

Review found two Important issues. Both fixed.

### Finding 1: unbounded map growth on settlement failure

Confirmed by reading `@x402/core@2.25.0`'s compiled `settlePayment`
(`dist/cjs/server/index.js`): `onAfterSettle` only runs in the `if (settleResult
.success)` branch. A clean `{success: false}` from the facilitator — or the
facilitator client throwing — instead takes the `if (!settleResult.success) { ...run
onSettleFailure hooks...; return settleResult }` branch (same branch handles both:
the surrounding `try` also routes a thrown error to `onSettleFailure` via its own
`catch`). Neither of those ever reached `onAfterSettle`, so the entries `onAfterVerify`
and the route wrapper in `mountTier` had written for that request were never deleted.

**Fix** (`packages/service/src/rails/hedera.ts`):

- Registered `server.onSettleFailure(...)`, mirroring `onAfterSettle`'s cleanup
  (`verifiedPayerByTxKey.delete(b64)`, `receiptByTxKey.delete(b64)`) but without
  calling `deps.onSettled?.(...)`, since the payment never actually settled.
- Gave both maps a TTL: values are now stored as `{ value, expiresAt: Date.now() +
  10 * 60_000 }` (`Expiring<T>`, `ENTRY_TTL_MS = 10 * 60_000`), written via a new
  `putWithTtl` helper that sweeps every already-expired entry out of the map on each
  insert (`sweepExpired`, no `setInterval`/`setTimeout` — nothing to leak in an idle
  process, and no timer-driven flakiness in tests). Reads go through a new `getFresh`
  helper that treats an entry past its TTL as absent even if the sweep hasn't reached
  it yet, so a value can't ever be read stale between sweeps. This covers the one gap
  neither hook can: a payment that's verified and then abandoned before the client
  (or facilitator) ever settles it, which fires no hook at all.
- No new logging anywhere in the file (confirmed: `grep -n "console\." hedera.ts`
  matches nothing) — the "never log the keys" instruction was already satisfied by not
  logging at all.

### Finding 2: no coverage for the hook/map machinery

The existing fake facilitator always answered `/verify`/`/settle` with a clean
failure, so `onAfterVerify`, `onAfterSettle`, `onSettleFailure`, and `deps.onSettled`
had zero test coverage.

**Fix** (`packages/service/test/hedera-rail.test.ts`):

- `fakeFacilitator` now takes `{ feePayer?, verify?: {isValid, payer?, invalidReason?},
  settle?: {success, transaction?, payer?, errorReason?} }`, defaulting to the same
  clean-failure shape every existing test already relies on (no changes needed at
  those call sites).
- `mountRail` now accepts `{ onSettled?, scan? }` to let a test observe settlement
  callbacks and, for one test, hook into the handler's own execution window (see
  below). `onSettled` is passed through `BuildAppDeps & { onSettled?: ... }` — typed
  as a variable rather than an inline object literal passed directly to `buildApp`,
  so TypeScript's excess-property check (which only fires against literals) doesn't
  reject a field `BuildAppDeps` itself doesn't declare but `mountHederaRail` does
  (`app.ts` forwards the whole `deps` object through by reference, so the field is
  genuinely there at runtime).
- **Found and fixed a real bug in the *test fixture*, not the rail**, while wiring
  the paid path end to end: `buildPaymentSignatureHeader`'s `accepted.extra` was `{}`.
  Traced `@x402/core`'s `findMatchingRequirements` → `paymentRequirementsMatchAccepted`
  → `objectContainsSubset`: it requires every key in the *server's* computed
  `extra` to be present with an equal value in the *client payload's* `accepted.extra`.
  `ExactHederaScheme.enhancePaymentRequirements` merges the facilitator's declared
  `feePayer` into the server's requirements, so a client payload without a matching
  `feePayer` in `extra` fails to match and never reaches verify/settle — the existing
  `decodeHederaPayment`-only test never noticed because it calls `decodeHederaPayment`
  directly and never goes through `paymentMiddleware` at all. Fixed by adding a
  `feePayer` parameter (defaulting to the same `DEFAULT_FEE_PAYER` the fake
  facilitator declares) to `buildPaymentSignatureHeader`, with the requirements-match
  chain documented in a comment so the next person touching this fixture doesn't
  reintroduce it.
- Added `_mapSizesForTests()` to `hedera.ts` — a small, clearly-labeled test-only
  export (`{ payer: verifiedPayerByTxKey.size, receipt: receiptByTxKey.size }`) — to
  give the "both maps are empty afterwards" assertions something direct to check,
  rather than inferring emptiness indirectly.
- No facilitator-independent verify step needed stubbing: `ExactHederaScheme`
  (server, `@x402/hedera/exact/server`) only implements `parsePrice` /
  `enhancePaymentRequirements` / `getAssetDecimals`; verification itself is entirely
  delegated to whatever the facilitator's `/verify` HTTP endpoint returns (confirmed
  by reading its compiled source — no local Hedera SDK calls, mirror-node or
  otherwise, happen on the resource-server side of this scheme). The fake facilitator
  needed nothing beyond the configurable responses above.
- Three new tests, all sending a real header from `buildPaymentSignatureHeader()`
  against `POST /hedera/v1/scan`:
  1. Verify `{isValid:true, payer:"0.0.4242"}` + settle `{success:true, transaction:
     "0.0.4242@1700000000.000000001", payer:"0.0.4242"}` → 200 with a receipt;
     `onSettled` called exactly once with `(receipt, "0.0.4242@...")` — asserted
     `.toEqual(j.receipt)` for the receipt and `.toBe(SETTLED_TX)` for the tx id, and
     documented in the test why that tx id legitimately differs from
     `j.receipt.payment.txId` (the client-signed id, captured before settlement runs
     at all); `_mapSizesForTests()` → `{payer: 0, receipt: 0}`.
  2. Same verify, but settle `{success:false}` → `onSettled` never called;
     `_mapSizesForTests()` → `{payer: 0, receipt: 0}` (proving the new
     `onSettleFailure` hook, not `onAfterSettle`, did the cleanup).
  3. `hederaPayerFromRequest` prefers `"0.0.4242"` (the verify-hook payer) over
     `PAYER_ACCOUNT` (`"0.0.1234"`, what the transaction's own transfer list would
     decode to) — checked via a `data.scan` override that calls
     `hederaPayerFromRequest` with a minimal fake request object (just `.header()`)
     *during* the handler's own execution, the one window after verify has populated
     the map and before settle has had a chance to clear it.

### Commands and output

```
$ bun test packages/service/test/hedera-rail.test.ts
 13 pass
 0 fail
 38 expect() calls
Ran 13 tests across 1 file. [2.9s]

$ bun test packages/service   # x3 consecutive runs, no flakiness
 39 pass
 1 skip
 0 fail
 143 expect() calls
Ran 40 tests across 5 files.

$ bun test                    # whole workspace, no regressions
 114 pass
 1 skip
 0 fail
 344 expect() calls
Ran 115 tests across 19 files.

$ bun x tsc -p packages/service/tsconfig.json --noEmit
(no output, exit 0)
```

### Files changed (fix round 1)

- `packages/service/src/rails/hedera.ts` (modified — TTL-based expiring maps,
  `onSettleFailure` hook, `_mapSizesForTests` test-only export)
- `packages/service/test/hedera-rail.test.ts` (modified — configurable fake
  facilitator, `feePayer` fix in the payload fixture, three new paid-path tests)
