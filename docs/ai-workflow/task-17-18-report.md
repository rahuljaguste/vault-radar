# Task 17+18 report: HCS commitment queue and identity bootstrap

## Status: DONE_WITH_CONCERNS

Both tasks are code-complete, tested, and committed on `ws/service`. "Concerns" is for the
live/credential-gated steps that cannot run in this sandbox (same pattern as Tasks 16/24) and a
couple of judgment calls made where the brief's pseudocode needed adjustment for testability or
to avoid a conflict with already-merged Task 16/21 code.

Commits (in `.worktrees/service`, branch `ws/service`):
- `7f2dbe0` — feat(service): HCS commitment queue with retry and receipt lookup
- `bb85376` — feat(service): ERC-8004 registration with on-chain PQ key hash; HCS topic bootstrap
- `8cb0658` — merge: main into ws/service (docs Task 25 draft: README, SKILL.md, demo script)
- `885c60e` — fix(service): skill.md route now reflects the published SKILL.md, not a 404 stub
- `6f99a20` — merge: main into ws/service (dashboard user/admin views docs, spec §13)

Note on the briefs: `task-17-brief.md` was found at
`.superpowers/sdd/2026-09-09-vaultradar/task-17-brief.md` as pointed to, but `task-18-brief.md`
did not exist there — it only existed in `.worktrees/core/.superpowers/sdd/2026-09-09-vaultradar/task-18-brief.md`
(a different worktree). Read from there; flagging in case that directory is meant to be kept in
sync across worktrees.

---

## Task 17: HCS commitments and receipt lookup

### What I implemented

- `packages/service/src/hcs.ts` (new):
  - `HcsQueue` — `enqueue(receipt)` is synchronous (pushes to an in-memory array, kicks off a
    drain loop, returns `void`); `drain()` retries the head-of-queue message forever on failure
    (fixed delay) and never drops it; `lookup(hash)` checks the in-memory `done` map first, then
    falls back to `mirrorLookup`, then a null-sequence record. `pending()` reports queue depth.
  - `makeHederaSubmit(config)` — built from the brief's own pseudocode almost verbatim
    (`TopicMessageSubmitTransaction` → `getReceipt` → `getRecord` for the sequence number,
    consensus timestamp, and transaction id).
  - `mirrorLookup(topicId, hash, fetchImpl?)` — pages
    `https://testnet.mirrornode.hedera.com/api/v1/topics/{id}/messages?limit=100&order=desc`,
    follows `links.next` up to 5 pages, groups messages by `chunk_info.initial_transaction_id`
    (non-chunked messages get their own group keyed by `sequence_number`), waits for a group to
    have exactly `chunk_info.total` members before treating it as complete, sorts by
    `chunk_info.number`, concatenates the base64-decoded **bytes** (not decoded strings — avoids
    any risk of splitting a multi-byte UTF-8 character across a chunk boundary) before the single
    final UTF-8 decode, then matches `receipt_hash`. Never throws — any fetch/decode/parse failure
    yields `null`.
- `packages/service/src/wellknown.ts` — `GET /v1/receipts/:hash` now validates the hash is 64
  lowercase hex before doing anything else (400 `{reason: "bad_hash"}` otherwise — the Task 14
  deferred minor); the no-`hcs` stub now returns the full 5-field `LookupResult` shape
  (`consensus_timestamp`/`initial_transaction_id: null` added) so the route's response shape
  doesn't change based on server config. Removed the placeholder `HcsLookup` interface in favor
  of importing the real `HcsQueue` type.
- `packages/service/src/app.ts` — `BuildAppDeps.hcs` tightened to `HcsQueue | null`. Added an
  optional `onSettled` field to `BuildAppDeps` (see "Deviation 1" below) and, when mounting the
  Hedera rail, composes a settlement hook that calls both `deps.hcs?.enqueue(receipt)` and any
  caller-supplied `deps.onSettled`.
