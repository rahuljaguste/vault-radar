# Final fix wave, re-review (branch `ws/hardening`, base `ae54a8d`, head `1d0ac83`)

Read-only review of the 14 fix commits in `review-ae54a8d..1d0ac83.diff`. Nothing in the working
tree, index, HEAD or branch state was mutated.

## Finding Verdicts

**F1, ERC-8004 anchor now binds the key that signs**, ADDRESSED.
`packages/agent/src/client.ts:294` computes `publishedHash = sha256Hex(sigPk)`; line 299 compares
the chain read to that alone, lower-cased on both sides; the card's `pq.sig.pub_hash` is no longer
a comparison target anywhere. `keyBindingValid` is set at line 295 and carried on `Discovery`
(line 77). `packages/agent/src/watch.ts:256-271` is fail-closed in every branch: refusals for bad
card signature, bad key binding, any `matches === false`, empty `onChain`, and no
`matches === true`, with the single `return null` reachable only after all five. One definition,
three call sites, no duplication: `watch.ts:574`, `packages/agent/src/tools.ts:199` (the shared
`buy`, which both paid tools route through), `packages/dashboard/lib/scan.ts:322` (imported from
`@vaultradar/agent`, reason used verbatim as the 502 body). `sha256Hex` is `toHex(sha256(b))` with
lower-case hex (`packages/core/src/util/bytes.ts:3`), so the case-insensitive compare is sound.
Adversarial test at `packages/agent/test/client.test.ts:106-122`: a card signed by an attacker key
advertising the legitimate hash, chain returning the legitimate hash, asserts
`cardSignatureValid: true`, `keyBindingValid: false`, `matches: false`, and that `identityRefusal`
names it. `describe("identityRefusal")` in `packages/agent/test/watch.test.ts:415-470` covers one
case per branch plus the `[true, null]` proceed case, each spreading one real harness `Discovery`.
Dashboard tests cover `onChainHash = null` and an `erc8004: []` card, both 502 with the
reservation released. `app/verify/page.tsx` declares its own local `cardSignatureValid` type and is
unaffected by the `Discovery` change.

**F2, discovery is bounded and the reservation is released**, ADDRESSED.
`packages/dashboard/lib/scan.ts:121` adds `withTimeout`; line 315 wraps `client.discover()`; line
318 returns 502 naming the bound; the pre-existing `finally` (just after the 200 return) releases
the reservation on every path that did not settle. The implementer's deviation is sound and I
verified its premise: the test `deps()` replaces `makeClient` wholesale, so a timeout installed in
`defaultDeps` would never reach an injected client. The defect named by the finding (unbounded
reservation hold) no longer exists. Residual cost, disclosed at the helper: the abandoned socket is
not torn down, because `discover()` takes no `AbortSignal`. `withTimeout` attaches handlers to both
legs of the race, so a late rejection from the abandoned work cannot surface as an unhandled
rejection, and `clearTimeout` runs in `.finally`. Test injects a 250 ms bound against a `fetchImpl`
that never settles, asserts 502 inside 5 s, no run file, ledger back to zero, and the next caller
getting the full allowance.

**F3, Arc ceiling registers for a zero quote**, ADDRESSED.
`packages/agent/src/rails/arc.ts:86` is `if (quoteAtomic != null)`. Test covers `"0"` and `""`
against a demand of `"1"` (both abort before signing) and a demand of `"0"` against quote `"0"`
(still in band, signs). `client.ts:378` always computes and passes the quote, so the omitted-quote
path is reachable only from a direct `payArcWith` call.

**F4, `quoteFor` comment corrected**, ADDRESSED.
The comment at `packages/agent/src/watch.ts:147-153` states the inexactness without claiming a
direction, names both failure modes, keeps the integer micro-USD rationale, and drops the
`0.03 * 3` parenthetical. Verified numerically: `0.06 * 11` is `0.6599999999999999`, which is
**less** than `0.66`; `0.03 * 3` is exactly `0.09`.

