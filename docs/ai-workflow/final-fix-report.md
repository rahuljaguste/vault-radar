# Final fix wave — report (branch `ws/hardening`, base `ae54a8d`)

Status: **DONE_WITH_CONCERNS**. Every item F1–F10 is implemented, committed and verified. The
concerns are two deliberate deviations (both widenings, both named below) and one pre-existing
`next build` warning I did not touch.

Verification at `1d0ac83`:

| Gate | Result |
|---|---|
| `bun test` | 443 pass, 1 skip, 0 fail (444 tests, 41 files) |
| `bun run typecheck` | clean, now including the dashboard |
| `bun run --cwd packages/dashboard build` | exit 0 |

Baseline at `ae54a8d` was 416 pass / 1 skip / 0 fail, so this wave adds 27 tests.

## Commits

| Commit | Item | Subject |
|---|---|---|
| `438dc81` | F1a+F1b+F1c | Bind the ERC-8004 anchor to the key that actually signs |
| `5ebdc6c` | F2 | Bound discovery in the dashboard's paid-scan route |
| `2422c2f` | F3 | Register the Arc quote ceiling for a zero quote too |
| `ce7c113` | F4 | Fix the float-hazard comment in quoteFor |
| `43cd57f` | F5 | Take the 24 h outflow from one series, not from a merged two |
| `c6cad98` | F6 | Make the scan-hbar receipt state the price the route actually charges |
| `012399a` | F7 | Correct the docs that still describe shipped work as unbuilt |
| `979ff06` | F8 | Derive no decisions from a receipt that did not verify |
| `d546c62` | F9 | Say plainly that quote() is local arithmetic, and amend the spec |
| `882f34a` | F10a | Refuse a table request for a protocol nobody indexes, before charging for it |
| `14f6ba0` | F10b | Compare the admin token in constant time |
| `9542230` | F10c | Report an unreadable share price as unavailable, not ok |
| `b9ae95f` | F10d | Put the dashboard inside the root typecheck gate |
| `1d0ac83` | F10e | Stop readSinkCursorBlock from swallowing a database outage silently |

---

## F1 — the ERC-8004 anchor did not bind the key that signs (`438dc81`)

All three sub-items in one commit, as the brief directed.

**F1a.** `packages/agent/src/client.ts`. `discover()` now computes
`publishedHash = sha256Hex(sigPk)` and compares the on-chain value to that alone; the card's
`pq.sig.pub_hash` is never the comparison target. Both sides are `.trim().toLowerCase()`d, so
an upper-case registry value matches. `Discovery` gains `keyBindingValid`, true when the card's
advertised hash really is the hash of the key it ships. The `discover()` doc comment was
rewritten to state what is bound to what and why the card's own claim is not usable as a
reference.

The brief's line citations were accurate: `client.ts:261` was the bad comparison and
`client.ts:59-65` the `Discovery` type.

`RunRecord` (`packages/agent/src/runs.ts`) and the dashboard's saved-run shape are untouched,
and `pubHash` still prints `card.pq.sig.pub_hash` everywhere it did before.

**F1b.** `packages/agent/src/watch.ts`. `identityRefusal` now requires a positive anchor:
refuses on `!cardSignatureValid`, `!keyBindingValid`, any `matches === false`, an empty
`onChain`, or no `matches === true`. The doc comment was rewritten, including the reason a
`null` is a failed read rather than an unconfigured chain (`erc8004.ts` ships RPC URLs for both
chains the service registers on).

One line beyond the brief: the `watch` banner printed `unverified (no RPC for this chain)` for
a `null`, which asserts the same wrong cause the old comment did. Changed to
`unverified (the registration could not be read)`. No test asserted the old string.

**F1c.** `packages/dashboard/lib/scan.ts`. Step 7 now calls `identityRefusal` imported from
`@vaultradar/agent` and returns its reason verbatim as the 502 `error`, replacing the route's
own two checks. Reservation release is unchanged (the existing `finally`).

