# Final fix wave, brief (branch ws/hardening, worktree /Users/rahuljaguste/pq/ethonline-20206/.worktrees/hardening, BASE ae54a8d)

This is the single fix dispatch after the whole-branch review of VaultRadar. Fix every item below in the order given, one commit per item (or per tightly related group), tests first where a test is named. Do not refactor beyond what an item needs. Do not touch docs except where an item says so.

## Binding constraints (from the plan's Global Constraints and the spec)

- Spec is the authority: `docs/superpowers/specs/2026-09-05-vaultradar-design.md`. §3 threat 5 (key substitution during discovery): "the ML-DSA public-key hash is written on-chain as ERC-8004 metadata under the service's agent id; discovery reads it from the chain." The anchor exists so that a card served by whoever answers for the URL cannot swap the key.
- Every commit message ends with the trailer line exactly: `Claude-Session: https://claude.ai/code/session_01GP7VEZFF8kYLm28Syzbar8`
- Never log, print, or commit secrets. No `.env` exists; everything must stay testable offline (tests inject `readPqHash` / `payingFetch` stubs).
- Run from the worktree root: `bun test` (whole workspace), `bun run typecheck`, and `bun run --cwd packages/dashboard build` must all pass before you report. Record the counts.
- Run git only inside this worktree, with plain single commands (`git add`, `git commit`, `git log`). Do not merge, push, or rebase. Do not `cd` out of the worktree.
- You do not dispatch subagents. Review arrives from the controller after your report.

## F1 (Critical), the ERC-8004 anchor does not bind the key that signs

Two independent bypasses; close both.

**F1a, agent discover compares the chain against a self-asserted value.**
`packages/agent/src/client.ts:261` sets `matches: hash === card.pq.sig.pub_hash`. `card.pq.sig.pub_hash` is a field of the card body the server chooses; nothing ties it to `card.pq.sig.public_key`. `checkSig` (core `pq/sign.ts`) binds only the signature envelope's `sig.pub_hash` to the key that signed. Failure: a substituted card ships attacker key K_a in `pq.sig.public_key`, a valid self-signature under K_a (so `cardSignatureValid` is true), and copies the legitimate service's hash into `pq.sig.pub_hash`; the on-chain read returns that legitimate hash, `matches` is true, the agent pins K_a and pays.

Fix in `discover()`:
1. `const publishedHash = sha256Hex(sigPk)` (import `sha256Hex` from `@vaultradar/core`; it is already exported from `canonical.ts`).
2. Compare the on-chain value to `publishedHash` only, never to the card's claim: `matches: hash == null ? null : hash.toLowerCase() === publishedHash`.
3. Add `keyBindingValid: boolean` to the `Discovery` type (`client.ts:59-65`): `card.pq.sig.pub_hash.trim().toLowerCase() === publishedHash`. A card whose claimed hash is not the hash of the key it ships is malformed; consumers refuse on it (see F1b/F1c). Do not change the `RunRecord` contract in `packages/agent/src/runs.ts` or the dashboard's saved-run shape; `keyBindingValid` is in-memory discovery state only. Where runs/tools print `pubHash`, keep printing `card.pq.sig.pub_hash` (after F1 it is verified equal to the key hash whenever payment proceeds).
4. Update the doc comment above `discover()` (lines 237-244) to say what is now bound to what.

Tests (`packages/agent/test/client.test.ts`; the existing test at line 109 is the model, it builds a signed card with `keys` and a `readPqHash` stub):
- a card signed by key B whose `pq.sig.pub_hash` is the hash of key A, with the chain returning hash(A): expect `matches: false` and `keyBindingValid: false`; `cardSignatureValid` may be true.
- a well-formed card with the chain returning hash(sigPk): `matches: true`, `keyBindingValid: true` (extend the existing test).
- the chain returning a hash in upper-case hex for a well-formed card: `matches: true` (case-insensitive compare).