**F5, 24 h outflow comes from one series**, ADDRESSED.
`series` is required on `HistoryPoint` (`packages/core/src/unify/types.ts:28`) and set by every
producer. I grepped `HistoryPoint` and `netFlowAssets:` across all four packages: the only
producers are `standardized/map.ts:40` and `:69` (both Messari mappers, via a new `series`
parameter on `yieldSeriesHistory` / `lendingSeriesHistory`), `substreams/reader.ts:85` (`"block"`),
plus three test fixtures (`core/test/risk.test.ts`, `agent/test/harness.ts`,
`dashboard/test/scan.test.ts`). Service `data/provider.ts` builds no `HistoryPoint` of its own and
`core/test/fixtures/*.json` are mapper *inputs*, so the implementer's claim that neither needed a
change holds. `risk.ts:63-67`'s `flows24h` filters to in-window **non-null** flows first, then
picks the finest series present among those, so a series whose in-window points all carry null
flows cannot capture the selection and silently hide a coarser series that does carry flows, the
ordering of those two steps is what makes the selection safe. Tests cover the real merged shape
(24 hourly at -5000 plus a daily at -115000 on a 1,000,000 balance → no flag, score 0, `ok`),
daily-only with `value: "0.250000"` / `threshold: "0.200000"` / `window: "24h"` asserted exactly,
finest-series-wins, block-series still summing, and an out-of-window hourly point not capturing the
selection. `standardized-map.test.ts` asserts `["hourly","hourly","daily","daily"]` for both
mappers; `reader.test.ts` asserts `"block"`.

**F6, scan-hbar receipt states tinybars of HBAR, and Arc is byte-identical**, ADDRESSED.
`HandlerDeps.price` is required (`packages/service/src/handlers/scan.ts:49`) and used at `:207`;
the inline rail/tier ternary and the `usdcToken` lookup are gone along with the four imports that
became unused. `packages/service/src/rails/hedera.ts:89-91` defines `HBAR_ASSET`,
`TINYBARS_PER_VAULT` and an `hbarScanAmount` helper once, shared by `hbarPrice` (line 255) and the
scan-hbar mount (line 279). The three Hedera mounts (lines 278-280) supply exactly the values the
brief specified. Arc mounts (`rails/arc.ts:262-269`) pass
`ARC_BUCKET_PRICE[arcBucket(count)]` / `"USDC"` for scan and `TABLE_PRICE_USD` / `"USDC"` for
table, which is precisely what the old ternary produced for those cases, so Arc receipt values are
byte-identical; the pre-existing Arc assertions at `handlers.test.ts:255` and `:271` pass
untouched. New paid scan-hbar test (`hedera-rail.test.ts`) asserts
`{ amount: "2000000", asset: "0.0.0", rail: "hedera" }` for two vaults and `fac.calls.settle === 1`;
the paid USDC scan test now also asserts `{ amount: hederaScanPriceAtomic(1), asset: TOKEN_ID,
rail: "hedera" }`. The implementer's note is correct and I confirmed it: both pre-existing
scan-hbar tests were unpaid (a 402 probe and a 400 `bad_count`), so a paid one had to be written
rather than extended. The `count` the handler passes to `d.price(count)` is the request's own vault
count, which the rail has already forced to equal `X-VR-Count` (clear bodies) or the envelope's
count (sealed), so the receipt cannot state a different quantity than the 402 priced.

**F7, docs corrected**, ADDRESSED.
README lines 12, 152 and 219 rewritten as specified. I re-grepped the README for `not yet`,
`in progress`, `planned`, `specified but`, `will be` and `Tasks N`: zero remaining stale hits.
README:68 now says queries go to the pinned `deploymentId` once the gate has run and resolve by
subgraph id until then; I confirmed both halves, all 15 entries in `deployments.json` have
`deploymentId: null`, and `gateway.ts:6-8` is the subgraph-id fallback. `HEDERA_NETWORK` deleted
from `.env.example`; the only occurrence left repo-wide is in the historical plan document, and
`config.ts` pins `network: "testnet"`. The `ADMIN_TOKEN` comment now describes the real behaviour
(service answers 503 `admin_disabled`, dashboard page still renders and explains itself).
`scripts/demo.sh:12-16` is accurate: step 3 uses `policy.example.json`, step 4
`policy.strict.json`, step 5 `hello-arc.ts`, and the `run_or_show` guard still exists at line 83.
`packages/agent/src/policy.ts:90-97` is now correct, verified by running the price functions: Arc
is cheaper at 5 ($0.003 vs $0.0035), 20 ($0.01 vs $0.011) and 100 ($0.05 vs $0.051); Hedera at 1, 6
and 21; exact ties fall at 4, 18 and 98, exactly as the comment now claims. The dashboard README
gained the `/admin` deploy-time note under the metrics section.

