# Task 29 report: hardening the paid paths and verification chain

Branch `ws/hardening`, worktree `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening`, four commits on top of `main` (`cf5fdc1`).

```
82af33a Make the verify gate verify, pin the Substreams import, guard demo.sh
d15900c Cap what the dashboard can spend, and verify the key behind a receipt
4369637 Stop the agent paying whatever the 402 demands
4f7392c Harden core primitives and the service's paid paths
```

Every numbered finding below has at least one test that was confirmed to fail with the fix reverted and pass with it restored; the reverted-run output is quoted per finding.

---

## 1. Dashboard paid scan could drain the operator wallet; rate limit forgeable

**What changed**

- **New** `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening/packages/dashboard/lib/spend.ts`. `SpendLedger` with the brief's interface (`canSpend(microUsd)`, `record(microUsd)`, `snapshot()` returning `{ spentMicroUsd, capMicroUsd, windowStartedAt, ... }`) plus a `refuse(microUsd)` sibling that returns *why*, the route needs the distinction to render a usable sentence, and `canSpend` is the boolean wrapper over it. Rolling 24 h aggregate cap from `DASHBOARD_SPEND_CAP_USD` (default `1.00`) and a global rolling-hour scan allowance from `DASHBOARD_MAX_SCANS_PER_HOUR` (default `20`). An unparseable or non-positive limit falls back to the documented default, never to "no limit".
- `packages/dashboard/lib/scan.ts`: the ledger is checked at step 5, before payment and before the per-client limiter, and recorded after the purchase at the **receipt's** price (falling back to the quote when the receipt has none). A failure after the request went out also records the quote, so a rail that fails while charging is still metered. Refusals are `429` with a machine-readable code.
- `packages/dashboard/lib/scan.ts`: optional `SCAN_ACCESS_TOKEN` bearer gate, checked ahead of everything else (so an unauthenticated caller cannot even probe whether the deployment has payment keys). Constant-time compare over equal-length strings; the token never reaches a response or a log line.
- `packages/dashboard/lib/ratelimit.ts`: `clientKey(req, env)` believes `x-forwarded-for` / `x-real-ip` only when `TRUST_PROXY=1`. Next.js hands a route handler a `Request` with no socket address, so without the flag there is no per-caller identity at all and everyone shares the `"unknown"` bucket. The module comment that named the agent policy budget "the real spending backstop" is corrected in place: that budget caps one purchase, and the aggregate limits are what bound the bill.
- `packages/dashboard/app/portfolio/page.tsx` renders the snapshot ("Spent today: X of Y USD", "Scans this hour: N of M") from the same process-wide ledger the route uses. `ScanForm.tsx` turns the two new 429 codes into sentences and handles 401.
- `.env.example` documents `DASHBOARD_SPEND_CAP_USD`, `DASHBOARD_MAX_SCANS_PER_HOUR`, `SCAN_ACCESS_TOKEN`, `TRUST_PROXY`.

**Covering tests**, `packages/dashboard/test/spend.test.ts` (11 tests: defaults, env parsing, bad-value fallback, inclusive cap, rolling windows, scan allowance independent of price, ordering of the two refusals, unpriceable purchases still counted, snapshot shape, pruning) and in `packages/dashboard/test/scan.test.ts`: `429 spend_cap_24h ...`, `429 scan_rate_1h ... whatever the client key is`, `the ledger records the receipt's price, not the quote`, `a refusal before payment does not touch the ledger`, the five access-token tests, `without TRUST_PROXY a forged x-forwarded-for buys no second window`. In `ratelimit.test.ts`: `without TRUST_PROXY every caller shares one bucket ...` (drives a hundred forged addresses through the limiter and asserts one allowed call) and `TRUST_PROXY is only honoured as exactly "1" ...`.

**Reverted-fix run** (ledger check, token gate and trust-proxy guard removed):

```
(fail) without TRUST_PROXY every caller shares one bucket, so a forged header buys no extra window
(fail) TRUST_PROXY is only honoured as exactly "1", with surrounding whitespace tolerated
(fail) without TRUST_PROXY a forged x-forwarded-for buys no second window
(fail) 429 spend_cap_24h when the purchase would take the rolling total past the cap, before paying
(fail) 429 scan_rate_1h once the global hourly allowance is used up, whatever the client key is
(fail) with SCAN_ACCESS_TOKEN set, a request without a matching bearer token is 401 and spends nothing
(fail) the access check runs before the keys check, so an unauthenticated caller learns nothing about this deploy
```

---

## 2. Clear-mode scans bypassed per-vault pricing

**What changed**