`packages/agent/src/tools.ts`: `buy` already routed through `identityRefusal`, so `pay_and_scan`
and `vaultradar_table` were covered with no change. `cli.ts` holds no copy of the rule. I did
add `key_binding_valid` to the `vaultradar_discover` tool's output, because without it a card
failing key binding looks clean to the model while the paid tools refuse it.

Tests added:
- `packages/agent/test/client.test.ts`: a card signed by key B advertising key A's hash with the
  chain returning hash(A) (`cardSignatureValid: true`, `keyBindingValid: false`,
  `matches: false`, and `identityRefusal` naming it); an upper-case on-chain hash matching; and
  `keyBindingValid: true` added to the existing happy-path assertion. A `clientServing` helper
  drives a crafted card through the real `discover()` via `fetchImpl`.
- `packages/agent/test/watch.test.ts`: a `describe("identityRefusal")` with one case per branch
  plus the `[true, null]` proceed case, each spreading one real harness `Discovery`.
- `packages/dashboard/test/scan.test.ts`: `onChainHash = null` → 502 with reservation released;
  a card re-signed with `erc8004: []` → 502; the existing happy path unchanged.
- The existing dashboard mismatch test's assertion text was updated to the agent's wording
  (`does not match its on-chain ERC-8004 registration`), which is the intended consequence of
  using one rule in one place.

## F2 — `discover()` in the dashboard scan route had no timeout (`5ebdc6c`)

`ScanDeps` gains `discoveryTimeoutMs`, defaulting to `SERVICE_FETCH_TIMEOUT_MS` from
`lib/service.ts`, and step 7 wraps `client.discover()` in a new `withTimeout` helper. A timeout
returns 502 naming the bound; the existing `finally` releases the reservation.

**Deviation from the brief's suggested mechanism, with reason.** The brief preferred wrapping
the client's `fetchImpl` with a timeout. That does not work here: the client is built by
`deps.makeClient`, which every test overrides with its own `VaultRadarClient`, so a timeout
installed in `defaultDeps` would be untestable and absent from every injected client. A race is
testable and covers every client. Its cost is that the abandoned socket may linger until the
upstream or the platform closes it, since `discover()` takes no `AbortSignal` and the route
cannot reach the fetch; that is stated at the helper. The reservation release and the caller's
answer do not wait on it.

Test (`packages/dashboard/test/scan.test.ts`): a `fetchImpl` that never settles, with an
injected 250 ms bound → 502 inside 5 s, no run file, ledger back to zero, and the next caller
gets the full allowance. The shared test `deps()` uses 2 s so no other test can hang the suite.

## F3 — the Arc quote-ceiling hook skipped a zero quote (`2422c2f`)

`packages/agent/src/rails/arc.ts`: `if (quoteAtomic)` → `if (quoteAtomic != null)`. Verified
`client.ts:358` always passes the quote, so the omitted-quote path is only reachable from a
direct `payArcWith` call (and stays unbounded, as before).

Test (`packages/agent/test/client.test.ts`, extending the existing Arc ceiling test): quotes
`"0"` and `""` against a demand of `"1"` both abort before signing, and a demand of `"0"`
against a quote of `"0"` is still inside the band and signs.

## F4 — the `quoteFor` comment drew the wrong conclusion (`ce7c113`)

Verified with `bun -e`: `0.06 * 11` is `0.6599999999999999`, which is **less** than `0.66`, and
`0.03 * 3` is exactly `0.09`. The comment now states the inexactness without claiming a
direction and names both failure modes; the `0.03 * 3` parenthetical is gone. Comment only, no
test, as specified.

## F5 — `tvl_outflow_24h` double-counted merged hourly + daily series (`43cd57f`)

1. `HistoryPoint` (`packages/core/src/unify/types.ts`) gains a required
   `series: "hourly" | "daily" | "block"`, documented as to why it must survive the merge.