**F8, validity checked before any decision is derived**, ADDRESSED.
`packages/dashboard/lib/scan.ts:377` computes the failure reason, and the `buildFailedRecord`
branch at `:386` returns before `buildRecord` (and therefore before `decide`) ever runs. The
persisted failed record carries `requests: []` and every vault as `insufficient data` with the
reason, so no `hold`, `withdraw` or `rebalance` can appear in it. `buildFailedRecord` gained an
optional `receiptHash` defaulting to `""`, so the pre-payment caller at line 345 is unchanged and
`RunRecord`'s shape is untouched. The branch sits after `settled = true`, so the ledger still
charges for a payment that moved. Test flips one character of `receipt.sig.value` and asserts the
502 with a `runId`, one run file, empty `requests`, every action `insufficient data`, the txId and a
64-hex receipt hash present, and the allowance consumed.

**F9, quote documented as local arithmetic, spec amended**, ADDRESSED, wording accurate.
The `vaultradar_quote` tool description, `quote()`'s own doc comment (`client.ts:318`), README
step 4, and a dated `(Amended 2026-09-10: ...)` note in spec §5.6 (line 148) all say the same thing,
in the same style as the §5.5 table-price note (line 136). I verified every factual claim in that
wording: `maxAcceptableAtomic("3000")` is `3030n`, so the band really is one percent;
`quoteAtomicFor` is threaded to both rails for both tiers (`client.ts:385` sets `this.quoteAtomic`
for the Hedera policy, `:405` passes it to `arcPay`), so the 402's demand is genuinely checked
before anything is signed on either rail; and `checkSettledPrice` is called at `:456` for the
after-the-fact receipt check. No live probe was implemented, per the controller's ruling.
`demo.sh` step 2 untouched.

**F10a, unknown protocol refused pre-settlement on both rails**, ADDRESSED.
`knownProtocol` (`packages/core/src/standardized/registry.ts:15`) matches the registry on protocol
**and** chainId, or `protocol === "erc4626"`. Hedera enforces it in the handler
(`handlers/scan.ts:155`), which is pre-settle on that rail; the test asserts `verify === 1` and
`settle === 0`. Arc's `preValidateTable` (`rails/arc.ts:170`) is mounted at line 234, immediately
before `gateway.require(price)` at line 235, so it is genuinely pre-payment; both Arc tests assert
`fac.calls.supported === 0`, i.e. the facilitator was never even asked what it supports. It reads a
sealed body off `res.locals.opened`, which `preValidateSealed` sets for every sealed body it
accepts (and 422s pre-payment when the open fails), so the envelope is not decrypted twice.
`checkSealedRequestPrePayment` only *reads* the nonce store (`envelope.ts:50`; commits are split
into `commitNonce`), so the new 422 burns no nonce. `errBody` keeps the `error` alias and every
test asserts both keys. `DEFAULT_TABLE_PROTOCOL` is `"erc4626"`, which `knownProtocol` accepts on
any chain, so the agent's strict-tier table purchases are unaffected.

**F10b, admin token compared in constant time**, ADDRESSED.
`packages/service/src/admin.ts:20` is a length check followed by XOR accumulation over char codes,
used at line 62. Near-miss cases (one character wrong, one short, one long) are asserted 401, and
the pre-existing admin tests pass.

**F10c, unreadable share price is `unavailable`**, ADDRESSED, and the widening is coherent.
`packages/core/src/risk.ts:87-89` returns `verdict: "unavailable"`, score 0 and a
`{ name: "bad_share_price", value: String(v.sharePrice), threshold: "finite", window: "now" }` flag
when the price is blank or not finite, placed after the `stale_data` branch so a stale source still
wins. The blank-string widening the controller pre-accepted is justified rather than arbitrary:
`Number("")` is `0`, which would otherwise read as a share price of zero and, with any history,
fabricate a 100% drawdown. `UnifiedVault.sharePrice` is a required `string` and every producer
writes `String(...)`, so `.trim()` cannot throw on a runtime null; a SQL NULL becomes the string
`"null"`, which the finite check catches. Test covers `""`, `"n/a"`, `"null"`, `"abc"` and the
stale-source precedence.