- `packages/service/src/main.ts` — constructs `HcsQueue` (with `makeHederaSubmit(config)`) only
  when `HEDERA_HCS_TOPIC_ID` is set; sets `rails: { hedera: Boolean(config.hedera.payToAccountId) }`;
  logs one startup line naming which rails and HCS are enabled (no secrets — see "Secret-logging
  verification" below).
- `packages/service/src/rails/hedera.ts` — **no changes needed.** The brief's file list says to
  modify this to call `onSettled`, but Task 16's implementation already added the full
  `onAfterSettle`/`onSettleFailure` hook machinery and already calls `deps.onSettled?.(receipt,
  ctx.result.transaction)` (see `task-16-report.md`, "Settlement observation" section). Verified
  by reading the current file before touching anything.

### Deviation 1: `onSettled` is composed, not replaced, in `app.ts`

The brief's resolution said main.ts should pass `onSettled: (receipt) => hcs?.enqueue(receipt)`.
I did not wire it that way, for two reasons discovered while reading the existing code:

1. **`hedera-rail.test.ts` (from Task 16) already relies on `app.ts` forwarding a caller-supplied
   `onSettled` through to `mountHederaRail` unchanged** (its `mountRail` helper builds
   `BuildAppDeps & {onSettled}` and calls `buildApp(deps)`, with a comment explaining this exact
   mechanism). If `app.ts` had replaced `deps.onSettled` with a hardcoded `hcs.enqueue`-only
   closure, three passing Task 16 tests that assert `onSettled` fires with the right receipt/txId
   would have silently stopped observing anything.
2. **Wiring `onSettled: (receipt) => hcs?.enqueue(receipt)` in `main.ts` *and* having `app.ts`
   also call `hcs.enqueue` internally would double-submit every receipt to HCS.**

Resolution: `BuildAppDeps` gained an optional `onSettled` field; `app.ts` builds one composed
closure — `deps.hcs?.enqueue(receipt); deps.onSettled?.(receipt, txId);` — so both run
independently. `main.ts` now only constructs and passes `hcs`; it never sets `onSettled` itself.
`hedera-rail.test.ts`'s existing tests keep passing unmodified (confirmed: I didn't touch that
file, and it's part of the 57 passing service tests).

### TDD evidence

- `hcs.test.ts` written first; ran with no `src/hcs.ts` present → `Cannot find module '../src/hcs'`
  (RED for the right reason). Implemented `hcs.ts`; all 7 tests passed on the second attempt — the
  first attempt had a test bug, not an implementation bug (see below).
- One test initially failed for an interesting reason worth recording: I wrote a test asserting
  `submitStarted` stays `false` synchronously after `enqueue()`, assuming `drain()`'s first
  `await` suspends before ever calling `submit`. It failed — `submitStarted` was `true`. This was
  my test's wrong assumption, not a bug: evaluating `this.deps.submit(message)` as the operand of
  an `await` calls `submit` synchronously up to *its own* first `await`/return, which set the flag
  before the Promise was even returned. Fixed the test to assert the actually-meaningful property
  (`enqueue` returns `undefined` synchronously, observable with no `await` in between) instead of
  a wrong assumption about scheduling. This is exactly the "watch it fail, understand why" step
  paying for itself — the field to protect for the "never blocks a response" claim is that
  `enqueue()` is not, and does not have to be, awaited; not that nothing runs synchronously.
- `wellknown.test.ts`: added the `bad_hash` test and rewrote the null-stub test to use a real
  64-hex hash before touching `wellknown.ts`; ran → 2 failures for the expected reasons (400 vs
  200 returned; the null-stub was missing the two new fields). The third new test (hit/miss via a
  real `HcsQueue`) passed immediately even pre-implementation, because it only exercises the
  already-correct `if (hcs) res.json(await hcs.lookup(hash))` branch — noted this rather than
  treating an unexpectedly-passing test as a red flag without checking why.
- Commands:
  ```
  $ bun test packages/service/test/hcs.test.ts
  7 pass, 0 fail, 19 expect() calls
  $ bun test packages/service/test/wellknown.test.ts
  9 pass, 0 fail (after the fix + additions)
  $ bun x tsc -p packages/service/tsconfig.json --noEmit
  (clean, exit 0)
  $ bun test packages/service
  48 pass, 1 skip, 0 fail (at the Task 17 commit point)
  ```

### Files changed
- `packages/service/src/hcs.ts` (new)
- `packages/service/test/hcs.test.ts` (new)
- `packages/service/src/app.ts`, `src/wellknown.ts`, `src/main.ts` (modified)
- `packages/service/test/wellknown.test.ts` (modified)

---

## Task 18: Identity bootstrap

### What I implemented

- `packages/service/src/erc8004.ts` (new) — `ERC8004_ABI`, `CHAINS`, `PQ_KEY`, `readPqHash`, all
  matching the brief. **One additive signature change**: `readPqHash(chainId, agentId, rpcUrl,
  transport?)` takes an optional 4th `viem.Transport` parameter (default `http(rpcUrl)`), purely
  so tests can inject a fake `custom()` transport instead of hitting the network. Verified this is
  safe by grepping `readPqHash` across every worktree: nothing outside `packages/service` imports
  it — the agent package (Task 21) built its own independent `readPqHashOnChain` in
  `packages/agent/src/erc8004.ts` rather than importing this one, so there is no external caller
  whose call signature I could break.
- `packages/service/scripts/identity.ts` (new) — HCS topic creation (skipped when
  `HEDERA_HCS_TOPIC_ID` is already set, or when `HEDERA_OPERATOR_ID`/`HEDERA_OPERATOR_KEY` are
  missing) and on-chain `register()` on both `CHAINS` entries, printing `HEDERA_HCS_TOPIC_ID=`,
  `ERC8004_HEDERA_AGENT_ID=`, `ERC8004_ARC_AGENT_ID=` lines to paste into `.env`. Exports
  `agentUriFor` and `buildRegisterCalldata` (pure helpers) for testability, and only runs `main()`
  under `if (import.meta.main)` so importing the module for tests has no side effects and doesn't
  require any env var to be set.
  - `--dry-run` computes and prints `agentURI=` and `calldata=` for both chains, using
    `encodeFunctionData` directly — no deployer key, no HCS call, no chain/network access at all.
- `.env.example` — appended `DEPLOYER_KEY_HEDERA=` and `DEPLOYER_KEY_ARC=` under a new comment
  block near the existing `ERC8004_*` lines.

### TDD evidence

- `test/erc8004.test.ts` written first; ran with no `src/erc8004.ts` → `Cannot find module
  '../src/erc8004'` (RED). Implemented; all 5 tests passed immediately, including the fake-viem-
  `custom()`-transport test (built with `encodeFunctionResult` to produce a realistic ABI-encoded
  `eth_call` response, rather than a hand-rolled hex string) and the revert→`null` test.
- `test/identity.test.ts` written first; ran with no `scripts/identity.ts` → `Cannot find module
  '../scripts/identity'` (RED). Implemented; all 4 tests passed, including a `Bun.spawn`-based
  end-to-end test that runs the actual script with `--dry-run` and asserts the printed calldata
  line decodes (via `viem`'s `decodeFunctionData`) to the exact pub hash derived from the seed
  passed in the test's own env — not just that some output was produced. Re-ran twice more for
  flakiness (subprocess tests are the most likely to flake): clean both times, ~4–5s each.
- Commands:
  ```
  $ bun test packages/service/test/erc8004.test.ts
  5 pass, 0 fail, 9 expect() calls
  $ bun test packages/service/test/identity.test.ts
  4 pass, 0 fail, 15 expect() calls   (x3 runs, no flakiness)
  $ bun x tsc -p packages/service/tsconfig.json --noEmit
  (clean, exit 0)
  ```

### Exact live commands for the identity bootstrap (cannot run in this sandbox — no real
Hedera/Arc credentials)

```bash
# 1. Preview only — no key or network access, safe to run any time:
PQ_SIG_SEED=<hex32> PUBLIC_URL=https://your-service.example \
bun run packages/service/scripts/identity.ts --dry-run

# 2. Create the HCS topic (only if HEDERA_HCS_TOPIC_ID is not already set) and register on
#    whichever chain(s) have a deployer key. The Hedera deployer must be an ECDSA account with an
#    EVM alias (the Hedera portal's ECDSA accounts have one); Arc gas is paid in native USDC —
#    fund the deployer from faucet.circle.com (Arc Testnet).
PQ_SIG_SEED=<hex32> PUBLIC_URL=https://your-service.example \
HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=<ecdsa-hex> \
DEPLOYER_KEY_HEDERA=0x<evm-private-key> DEPLOYER_KEY_ARC=0x<evm-private-key> \
bun run packages/service/scripts/identity.ts

# Paste the printed HEDERA_HCS_TOPIC_ID=, ERC8004_HEDERA_AGENT_ID=, ERC8004_ARC_AGENT_ID=
# lines into .env, then redeploy the service so the agent card and /.well-known/erc8004.json
# carry them.

# 3. Verify the anchor (per the brief's Step 3):
bun -e 'import { readPqHash } from "./packages/service/src/erc8004"; console.log(await readPqHash("296", process.env.ERC8004_HEDERA_AGENT_ID))'
# → should print the same value as the deployed service's /.well-known/erc8004.json "pq.pub_hash".
```

`docs/verification-log.md` does not exist yet in this repo (same as Task 16 found) — not creating
a placeholder with no real content; whoever runs the live steps above should record both explorer
links (HashScan for the Hedera tx, Arc's explorer for the Arc tx) there.

### Files changed
- `packages/service/src/erc8004.ts` (new)
- `packages/service/scripts/identity.ts` (new)
- `packages/service/test/erc8004.test.ts` (new)
- `packages/service/test/identity.test.ts` (new)
- `.env.example` (modified)

---

## Self-review (both tasks)

- **Every export in both briefs exists**: `HcsQueue` (constructor, `enqueue`, `lookup`,
  `pending`), `LookupResult`, `makeHederaSubmit`, `mirrorLookup`; `ERC8004_ABI`, `CHAINS`,
  `PQ_KEY`, `readPqHash`. Confirmed by grepping the compiled test imports and by `tsc` passing.
- **The queue retries and never blocks a response**: `enqueue` returns `void` synchronously
  (tested); `drain()`'s catch branch retries the same head-of-queue message on a fixed delay
  rather than dropping it (tested with a fake `submit` that fails once then succeeds).
- **The mirror fallback reassembles chunks correctly**: tested with chunks arriving
  out-of-order within one page (proving the sort-by-`chunk_info.number` step, not array order,
  drives reassembly), and with chunks split across two pages (proving `links.next` is actually
  followed, with the exact URL sequence asserted) — plus a 5-page cutoff test and a
  null-on-no-match/on-500/on-throw test.
- **The receipts route validates input**: 400 `bad_hash` for a too-short hash, an uppercase-hex
  hash, and a non-hex-char hash, all asserted in one test; validation runs before the `hcs`
  null-check so it applies regardless of whether HCS is wired up.
- **`main.ts` wiring is guarded by env presence**: `hcs` is `null` unless
  `config.hedera.hcsTopicId` is set (itself only set from `HEDERA_HCS_TOPIC_ID`); `rails.hedera`
  is `Boolean(config.hedera.payToAccountId)`. Both read from the existing `Config` shape, no new
  parsing needed.
- **Nothing secret is logged — verified, not assumed.** I traced the actual dependency chains
  installed in this lockfile (not just the brief's code) for every place a secret-bearing call
  could throw and get logged:
  - `main.ts`'s pre-existing top-level `catch (err) { console.error("fatal:", err); }` now also
    catches failures from the `PrivateKey.fromStringECDSA(c.hedera.operatorKey)` call I added
    inside `makeHederaSubmit`. Read `@hiero-ledger/cryptography@1.19.0`'s `PrivateKey`/
    `EcdsaPrivateKey` source (the actual resolved version, via the bun install cache) down to
    where it delegates to `@noble/curves@1.9.1`'s secp256k1: every thrown message is a fixed
    string, a byte-length count, or a `typeof` — never the key value (one line in that library
    literally comments `// unsafe is fine: no priv data leaked`).
  - `identity.ts`'s `privateKeyToAccount(deployerKey)` (viem 2.56.3) delegates to the same
    `@noble/curves` secp256k1 for validation — same conclusion.
  - Every `console.log` in `identity.ts` prints only public data: env-var-not-set notices, the
    HCS topic id, the agentURI, the register() calldata (which embeds the *public* pub hash —
    the entire point of anchoring it on-chain — never a private key), agent ids, and tx hashes.
- **Tests pristine**: `bun test packages/service` → 57 pass, 1 skip (pre-existing, unrelated
  `LIVE=1`-gated test), 0 fail. `bun test` (whole workspace) → 147 pass, 1 skip, 0 fail — clean at
  the current `HEAD`. `bun x tsc -p packages/service/tsconfig.json --noEmit` → clean both times.

## Concerns

1. **Live steps not run** (no real Hedera/Arc credentials in this sandbox): HCS topic creation,
   on-chain registration on both testnets, and the `readPqHash` on-chain verification step. All
   offline code, dry-run behavior, and unit tests are complete and verified; exact commands are
   above, ready to run once secrets are available.
2. **A pre-existing, unrelated environment issue found and fixed along the way**: the first whole-
   workspace `bun test` run failed with `Cannot find module '@vaultradar/core'` from
   `packages/agent/test/client.test.ts`. Confirmed via `git stash` that this predates my changes
   entirely (fails identically with my diff removed), and confirmed via targeted runs that
   `packages/core`/`packages/dashboard`/`packages/service` were all unaffected — isolated to
   `packages/agent`'s own dependency resolution in this specific worktree. A plain `bun install`
   (no source changes; `bun.lock` diff is empty) resolved it, and the whole workspace now passes
   cleanly. Flagging in case this recurs in a fresh clone of `ws/service` — it may be worth a
   `bun install` step in whatever CI/verification runs this worktree next.
3. **`readPqHash`'s signature gained an optional 4th parameter** (`transport`) beyond the brief's
   `(chainId, agentId, rpcUrl)`. Purely additive/backward-compatible, and confirmed via search
   that nothing outside `packages/service` calls it, but noting it as a deviation from the literal
   brief text.
4. **Inherited (not introduced) design property**: `HcsQueue` is a strict single-lane FIFO —
   `drain()` retries the head-of-queue message forever on failure before ever advancing to the
   next one. A receipt that is *permanently* unsubmittable (not just transiently failing) would
   block every later-enqueued receipt indefinitely. This is the brief's own pseudocode design
   (same retry-forever shape), not something I added, and in practice every `Receipt` reaching
   `enqueue` was already built by `buildReceipt`/`attachSig`, so a permanently-malformed message
   shouldn't occur — flagging only for completeness, not proposing a fix since the brief didn't
   ask for one and it would be speculative engineering against a failure mode that can't currently
   happen.
5. **`task-18-brief.md` was missing from this worktree's `.superpowers/sdd/2026-09-09-vaultradar/`
   directory** (only Task 17's brief was there); found it in `.worktrees/core`'s copy of the same
   path instead. Noting in case other in-flight dispatches hit the same gap.

---

## Skill test fix

Per the follow-up request: merged `main` into `ws/service`, fixed the stale `skill.md` test, and
committed both as separate small commits (`8cb0658`, `885c60e`) rather than folding into the
Task 17 commit, to avoid rewriting an already-reported commit.

- **Merge**: `git merge main` produced exactly one conflict, in `.env.example` — main's docs
  branch had fully restructured/re-commented that file, while this branch had only added two
  lines (`DEPLOYER_KEY_HEDERA=`, `DEPLOYER_KEY_ARC=`) to the old version. Resolved by union: kept
  main's restructured file in full and re-inserted the two `DEPLOYER_KEY_*` lines (with their
  comment) into its `--- ERC-8004 identity ---` section. Verified every variable name from both
  sides survived (`grep -oE "^[A-Z_0-9]+=" .env.example`) and no conflict markers remain.
- **Test fix**: `packages/service/test/wellknown.test.ts`'s old "skill.md 404s until Task 25
  publishes it" test now failed with 200 (confirmed first, before changing anything — real RED).
  Replaced it with two tests: one asserting the real file is served (`200`, `content-type`
  starting `text/markdown`, body starting `---`), and one asserting `404` when a request targets a
  skill file that doesn't exist. The 404 case needed a way to point the route at a nonexistent
  path without touching the filesystem, so `mountWellKnown`'s `WellKnownDeps` (and `buildApp`'s
  `BuildAppDeps`, so the test's object literal type-checks) both gained an optional `skillPath?:
  string`, defaulting to the existing computed repo path when absent. `wellknown.ts`'s route
  handler now reads `deps.skillPath ?? SKILL_MD_PATH` instead of the hardcoded constant directly.
- **Verification**: `bun test packages/service/test/wellknown.test.ts` → 10 pass, 0 fail;
  `bun x tsc -p packages/service/tsconfig.json --noEmit` → clean; `bun test packages/service` → 58
  pass, 1 skip, 0 fail; `bun test` (whole workspace) → 148 pass, 1 skip, 0 fail — all at the final
  `HEAD` (`885c60e`).

### A tooling near-miss during the merge, disclosed for completeness

While completing the merge, several consecutive shell commands omitted the required explicit
`cd .../worktrees/service &&` prefix, relying on the shell's working directory persisting between
calls. It doesn't reliably persist — the *next* bare command silently executed inside
`.worktrees/agent` instead (a different worktree I was told not to touch), landing on a `git
commit` that found nothing staged there and did nothing (`"On branch ws/agent, nothing to commit,
working tree clean"`).

I stopped, investigated before proceeding further, and confirmed via `.worktrees/agent`'s
`git status`, `git reflog`, and the absence of a `MERGE_HEAD` there that nothing was modified,
staged, or committed in that worktree at any point — the stray command was a no-op by luck of
there being nothing conflicting to stage, not because it was harmless by design. Separately
confirmed `.worktrees/service` still held the fully-resolved, staged merge exactly as left, and
completed the merge commit there with an explicit `cd` this time. Every command after that point
in this session used an explicit `cd` (verified twice more that a bare command's directory is not
reliably predictable in this environment — one later bare `pwd` landed back in `.worktrees/agent`,
another in `.worktrees/service`, with no `cd` in between). No other worktree was touched, and no
work was lost, but flagging this plainly rather than omitting it, since a different sequence of
commands could have written to the wrong worktree instead of merely reading it.

### Addendum: "did not land" was a stale-snapshot issue, not lost work

A follow-up message reported the skill.md fix "did not land" and asked for it again as a fresh
commit. Before redoing anything, I verified directly on `ws/service`: `885c60e` was present at
`HEAD`, `git status` was clean, and both `packages/service/src/wellknown.ts`'s `skillPath` dep and
`test/wellknown.test.ts`'s two new tests were on disk exactly as committed — the work was never
lost. What had actually changed was `main` itself: `git merge-base --is-ancestor main HEAD` came
back false, and `git log HEAD..main` showed one new commit, `3566f3b` (dashboard docs, spec §13),
landed on `main` *after* my `8cb0658` merge. That's almost certainly what the "did not land" check
was seeing — `ws/service` was one commit behind the `main` it was being compared against, not
missing the skill fix itself.

Confirmed `3566f3b` touches only two docs files (no overlap with anything on this branch), merged
it cleanly (`6f99a20`, no conflicts), amended in the session trailer (git's own merge auto-commit
doesn't add one), and re-verified `main` is now fully an ancestor of `ws/service`'s `HEAD`. Did not
re-touch `wellknown.ts`, `app.ts`, or `wellknown.test.ts` — they were already correct.

### Files changed (skill test fix)
- `packages/service/src/wellknown.ts` (modified — `skillPath` dep, route reads it)
- `packages/service/src/app.ts` (modified — `skillPath` added to `BuildAppDeps`)
- `packages/service/test/wellknown.test.ts` (modified — two tests replacing the stale one)
- `.env.example` (merge-resolved, see above)
- Plus everything else `main`'s merge brought in unmodified: `README.md`, `docs/architecture.md`,
  `docs/architecture.png`, `docs/payment-flow.png`, `docs/standards-leverage.md`,
  `scripts/demo.sh`, `skills/vaultradar/SKILL.md`, `substreams/erc4626-vault-metrics/README.md`.

---

## Fix round 1

Review found two Important issues (both inherited from the briefs' own pseudocode/snippets) and
one folded-in minor. All three fixed on commit `68ede9a`.

### Finding 1: `makeHederaSubmit` reported the wrong chunk's sequence/consensus timestamp

`TopicMessageSubmitTransaction.execute()` returns only the *first* chunk's
`TransactionResponse` (`(await this.executeAll(client))[0]`, per `@hashgraph/sdk`'s own source).
The receipt commitment message (spec §5.5) is ~4.6 KB — always 5 chunks — so every submission was
reporting chunk 1's `sequence`/`consensus_timestamp`, while `mirrorLookup` (which has no such
shortcut; it must wait for every chunk to actually arrive before a message is complete) reports
the *last* chunk's. The same receipt would therefore describe two different `(sequence,
consensus_timestamp)` pairs depending on whether it was looked up from `HcsQueue`'s in-memory map
or reconstructed from the mirror node after a restart.

**Fix** (`packages/service/src/hcs.ts`): `makeHederaSubmit` now calls `executeAll(client)` and:
- takes the **last** response's receipt (`topicSequenceNumber`) and record (`consensusTimestamp`)
  as canonical — matching `mirrorLookup`'s own choice, since the message isn't complete until its
  last chunk lands;
- takes the **first** response's `transactionId` for the reported `transactionId` — that's exactly
  the `chunk_info.initial_transaction_id` the mirror node groups chunks by, so it's the id a caller
  actually needs to find the message there.

Both choices are documented in a comment at the call site. `makeHederaSubmit` gained an optional
second parameter, `deps: { client?: Client; makeTx?: () => ChunkedSubmitTx }`, so a test can inject
a fake for both the Hedera `Client` and the transaction builder — production callers (`main.ts`)
never set either, so the real `Client.forTestnet().setOperator(...)` and real
`TopicMessageSubmitTransaction` remain the defaults.

**TDD evidence**: added the test first, calling `makeHederaSubmit(config, {...})` against the
*unmodified* code. Since JS silently ignores an unexpected second argument, this didn't fail with
a clean type error — it fell through to the real (buggy) implementation, which built a real
`Client`/`PrivateKey` and attempted a genuine (fast-failing, precheck-rejected) network call to
Hedera testnet with fabricated credentials — a legitimate RED (the injection feature plainly
doesn't exist yet) but noisier than ideal, so the test carries an explicit 3000ms timeout as a
safety net against a real hang. After adding the `deps` parameter and the `executeAll`/first-last
fix together, the same test passes cleanly and fast (no network):
```
$ bun test packages/service/test/hcs.test.ts
8 pass, 0 fail, 22 expect() calls
```
The new test builds 3 fake chunk responses (sequence 41/42/43, distinct consensus timestamps, distinct
transaction ids) via a fake transaction object implementing only `executeAll` (no `execute` at
all — so a regression back to calling the wrong method would fail immediately and loudly, not
silently pass with stale data) and asserts `transactionId` equals chunk 1's and
`sequence`/`consensusTimestamp` equal chunk 3's.

### Finding 2: `readPqHash` didn't reject non-UTF-8 metadata

`readPqHash` decoded `getMetadata`'s returned bytes with viem's `hexToString`, whose default
`TextDecoder` is non-fatal — corrupted or unrelated on-chain bytes decode into a
garbled-but-non-null string (e.g. the U+FFFD replacement character) rather than failing, so a
comparison against the card's claimed hash could pass or fail somewhat arbitrarily instead of
cleanly reporting "could not verify."

**Fix** (`packages/service/src/erc8004.ts`): decode with `new TextDecoder("utf-8", { fatal: true
})` inside the existing try/catch (a fatal decode error is now just another path to the function's
existing `null` return), then require the decoded string to match `/^[0-9a-f]{64}$/` — the sha256
hex-digest shape every `pubHash` in this codebase actually has — returning `null` otherwise.

**TDD evidence**: two tests added first, both against the *unmodified* code:
```
$ bun test packages/service/test/erc8004.test.ts
(before fix) 5 pass, 2 fail — received "�" instead of null for invalid UTF-8 bytes (0xff),
and received "hello world" instead of null for valid-but-non-hash UTF-8 — both real RED failures
matching the finding exactly, not typos.
(after fix) 7 pass, 0 fail, 11 expect() calls
```
One test feeds `encodeFunctionResult({..., result: "0xff"})` (0xFF is never a valid UTF-8 leading
byte); the other feeds `stringToHex("hello world")` (valid UTF-8, wrong shape). Both must return
`null`.

### Folded-in minor: `metadataArgs(pubHash)` in `scripts/identity.ts`

Pure refactor, no behavior change — extracted the `[{ metadataKey: PQ_KEY, metadataValue:
stringToHex(pubHash) }]` tuple (previously written out identically in both
`buildRegisterCalldata` and `registerOnChain`) into one shared `metadataArgs(pubHash)` helper used
by both. Existing tests (`identity.test.ts`) already exercise `buildRegisterCalldata` end to end
(including through the `--dry-run` subprocess test), so this needed no new test — ran the existing
suite to confirm nothing changed behaviorally:
```
$ bun test packages/service/test/identity.test.ts
4 pass, 0 fail, 15 expect() calls
```

### Commands and output (full verification, at commit `68ede9a`)

```
$ bun x tsc -p packages/service/tsconfig.json --noEmit
(clean, exit 0)

$ bun test packages/service
61 pass, 1 skip, 0 fail, 204 expect() calls
Ran 62 tests across 8 files.

$ bun test
151 pass, 1 skip, 0 fail, 448 expect() calls
Ran 152 tests across 23 files.
```
Re-ran `bun test packages/service/test/hcs.test.ts packages/service/test/erc8004.test.ts` twice
more after the fix for flakiness (the chunking test in particular, since it exercises a real
`Client`/transaction-builder object graph up to the point the fake takes over) — clean both times,
no timing sensitivity observed.

### Files changed (fix round 1)
- `packages/service/src/hcs.ts` (modified — `executeAll`, first/last chunk semantics, injectable
  `{client, makeTx}`)
- `packages/service/src/erc8004.ts` (modified — fatal UTF-8 decode + hash-shape validation)
- `packages/service/scripts/identity.ts` (modified — `metadataArgs` extraction)
- `packages/service/test/hcs.test.ts` (modified — new chunking test)
- `packages/service/test/erc8004.test.ts` (modified — two new tests)

### Concerns
None new. The two fixed issues were both inherited from the briefs' own example code (Task 17's
`makeHederaSubmit` snippet used `.execute()`; Task 18's `readPqHash` snippet used bare
`hexToString`), not deviations introduced during implementation — noting this only so the pattern
(brief pseudocode traded completeness for brevity in ways that needed a second pass) is visible
for whoever plans future tasks' code snippets.