2. Stamped at every producer: both Messari mappers (`standardized/map.ts`, via a new `series`
   parameter on `yieldSeriesHistory` / `lendingSeriesHistory`) and `substreams/reader.ts`
   (`"block"`). The compiler found three test fixtures to update: `packages/core/test/risk.test.ts`,
   `packages/agent/test/harness.ts`, and `packages/dashboard/test/scan.test.ts` (that last one
   is outside any tsc project, so I fixed it by inspection, not by compiler error — see the F10d
   note). `packages/service/src/data/provider.ts` builds no `HistoryPoint` of its own and
   `packages/core/test/fixtures/*.json` are mapper *inputs*, so neither needed a change.
3. `computeRisk` takes the 24 h flows from one series via a new `flows24h` helper: finest
   series present in the window wins (hourly, then daily, then block), so resolution is never
   discarded. Share-price windows are untouched, and the doc comment says why mixing is
   harmless there.

Tests: `risk.test.ts` gains the real merged shape (24 hourly at −5000 plus a daily at −115000 on
a 1,000,000 balance → no flag, score 0, `ok`), a daily-only case asserting
`value: "0.250000"` / `threshold: "0.200000"` / `window: "24h"` exactly, a finest-series-wins
case, a block-series case that still sums, and a case proving an out-of-window hourly point
cannot capture the series and hide an in-window daily one. `standardized-map.test.ts` asserts
`["hourly","hourly","daily","daily"]` for both mappers; `reader.test.ts` asserts `"block"`.

## F6 — the `/hedera/v1/scan-hbar` receipt misstated price and asset (`c6cad98`)

1. `HandlerDeps` (`packages/service/src/handlers/scan.ts`) gains a required
   `price: (count) => { amount, asset }`, used for the receipt's `price.amount`/`price.asset`.
   The inline rail/tier ternary and the `usdcToken` lookup are gone, along with the four imports
   that became unused (`hederaScanPriceAtomic`, `TABLE_PRICE_USD`, `arcBucket`,
   `ARC_BUCKET_PRICE`).
2. `rails/hedera.ts` defines `HBAR_ASSET` and `TINYBARS_PER_VAULT` once, with an
   `hbarScanAmount` helper shared by `hbarPrice` and the scan-hbar mount. `mountTier` gained the
   price argument and supplies the three values the brief specified. Both rails' deps types now
   `Omit` `"price"` as well.
3. `rails/arc.ts` mounts pass `{ ARC_BUCKET_PRICE[arcBucket(count)], "USDC" }` and
   `{ TABLE_PRICE_USD, "USDC" }` — identical to what its receipts already carried, so Arc
   receipt tests pass untouched.

Four test `HandlerDeps` literals needed the new field: `packages/service/test/handlers.test.ts`
(via a `routePrice(rail, tier)` helper so its three existing `receipt.price` assertions keep
asserting the production values), `packages/agent/test/harness.ts`,
`packages/agent/test/client.test.ts`, `packages/dashboard/test/scan.test.ts`.

**Note on the brief's test instruction.** It says "extend the paid one" at
`hedera-rail.test.ts:197`/`253`. Both of those scan-hbar tests are unpaid (a 402 probe and a 400
`bad_count`); there was no paid scan-hbar test to extend. I added one, modelled on the paid scan
test, with a new `buildHbarPaymentSignatureHeader` that carries an hbar transfer and
`asset: "0.0.0"` so x402's requirements matching accepts it. It asserts
`{ amount: String(n * 1_000_000), asset: "0.0.0", rail: "hedera" }` for n = 2 vaults and that
settlement happened. The existing paid USDC scan test now also asserts
`{ amount: hederaScanPriceAtomic(1), asset: TOKEN_ID, rail: "hedera" }`.

## F7 — README and adjacent docs understated what shipped (`012399a`)

All in one commit, as directed. Every `<<FILL:>>` marker left in place.

- `README.md:12`: `(in progress, see scope notes)` removed.
- `README.md:152`: rewritten — `watch`, both policy files, and which demo steps drive them
  (read `demo.sh`: step 3 balanced, step 4 strict).
- `README.md:219`: the "In flight" bullet now says the HCS queue, `scripts/identity.ts`, the Arc
  rail and the agent policy/CLI are built and tested, and that the Fly deployment, the identity
  registration run and the `<<FILL>>` links are what wait on credentials.