**F1b, the agent refuses only on `matches === false`.**
`packages/agent/src/watch.ts:241-248` `identityRefusal` proceeds when the card lists no ERC-8004 identity (empty `onChain`) or when every read returned `null`. A card that simply omits its identities skips the anchor entirely, which is exactly the substitution the anchor exists to stop. Note the agent has built-in RPC URLs for chains 296 and 5042002 (`packages/agent/src/erc8004.ts:25-26`), so `null` means the RPC failed or the chain is unknown, not "unconfigured".

Fix: `identityRefusal` returns a refusal when
- `!disc.cardSignatureValid` (existing message), or
- `!disc.keyBindingValid`: "the service's agent card claims a key hash that is not the hash of the key it published, refusing to pay", or
- any entry has `matches === false` (existing message), or
- `disc.onChain.length === 0`: "the service's agent card lists no on-chain ERC-8004 identity, so nothing anchors its key, refusing to pay", or
- no entry has `matches === true` (every read returned null): "the on-chain ERC-8004 registration could not be read for any identity the card lists, so the key is unverified, refusing to pay".
Proceed only when at least one entry is `true` and none is `false`. One confirmed anchor suffices; a contradicted anchor on any chain refuses. Update the doc comment above the function (it currently says `null` is not a refusal).

Tests (`packages/agent/test/watch.test.ts`; there is no `identityRefusal` test yet, add a `describe("identityRefusal")` with one case per branch above plus the proceed case `[true, null]`). Check `watch.test.ts` fixtures that build a `Discovery` and give them `keyBindingValid: true` and at least one `matches: true` so the existing watch tests still pay.

Also grep `packages/agent/src/tools.ts` and `packages/agent/src/cli.ts` for any second copy of the refusal logic (the `discover` tool reports `onChain` and `pubHash`, and `pay_and_scan` must refuse on the same rule). If `tools.ts` pays without calling `identityRefusal`, route it through `identityRefusal`; do not duplicate the rule.

**F1c, the dashboard's paid scan route has the same gap.**
`packages/dashboard/lib/scan.ts:278-291` (step 7) refuses on `!cardSignatureValid` and on `matches === false` only. Apply the same rule as F1b: refuse (HTTP 502, `error` body, reservation released exactly as the existing two refusals do) when `!discovery.keyBindingValid`, when `discovery.onChain.length === 0`, or when no entry is `true`. Prefer importing `identityRefusal` from the agent package (check how `packages/dashboard` already imports agent code, `lib/scan.ts` uses `VaultRadarClient` from it) and using its returned string as the error text, so there is one rule in one place. Keep the existing messages' tone.

Tests (`packages/dashboard/test/scan.test.ts`; `deps()` at line 153 takes `onChainHash` and the client is built with `readPqHash: async () => onChainHash`):
- `onChainHash = null` → 502, body error says the anchor could not be read, ledger reservation released (follow the pattern of the existing "card signature invalid" test).
- a service card with an empty `erc8004` list → 502 refuse (you may need a `deps` override that serves a card with `erc8004: []`; look at how the test app builds its card).
- existing happy path still passes (its stub returns `keys.sig.pubHash`, which is `sha256Hex(sigPk)`, so it stays green once F1a compares against the key hash).

The dashboard `/verify` page (`packages/dashboard/app/verify/page.tsx:100-131`) already binds the card's claim and the receipt's `pub_hash` to `sha256Hex(publicKey)` and checks anchors against `publishedHash`; leave it alone unless a later item below names it.

## F2 (deferred minor, fix now), `discover()` in the dashboard scan route has no timeout

`packages/dashboard/lib/scan.ts:272-276`: the spend reservation is taken at step 6 (`deps.ledger.reserve(quoteMicro)`, line 248) and then `await client.discover()` runs with no bound. A service that accepts the connection and never answers holds the reservation (and the per-IP slot) indefinitely. `packages/dashboard/lib/service.ts:60-84` already has the abort-controller pattern and `SERVICE_FETCH_TIMEOUT_MS` for this exact reason; `lib/admin.ts:136` uses `AbortSignal.timeout(5_000)`.