**F10d, dashboard inside the typecheck gate**, ADDRESSED.
`package.json:7` appends `bun x tsc -p packages/dashboard/tsconfig.json --noEmit`. I ran
`bun run typecheck`: exit 0 across all four legs, with no tsconfig adjustment, confirming the
implementer's claim. Their caveat is worth keeping: that tsconfig excludes `test/`, so the gate
covers `app/` and `lib/` but not the dashboard's own tests.

**F10e, cursor read logs a non-`42P01` failure**, ADDRESSED.
`packages/core/src/substreams/reader.ts:51-52` warns for any error whose `code` is not `42P01`,
naming the chain id, and still returns `null` so callers keep degrading. `withoutUrls` (line 43)
strips anything URL-shaped before logging and the query text is never logged. Tests assert silence
on a missing table (now thrown with `code: "42P01"`, which is what `pg` really sets) and exactly
one warning containing `chain 1` and the error message but no `SELECT`, no `postgres://` and no
credentials on an auth failure.

## New Breakage in the Fix Diff

**Minor, deployment consequence of F1, not a code defect.**
`packages/service/src/config.ts:33-35` builds the card's `erc8004` list only from
`ERC8004_HEDERA_AGENT_ID` / `ERC8004_ARC_AGENT_ID`, so with both unset the card lists no identity
and F1b's new empty-`onChain` rule refuses every purchase from both the agent and the dashboard.
F1b additionally requires at least one on-chain read to *succeed*, so a Hashio or Arc RPC outage
refuses a paid run too. Both behaviours are exactly what the brief and spec §3 threat 5 mandate and
I am not suggesting either be relaxed. What is missing is one sentence saying so: `.env.example:34-36`
still presents the two ids as blanks "filled by scripts/identity.ts", and F7's rewritten
README:219 lists the identity registration run only as "waiting on credentials". As shipped, the
paid demo path is inert until that run completes, and every purchase now carries a live
third-party RPC dependency.

Nothing else. The fix introduces no new Critical or Important breakage.

## Out-of-Scope Observations

- **Arc table, malformed body.** A clear body whose `protocol` is not a string (for example
  `{ protocol: 123, chainId: "1" }`) falls through `preValidateTable` to `gateway.require`,
  settles, and only then gets 422 `bad_table_request` from the handler, so the payer is charged for
  nothing. The brief explicitly sanctioned this fall-through and it predates the fix, so it is not
  F10a breakage, but it is the same class of bug F10a closed and would cost about two lines to
  close (a pre-payment `bad_table_request` for the table tier).
- **F5's hourly window covers about 23 hours.** A Messari history with 24 hourly snapshots has a
  null flow on the oldest point (no older sibling to diff against), so the chosen hourly series
  spans roughly 23 of the 24 hours and a real 20.8% even outflow would read as about 19.9% and miss
  the threshold. The brief specified this selection and the alternative (daily) is coarser; noted
  only so "the 24 h change" is not read as exact.
- `handleScan` computes `applyAgeCheck` before the new validity branch and does not use it on the
  failure path. One line of dead work.
- I did not re-run `next build`, so the four pre-existing dynamic-filesystem warnings in
  `packages/dashboard/lib/runs.ts` remain unverified by me. The implementer reports exit 0 and did
  not touch that file; no item named it.

## Verdict

**Fix round: All findings addressed, no new Critical/Important breakage.**

F1 through F10e are each closed at the level of the specific defect, not merely attempted. Checks I
ran, all read-only and all inside this worktree:

| Check | Result |
|---|---|
| `Claude-Session` trailer on every commit in `ae54a8d..1d0ac83` | 14 of 14 present |
| `bun run typecheck` (now four legs, including the dashboard) | exit 0 |
| `packages/core/test/{risk,reader,standardized-map}.test.ts` | 29 pass, 0 fail |
| `packages/dashboard/test/scan.test.ts` | 53 pass, 0 fail |
| `packages/agent/test/{client,watch,tools}.test.ts` | 64 pass, 0 fail |
| `packages/service/test/{hedera-rail,arc-rail,handlers,admin}.test.ts` | 60 pass, 0 fail |

The implementer's report names a covering test for every item that required one, and each named
test exists in the diff and passes. The only item left needing a decision is documentary: whether
to state in `.env.example` and the README that an unregistered ERC-8004 identity, or an RPC that
cannot be read, now makes every paid run refuse.
