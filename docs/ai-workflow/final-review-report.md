# VaultRadar, final whole-branch review

Reviewer: senior code review pass, read-only on `.worktrees/hardening`.
Range: base `c4c3b2c` → head `ae54a8d` (84 commits, 173 files, 23 619 insertions).
Date: 2026-09-10.

Nothing in this review mutated the working tree, the index, HEAD or branch state. No network
calls were made. Verification commands run: `bun test`, `bun run typecheck`, and a separate
`bun x tsc -p tsconfig.json --noEmit` inside `packages/dashboard`.

---

## Passes performed

1. **Spec, plan, ledger.** Spec §1-13 read in full. All 21 `minor (deferred` lines and all 31
   `Ruling:` lines extracted from the ledger. Note the ledger is at
   `/Users/rahuljaguste/pq/ethonline-20206/.superpowers/sdd/2026-09-09-vaultradar/progress.md`
   (the main checkout), not in this worktree as the review brief stated.
2. **`packages/core`.** Every source file: `canonical.ts`, `pq/keys.ts`, `pq/seal.ts`,
   `pq/sign.ts`, `envelope.ts`, `receipts.ts`, `pricing.ts`, `risk.ts`, `unify/*`,
   `standardized/*`, `substreams/reader.ts`, `util/bytes.ts`.
3. **`packages/service`.** Every source file: `app.ts`, `config.ts`, `main.ts`, `keys.ts`,
   `wellknown.ts`, `admin.ts`, `metrics.ts`, `hcs.ts`, `erc8004.ts`, `handlers/scan.ts`,
   `rails/hedera.ts`, `rails/arc.ts`, `data/provider.ts`, plus `scripts/identity.ts`.
4. **`packages/agent`.** `client.ts`, `policy.ts`, `watch.ts`, `tools.ts`, `runs.ts`,
   `balances.ts`, `erc8004.ts`, `rails/{hedera,arc,quote}.ts`, `cli.ts`.
5. **`packages/dashboard`.** `lib/{scan,spend,ratelimit,process-state,service,onchain,admin,types}.ts`,
   `app/verify/page.tsx`, `app/runs/[id]/page.tsx`, `app/admin/page.tsx`, `app/portfolio/*`.
6. **`substreams/erc4626-vault-metrics`.** `schema.sql`, `substreams.base.yaml` import pinning,
   `net_flow` / `net_deposited_assets` semantics in `src/lib.rs`.
7. **Cross-package shape checks.** Agent card ↔ `AgentCardSchema`; `RunRecord` agent ↔ dashboard
   (diffed field by field); pricing constants ↔ all five quote paths; admin metrics JSON ↔ the
   dashboard admin page types; `HcsSink` ↔ its test fakes; `Receipt`/`Attestation` ↔ client
   verifier ↔ `/verify` page.
8. **Verification.** `bun test`: 416 pass, 1 skip, 0 fail, 1860 assertions, 41 files, 12.07 s.
   `bun run typecheck`: clean. Dashboard `tsc --noEmit`: clean. Env-var cross-check of
   `.env.example` against every `process.env` read. Commit-trailer audit of all 84 commits.

---

## Strengths

- **The sealed-request check split is genuinely well engineered.**
  `checkSealedRequestPrePayment` / `checkSealedRequestPayer` / `commitNonce` exist because Circle
  settles before the handler and Hedera settles after. Both orderings are traced against the
  compiled vendor source (`@circle-fin/x402-batching` 3.4.0's `dist/server/index.js`, `@x402/core`'s
  `settlePayment`), the reasoning is recorded in the comments rather than lost, and replay defence
  is tested on both rails in both clear and sealed modes.
- **Tests are real, not mocks.** Real seeded ML-DSA-65 and ML-KEM keypairs, real Express apps bound
  to real ports, the real `@x402/express` and `@circle-fin/x402-batching` middleware driven against
  an in-process fake facilitator HTTP server, and a real `GatewayClient` in the Arc paid-path test.
  The single skipped test is the env-gated live one, exactly as expected.