- Grepped the README for `not yet` / `in progress` / `will be` / `planned` / `specified` /
  `Tasks N`: the only remaining hits are the two accurate "was cut" scope notes (the Hedera
  Harness PR and the upstream x402 payment) and one use of "future" inside the quoted threat
  boundary. Nothing else was stale, so nothing else changed.
- `README.md:68`: reworded to say queries go to the pinned `deploymentId` once the gate has run,
  and that until then the registry resolves by subgraph id. Verified both halves: all 15
  `deployments.json` entries have `deploymentId: null`, and `gateway.ts:5-9` is the fallback.
- `.env.example`: `HEDERA_NETWORK` deleted. Grepped `packages/`, `scripts/` and `docs/`: nothing
  reads it, and `config.ts:58` pins `network: "testnet"`. The section header now says so.
- `.env.example` `ADMIN_TOKEN`: comment replaced with what unset actually does (service answers
  503 `admin_disabled`; the dashboard page still renders and explains itself).
- `scripts/demo.sh:12-16`: rewritten to describe what steps 3, 4 and 5 run, keeping the note
  that `run_or_show` prints a missing step's command instead of aborting (the guard still exists;
  all three entrypoints are present).
- `packages/agent/src/policy.ts:91-93`: corrected. Verified the prices with `bun -e`: Arc is
  cheaper at 5 (0.003 vs 0.0035), 20 (0.01 vs 0.011) and 100 (0.05 vs 0.051). The comment now
  says ties are not confined to the table tier and names the three scan counts where the metered
  price lands exactly on a bucket price — 4, 18 and 98, each verified to be an exact tie.
- `packages/dashboard/README.md`: a deploy-time note under `/admin`, precisely, that the page has
  no access control of its own (the token authenticates the server, per spec §13.1) and what the
  two options are.

## F8 — the dashboard persisted decisions from an unverified receipt (`979ff06`)

`packages/dashboard/lib/scan.ts` step 10 now computes the failure reason before building
anything, and on failure persists `buildFailedRecord` instead of `buildRecord`, then returns 502
with that record's `runId`. The two existing error strings are unchanged. `buildRecord` (and so
`decide`) only runs once both checks pass.

`buildFailedRecord` gained an optional `receiptHash` (default `""`, which is what the existing
pre-payment-failure caller still gets) so the failed record keeps the hash the receipt would be
looked up by on HCS, alongside the txId it already carried. `RunRecord`'s shape is unchanged.

Test: a `payingFetch` that returns the real service reply with one character of
`receipt.sig.value` flipped → 502 mentioning the receipt, one run file, `requests: []`, every
decision `insufficient data` with the reason, no `hold`/`withdraw`/`rebalance`, txId and a
64-hex receipt hash present, and the allowance still consumed because the money moved.

## F9 — `quote()` is local arithmetic, not a 402 probe (`d546c62`)

Implemented as the controller ruled: no live probe.

- `packages/agent/src/tools.ts`: the `vaultradar_quote` description now says the figures are
  computed locally from the shared pricing table and that the service's 402 demand is checked
  against the quote before anything is signed.
- `README.md`: the Hedera flow's step 4 says the same in one sentence, including the one-percent
  band and the after-the-fact receipt check. `demo.sh` step 2 untouched.
- `docs/superpowers/specs/2026-09-05-vaultradar-design.md` §5.6: a dated amendment note in the
  style of §5.5's table-price note, stating that `quote` is local arithmetic and that the per-rail
  ceilings plus `checkSettledPrice` are what enforce the 402's demand.
- Also added (one doc comment, not in the brief): `quote()`'s own comment in `client.ts` now
  points at the amendment, since that is the first place a reader of the code looks.

## F10 — the review's Minor list