Fix: bound discovery with the same timeout constant (reuse `SERVICE_FETCH_TIMEOUT_MS` from `lib/service.ts`, or the client's own fetch option if `VaultRadarClient` accepts a `fetchImpl`, check the `client.ts` constructor options; wrapping `fetchImpl` with a timeout is the smallest change). On timeout: release the reservation through the existing release path and return 502 with an `error` body saying discovery timed out. Test in `packages/dashboard/test/scan.test.ts` (or `service-timeout.test.ts` if the timeout helper lives there): a card fetch that never resolves → 502 within the test's timeout, reservation released (use a short injected timeout, not the production value).

## F3 (deferred minor, fix now), the Arc quote-ceiling hook does not register for a "0" or empty quote

`packages/agent/src/rails/arc.ts:81`: `if (quoteAtomic) gateway.onBeforePaymentCreation(arcQuoteCeilingHook(quoteAtomic));` skips the hook when the quote is `"0"` or `""`, exactly the cases where the ceiling should bite hardest (`overQuoteReason(x, "0")` and `overQuoteReason(x, "")` both refuse any non-zero demand, since `BigInt("")` is `0n`). Fix: register whenever a quote was supplied, `if (quoteAtomic != null)`. Check `payArc`'s callers (`client.ts`) always pass the quote. Test in the agent's Arc rail tests (find them with `grep -rn "arcQuoteCeilingHook\|payArcWith" packages/agent/test`): quote `"0"` with a demanded amount `"1"` → the hook aborts with the over-quote reason.

## F4 (low, fix now), `quoteFor` comment in `packages/agent/src/watch.ts:147-152` draws the wrong conclusion

The comment says `0.06 * 11` is `0.6599999999999999` "which compares greater than a budget of '0.66'". It is less than 0.66, not greater (`node -e 'console.log(0.06*11 > 0.66)'` prints `false`). The hazard the comment defends against is real but runs the other way too: a float total that falls below a budget it actually equals or exceeds would let an over-budget plan through, and one that lands above would refuse an affordable one. Rewrite the sentence so it states the inexactness without claiming a direction, keep the integer micro-USD rationale, and drop the parenthetical about the earlier `0.03 * 3` version (history belongs in git, not the comment). Comment-only change; no test.

## F5 (Important), `tvl_outflow_24h` double-counts merged hourly + daily series

`packages/core/src/risk.ts:56-60` sums `netFlowAssets` over every history point within 24 h. The Messari mappers build `history` by concatenating two series: `packages/core/src/standardized/map.ts:47-50` (yield: 24 hourly + 8 daily snapshots, flows are within-series adjacent diffs, see `yieldSeriesHistory` at 29-41) and `76-79` (lending: per-point period totals from `hourlyDepositUSD/dailyDepositUSD`). The 23 hourly flows inside the window already telescope to roughly the 24 h change; the newest daily point also sits inside the window and contributes roughly the same change again. Failure: a vault with a real 11% outflow reports about 22%, crosses the 20% threshold, gains 25 points, and an `ok` vault reads `watch` (or `watch` becomes `alert` and the agent emits `withdraw`). Spec §5.3 asks for "the 24 h change", one figure. The Substreams path (`packages/core/src/substreams/reader.ts:61`) is per block and correct. Every existing risk test uses a single-point history, so nothing covers the real shape.

Fix:
1. Add `series: "hourly" | "daily" | "block"` to `HistoryPoint` (`packages/core/src/unify/types.ts:14-20`), required.
2. Set it at every producer: pass the series name into `yieldSeriesHistory` and `lendingSeriesHistory` and stamp each point; `"block"` in `reader.ts:61`. Fix any other producer the compiler finds (service `data/provider.ts`, test fixtures, `packages/core/test/fixtures`).
3. In `computeRisk`, take the 24 h flows from ONE series: the hourly series if it has any point with a non-null flow inside the window, else daily, else block. Share-price drop windows stay as they are (they pick one reference point; mixing series is harmless there). Note the change in the doc comment near the outflow block.

Tests (`packages/core/test/risk.test.ts`): (a) balance 1,000,000; 24 hourly points within 24 h each `netFlowAssets: "-5000"` (oldest may be null) plus one daily point within 24 h with `netFlowAssets: "-115000"` → no `tvl_outflow_24h` flag (about 11.5%, not 23%); (b) daily-only history, one point `-250000` within 24 h → flag, value about 0.25; (c) block-series history unchanged → existing behaviour. `packages/core/test/standardized-map.test.ts`: assert mapped hourly points carry `series: "hourly"` and daily `series: "daily"`; `reader.test.ts`: `series: "block"`.

## F6 (Important), the `/hedera/v1/scan-hbar` receipt misstates price and asset

`packages/service/src/rails/hedera.ts:237-242` prices that route at `count × 1_000_000` tinybars of asset `0.0.0`, and `mountTier("/hedera/v1/scan-hbar", "scan")` at line 262 uses the same handler as the USDC route. `packages/service/src/handlers/scan.ts:189-205` builds every Hedera receipt with `hederaScanPriceAtomic(count)` micro-USDC and `asset: d.config.hedera.usdcToken`. Failure: a payer spends 2,000,000 tinybars and the signed receipt, committed to HCS and verifiable forever, says `amount: "2000"`, `asset: "0.0.429274"`; an auditor concludes USDC was paid. The route is advertised on the agent card (`packages/service/src/keys.ts:14`, `endpoints.hedera.scanHbar`).

Fix (thread the route's price into the receipt; do not delete the route):
1. Add to `HandlerDeps` (`handlers/scan.ts:33-49`) a required `price: (count: number) => { amount: string; asset: string }` and use it for `price.amount` / `price.asset` in `buildReceipt`, replacing the inline rail/tier ternary and `usdcToken` lookup. Drop imports that become unused.
2. Define the HBAR rate once in `rails/hedera.ts` (`const HBAR_ASSET = "0.0.0"; const TINYBARS_PER_VAULT = 1_000_000;`) and use it in both `hbarPrice` and the scan-hbar mount. Mounts: scan → `{ amount: hederaScanPriceAtomic(count), asset: c.hedera.usdcToken }`; scan-hbar → `{ amount: String(count * TINYBARS_PER_VAULT), asset: HBAR_ASSET }`; table → `{ amount: String(Math.round(Number(TABLE_PRICE_USD) * 1e6)), asset: c.hedera.usdcToken }`. `mountTier` gains the price argument.
3. Arc mounts (`rails/arc.ts:192`): scan → `{ amount: ARC_BUCKET_PRICE[arcBucket(count)], asset: "USDC" }`; table → `{ amount: TABLE_PRICE_USD, asset: "USDC" }`, identical values to today.

Tests: `packages/service/test/hedera-rail.test.ts` already exercises scan-hbar at lines 197 and 253; extend the paid one to assert the receipt's `price` equals `{ amount: String(n * 1_000_000), asset: "0.0.0", rail: "hedera" }` for its `n` vaults, and keep (or add) the assertion that the USDC scan receipt's `price.asset` is the configured USDC token with the micro-USDC amount. Arc receipt tests must still pass unchanged.

## F7 (Important), the README understates what shipped

Three stale status statements from the Task 25 draft; fix only these, leave every `<<FILL: ...>>` marker in place (they wait on credentials):
- `README.md:12`: "the Circle Gateway rail (in progress, see scope notes)" → the rail is complete (`packages/service/src/rails/arc.ts`, tested); remove the parenthetical.
- `README.md:152`: "The `watch` command and its policy file are Tasks 22 and 23, specified but not yet built." → they are built and tested (`packages/agent/src/watch.ts`, `packages/agent/policy.example.json`, `packages/agent/policy.strict.json`); `scripts/demo.sh` runs them, read `demo.sh` and say which steps.
- `README.md:219` "In flight at the time of writing" bullet → the HCS commitment queue, the ERC-8004 registration script (`scripts/identity.ts`), the Arc rail, and the agent policy and CLI are built and covered by `bun test`. What still waits on credentials: the Fly deployment, the identity registration run, and the live links marked `<<FILL>>`. Rewrite the bullet to say exactly that.
Then grep the README for any other "not yet built" / "in progress" / "future tense" claim about those components and correct only stale status wording; do not restructure sections.

Also in this docs pass (same commit):
- `README.md:68`: "Every query goes to the pinned `deploymentId`, never a subgraph name..." is false as shipped: all 15 entries in `packages/core/src/standardized/deployments.json` have `deploymentId: null` because `scripts/verify-deployments.ts` (which pins on first run) has never run without a Studio key. Reword to: every query goes to the pinned `deploymentId` once the verification gate has run; until then the registry resolves by subgraph id (`packages/core/src/standardized/gateway.ts:5-9`). Leave the `<<FILL>>` count marker.
- `.env.example:20` `HEDERA_NETWORK=testnet`: grep `packages/service/src` for `HEDERA_NETWORK`; if nothing reads it (config hardcodes `network: "testnet"`), delete the line.
- `.env.example:32` `ADMIN_TOKEN` comment: "unset means no /admin view" is wrong. Unset makes the service answer 503 `admin_disabled` while the dashboard `/admin` page still renders and explains the misconfiguration. Say that.
- `scripts/demo.sh:12-16` header: says steps 3, 4 and 5 drive pieces "specified but not yet built". They are built; the `run_or_show` guards find all three entrypoints. Rewrite the paragraph to describe what the steps run (keep the note that a missing entrypoint prints the command instead of aborting, if that guard still exists).
- `packages/agent/src/policy.ts:91-93` comment: Hedera is not "the cheaper rail at every bucket size", Arc is cheaper at 5 vaults ($0.003 vs $0.0035), 20 ($0.01 vs $0.011) and 100 ($0.05 vs $0.051). The sort is correct; fix the comment to say the tie-break towards Hedera applies whenever quotes are equal (the flat table price, and any scan count where the two rails coincide).
- `packages/dashboard/README.md`: add a short deploy-time note that `/admin` is readable by anyone who can reach the dashboard (the admin token lives server-side, per spec §13.1), so a public deployment should sit behind its own access control or the page should be disabled by leaving `ADMIN_TOKEN` unset.

## F8 (Important), the dashboard persists actionable decisions derived from an unverified receipt

`packages/dashboard/lib/scan.ts:333-343`: step 10 builds the run record (`buildRecord` → `decide(result, age)` → `hold` / `withdraw` / `rebalance` per vault) and persists it BEFORE checking `result.receiptValid` and `result.attestationsValid`. The agent in the same situation (`packages/agent/src/watch.ts:373-397`) returns `ok: false` and carries no decisions from the failed purchase. Failure: a service returns a receipt whose ML-DSA signature fails; the browser gets a 502, but `runs/web-<hex>.json` now holds full actionable decisions, `RunRecord` has no field marking them unverified, and `app/runs/[id]/page.tsx` renders them identically to verified ones.

Fix: check validity first. When either check fails, persist a record with no actionable decisions, use `buildFailedRecord` (`lib/scan.ts:398`) with the reason ("the payment settled but the service's receipt did not verify" / "...attestations did not verify") so the run still exists as evidence (keep the txId and the receipt hash if the helper carries them), then return the 502 with `runId`. Keep the comment's intent ("fail closed, but still save the run"). Test (`packages/dashboard/test/scan.test.ts`): a service whose receipt signature fails (sign the receipt with a different key, or corrupt `sig.value`) → 502, and the persisted run has no `hold`/`withdraw`/`rebalance` decision (only the failed-record shape).

## F9 (Important, documentation + spec amendment), `quote()` is local arithmetic, not the unpaid 402 probe the spec names

`packages/agent/src/client.ts:274-279`: `quote(count)` computes prices from shared `@vaultradar/core` constants and never contacts the service; spec §5.6 says `quote(request)` is "an unpaid 402 probe per rail". Ruling (controller): do not implement a live probe now, the 402's actual demand is already checked against the quote before anything is signed (`quoteCeilingPolicy` on Hedera, `arcQuoteCeilingHook` on Arc) and the receipt's price is checked afterwards (`checkSettledPrice`), so the agent cannot be overcharged. Make the docs and the spec agree with the code:
- `packages/agent/src/tools.ts`: the `vaultradar_quote` tool description must say the quote is computed locally from the shared pricing table and that the service's 402 demand is checked against it at payment time.
- `README.md`: wherever the agent's quote step is described, say the same in one sentence. Do not touch `demo.sh` step 2 (its curl probe is a real 402 and stays).
- `docs/superpowers/specs/2026-09-05-vaultradar-design.md` §5.6: add a dated amendment note (same style as the §5.5 table-price note already in the spec) stating that `quote` is local arithmetic and the 402 demand is enforced by the per-rail ceilings.

## F10, small fixes from the review's Minor list (fix now)

a. **Unknown protocol table request is charged for an empty body.** `packages/service/src/data/provider.ts:172-188`: `table(protocol, chainId)` for a protocol with no `DEPLOYMENTS` entry (and not `"erc4626"`) returns `{ vaults: [], sources: [] }` after the payment. Add a `knownProtocol(protocol, chainId)` check in core (`DEPLOYMENTS` match on protocol + chainId, or `protocol === "erc4626"`) and apply it where table requests are validated before settlement: on Hedera the handler runs before settle, so a 422 from the handler's table-request validation is free; on Arc Circle settles before the handler, so the check must go in the existing pre-payment envelope validation (`rails/arc.ts` `preValidateSealed` / bucket validation, find where the table route's body is validated pre-payment and add it there). Test per rail: an unknown protocol table request is rejected with 422 and no settlement is recorded (Hedera: the in-process facilitator's settle is not called; Arc: the pre-payment path rejects before the gateway). Keep the error body's `error` alias convention.
b. **Admin token compared with `!==`.** `packages/service/src/admin.ts:47`. Use a constant-time comparison (the loop in `packages/dashboard/lib/scan.ts:113-116` is the model: length check, then XOR over char codes). Existing admin tests must pass.
c. **Non-numeric `sharePrice` scores `ok`.** `packages/core/src/risk.ts:46`: `const cur = num(v.sharePrice)!`, a non-numeric value makes `cur` NaN, every drawdown comparison false, score 0, verdict `ok`. Spec §5.3: "No verdict is ever inferred from partial data." When `cur` is not finite, return `verdict: "unavailable"` with a flag `{ name: "bad_share_price", value: String(v.sharePrice), threshold: "finite", window: "now" }` and score 0, like the `stale_data` branch. Test in `risk.test.ts`.
d. **Dashboard outside the root typecheck gate.** `package.json:7`: add `&& bun x tsc -p packages/dashboard/tsconfig.json --noEmit`. Verify it passes; if Next's tsconfig needs an adjustment for a plain `tsc` run, make the smallest one and say so in the report.
e. **`readSinkCursorBlock` swallows every error.** `packages/core/src/substreams/reader.ts:30-34`: the bare `catch { return null }` makes a database outage look like "chain not indexed yet". Keep returning null, but log one `console.warn` line for any error other than Postgres `42P01` (undefined table), naming the chain id; never log the query or connection string. `reader.test.ts` must still pass.

In F5's tests, assert the flag's `threshold` string is exactly `"0.200000"` (the plan-mandated literal) on the daily-only case.

## Report contract

Write the full report to `.superpowers/sdd/2026-09-09-vaultradar/final-fix-report.md` (relative to this worktree root): per item F1-F10, the commit hash, what changed, which tests were added, and anything you deviated on with the reason. Return only: status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), the commit list, one line of test counts (`bun test`, `bun run typecheck`, dashboard build), and concerns.