- **The `/verify` page gets the key binding exactly right** and documents why, including the
  empty-anchor-list fail-open that it explicitly closed.
- **The spend ledger's reserve / settle / release protocol** closes a real concurrent-burst hole,
  and `chargedMicroUsd` taking the max of quote and receipt price is the correct direction for a
  spending cap.
- **The deployment verification gate pins on first run and never overwrites**, turning an upstream
  re-point into a reviewable decision rather than a silent follow. The comment explaining why the
  previous version was inert is worth keeping.
- **Commit hygiene.** 83 of 84 commits carry
  `Claude-Session: https://claude.ai/code/session_01GP7VEZFF8kYLm28Syzbar8`. The one exception is
  `31b023e`, a bare `git merge` default message with no body.

---

## Issues

### Critical (Must Fix)

#### C1. The ERC-8004 anchor does not bind the key that actually signs, two independent bypasses

**Where:** `packages/agent/src/client.ts:261` (the comparison), `packages/agent/src/client.ts:257`
(what `checkSig` does bind), `packages/agent/src/watch.ts:241-248` (`identityRefusal`), and
`packages/dashboard/lib/scan.ts:281-291` (the dashboard's real-money route inherits both).

**What is wrong.** `discover()` sets

```ts
const sigPk = fromB64(card.pq.sig.public_key);
const cardSignatureValid = checkSig(raw as { sig?: Sig }, sigPk);       // line 257
...
matches: hash == null ? null : hash === card.pq.sig.pub_hash            // line 261
```

`checkSig` binds `card.sig.pub_hash` (the card signature's own label) to `sha256(sigPk)`. That is
good hardening and was added deliberately. But the on-chain comparison at line 261 uses
`card.pq.sig.pub_hash`, a **different field**, which nothing in the codebase ever binds to
`sigPk`. It is a free-text claim the card makes about itself.

**Bypass A, substituted key with a borrowed hash.** An impostor who can answer for the service URL
serves a card with:

- `pq.sig.public_key` = attacker key `A`
- `sig` = `{ alg, pub_hash: sha256(A), value: sign(body, A_priv) }` → `cardSignatureValid === true`
- `pq.sig.pub_hash` = the **real** service's pinned hash `X`

Then `readPqHash` returns `X` from chain, line 261 compares `X === X`, and `matches === true`. Both
identity checks report success. Every receipt and attestation in the session is then verified
against `A`, i.e. against the impostor, and the agent pays the impostor.

**Bypass B, empty identity list.** `identityRefusal` refuses only when some entry has
`matches === false`:

```ts
const mismatch = disc.onChain.find(e => e.matches === false);
```

`card.erc8004` is attacker-controlled. An impostor card with `erc8004: []` produces an empty
`onChain`, so there is nothing to mismatch, `identityRefusal` returns `null`, and the agent pays
with no on-chain check having happened at all. `matches: null`, returned by `readPqHashOnChain`
for an unknown chain id **or any RPC failure**, also proceeds, so an attacker who can make the
Hashio/Arc RPC read fail gets the same outcome.

**Why it matters.** This is spec §3 threat 5 verbatim ("Key substitution during discovery ... a
registration file served from the same host cannot rule that out. Mitigation: the ML-DSA public-key
hash is written on-chain ... discovery reads it from the chain"). As shipped, discovery reads the
chain and then compares it to the card. The README boundary statement's claim that "the anchor
protects discovery today" is not true of the paying path. It is also the designated WOW item for
the finalist criteria, and the first thing a security-minded judge would probe.

**Blast radius.** Two consumers, both of which spend money:
`packages/agent/src/watch.ts` / `tools.ts` (the agent CLI and the Claude Agent SDK tools), and
`packages/dashboard/lib/scan.ts:281-291` (the `/portfolio` server-side paid scan, which filters
`discovery.onChain` on `matches === false` and so inherits both bypasses unchanged).

**Not affected: the `/verify` page.** `packages/dashboard/app/verify/page.tsx:100-126` does it
correctly and is the model to copy. It computes `publishedHash = sha256Hex(publicKey)`, requires
**both** `card.pq.sig.pub_hash` and `receipt.sig.pub_hash` to equal it, passes `publishedHash`
(not a card field) into `checkAnchor`, takes the identity list from the receipt's **signed**
`service.erc8004` rather than from the live card, cross-checks those identities against the card,
and treats an empty list as `UNPROVEN` rather than verified. Its comment even names the exact hole
the agent still has: *"Reading them off the card let the impostor supply an empty list and skip the
on-chain check altogether, and an empty list used to read as verified."* The fix was applied on one
side of the repo and not the other.

**Fix.** In `packages/agent/src/client.ts` `discover()`:

1. `const publishedHash = sha256Hex(sigPk);`
2. Throw (or set a hard-fail flag) when `card.pq.sig.pub_hash.trim().toLowerCase() !== publishedHash`
, the card must not be able to advertise a hash that is not its own key's.
3. Change line 261 to compare against `publishedHash`, not `card.pq.sig.pub_hash`.

Then in `packages/agent/src/watch.ts` `identityRefusal`, fail closed: refuse when `disc.onChain` is
empty, and refuse unless at least one entry has `matches === true`. Keep `matches: null` reported
distinctly in the run record so an operator can tell "could not verify" from "mismatch", but do not
let it authorise a payment.

Both call sites inherit the fix with no change of their own. Add two adversarial tests: a card whose
`pq.sig.pub_hash` differs from `sha256(public_key)`, and a card with `erc8004: []`. Neither case is
covered today, `packages/agent/test/client.test.ts` only ever builds cards through the real
`buildAgentCard`, where the two fields always agree.

---

### Important (Should Fix)

#### I2. `tvl_outflow_24h` double-counts, so it fires at roughly half its documented threshold

**Where:** `packages/core/src/risk.ts:56-60`, with the inputs built at
`packages/core/src/standardized/map.ts:47-50` (yield) and `76-79` (lending).

**What is wrong.** `risk.ts` sums every history point inside a 24-hour window:

```ts
const flows = v.history.filter(h => nowTs - Number(h.timestamp) <= 86400 && h.netFlowAssets != null)
                       .map(h => Number(h.netFlowAssets));
if (bal && flows.length) {
  const out = -flows.reduce((a, b) => a + b, 0) / bal;
  if (out >= 0.2) { ...; score += 25; }
}
```

But `history` for Messari sources is the **hourly and daily snapshot series concatenated** (24 hourly
points plus 8 daily points, merged and re-sorted). The 24 hourly points already telescope to the
full 24-hour change. The newest daily point also falls inside the 86 400-second window and carries
approximately the same change again.

- Yield: `netFlowAssets` is an adjacent-point diff of `inputTokenBalance` **within** a series. Summing
  the hourly diffs gives the 24 h change; adding the newest daily diff adds a second full-day change.
- Lending: `netFlowAssets` is `hourlyDepositUSD - hourlyWithdrawUSD` for hourly points and
  `dailyDepositUSD - dailyWithdrawUSD` for daily ones, so the day's flows are counted in both series.

**Failure scenario.** A vault with a genuine 11 % 24-hour outflow reports roughly 22 %, crosses the
documented 20 % threshold, gains 25 points, and a vault that should read `ok` reads `watch`, or a
`watch` becomes an `alert` and the agent emits `withdraw` on a healthy position. The flag's `value`
field, which the agent cites verbatim in its decisions and the dashboard renders, is wrong by about
2×.

**Spec conflict.** §5.3 specifies "yield uses the 24 h change in `inputTokenBalance` relative to the
current balance", a change, not a sum over merged series.

**Correct by contrast:** the Substreams path. `src/lib.rs:339` folds `net_flow` over **one block's**
events, so `vault_metrics.net_flow_assets` is genuinely per block and summing it over 24 hours is
right. Only the Messari path is affected.

**Untested.** Every case in `packages/core/test/risk.test.ts` uses a single-point history, so nothing
exercises the merged hourly+daily shape the mappers actually produce.

**Fix.** Add a `series: "hourly" | "daily"` field to `HistoryPoint`, and in `computeRisk` compute the
outflow from one series only, preferring hourly when any hourly point is present. Add a test with a
realistic 24-hourly-plus-8-daily history and assert the ratio equals the single-series figure.

#### I3. The `scan-hbar` receipt misstates both price and asset

**Where:** `packages/service/src/rails/hedera.ts:239-242` (the price function) against
`packages/service/src/handlers/scan.ts:190-192` and `:205` (the receipt).

**What is wrong.** `/hedera/v1/scan-hbar` is priced in tinybars of the native asset:

```ts
const hbarPrice = (ctx) => ({ asset: "0.0.0", amount: String(countFromCtx(ctx) * 1_000_000) });
```

but it is mounted with `tier: "scan"`, and the handler's receipt construction branches only on
`d.rail`:

```ts
const amount = d.rail === "hedera"
  ? d.tier === "scan" ? hederaScanPriceAtomic(count) : ...
price: { amount, asset: d.rail === "hedera" ? d.config.hedera.usdcToken : "USDC", rail: d.rail }
```

So for a 2-vault HBAR purchase the payer transfers 2 000 000 tinybars of `0.0.0`, and the signed
receipt records `amount: "2000"`, `asset: "0.0.429274"`.

**Failure scenario.** That receipt is ML-DSA-signed, committed to HCS, and designed to be verifiable
by an auditor years later. It states a USDC amount and a USDC token id for a payment made in HBAR.
An auditor reconciling receipts against on-chain transfers finds a 1000× discrepancy and no USDC
transfer at all. The route is advertised on the agent card as `endpoints.hedera.scanHbar`, so it is
discoverable and callable.

**Fix.** Thread the settled asset and amount into `HandlerDeps` (the rail knows both at mount time)
and use them in `buildReceipt`. Or delete the route and its card entry: the only consumer it was ever
intended for, the Tier 3.5 `x402Probe` harness validator, was cut, and the README says so.

#### I4. The README understates what shipped, in three places

**Where:** `README.md:152`, `README.md:219`, `README.md:12`.

- `README.md:152`, "The `watch` command and its policy file are Tasks 22 and 23, specified but not
  yet built. The client library underneath them is built and tested." Both are built, tested
  (`packages/agent/test/{watch,policy,cli,tools}.test.ts`), and are what `demo.sh` steps 3 and 4
  actually run.
- `README.md:219`, "**In flight at the time of writing.** The HCS commitment queue, the ERC-8004
  registration script, the Arc rail, the Fly deployment, and the agent policy and CLI are specified
  in `docs/superpowers/plans/...` and described above in future tense." Four of those five shipped
  (`hcs.ts`, `scripts/identity.ts`, `rails/arc.ts`, `policy.ts` + `cli.ts`). Only the Fly deployment
  is genuinely outstanding.
- `README.md:12`, "the Circle Gateway rail (in progress, see scope notes)". Complete, with 502 lines
  of tests in `packages/service/test/arc-rail.test.ts`.

**Failure scenario.** A judge reads the README as the map of what shipped and is told five delivered
components are unfinished. The damage lands precisely on the two tracks those components serve: Arc
Agentic Economy (the Arc rail) and The Graph AI Use Case (the policy-driven agent). This is stale
Task-25 draft text that predates the Tasks 17-23 merges; the honesty section has become dishonest in
the understating direction.

**Fix.** One truth pass over those three lines. Keep the genuinely-cut items in the scope notes (the
harness PR, HCS-14 UAID, Falcon, upstream x402) exactly as they are, those are accurate and well
written.

#### I5. Every deployment ships unpinned, contradicting the README's central Graph claim

**Where:** `packages/core/src/standardized/deployments.json` (all 15 entries) against `README.md:68`.

**What is wrong.** All 15 registry entries carry `deploymentId: null` and `status: "unverified"`,
with `headLagSeconds: null` and `verifiedAt: null`. `gatewayUrl`
(`packages/core/src/standardized/gateway.ts:5-9`) therefore takes the fallback branch for every
query:

```ts
return d.deploymentId
  ? `https://gateway.thegraph.com/api/deployments/id/${d.deploymentId}`
  : `https://gateway.thegraph.com/api/subgraphs/id/${d.subgraphId}`;
```

`README.md:68` states: "Every query goes to the pinned `deploymentId`, never a subgraph name, so a
re-point cannot silently change the data underneath a risk verdict." As the registry ships, every
query goes to the subgraph id and a re-point would silently change the data.

**Failure scenario.** A judge evaluating the Composable / Standardized track opens
`deployments.json`, sees fifteen nulls, and the track's headline claim is contradicted in ten
seconds.

**Root cause is benign.** `scripts/verify-deployments.ts` is correct and well designed, it pins on
first run (`reconcile`'s `existing.deploymentId === null` branch) and thereafter compares rather than
overwrites, reporting `status: "repointed"` and leaving the pin alone. It has simply never run,
because it requires `GRAPH_STUDIO_API_KEY`.

**Fix.** Either run `bun run verify-deployments` once credentials exist, which populates all 15 pins
and the `<<FILL: live/total count>>` marker on the same line, or reword line 68 to "Every query goes
to the pinned `deploymentId` once the verification gate has run; until then the registry resolves by
subgraph id." The first is preferable and is a prerequisite for §9 success criterion 3 anyway.

#### I6. The dashboard persists actionable decisions derived from an unverified receipt; the agent does not

**Where:** `packages/dashboard/lib/scan.ts:333-343` against `packages/agent/src/watch.ts:373-397`.

**What is wrong.** The dashboard builds and persists the run record **before** checking validity:

```ts
const record = buildRecord({ result, discovery, policy, hash, age, serviceUrl, startedAt });
persist(deps, record, secrets);

if (!result.receiptValid)      return json({ error: "...receipt did not verify", runId: record.id }, 502);
if (!result.attestationsValid) return json({ error: "...attestations did not verify", runId: record.id }, 502);
```

`buildRecord` calls `decide(result, age)`, which emits `hold` / `withdraw` / `rebalance` per vault.
The agent, in the identical situation, returns `ok: false` and carries **no** decisions from the
failed purchase.

**Failure scenario.** A service returns a receipt whose ML-DSA signature fails. The HTTP caller gets
a 502, so the browser shows an error, but `runs/web-<hex>.json` now holds full actionable decisions.
`RunRecord` has no field to mark them unverified (deliberately, to keep the cross-package contract),
and `app/runs/[id]/page.tsx:32-38` renders card-signature and anchor status but nothing about receipt
or attestation validity. So `/runs/<id>` displays `withdraw` recommendations, with citations, derived
from data whose signature failed, and they look identical to verified ones. That is the one artifact
an operator would consult after the fact.

**Fix.** Compute validity first and build the record with `decisions: []` when either check fails,
mirroring the agent. The existing `buildFailedRecord` helper already demonstrates the right
vocabulary if you would rather emit one `insufficient data` decision per vault carrying the reason.

#### I7. `quote()` is local arithmetic, not the unpaid 402 probe the spec names

**Where:** `packages/agent/src/client.ts:274-279`.

**What is wrong.** `quote(count)` returns `hederaScanPriceUsd(count)` and
`ARC_BUCKET_PRICE[arcBucket(count)]` computed from shared `@vaultradar/core` constants. It never
contacts the service. Spec §5.6 defines the tool as `quote(request)`, "(unpaid 402 probe per rail)".

**Why it is Important rather than Critical.** The security goal the probe would serve is met
elsewhere and better: `quoteCeilingPolicy` (Hedera) and `arcQuoteCeilingHook` (Arc) both check the
402's actual demand against the same quote before anything is signed, and `checkSettledPrice`
re-checks the receipt afterwards. So the agent cannot be overcharged. What is missing is fidelity and
demonstrability: `demo.sh` step 2 shows a 402 probe that the client itself never performs, and
`vaultradar_quote`'s tool description tells the model it is pricing against the service when it is
pricing against a local constant.

**Fix.** Either issue a real unpaid POST and decode the `PAYMENT-REQUIRED` header (a dozen lines, and
it would surface a service/agent price disagreement before any payment), or state plainly in the
README and the tool description that quoting is local and the 402's demand is checked at payment
time.

---

### Minor (Nice to Have)

- `packages/service/src/data/provider.ts:172-188`, a `table` request for an unknown protocol returns
  an empty body for a full $0.06. Validate `protocol` against `DEPLOYMENTS` before the data call so
  Hedera's pre-settlement 422 makes the mistake free.
- `packages/service/src/admin.ts:47`, admin token compared with `!==`. Use the constant-time loop
  already written in `packages/dashboard/lib/scan.ts:113-116`.
- `packages/service/src/data/provider.ts:195-206`, the 60-second per-chain `chainCache` keeps serving
  `fresh`-marked vaults for up to a minute after the head RPC starts failing, against spec §7's
  "Chain head RPC failure: every source on that chain stale". Bounded and in only one direction, but
  it is a stated rule.
- `packages/core/src/risk.ts:46`, a non-numeric `sharePrice` makes `cur` `NaN`, every drawdown
  comparison false, and the vault scores 0 and reads `ok`. Spec §5.3: "No verdict is ever inferred
  from partial data." Return `unavailable` when `cur` is not finite.
- `.env.example:20` declares `HEDERA_NETWORK=testnet`, which nothing reads; `config.ts:59` hardcodes
  `network: "testnet"`. Either read it or drop it.
- `.env.example:32`, the `ADMIN_TOKEN=` comment says "unset means no /admin view". Unset actually
  means the service answers 503 `admin_disabled` while the dashboard page still renders and explains
  the misconfiguration. (This is the Task 28 deferred minor; worth the one-line correction.)
- The root `typecheck` script covers core, service and agent only. The dashboard typechecks clean
  today but sits outside the gate; add a fourth `tsc -p packages/dashboard/tsconfig.json --noEmit`.
- `packages/agent/src/policy.ts:92-94`, the comment calls Hedera "the cheaper rail at every bucket
  size". Arc is cheaper at 5 ($0.003 vs $0.0035), 20 ($0.01 vs $0.011) and 100 ($0.05 vs $0.051). The
  sort picks correctly; only the comment is wrong.
- `scripts/demo.sh:12`, the header comment still says steps 3, 4 and 5 drive pieces "specified but
  not yet built". The `run_or_show` guards now find all three entrypoints and the steps run.
- `packages/service/src/rails/hedera.ts:55,73`, `verifiedPayerByTxKey` and `receiptByTxKey` are
  module-level, so two rails mounted in one process share them. Harmless in production (one mount),
  theoretically cross-correlating in a multi-app test process.
- `packages/core/src/canonical.ts:9-10`, integers above 1e21 serialise via `String()` as `1e+21`.
  Deterministic, so round-trip hashing is safe, but not the form a foreign canonicaliser would
  produce.
- `packages/core/src/substreams/reader.ts:32-34`, `readSinkCursorBlock`'s bare `catch { return null }`
  makes a genuine database outage indistinguishable from "this chain is not indexed yet". One log line
  on an unexpected error code would pay for itself during the demo.
- Spec-level, not implementation: §13.1 places the admin token server-side in the dashboard, which
  makes `/admin` readable by anyone who can reach the dashboard. Implemented exactly as specified;
  worth a deploy-time note, or put the page behind the same `SCAN_ACCESS_TOKEN` pattern
  `lib/scan.ts` already has.

---

## Deferred-minor triage

One line per `minor (deferred` item in the ledger.

| Ledger item | Verdict |
|---|---|
| Task 1: root typecheck / verify-deployments reference packages later tasks create | leave, all packages now exist; the real remaining gap is the missing dashboard, listed under Minor |
| Task 2: `canonical.ts:9` `Number.isInteger` nuance | leave, deterministic; exponent form only matters against a foreign canonicaliser |
| Task 11: blanket `#[allow(dead_code)]` on `mod pb`; `package.url` placeholder; committed `Cargo.lock` / `buf.gen.yaml` / `.last_generated_hash` | leave, the placeholder fills with the public repo URL; committing the lockfile is correct |
| Task 3: `kidOf` duplication; KEM determinism assertion | leave, folded already |
| Task 3: `attachSig` has no null guard; `lengths.seed ?? 96` dead fallback | leave, producer-side, non-adversarial |
| Task 12: `RpcBatch` / `HashSet` shape duplicated; BigInt zero-fallback boilerplate | leave, style |
| Task 5: duplicated vaults cast; empty-sources receipt untested | leave |
| Task 6+7+8: pricing no-exponent test rationale; hard-coded `"0.200000"` threshold string | leave (plan-mandated), but note this is the very threshold issue I2 breaks, so fixing I2 should assert against it |
| Task 6+7+8: outer deposit-limit gate uses `Number()` truthiness; negative `depositLimit` quirk | leave, a `"0"` limit is not a limit; pre-existing semantics |
| Task 13: duplicated NULL-skip block in `db_out`; crate-wide clippy allow | leave |
| Task 9+10: mapper duplication; two `Meta` types; sequential per-vault history queries; 44-char ids | leave, the sequential history queries are the only one with a cost, bounded by the 100-row LIMIT |
| Task 14: no `afterAll` server close in test; `/v1/receipts/:hash` 64-hex validation; PORT NaN guard; top-level test setup | leave, the hex validation was in fact done (`wellknown.ts:16,85`); PORT NaN yields a random port, cosmetic |
| Task 9+10: `readSinkCursorBlock` catch swallows all errors | leave, but see the Minor entry, one log line is cheap and pays off during a live demo |
| Task 14: per-route `cors()` does not answer OPTIONS preflight | leave, verified no browser client preflights these routes; `/verify` and `/admin` use simple GETs and server-side fetches |
| Task 15: duplicate local `count` names in `scan.ts`; table price derived from `TABLE_PRICE_USD`; RPC failures unlogged; catalog `vaultCount` from the 60 s cache | leave, all documented accepted deviations |
| Task 21: `ensureDiscovery` no in-flight dedupe; `listRuns` no shape check; `AgentCardSchema.arc.scan` lacks passthrough | leave, every caller is sequential; the inner `scan` object genuinely has a fixed shape |
| Task 16: duplicated validation predicates; microtask-ordering argument only in a comment | leave, the comment is unusually thorough and traces the vendor source |
| Task 22+23: `watch.ts` mixes formatting concerns; chat untested | leave, scoped out deliberately |
| Task 17+18: redundant `getReceipt` before `getRecord`; agent `erc8004.ts` same non-fatal decode pattern | leave, the agent decode is in fact strict (`fatal: true` + `PUB_HASH_RE`) and tested |
| Task 22+23: tools' top-level `receipt_hash` / `tx_id` describe payment 1 while `price_usd` sums all; `missingVaultDecisions` cites empty block/source | leave, the `note` field mitigates the first; the second is honest about having looked at nothing |
| Task 28: large single files (`scan.ts`, `ScanForm.tsx`, `admin/page.tsx`); `.env.example` comment overstates `/admin` | **fix the `.env.example` line before merge** (one line, listed under Minor). Leave the file sizes. |
| Task 19+27: Arc check-then-commit nonce gap under concurrent identical paid requests | leave, the attacker pays twice for the same answer; no fund loss to the service, and it is documented |
| Task 29: `discover()` timeout in the dashboard scan route (reservation held while a service hangs) | **defer**, see below |
| Task 29: Arc hook should register even for a `"0"`/empty quote (fail closed) | **fix now**, see below |
| Task 29: `watch.ts:148` comment draws the wrong conclusion | **defer**, see below |

### The three Task 29 items, in detail

1. **`discover()` timeout in the dashboard scan route, defer.**
   `packages/dashboard/lib/scan.ts:274` calls `client.discover()` with no timeout while holding a
   spend reservation taken at line 248. A service that accepts the TCP connection and never answers
   holds the reservation and one hourly scan slot indefinitely, and the HTTP request hangs until the
   platform's own limit. It **fails closed on money**, a held reservation suppresses spending rather
   than enabling it, so the impact is availability only, and only for a deployment pointed at a
   hanging service. `packages/dashboard/lib/service.ts:65-81` already has the
   `AbortController` + `SERVICE_FETCH_TIMEOUT_MS` pattern to copy if you want it cheaply; the clean
   fix is an `AbortSignal` threaded through `VaultRadarClientOpts.fetchImpl`.

2. **Arc ceiling hook not registering for a `"0"` / empty quote, fix now.**
   `packages/agent/src/rails/arc.ts:81`:

   ```ts
   if (quoteAtomic) gateway.onBeforePaymentCreation(arcQuoteCeilingHook(quoteAtomic));
   ```

   A falsy `quoteAtomic`, `""`, or `"0"` from a future pricing path, registers **no**
   `onBeforePaymentCreation` hook at all, and `gateway.pay` then signs an EIP-3009 authorization for
   whatever the 402 demands. Circle's client has no equivalent of `@x402/core`'s default $1 spend
   control, so on that rail this hook is the *only* ceiling, and Arc settles before any handler can
   object. A guard that silently disables the sole ceiling on a falsy input is the wrong default for
   a money path. Change to `if (quoteAtomic !== undefined)`. One line. (`"0"` would then correctly
   refuse any non-zero demand, which is the fail-closed behaviour you want.)

3. **`watch.ts:148` comment draws the wrong conclusion, defer.**
   Comment-only. The arithmetic it sits above (`quoteFor`'s integer micro-USD multiplication) is
   correct, and the comment already carries its own self-correction about the `0.03 * 3` example.

---

## Recommendations, in order

1. **Fix C1 first.** Four lines in `discover()` plus a fail-closed `identityRefusal`. It is the
   mitigation spec §3 threat 5 names, the README asserts it works today, it is the designated WOW
   item, and the correct implementation already exists in `app/verify/page.tsx` to copy from. Add the
   two adversarial card tests while you are there.
2. **Apply the one-line Arc ceiling guard.** Smallest possible change protecting the rail with the
   weakest post-hoc recourse.
3. **Fix I2.** Add one merged-series risk test; it is the only risk rule with no coverage of the data
   shape the mappers actually emit, and it is what makes the 20 % threshold in the README true.
4. **Do a single docs truth pass:** README lines 12, 68, 152, 219, the `.env.example` admin comment,
   and the `demo.sh` header. All six are checkable against the code in under a minute each, and five
   of them currently understate or misstate shipped work.
5. **Decide on `scan-hbar`:** thread the real asset and amount into the receipt, or delete the route
   and its agent-card entry now that the harness PR is cut. Leaving a signed receipt that misstates
   the currency is worse than not shipping the route.
6. **Add the dashboard to `bun run typecheck`.**
7. Before the demo, run `bun run verify-deployments` as the first step once the Studio key exists,
   it populates the 15 pins, the `headLagSeconds` values, and the live/total count the README needs.

---

## Assessment

**Ready to merge?** With fixes.

**Reasoning.** The engineering quality is high and the test suite is honest: 416 real tests with real
post-quantum crypto and real payment middleware against in-process facilitators, a clean typecheck
across all four packages, and payment-path hardening that traces vendor internals rather than guessing
at them. The blocking problems are narrow and specific. The on-chain key anchor, which spec §3 names
as the mitigation for key substitution and which the README asserts protects discovery today, can be
bypassed two ways in the agent and in the dashboard's real-money route, while the same repo's
`/verify` page implements the check correctly. `tvl_outflow_24h` fires at about half its documented
threshold because two snapshot series are summed as one. Both are small, well-localised fixes with an
existing correct implementation or a clear spec sentence to aim at. The one-line Arc ceiling guard
should go in with them. The docs truth pass is not a correctness issue but it is the cheapest credit
on the board, because the README currently tells judges that five delivered components are unfinished.