- `packages/service/src/handlers/scan.ts`: for the scan tier in clear mode, `clampCount(X-VR-Count)` must equal `vaults.length` or the request is `422 count_mismatch`, returned before the `DataProvider` call. Gated on `!sealedIn`, so the sealed branch keeps exactly its previous semantics (it already compares the envelope's own count, and skips when there is no usable header).
- `packages/service/src/rails/arc.ts`: `preValidateClearCount(tier)` mounted between `preValidateSealed` and `gateway.require`, because Circle settles inside `gateway.require` and a handler-level refusal would land after the money moved. Guards the read with `Array.isArray` exactly as `checkSealedRequestPrePayment` does, so a clear body with a non-array `vaults` still reaches the handler's own `bad_vaults` rather than being relabelled.
- On Hedera `@x402/express` settles only after a 2xx, so the handler's 422 is itself pre-settlement; the test asserts that by checking the facilitator's settle count stays at zero after a successful verify.

**Covering tests**, `packages/service/test/handlers.test.ts`: `a clear scan body whose count disagrees with X-VR-Count returns 422 count_mismatch, before any DataProvider call` (also covers a missing/0/non-numeric/101 header, and that the matching case still reaches the provider), plus `the count rule does not touch the table tier` and `a sealed request is unaffected by the clear-mode count rule`. `arc-rail.test.ts`: `a clear scan body whose vault count disagrees ... before any facilitator call` (zero `supported`/`verify`/`settle` calls), `... count matches ... still reaches the facilitator`, `a clear table body is unaffected`. `hedera-rail.test.ts`: `... is refused 422 count_mismatch, and never settles` (verify 1, settle 0) and the matching control.

**Reverted-fix run** (both the handler check and the Arc middleware removed):

```
(fail) a clear scan body whose count disagrees with X-VR-Count returns 422 count_mismatch, before any DataProvider call
(fail) a clear scan body whose vault count disagrees with X-VR-Count is rejected 422 count_mismatch before any facilitator call
(fail) a clear scan body whose vault count disagrees with X-VR-Count is refused 422 count_mismatch, and never settles
```

**Note on existing tests.** Three `handlers.test.ts` tests posted clear scan bodies with no `X-VR-Count` and now need one, and two `arc-rail.test.ts` fixtures used `{ vaults: [] }` with `X-VR-Count: 1`. Both mounted rails reject a missing or invalid count with a 400 *before* the handler, so in production the header is always present there; those tests mount the handler bare (or stop at the 402) and now supply a consistent header. The Hedera clear-mode tests are placed last in their file on purpose, with a comment: the mismatch test verifies a payment the request then refuses, so no settle hook fires and its entry sits in `verifiedPayerByTxKey` until the 10-minute TTL, the documented abandoned-request case, which would otherwise break the earlier `_mapSizesForTests()` assertions.

---

## 3. Agent paid whatever the 402 demanded

**What changed**

- `packages/agent/src/rails/hedera.ts`: `quoteCeilingPolicy(quote)` returns a `PaymentPolicy` (the type `@x402/fetch` re-exports from `@x402/core/client`) registered on the `x402Client`. It throws, naming the demanded amount, the quote and the ceiling, when any requirement's atomic amount exceeds the quote by more than `QUOTE_TOLERANCE_BPS` (100 bps). Throwing rather than filtering to `[]` is deliberate: an empty filter result makes `@x402/core` raise `All payment requirements were filtered out by policies`, which says nothing about amounts. `maxAcceptableAtomic` is exported so the post-payment check applies the identical bound.
- `packages/agent/src/client.ts`: `quoteAtomicFor(rail, tier, count)` derives the expected atomic amount from the same `@vaultradar/core` price functions the service prices with, and is handed to `payingFetchHedera` through a `QuoteSource`, because `@x402/core`'s policy signature is `(version, requirements)` and gets no handle on the request. Set immediately before the paying fetch and cleared in a `finally`.
- `packages/agent/src/client.ts`: `checkSettledPrice` reads the price off the signed receipt (atomic on Hedera, the USD decimal string on Arc, the two rails genuinely write different units) and, on Arc, also Circle's own `PayResult.amount`, and compares both to the quote within the same band. A disagreement sets `receiptValid = false`. `PaidResult.priceUsd` now comes from the receipt.
- `packages/agent/policy.strict.json` created: the strict-tier example policy `scripts/demo.sh` step 4 already referenced but which did not exist.

**Covering tests**, `packages/agent/test/client.test.ts`: `the quote ceiling policy refuses any requirement above the quote, and bounds nothing without one`; `the paying fetch registers the quote ceiling, so an over-quote 402 never reaches the signer` (end to end through `payingFetchHedera` with a real constructed signer against a fake 402, asserting exactly one request reached the server, i.e. the paid retry never happened); `a receipt whose price does not match the quote fails receiptValid, and priceUsd comes from the receipt`; `on the arc rail both the receipt's price and the Gateway's reported amount are checked against the quote`. `packages/agent/test/policy.test.ts` asserts `policy.strict.json` loads and that `chooseTier` returns the table tier for it.

**Reverted-fix runs:**

```
# policy registration removed
(fail) the paying fetch registers the quote ceiling, so an over-quote 402 never reaches the signer
# receipt-price binding and priceUsd source reverted
(fail) a receipt whose price does not match the quote fails receiptValid, and priceUsd comes from the receipt
(fail) on the arc rail both the receipt's price and the Gateway's reported amount are checked against the quote
```

**Correction to the brief's framing.** The brief described the agent as paying "whatever the 402 demands". `@x402/core` applies its own default spend control (`$1` per payment, `DEFAULT_MAX_AMOUNT_PER_PAYMENT`) *before* policies, so amounts above a dollar were already refused, with an error about spend controls, not about the quote. The real exposure was everything up to `$1`: six hundred times a one-vault scan and sixteen times the table price. The end-to-end test deliberately demands `$0.90` so the quote ceiling, not the built-in control, is what refuses it; the source comment states this.

**Two judgement calls worth flagging.** The post-payment band is closed on both sides, a receipt that *understates* the price also fails. The agent and service compute prices from the same constants, so an understated price is not a cheaper purchase but a receipt that does not describe this one, and `priceUsd` is cited in run records. And the in-flight quote lives in a field on the client, which two *concurrent* `paid()` calls on one client would race on; nothing in this package does that (the watch loop and the dashboard route are strictly sequential) and the field's doc comment says so.

---

## 4. `checkSig` ignored `sig.pub_hash`; `/verify` trusted a fresh key

**What changed**

- `packages/core/src/pq/sign.ts`: `checkSig` additionally requires `sig.pub_hash === sha256Hex(publicKey)`. Before this, `pub_hash` was free text nothing verified, while being the field every consumer compares against an independent pin, so a service could sign with key A and label the signature with the hash of key B, and a caller verifying against A while comparing `pub_hash` to an on-chain pin of B reported both "signature valid" and "key binding matches" for a receipt the pinned key never signed. `verifyReceipt` and `verifyAttestation` route through `checkSig`, so both inherit the binding.
- `packages/dashboard/app/verify/page.tsx`: verifies the card's own signature with `checkSig`; recomputes `sha256Hex(publicKey)` from the shipped key rather than trusting the card's label, and requires both the card's and the receipt's `pub_hash` to equal it; and when the card lists ERC-8004 ids, reads `pq.sig.pubhash` on chain and renders "on-chain anchor: matches / mismatch / unavailable" per identity. `isVerified` requires all of it. The page's privacy copy is corrected: the receipt still never leaves the browser, but the browser now also makes a read-only RPC call.
- **New** `packages/dashboard/lib/onchain.ts`: registry address `0x8004A818BFB912233c491871b3d84c89A494BD9e`, `getMetadata(uint256,string)`, `https://testnet.hashio.io/api` for 296 and `https://rpc.testnet.arc.io` for 5042002, the agent's `decodePqHash` strictness (`TextDecoder` with `fatal: true`, 64-char lowercase hex only), and `checkAnchor` with an injectable reader. `viem` added to the dashboard's dependencies.

**Covering tests**, `packages/core/test/pq-sign.test.ts`: `checkSig binds sig.pub_hash to the verifying key, so a mislabelled signature fails` (asserts the underlying ML-DSA signature is still *good* and the object still fails). `packages/dashboard/test/onchain.test.ts`: six tests, including one that asserts every constant and the ABI equal the agent's imported counterparts, that is the seam that stops the two readers drifting. `packages/dashboard/test/verify.test.ts`: five tests over `isVerified` plus the freshly-fetched-key attack spelled out with real keys.

**Reverted-fix run:**

```
(fail) checkSig binds sig.pub_hash to the verifying key, so a mislabelled signature fails
```

**Why the read is restated rather than imported.** `/verify` is a client component, and `@vaultradar/agent`'s barrel exports `./tools` (Claude Agent SDK) and both x402 rails; its `exports` map offers no deep path. The constant-equality test is what holds the duplicate honest.

---

## 5. Post-payment failure discarded the run

**What changed**, `packages/dashboard/lib/scan.ts` returned 502 from the `client.scan` catch with nothing saved. It now builds a run record and persists it first. `RunRecord` has no "this attempt failed" field and inventing one would break the cross-package contract in `lib/types.ts`, so the failure is recorded in the shape's own vocabulary: `requests: []` (itself the signal that nothing verifiable came back) and one `insufficient data` decision per vault asked about, carrying the redacted reason. `citations.txId` holds a payment reference when one is known; in this path the client throws before any response is read, so it is `null`. The two verification-failure 502s already saved a run with the real tx id; their message now reads "the service's receipt did not verify" rather than naming only the signature, since a price disagreement now also fails `receiptValid`.

**Covering test**, `packages/dashboard/test/scan.test.ts`: `a post-payment failure still writes a run, with the reason as an insufficient-data decision` (checks the record's shape, the decisions, and that the key is redacted out of the *persisted* file as well as the response) and `a failure after payment is charged to the ledger`.

**Reverted-fix run:**

```
(fail) a post-payment failure still writes a run, with the reason as an insufficient-data decision
(fail) a failure after payment is charged to the ledger, so a rail that fails while charging is still capped
```

---

## 6. Verify gate populated instead of verifying

**What changed**, `scripts/verify-deployments.ts` set `deploymentId: data._meta.deployment` on every deployment on every run, overwriting whatever the registry pinned. A publisher rolling a new subgraph version silently moved this repo onto it, with no diff beyond a changed hash, and `gatewayUrl` then read the new deployment as though it had always been pinned. Now: `reconcile` writes a pin only when there is none; an agreeing pin is a normal verification; a disagreeing pin is `status: "repointed"` with `deploymentId` untouched and both ids named in the line. `summarize` prints counts per status and names every repointed deployment. The script is restructured behind `import.meta.main` with `verifyAll(deployments, query, now)` taking an injectable `QueryMeta`, so the gate is unit-testable without the gateway or an API key. `Deployment["status"]` in `packages/core/src/standardized/types.ts` gains `"repointed"`; the service's `Catalog.protocols[].status` is already `string`, and the dashboard's `CatalogEntry` union is widened to match. A repointed deployment is still queried (`fetchStandardized` filters only `"down"`), which is correct, queries go to the pinned deployment, which is the point of pinning.

**Covering test**, **new** `scripts/verify-deployments.test.ts`, seven tests with a fake gateway: agreeing pin, disagreeing pin (asserts `deploymentId` is unchanged and both ids appear in the note), absent pin as the only write case, lag/indexing-error status, unreachable deployment, a whole four-deployment registry through `verifyAll`, and the summary's one-line form.

**Reverted-fix run** (old overwrite behaviour restored):

```
(fail) a pinned id that disagrees is reported as repointed, and the pin is NOT overwritten
(fail) an absent pin is the only case the gate writes one
(fail) status follows the indexing lag, and indexing errors are down regardless of lag
(fail) verifyAll runs the whole registry against a fake gateway and never rewrites a pin
```

---

## 7. Pricing and Messari page size

**What changed**, `TABLE_PRICE_USD = "0.06"` in `packages/core/src/pricing.ts`. The spec says `table` is never cheaper than a sealed `scan`, but `hederaScanPriceUsd(100)` is `0.051`, so at `0.03` the premium inverted above 58 vaults and whole-protocol data was the cheaper buy. Messari page size `50 → 200`, exported as `PAGE_SIZE` from `packages/core/src/standardized/gateway.ts` and passed explicitly by `fetchStandardized`; at 50 a vault outside the first page read as "not found" rather than as data.

Dependent constants updated: `packages/service/test/hedera-rail.test.ts` (atomic `30000 → 60000`), `packages/agent/test/tools.test.ts` (four quote assertions), `packages/agent/test/watch.test.ts` (`priceUsd`, the two-table total, and the three-chain budget refusal `0.09 → 0.18`), `README.md` §privacy tiers, `skills/vaultradar/SKILL.md` (both table rows plus the premium sentence), `scripts/demo.sh` step 4 prose, and `docs/superpowers/specs/2026-09-05-vaultradar-design.md` §5.5 with a dated amendment note explaining the inversion. `packages/dashboard/public/demo-run.json` is left at `0.03`: it is a record of a past (simulated) purchase whose receipt is signed over that amount, and rewriting it would make the fixture internally inconsistent.

**Covering test**, `packages/core/test/pricing.test.ts`: `the table tier is never cheaper than a scan, at any count the service will price`, the brief's property at `MAX_SCAN`, then over every count 1..100, then for all three Arc buckets, compared in integer micro-USD.

**Reverted-fix run** (`TABLE_PRICE_USD` back to `0.03`):

```
(fail) the table tier is never cheaper than a scan, at any count the service will price
```

---

## 8. The small ones

| Item | What changed | Covering test |
|---|---|---|
| `policy.strict.json` | Created, `privacy: "strict"` | `policy.test.ts` asserts it loads and selects the table tier |
| `demo.sh` VAULTS guard | `case` on empty or `<<FILL`, exits 1 with the ids-to-use commands | `bash -n` clean; both cases verified to exit 1 |
| `lib/service.ts` timeout | 10 s `AbortController` (`SERVICE_FETCH_TIMEOUT_MS`); an abort is indistinguishable from any other unreachable-service failure. The three fetchers take an optional `timeoutMs` so the abort path is drivable | `test/service-timeout.test.ts`, 4 tests, including three abandoned requests against a server that answers none |
| `HcsQueue.done` cap | `DONE_MAX = 10_000`, oldest evicted, resubmits do not double-count; injectable `doneMax` so eviction is driven without 10 002 signatures | `hcs.test.ts`: the under-cap test and `the cap evicts the oldest confirmed entry ...` |
| HCS rotation | A message failing `MAX_CONSECUTIVE_FAILURES = 5` submits in a row moves to the back (only when something is behind it); `rotated` counted in `stats()` | `hcs.test.ts`: `a receipt that fails MAX_CONSECUTIVE_FAILURES submits moves to the back ...` and `a lone failing receipt is retried in place and never counted as rotated` |
| Pinax pin | Both manifests pinned to `970a665e15619de8ad7f686bd89412a1030d46dc` (from `git ls-remote`), URL verified `200`, refresh procedure documented | YAML parse check plus a `curl -I` returning 200 |
| DEMO prefers real runs | `listRunFiles` no longer short-circuits on `DEMO=1` | `runs-dir.test.ts`: `DEMO=1 no longer hides real runs ...` and `an empty runs directory still falls back to the bundled demo run, in either mode` |

**Reverted-fix runs** for the timeout, the HCS pair and DEMO:

```
(fail) a service that accepts the connection and never answers is abandoned, not waited on
(fail) DEMO=1 no longer hides real runs, so a purchase this deployment made is never replaced by the fixture
(fail) the cap evicts the oldest confirmed entry, which then falls back to the mirror node
(fail) a receipt that fails MAX_CONSECUTIVE_FAILURES submits moves to the back, so the queue keeps draining
```

---

## Commands and output

Run before each commit, and again on the final tree:

```
$ bun test
 388 pass
 1 skip
 0 fail
 1721 expect() calls
Ran 389 tests across 40 files. [10.56s]

$ bun run typecheck
$ bun x tsc -p packages/core/tsconfig.json --noEmit && bun x tsc -p packages/service/tsconfig.json --noEmit && bun x tsc -p packages/agent/tsconfig.json --noEmit
(no output)

$ bun run --cwd packages/dashboard build
✓ Compiled successfully
Turbopack build encountered 4 warnings:   # same 4 as main (dynamic fs access in lib/runs.ts); verified by running the build on the main checkout

$ bun run --cwd packages/dashboard lint
$ eslint
(no output)
```

The one skipped test is the pre-existing env-gated live Hedera rail test.

One build error was found and fixed along the way: the dashboard type-checks `packages/agent`'s source directly against Next.js's ES2017 target, which rejects BigInt literals. `QUOTE_TOLERANCE_BPS` is written `BigInt(100)` rather than `100n`, with the reason in a comment.

## Files changed

Created:

- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening/packages/dashboard/lib/spend.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening/packages/dashboard/lib/onchain.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening/packages/agent/policy.strict.json`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening/packages/dashboard/test/spend.test.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening/packages/dashboard/test/onchain.test.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening/packages/dashboard/test/verify.test.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening/packages/dashboard/test/service-timeout.test.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening/scripts/verify-deployments.test.ts`

Modified: `packages/core/src/{pricing.ts,pq/sign.ts,standardized/{gateway.ts,index.ts,types.ts}}`, `packages/core/test/{pricing,pq-sign}.test.ts`, `packages/service/src/{handlers/scan.ts,hcs.ts,rails/arc.ts}`, `packages/service/test/{handlers,arc-rail,hedera-rail,hcs}.test.ts`, `packages/agent/src/{client.ts,rails/hedera.ts}`, `packages/agent/test/{client,policy,tools,watch}.test.ts`, `packages/dashboard/{lib/{ratelimit,runs,scan,service}.ts,app/verify/page.tsx,app/portfolio/{page.tsx,ScanForm.tsx},package.json,README.md}`, `packages/dashboard/test/{ratelimit,scan,runs-dir}.test.ts`, `scripts/{demo.sh,verify-deployments.ts}`, `substreams/erc4626-vault-metrics/substreams{,.base}.yaml`, `.env.example`, `README.md`, `skills/vaultradar/SKILL.md`, `docs/superpowers/specs/2026-09-05-vaultradar-design.md`, `bun.lock`.

## Self-review

- Every numbered finding has a test that fails without its fix; each reverted-fix run is quoted above, and the tree was restored and re-verified green after each.
- §13.1's admin metrics response shape is unchanged. `metrics.ts` reads four named fields off `HcsSink.stats()`, so the new `rotated` counter does not reach the endpoint; `rotated` is optional on the interface so existing fakes still satisfy it. `packages/service/test/metrics.test.ts`'s exact-shape assertion on `snap.hcs` still passes untouched.
- No key or token is logged or returned. The access-token comparison never echoes the token; a 401 body is `{ "error": "unauthorized" }`. The failed-run record goes through `redact` before being written, and the test asserts the key is absent from the persisted file.
- Behaviour outside the list: the clear-mode count rule is gated on `!sealedIn`, so sealed requests are untouched (pinned by its own test). Five existing service tests had internally inconsistent fixtures (a clear scan body with no or a disagreeing `X-VR-Count`) and were made consistent rather than the rule weakened; both mounted rails 400 a missing count before the handler, so production never relied on the old leniency.

## Concerns

1. **`DEMO=1` is now advisory.** Making real runs win leaves the flag with no remaining effect: the demo-run fallback already applied with `DEMO` unset. I implemented the brief's literal requirement and corrected `packages/dashboard/README.md`'s row (one line, outside the brief's file list, but it stated the opposite of the code). The honest alternative is to make `DEMO=1` the *only* thing that enables the fallback, which would give the flag a real job at the cost of changing what a local dev with no runs sees. That is a product call, not mine.
2. **The tx id on a pre-receipt failure is null.** `VaultRadarClient.paid` computes `txIdFromResponse(res)` and then throws on a non-200, discarding it. Surfacing it would mean attaching it to the thrown error, changing the agent's error shape, more than this finding asked for. The run record's `citations.txId` is therefore `null` in that path; the verification-failure paths carry the real id.
3. **Arc's `payer_mismatch` is still caught after settlement.** Pre-existing and documented in `rails/arc.ts`; the count rule I added closes the underpricing hole ahead of payment, but the payer check genuinely cannot run before Circle settles.
4. **Two files were created beyond the brief's list.** `packages/dashboard/lib/onchain.ts` (so the `/verify` on-chain read is unit-testable rather than buried in a client component) and `scripts/verify-deployments.test.ts` (the brief asked for the test but named no path). `viem` was added to `packages/dashboard/package.json` because the page needs it; the lockfile diff is one line.
5. **The spec was edited.** `docs/superpowers/specs/...` §5.5 said `$0.03`; leaving it would have contradicted the shipped price. The line now reads `$0.06` with a dated amendment note. The historical plan under `docs/superpowers/plans/` is untouched.
6. **Four Turbopack warnings remain** in the dashboard build, about dynamic filesystem access in `lib/runs.ts`. Verified identical on `main`, so not a regression, but they mean the deployed server bundle traces the whole project.

---

# Fix round 1

Commit `96a0074` on `ws/hardening`, addressing the five Important findings from review. As before, each fix has a test confirmed to fail with the fix reverted; the reverted-run output is quoted per finding.

## 1. Aggregate spend caps fell to a concurrent burst

**The finding, restated.** `lib/scan.ts` called `deps.ledger.refuse(quoteMicro)`, then awaited a quote, a discovery round trip and a payment, and only then called `record`. Requests arriving together each observed the ledger before any of them had written to it, so each passed and each paid. A cap reading "1.00 USD" admitted as many purchases as arrived in one burst, the limit held only against sequential callers, which is not the threat.

**What changed.** `SpendLedger` now issues reservations instead of being checked and credited separately:

- `reserve(microUsd)` returns `{ ok: true, id }` or `{ ok: false, refusal }`. The check and the insert happen in one synchronous body with no `await` between them, so a concurrent caller cannot observe the ledger in between, JavaScript runs one turn at a time, and the hold is already counted by the time anyone else looks. The hourly scan allowance is reserved by the same insert, so a burst cannot get past the count either.
- `settle(id, microUsd)` replaces the held amount with what was spent, keeping the entry's place in both windows. A settled amount is allowed to exceed the cap: the purchase already happened, and the ledger's job is then to report the truth and refuse the next one.
- `release(id)` removes the entry entirely, amount and scan slot both, for a purchase that provably never happened.
- `refuse` / `canSpend` remain as read-only queries, and `record` remains as reserve-and-settle in one step for a caller with nothing to adjust.

In the route, the reservation is taken where the check used to be, and everything from there to the response is wrapped in a `try { ... } finally { if (!settled) release(...) }`. Every early exit after the reservation, the rate-limit 429, an unreachable service, an unsigned card, a substituted on-chain key, releases. The one path whose outcome is genuinely unknown, a throw out of `client.scan`, settles at the quote instead, because an unsettled payment must stay counted. The settle for a successful purchase is the first statement after `client.scan` returns, so nothing can throw between the payment and the booking.

**Covering tests**, `packages/dashboard/test/scan.test.ts`: `two concurrent requests against a cap that admits one: exactly one pays` (both fired through `Promise.all`, asserting the status pair `[200, 429]`, one run file, and one scan's allowance consumed) and `a burst of ten against a two-scan allowance pays exactly twice`. Release coverage: `a reservation is released when the purchase is refused after it, so a failed discovery costs nothing` and `a reservation is released when the rate limiter refuses, and when the card cannot be verified`. Ledger-level: seven new tests in `packages/dashboard/test/spend.test.ts` (synchronous hold visible before settle, the scan allowance reserved the same way, settle keeping the window position, a settled amount allowed past the cap, release returning both the amount and the slot, no-op release, distinct ids).

**Reverted-fix run** (back to `refuse` then `record`):

```
(fail) two concurrent requests against a cap that admits one: exactly one pays
(fail) a burst of ten against a two-scan allowance pays exactly twice
```

## 2. The client key was an entry the caller picks on an appending proxy

**What changed.** `TRUSTED_PROXY_HOPS` (default 1), and `clientKey` now takes the entry that many positions from the **end** of `x-forwarded-for` rather than the first. A list shorter than the configured hop count cannot have come from that chain, so it yields the shared `"unknown"` bucket rather than a guess. `x-real-ip` is still the fallback when there is no usable `x-forwarded-for`, unchanged.

One is correct for both documented hosts, for different reasons, and both are now written down in `.env.example` and the dashboard README:

| Host | `x-forwarded-for` behaviour | Why the last entry is the trustworthy one |
|---|---|---|
| Fly.io | appends the peer address it observed | a client sending `1.1.1.1` produces `1.1.1.1, <real client>`; the prefix is the client's invention |
| Vercel | replaces the header with the address it observed | there is one entry and it is Vercel's |

Raise the value only when another appending proxy of your own sits in front of that one.

**Covering tests**, `packages/dashboard/test/ratelimit.test.ts`: `clientKey takes the entry TRUSTED_PROXY_HOPS from the END, which is the one a caller cannot write` (including hops 2, 3 and an over-configured 4 → `"unknown"`); `both real proxy shapes key on the client: Fly appends, Vercel replaces` (asserts a caller varying its forged prefix gets the *same* key, and that the default works identically for both shapes); `TRUSTED_PROXY_HOPS defaults to 1 and falls back to it for any unusable value`.

**Reverted-fix run** (first entry again):

```
(fail) clientKey takes the entry TRUSTED_PROXY_HOPS from the END, which is the one a caller cannot write
(fail) both real proxy shapes key on the client: Fly appends, Vercel replaces
```

## 3. The ledger recorded a number the payee controls

**What changed.** New exported `chargedMicroUsd(quoteMicro, receiptPriceUsd)` in `lib/scan.ts` returns `Math.max(quoteMicro, usdToMicro(receiptPriceUsd))`, falling back to the quote when the receipt has no price or an unreadable one. A figure *above* the quote is still believed: that is the service stating it charged more, which a spending cap should accept.

The hole this closes: the receipt's price is the payee's own statement, so a service answering every purchase with `price: "0"` consumed no allowance at all while still being paid the quote, the cap was off. The agent does mark such a receipt `receiptValid: false`, but only after the money moved, so the ledger cannot wait for that verdict.

**Covering tests**, `packages/dashboard/test/scan.test.ts`: `the ledger records at least the quote, so a payee cannot charge the cap nothing` (the real purchase plus `chargedMicroUsd` over `"0"`, `"0.000001"`, the quote, an above-quote price, `null`, `""`, `"free"`, `"NaN"`), and an end-to-end `a service that under-reports its price still consumes the quoted allowance` that wraps the client so every receipt claims `"0"` and shows the third purchase refused on a cap of three scans' worth.

**Reverted-fix run** (taking the receipt's price verbatim):

```
(fail) the ledger records at least the quote, so a payee cannot charge the cap nothing
(fail) a service that under-reports its price still consumes the quoted allowance
```

## 4. `/verify` read identities from the unsigned card, and an empty list read as verified

**What changed.** The identities checked on chain now come from `receipt.service.erc8004`, inside the signed body, so `checkSig` covers them and an impostor can neither remove one without breaking the signature nor add one without the card agreeing. They are cross-checked against the live card's own list (`identitiesInCard`), because a receipt naming an identity the key's publisher does not claim is two parties disagreeing about who the service is. An empty list is now **UNPROVEN**, never "Verified.": there is nothing anchoring the key, which was exactly the shape an impostor could choose by serving a card with no `erc8004`. The on-chain comparison is against `sha256Hex(publicKey)` computed from the shipped key rather than the card's own label.

A new exported `headline(result)` names the first check that failed, so the page says "the agent card does not carry a valid signature of its own" or "the receipt claims no on-chain identity" rather than one generic refusal, and the page's intro copy now states that a receipt naming no identity cannot be verified.

**Covering tests**, `packages/dashboard/test/verify.test.ts`: `all five conditions together are what reads as verified`; `each condition on its own is enough to refuse, and the headline names which`; `a receipt that claims no on-chain identity is UNPROVEN, never Verified`; `one bad anchor among several is enough` (mismatch and unavailable); `the identities checked are the receipt's signed ones, which a card cannot shrink` (asserts stripping `service.erc8004` breaks the real ML-DSA signature, and drives the card cross-check both ways).

**Reverted-fix run** (empty anchors treated as verified again):

```
(fail) each condition on its own is enough to refuse, and the headline names which
(fail) a receipt that claims no on-chain identity is UNPROVEN, never Verified
```

## 5. The repoint comparison was inert in production

**What changed.** `queryDeployment` builds its URL with `gatewayUrl`, which prefers `deploymentId`, so the gate was asking `/deployments/id/<pin>`, an address for one immutable deployment, whose `_meta.deployment` is the pin restated. The comparison could only ever be equal, against the very thing it was added to detect.

`QueryMeta` now takes an `Endpoint` (`"pinned" | "subgraph"`), and `verifyAll` asks both for every pinned deployment: the pinned URL for the head lag and indexing errors (the deployment the service actually reads), and `/subgraphs/id/<subgraphId>` for what the publisher currently points that subgraph at. `reconcile(existing, pinned, serving, now)` compares `serving` to the pin, never `pinned.deployment`, and the doc comment says why. The subgraph query is caught separately so its failure cannot turn a healthy deployment `down`; it reports `repoint check unavailable` in the line, because silence there would read as agreement. The real query gets the subgraph URL by handing `queryDeployment` the same deployment with the pin blanked, so `gatewayUrl` stays the single place that knows the gateway's shape; `endpointsFor(d)` exposes both URLs and is asserted in the test.

**Covering tests**, `scripts/verify-deployments.test.ts`: `the two endpoints are the pinned deployment and the subgraph, and they are different URLs`; `a pin the subgraph no longer resolves to is reported as repointed, and NOT overwritten`; `the comparison is against the subgraph's answer, never the pinned query's own echo` (the pinned query echoes the pin, as in production, and the subgraph disagrees → `repointed`); `a repoint check that could not run says so, rather than reading as agreement`. `verifyAll` now runs a five-deployment registry through a fake gateway that serves **both** endpoints the way the real one does, and asserts which endpoints were asked for which deployment.

**Reverted-fix run** (comparing against the pinned query's echo):

```
(fail) verifyAll runs the whole registry against a fake gateway and never rewrites a pin
```

## Commands and output

```
$ bun test
 407 pass
 1 skip
 0 fail
 1826 expect() calls
Ran 408 tests across 40 files. [11.69s]

$ bun run typecheck
(no output)

$ bun x tsc -p packages/dashboard/tsconfig.json --noEmit
(no output)

$ bun run --cwd packages/dashboard build
✓ Compiled successfully
Turbopack build encountered 4 warnings:   # unchanged, same 4 as main

$ bun run --cwd packages/dashboard lint
$ eslint
(no output)
```

Nineteen tests added this round (388 → 407 passing).

## Files changed

`packages/dashboard/lib/{spend,scan,ratelimit}.ts`, `packages/dashboard/app/verify/page.tsx`, `packages/dashboard/test/{spend,scan,ratelimit,verify}.test.ts`, `scripts/verify-deployments.ts`, `scripts/verify-deployments.test.ts`, `.env.example`, `packages/dashboard/README.md`.

## Concerns

1. **The reservation is per process, like the rest of the ledger.** It closes the concurrency hole within one Next.js server, which is where the hole was. Two instances behind a load balancer still each hold their own budget, so the effective cap is the configured one times the instance count, the same caveat the ledger has always carried and which `/portfolio` states. A shared cap needs shared storage, which is out of scope here.
2. **`release` trusts the route's own control flow.** The `finally` covers every exit from the reservation onward, including an unexpected throw, and a throw can only come from code that runs before `client.scan`, but the correctness of "this path did not pay" is an argument about the code, not something a type enforces. The settle-at-quote on the unknown path is the fail-safe direction.
3. **Finding 4 makes an unanchored service unverifiable, by design.** A receipt from a service with no ERC-8004 registration now reads UNPROVEN rather than "Verified." That is the right answer, nothing anchors the key, but it means `/verify` cannot return a green verdict against a service that has not run `scripts/identity.ts`. Worth knowing before a demo.
4. **The subgraph endpoint doubles the gate's query count** and needs the same `GRAPH_STUDIO_API_KEY` quota. For a registry of this size that is immaterial, but the gate now makes two calls per pinned deployment rather than one.

## Addendum: two folded minors

Commit `ae54a8d`, same round.

### 6. Arc had no pre-payment ceiling

**The finding.** `payArc` handed the 402's demanded amount straight to Circle's `GatewayClient`, which signed an EIP-3009 authorization for it. The only check was `client.ts`'s post-payment receipt comparison, and on this rail Circle settles inside `gateway.require`, before any handler runs, so "afterwards" is after the money moved. Worse than Hedera before fix round 1: that rail at least had @x402/core's default `$1` spend control behind it, and Circle's client has no equivalent, so an Arc payment had no ceiling whatsoever.

**What changed.** `arcQuoteCeilingHook(quoteAtomic)` returns a hook for Circle's own `onBeforePaymentCreation`. It fires inside `createPaymentPayload`, and a returned `{ abort: true, reason }` makes `pay()` throw `Payment creation aborted: <reason>` before the authorization is built or signed (traced in `@circle-fin/x402-batching` 3.4.0's compiled `dist/client/index.js`, lines 177-186). `payArc` takes the expected atomic amount as a new argument and registers the hook when one is given; a fresh `GatewayClient` per call makes that straightforward, with no mutable field of the kind the Hedera policy needs. `payArcWith` is the same logic with the client injected, so the refusal is testable without a Gateway wallet. `client.ts`'s `arcPay` signature gains the quote and passes the request's own.

The band and the wording moved to **new** `packages/agent/src/rails/quote.ts`: `QUOTE_TOLERANCE_BPS`, `maxAcceptableAtomic`, and `overQuoteReason(demanded, quote)`. Three places now share one rule, the Hedera policy, the Arc hook, and the post-payment receipt check, because three nearly equal comparisons drift into a payment one rail refuses and the other pays. `rails/hedera.ts` re-exports the three names, so the package's public surface is unchanged.

**Covering tests**, `packages/agent/test/client.test.ts`: `on Arc the quote ceiling refuses an over-quote 402 through Circle's own pre-signing hook` (a stub that fires the registered hook exactly where Circle does; asserts the bucket price and the top of the band are signed, that one unit above is refused with both numbers in the message and `signed` still false, and that no quote means no hook); `the Arc hook and the Hedera policy refuse on the same band, with the same wording`; `the Arc client passes the request's quote into the rail, so the ceiling is the right one` (a scan and a table purchase on one client get their own ceilings).

**Reverted-fix run** (hook registration removed):

```
(fail) on Arc the quote ceiling refuses an over-quote 402 through Circle's own pre-signing hook
```

### 7. The displayed ledger may not have been the enforced one

**The finding.** Next.js compiles a route handler and a server component into different bundles, each with its own copy of `lib/spend.ts`. A module-level singleton therefore gave `POST /api/scan` one `SpendLedger` and `/portfolio` another: the page rendered a snapshot of an object nothing enforced, reporting no spend against a cap that had been reached. That is wrong in the reassuring direction, which is the worst direction for a spending figure. A development server's hot reload re-evaluates modules for the same reason and would have reset both counters silently.

**What changed.** **New** `packages/dashboard/lib/process-state.ts` holds the shared objects on `globalThis` under a single `Symbol.for("vaultradar.dashboard.processState")` key, with a typed `ProcessState` payload so bundles cannot disagree about what lives there, only the lookup is dynamic. `sharedInstance(key, create)` constructs on first use and never calls a later factory. `scanSpendLedger()` uses it, and `scanLimiter` becomes a function doing the same (a rate limit that resets whenever a module is re-evaluated is not a rate limit). `resetProcessStateForTests` exists for the tests and is called by nothing in the app.

**Covering tests**, **new** `packages/dashboard/test/process-state.test.ts`, six tests: `sharedInstance constructs once and never calls a later factory` (the property a second module graph depends on); `the instance is reachable through the global registry, not a module-local variable` (reads the symbol slot directly); `two calls to scanSpendLedger resolve to the same object, and state carries across them` (reference equality *and* a purchase booked through one call visible through the other); `two calls to scanLimiter resolve to the same object, so the window is not reset per caller`; slot independence; and that the reset helper makes first-use construction observable. `ratelimit.test.ts`'s shared-limiter test also asserts `scanLimiter() === scanLimiter()`.

A second module graph cannot be created inside one bun test process, imports of the same path are cached, so these pin the property that matters rather than staging the bundling itself. The test comment says so.

**Reverted-fix run** (module-level instances again):

```
(fail) the shared scan limiter is set to the spec's 30-second window, and is one instance
(fail) the instance is reachable through the global registry, not a module-local variable
(fail) two calls to scanLimiter resolve to the same object, so the window is not reset per caller
(fail) the two shared slots are independent of each other
(fail) resetProcessStateForTests clears the registry, so first-use construction is observable
```

### The two stale comments

`packages/agent/src/watch.ts` claimed `0.03 × 3` in binary floats is `0.09000000000000001`. It is exactly `0.09`, so the comment justified a correct practice with a false example. It now cites `0.06 × 11`, which genuinely is `0.6599999999999999` and would compare wrong against a budget of `"0.66"`, and says the old example was wrong. `packages/dashboard/lib/scan.ts`'s parenthetical about that claim is removed, since the claim it corrected no longer exists.

### Commands and output

```
$ bun test
 416 pass
 1 skip
 0 fail
 1860 expect() calls
Ran 417 tests across 41 files. [11.50s]

$ bun run typecheck
(no output)

$ bun x tsc -p packages/dashboard/tsconfig.json --noEmit
(no output)

$ bun run --cwd packages/dashboard build
✓ Compiled successfully
Turbopack build encountered 4 warnings:   # unchanged, same 4 as main

$ bun run --cwd packages/dashboard lint
$ eslint
(no output)
```

### Files changed

`packages/agent/src/{client.ts,watch.ts,rails/{arc,hedera,quote}.ts}`, `packages/agent/test/client.test.ts`, `packages/dashboard/lib/{process-state,spend,ratelimit,scan}.ts`, `packages/dashboard/test/{process-state,ratelimit}.test.ts`.

### Concerns

1. **Two more files added beyond the brief's original list**: `packages/agent/src/rails/quote.ts` and `packages/dashboard/lib/process-state.ts`. Both exist because the alternative was duplication, a second copy of the tolerance band, and a second copy of the global-registry dance in two modules that do not otherwise import each other.
2. **`ArcPayer` is a structural stand-in for `GatewayClient`**, not Circle's own type. Circle does not export `BeforePaymentCreationHook` from `@circle-fin/x402-batching/client` (it is imported into that module but not re-exported), so the hook's parameter shape is restated locally. If Circle changes the hook's context shape, the compiler will not catch it here; the hook reads only `selectedRequirements.amount`, which is the field least likely to move.
3. **`scanLimiter` changed from a `const` to a function.** An in-repo caller and its test were updated; anything outside this repo importing it would break, which nothing does.
4. **The shared instances are still per process.** `globalThis` fixes the bundling split, not horizontal scaling: two instances behind a load balancer still hold separate budgets. Unchanged from the previous round's concern and still stated on `/portfolio`.