**a. Unknown protocol table request was charged for an empty body (`882f34a`).**
`knownProtocol(protocol, chainId)` added to `packages/core/src/standardized/registry.ts`:
registry match on protocol *and* chainId, or `protocol === "erc4626"`. Hedera enforces it in the
handler's table validation (422 `unknown_protocol`), which is pre-settlement on that rail. Arc
enforces it in a new `preValidateTable` middleware mounted after `preValidateSealed` and before
`gateway.require`, reading a sealed request off the already-opened `res.locals.opened` rather
than decrypting twice, and falling through to the handler's `bad_table_request` for a malformed
body. `errBody` keeps the `error` alias.

Tests: Hedera, an unindexed protocol and a registered protocol on the wrong chain are both 422
with `verify` called but `settle` at 0 (placed at the end of that file, per its own section
comment about the module-level correlation maps). Arc, a clear body and a sealed envelope are
both 422 with `fac.calls.supported` at 0, i.e. rejected before the gateway was consulted. Core,
a unit test for `knownProtocol` including the `erc4626` special case.
`buildPaymentSignatureHeader` gained an optional atomic amount so the table route's 60000 can be
paid.

**b. Admin token compared with `!==` (`14f6ba0`).** `packages/service/src/admin.ts` now uses a
`tokenMatches` helper with the dashboard's length-check-then-XOR shape. Existing admin tests
pass; the near-miss cases (one character wrong, one short, one long) are asserted explicitly.

**c. Non-numeric `sharePrice` scored `ok` (`9542230`).** `computeRisk` returns
`verdict: "unavailable"`, score 0 and a `bad_share_price` flag
(`{ value: String(v.sharePrice), threshold: "finite", window: "now" }`) when the price is not
finite. `FlagName` gained the member; nothing switches exhaustively on it.

**Deviation, with reason.** The brief specified "when `cur` is not finite". `Number("")` is `0`,
not `NaN`, so a blank share price passes a finite check and still reads `ok` (or, with history,
fabricates a 100% drawdown). I check `v.sharePrice.trim() === ""` alongside the finite test and
say why in the comment. No fixture in the repo uses an empty share price, so nothing else moved.
Flag it if you would rather the rule be exactly as written.

**d. Dashboard outside the root typecheck gate (`b9ae95f`).** `package.json:7` now ends with
`&& bun x tsc -p packages/dashboard/tsconfig.json --noEmit`. It passes with **no** tsconfig
adjustment. Worth knowing for future reviews: that tsconfig excludes `test/` (anything importing
`@vaultradar/service` must stay out of the dashboard's compile or `next build` fails), so this
gate covers `app/` and `lib/` but not the dashboard's own tests — which is why F5's fixture
change in `packages/dashboard/test/scan.test.ts` had to be found by reading rather than by the
compiler.

**e. `readSinkCursorBlock` swallowed every error (`1d0ac83`).** Still returns `null`, but anything
whose `code` is not `42P01` logs one `console.warn` naming the chain id and the error's message.
The query text is never logged, and a `withoutUrls` helper strips anything URL-shaped first, so a
driver that echoes its DSN into an error text cannot put the password in the log. The existing
missing-table test now throws an error carrying `code: "42P01"` (what `pg` really sets) and
asserts nothing is logged; a new test covers the outage case and the redaction.

---

## Concerns

1. **F2's mechanism differs from the brief's suggestion** (race, not a wrapped `fetchImpl`).
   Reason above: an injected client cannot be reached to install a timeout. The abandoned socket
   is not torn down.
2. **F10c is slightly wider than specified** (blank share price treated as unreadable, because
   `Number("")` is 0). Easy to narrow if you want the literal rule.
3. **`next build` emits four pre-existing warnings**, all about dynamic filesystem access in
   `packages/dashboard/lib/runs.ts` ("Dynamic filesystem access causes tracing of the whole
   project", from `path.join(runsDir(), file)`). The build exits 0. `lib/runs.ts` is untouched by
   this wave and no item named it, so I left it; flagging it rather than working around it, per
   the dispatch. It is a deploy-size concern, not a correctness one.
4. **F1's `keyBindingValid` is in-memory only**, as directed, so a saved `RunRecord` cannot
   distinguish a run whose card failed key binding (no such run can pay, so nothing is lost
   today — but a future reader of old runs has no field for it).
