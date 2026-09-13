# Tasks 22 and 23 report: policy, Claude Agent SDK tools, and the agent CLI

Branch: `ws/agent` (worktree `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/agent`)

| Task | Commit | Subject |
|---|---|---|
| 22 | `e05c9f9` | feat(agent): policy-driven rail/tier selection, independent age check, decisions with citations |
| 23 | `728cdd6` | feat(agent): Claude Agent SDK tools, watch and chat CLI |

Final verification, run before each commit and again at the end:

```
bun test packages/agent                               → 64 pass, 0 fail, 290 expect() calls, 6 files
bun test                                              → 165 pass, 0 fail, 596 expect() calls, 23 files
bun x tsc -p packages/agent/tsconfig.json --noEmit    → clean (exit 0)
bun x tsc -p packages/service/tsconfig.json --noEmit  → clean (exit 0)
bun x tsc -p packages/core/tsconfig.json --noEmit     → clean (exit 0)
```

Note on brief paths, same as Task 21: the briefs were not at the path in the task
message. `.superpowers/sdd/` is per-checkout and gitignored; the top-level checkout only
carries briefs 1-17. I worked from
`.worktrees/core/.superpowers/sdd/2026-09-09-vaultradar/task-22-brief.md` and
`task-23-brief.md`, which are the real ones.

---

## Task 22: policy

### What I implemented

`packages/agent/src/policy.ts`, exporting every symbol in the brief's Interfaces block:

- **`Policy`**, exactly the brief's four fields, `budget` in USD decimal strings so it
  compares directly against the quotes `VaultRadarClient.quote()` returns.
- **`PolicySchema` / `loadPolicy(path)`**, zod-validated. Defaults applied for
  `privacy` (`balanced`), `rail_preference` (`cheapest`) and `max_age_seconds` (900).
  `budget` has **no** default: an unstated spending cap must never be inferred. Errors
  name the offending field (`policy at <path> is invalid, privacy: Invalid enum value...`)
  because a misread policy that silently spends real USDC is far worse than a failed run.
- **`chooseRail`**, a rail is usable only with (1) a non-null quote, (2) a healthy
  facilitator, (3) `balance >= quote`, and (4) `budget >= quote`. `cheapest` takes the
  lowest usable quote, tie-breaking to hedera via a stable sort over a hedera-first map.
  A named preference returns `{ rail, reason: "preferred_rail" }` when usable, else falls
  back to the other rail with `reason: "preferred_rail_unusable"`, else
  `{ rail: null, reason: "no_usable_rail" }`.
- **`chooseTier`**, `strict → { tier: "table", seal: true }`,
  `balanced → { tier: "scan", seal: true }`, `cheap → { tier: "scan", seal: false }`.
- **`applyAgeCheck`**, `now - Number(a.timestamp) > max_age_seconds` exactly as
  specified, against the signed attestation timestamps rather than the service's own
  `freshness` field.
- **`decide`**, `alert → withdraw`, `watch → rebalance`, `ok → hold`, `unavailable` or a
  rejected attestation → `insufficient data`. Citations come from the report's first
  evidence entry, falling back to the attestation, plus `result.txId` and
  `receiptHash(result.receipt)`. The `reason` is one sentence naming the flags.

`packages/agent/policy.example.json` is the file the controller specified, verbatim.

### Three judgement calls in Task 22, all deliberate

1. **Budget is enforced inside `chooseRail`.** The brief's `chooseRail` signature takes
   balances and never mentions the budget, but the task's own title includes "budget" and
   there is no other place it could bind. So `quote > budget` makes a rail unusable
   independently of `quote > balance`: funds you hold but have not authorised for this
   agent are not spendable. Covered by its own test (a tight per-rail budget routes to
   the other rail; a zero budget on both yields `no_usable_rail`; the budget also binds a
   preferred rail and produces `preferred_rail_unusable`).

2. **A report with no accepted attestation is `insufficient data`.** The brief lists two
   triggers (`unavailable`, rejected). I added a third: a vault with no accepted
   attestation at all. `applyAgeCheck` hands `decide` the accepted set, so a report whose
   vault isn't in it is unattested data, and the system prompt's own rule ("Never invent
   numbers") does not survive acting on it. Separate test; reason says "no attestation".

3. **An unparseable attestation timestamp is treated as epoch-dated**, so
   `ageSeconds = now`, finite (the run-file contract types `ageSeconds` as a plain
   number, and `NaN` serialises to `null`) and unambiguously past any sane max age. The
   alternative, `NaN > max === false`, would have let a malformed timestamp read as
   fresh. Separate test.

**Known limitation, implemented as specified:** a *future* attestation timestamp makes
`now - ts` negative, so it passes the age check. Evading the agent's freshness bar that
way requires a valid ML-DSA-65 signature from the service over a false timestamp, and the
check has no independent clock for the attested block, so there is nothing better to do
locally. Worth a reviewer's eye; I did not deviate from the brief's formula.

### Client hardening (same commit, per the controller's three carried items)

All three in `VaultRadarClient.paid()`:

1. **`attestationsValid` requires distinct `vaultId`s.** Count plus membership plus
   distinctness makes the attestation set a bijection with the returned vaults, so two
   attestations naming one vault can no longer leave another vault unattested.
2. **`sealed` is read off the observed response** (`isSealedResponse(raw)`), not from
   `!!env`.
3. **`receiptValid` additionally requires** `receipt.request_hash === requestHash(request)`
   and `receipt.response_hash === responseHash({ vaults, reports, attestations })` over
   the opened body, so a validly signed receipt for some other purchase cannot be
   replayed against this one.

### TDD evidence, Task 22

`test/policy.test.ts` was written first against the not-yet-existing `../src/policy`; the
first run was `error: Cannot find module '../src/policy'`. The three hardening tests were
appended to `test/client.test.ts` before touching `client.ts`. Red baseline:

```
(fail) attestationsValid is false when two attestations name the same vault
        → Expected: false   Received: true
(fail) receiptValid is false when the receipt's request_hash or response_hash does not cover what was exchanged
        → Expected: false   Received: true
  16 pass, 2 fail, plus 1 file-level error (missing ../src/policy)
```

After implementing: `31 pass, 0 fail`.

The `sealed` test passed against the pre-change code, and I am flagging that rather than
dressing it up: the two throw-guards added in Task 21 already make `isSealedResponse(raw)`
and `!!env` agree, so item 2 cannot change an observable outcome today. The test is a
regression guard, and I made it non-vacuous by asserting the client's observation equals
the service's own signed `receipt.sealed` in both directions (sealed and clear), which
would catch a future divergence.

Two assertions in the watch tests were initially weak and I tightened them: `4242` (a
block) and `1234` (an HCS sequence) were matched as bare substrings, and a 64-hex receipt
hash can contain any short digit run by chance. They now match standalone tokens
(`/(^|\s)4242(\s|$)/`) and the formatted phrase (`"sequence 1234"`).

### Files, Task 22

- `packages/agent/src/policy.ts` (new)
- `packages/agent/test/policy.test.ts` (new, 13 tests)
- `packages/agent/policy.example.json` (new)
- `packages/agent/src/client.ts` (three hardening changes in `paid()`)
- `packages/agent/test/client.test.ts` (three tests appended)
- `packages/agent/src/index.ts` (re-export `./policy`)

---

## Task 23: Claude Agent SDK tools, watch and chat CLI

### SDK version and API used

`@anthropic-ai/claude-agent-sdk@0.3.267` (`claudeCodeVersion` 2.1.267), read from the
installed `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, the bundled
`claude-api` skill explicitly does not cover the Agent SDK, so the installed types are
the authority here. API used:

- `tool(name, description, zodRawShape, handler)` → `SdkMcpToolDefinition`
- `createSdkMcpServer({ name, version, instructions, tools })` → `{ type: "sdk", name, instance }`
- `query({ prompt, options })` where `prompt` is an `AsyncIterable<SDKUserMessage>`, which
  keeps one session alive across chat turns. Options used: `systemPrompt: { type: "custom", prompt }`,
  `mcpServers`, `allowedTools`, `tools: []` (disables every built-in tool, so a
  money-spending agent has no file, shell or web access), `settingSources: []` (ignores
  any `CLAUDE.md` or local settings in the tree), `cwd`.

**The installed zod 3 is compatible, no bump needed.** Task 21's report flagged a peer
warning (`zod@3.25.76` vs the SDK's `zod@^4.0.0` peer). Reading the SDK's types,
`AnyZodRawShape = ZodRawShape | ZodRawShape_2` with `import type { ZodRawShape } from 'zod/v3'`
and `'zod/v4'`, and the comment "Supports both Zod 3 and Zod 4 schemas". zod 3.25.76 ships
both subpaths. I confirmed it at runtime, not just by reading: a throwaway probe built a
`tool()` with a zod 3 schema, passed it to `createSdkMcpServer`, and called the handler,
all worked, with `@modelcontextprotocol/sdk` (also an uninstalled peer) absent, since
`sdk.mjs` never requires it and `skipLibCheck` covers the type-only import.

### What I implemented

**`src/balances.ts`**, probes, all with `fetchImpl` injection.

- `hederaUsdcBalance(accountId)` → mirror node `GET /api/v1/accounts/{id}/tokens?token.id=0.0.429274`,
  `tokens[0].balance`, converted by `formatUsdc` using string arithmetic rather than
  `Number` division so a large balance cannot lose low-order digits.
- `arcGatewayBalance(privateKey)` → `GatewayClient.getBalances().gateway.formattedAvailable`.
  `getGatewayBalance` is **private** in the installed `@circle-fin/x402-batching@3.4.0`
  types (and marked `@deprecated` in favour of `getBalances()`), so the brief's first
  choice is not reachable; `getBalances()` is the public route and `formattedAvailable`
  is the spendable figure, excluding anything mid-withdrawal.
- `readBalances` / `readHealth`. A rail with no wallet configured reports `"0"`, and every
  failure path reports `"0"` or `false`: an unknown balance must never read as spendable,
  and `chooseRail` turns that into "rail unusable", which is the safe outcome.
- Health: service `/health` (2xx and `ok !== false`), Blocky402 `/supported`, Circle
  Gateway `/v1/x402/supported`. On a 404 from that last path it falls back to a 2xx on the
  API root and records a note, rather than silently marking the Arc rail down and quietly
  routing every purchase to Hedera. I used GET rather than the brief's HEAD, because
  `/supported` is a JSON endpoint and HEAD is not guaranteed to be routed.

**`src/watch.ts`**, the purchase pipeline.

- `identityRefusal(disc)` gates spend on the card signature and the on-chain ERC-8004 key
  pin. A `matches: null` entry (no RPC for that chain) is reported as unverified, not
  refused.
- `executePurchase(plan, serviceUrl, deps)` is the single paid step, **shared with the
  tools**: quote both rails for the tier the policy asks for, pick a usable rail, buy
  once, age-check, and refuse to derive a decision from a purchase whose receipt or
  attestations did not verify. It returns `ok: false` with a reason (and the `RunRequest`
  when payment already happened) rather than throwing for policy or verification
  outcomes. Factoring this out rather than duplicating it is deliberate: the verification
  gate is safety-critical and must not exist in two copies.
- `quoteFor(client, tier, count)`, `client.quote()` prices a scan only, so the table tier
  maps non-null scan quotes (the client's way of saying "this rail is configured") to
  `TABLE_PRICE_USD`. Without this, a `strict` policy would have chosen its rail against
  scan prices and then bought a table.
- `narrowResult(result, ids)`, the strict tier buys a whole protocol table (so the service
  never learns which vault is of interest) and filters locally. `receiptValid` /
  `attestationsValid` pass through unchanged, because they were computed over the full
  body that was actually signed.
- `pollHcs`, up to 3 attempts, 3 s gaps, never throws. An unreachable lookup is "no
  sequence yet", which must not invalidate a purchase that already succeeded.
- `formatDecisions`, two fixed-width tables (verdict/score/action/flags, then
  block/source/tx id/receipt/HCS sequence per vault), per-vault reason lines, and a footer
  with the full receipt hash, HCS topic and sequence, payment tx and the verification
  result. The second table shortens the vault id (`1:0xaaaaaa...aaaa`) because the full
  45-char id in both tables pushed the line past 180 columns.
- `runWatch(args, deps)` returns `{ exitCode, run, runPath, message }` instead of calling
  `process.exit`, so the whole pipeline is testable in-process; `cli.ts` exits on the
  returned code.

**`src/tools.ts`**, `SYSTEM_PROMPT` (verbatim, asserted character-for-character by a
test), `MCP_SERVER_NAME`, `TOOL_NAMES`, `ALLOWED_TOOLS`
(`mcp__vaultradar__vaultradar_*`), `AgentContext`, `RunLog`, `vaultradarTools(ctx, log)`,
`createVaultRadarMcpServer(ctx, log)`. The five tools are `vaultradar_discover`,
`vaultradar_quote`, `vaultradar_scan`, `vaultradar_table`, `vaultradar_verify_receipt`.
Every decision still runs in `policy.ts` / `watch.ts`; the handlers only marshal arguments
in and JSON out, so the model cannot talk the agent past its own policy. `vaultradar_scan`
returns `{ decisions, reports, receipt_hash, tx_id, rail, tier, sealed, rejected }` plus
`price_usd`, `hcs`, `verified` and `run_path`.

**`src/cli.ts`**, `parseArgs` (exported and tested), `watch`, `chat`, and a usage block.
`watch` needs no `ANTHROPIC_API_KEY` and never loads the Agent SDK (the import in
`chatCommand` is dynamic). `chat` requires the key and supports `/wallets`, `/balance`,
`/policy`, `/run`, `/help`, `/exit`.

### Two bugs found by running the thing

1. **`src/rails/hedera.ts` could never pay.** Running the CLI for real against a stub
   service failed with `error: Unsupported Hedera network: testnet`. The Task 21 code
   passed `{ network: "testnet" } as any` to `createClientHederaSigner`, but
   `@x402/hedera@2.25.0` asserts that option against exactly `"hedera:mainnet"` /
   `"hedera:testnet"` (`assertSupportedHederaNetwork`, and `config.network ?? HEDERA_TESTNET_CAIP2`
   in `createClientHederaSigner`). Every non-test Hedera payment failed at signer
   construction, invisible to the Task 21 suite because every test there injects
   `payingFetch`. Fixed to the CAIP-2 id, now a named export
   (`HEDERA_TESTNET_CAIP2`) shared with the `x402Client().register(...)` call so the two
   cannot drift. Covered by `test/cli.test.ts`, and I verified the test is load-bearing by
   reverting the fix (it failed with `Unsupported Hedera network: testnet`) and restoring.
   This is Task 21 code; I fixed it because a `watch` CLI that cannot pay is not a
   delivered Task 23.

2. **`RunLog` wrote an empty run for a purchase that never happened.** The "no usable
   rail" tool test caught `append()` calling `ensure()` unconditionally, which opened and
   wrote a run with zero requests whenever a model asked for a scan it could not afford.
   Now an outcome with no `request` opens no run. This differs from `runWatch` on purpose
   and both sites carry a comment saying so: a `watch` invocation is one shot whose whole
   outcome, including "I declined to pay, here is why", is worth a run file, whereas a
   chat session should not leave an empty run behind for each refusal.

### TDD evidence, Task 23

`test/watch.test.ts` was written before `src/watch.ts` existed (first run: module not
found). It drives `runWatch` end to end against the in-process service from Task 15/21,
real handlers, real ML-KEM sealing, real ML-DSA-65 receipts and attestations over
loopback, with a stub provider, raw Hedera routes carrying a fixed payer and tx id,
`payingFetch: fetch`, an injected `readPqHash`, injected balances/health, and an HCS
lookup stub so the receipt poll sees a real consensus sequence. Ten tests: the RunRecord
shape (asserted with `Object.keys().sort()` against the dashboard contract, at both the
run and request level), the stale-attestation path, strict and cheap tiers, no usable
rail, a forced rail that is unusable, a forced rail overriding a contrary preference, an
on-chain key-hash mismatch refused before payment, a post-payment verification failure
recorded without decisions, and `pollHcs`'s retry/gap behaviour.

`test/tools.test.ts` (14 tests) drives the tool handlers directly against the same
harness: names and `ALLOWED_TOOLS`, the verbatim prompt, discover, quote (scan and strict),
scan happy path with the full RunRecord round trip, two scans appending to one run file,
the stale path, strict narrowing, table, no usable rail, identity mismatch, verification
failure, and receipt verification including a tampered receipt and a non-receipt.

`test/balances.test.ts` (7 tests) covers `formatUsdc` (including a value past
`Number.MAX_SAFE_INTEGER`), the mirror-node URL and conversion, the empty/error/unreachable
paths, `readBalances` skipping an unconfigured rail's probe entirely, and all three health
verdicts including the Gateway 404 fallback. One failure there was a bug in my own test
stub (prefix matching let a route for the API root shadow a route for a path under it),
fixed in the test, not the implementation.

I extracted `test/harness.ts` so `watch.test.ts` and `tools.test.ts` share one in-process
service rather than a third copy of the setup. `test/client.test.ts` was left on its own
copy to avoid churning already-committed tests.

### Live verification

The brief's Step 3 live check against `https://vaultradar.fly.dev` is **blocked**: that
host does not answer (`curl → 000`), so the service is not deployed yet. Everything that
could be verified live, was:

| Probe | Result |
|---|---|
| `api.testnet.blocky402.com/supported` | 200 |
| `gateway-api-testnet.circle.com/v1/x402/supported` | 200 (so the 404 fallback is not needed today) |
| `hederaUsdcBalance("0.0.5176")` (the testnet USDC treasury) | `55.699998`, matching the raw atomic `55699998` |
| `hederaUsdcBalance("0.0.2")` (no token association) | `0` |
| `readHealth` against an unreachable service | `{ service: false, hedera: true, arc: true, notes: [...] }` |

I also ran the CLI as a real process against a loopback stub service. The no-funds path
printed the identity and rail summary, saved a run, and exited 2. The funded path (same
service, injected balances) printed exactly the output the brief asks for:

```
VaultRadar http://127.0.0.1:8799
  identity      card signature ok, pub hash c4fbd338d1665832bf51009e148cb0f8df0c6b0fa5638ab6ba8f194d504a18e7
  erc-8004      chain 296 agent 7: unverified (no RPC for this chain)
  policy        privacy balanced -> scan (sealed), max age 900s
  rails         hedera: quote 0.002, balance 5.00, budget 1.00, facilitator up; arc: quote n/a, balance 0, budget 1.00, facilitator down
  bought        scan on hedera for $0.002 (cheapest_usable_rail)

VAULT                                          VERDICT      SCORE  ACTION             FLAGS
---------------------------------------------  -----------  -----  -----------------  --------------------------------
1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa   alert        55     withdraw           share_price_drawdown_1h,share_p…
1:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb   ok           0      hold               none

VAULT               BLOCK       SOURCE                              TX ID                       RECEIPT         HCS SEQ
------------------  ----------  ----------------------------------  --------------------------  --------------  --------
1:0xaaaaaa…aaaa     4242        substreams:erc4626-vault-metrics    0.0.42@1700000000.0         88054b131d4a…   4321
1:0xbbbbbb…bbbb     4242        substreams:erc4626-vault-metrics    0.0.42@1700000000.0         88054b131d4a…   4321

  1:0xaaaaaa…aaaa: Verdict alert at score 55 with flags share_price_drawdown_1h, share_price_drawdown_24h: withdraw.
  1:0xbbbbbb…bbbb: Verdict ok at score 0 with no flags: hold.

  rail hedera  tier scan  sealed true  price $0.002
  receipt hash  88054b131d4aa79dbdccbe2d1496f4e5088d5d00e7ca8a771e0ff7824dcf0e38
  hcs           topic 0.0.99 sequence 4321
  payment tx    0.0.42@1700000000.0
  verified      receipt ok, attestations ok
  run saved     /tmp/vr-runs2/2026-09-10T01-49-33.244Z-u5jovkj5.json
```

Every CLI error path was exercised as a process: missing `--vaults`, missing policy, a
malformed vault id, `--rail solana`, no wallet configured, and `chat` without
`ANTHROPIC_API_KEY`. `bun run agent ...` passes arguments through correctly.

### Files, Task 23

- `packages/agent/src/balances.ts`, `src/watch.ts`, `src/tools.ts`, `src/cli.ts` (new)
- `packages/agent/test/harness.ts`, `test/watch.test.ts`, `test/tools.test.ts`,
  `test/balances.test.ts`, `test/cli.test.ts` (new)
- `packages/agent/src/rails/hedera.ts` (CAIP-2 network fix)
- `packages/agent/src/index.ts` (re-export `./balances`, `./watch`, `./tools`)
- `.env.example` (appended `ANTHROPIC_API_KEY`, `AGENT_HEDERA_ACCOUNT_ID`,
  `AGENT_HEDERA_KEY`, `AGENT_ARC_KEY`, `POLICY_PATH`, `RUNS_DIR`)

Root `package.json` already had `"agent": "bun run packages/agent/src/cli.ts"`; unchanged.
`/runs/` was already in `.gitignore`; unchanged.

---

## Self-review

- **Every export in both Interfaces blocks exists**, checked one by one against the
  source. Task 22: `Policy`, `loadPolicy`, `chooseRail`, `chooseTier`, `applyAgeCheck`,
  `decide` (and `Decision`, already in `runs.ts`). Task 23: all five tool names (asserted
  by a test that compares the registered names to `TOOL_NAMES` and `ALLOWED_TOOLS`),
  `tool()` + `createSdkMcpServer()`, both CLI commands, the balance and health probes, and
  every documented env var.
- **The run file matches `RunRecord` exactly.** Both `watch.test.ts` and `tools.test.ts`
  assert `Object.keys(saved).sort()` equals the seven-key contract, and `watch.test.ts`
  additionally asserts the nine-key `RunRequest` shape. I re-diffed `src/runs.ts` against
  `packages/dashboard/lib/types.ts` by hand: identical.
- **No key material is printed or persisted.** `grep` across `packages/agent/src` for any
  print touching `privateKey` / `secretKey` / `AGENT_*_KEY` returns exactly one hit,
  `arcAddress(r.wallets.arc.privateKey)`, which derives the public address. `RunRecord` has
  no key-shaped field. Two tests assert the printed output and the written run file never
  contain the test key.
- **`watch` output cites block, source, tx id, receipt hash and HCS sequence per vault**,
  see the captured output above, and asserted line by line in `watch.test.ts`.
- **Tests are real.** Every paid path runs against the in-process Express service with the
  real handlers and real post-quantum crypto over loopback. The only stubs are the data
  provider, the fixed payer/tx id that real payment middleware would set, and an HCS
  lookup. `balances.test.ts` injects a fetch stub; nothing in the suite makes a network
  call. The live probes above were run by hand, outside the suite, on purpose.

## Concerns

1. **The live check is blocked**, `vaultradar.fly.dev` is not deployed, so the brief's
   Step 3 (one paid request on the real service, `privacy: "strict"` showing a table
   purchase, a stale vault showing `insufficient data`) has not been run against anything
   but loopback. The stale and strict paths are covered by tests; the real x402 payment on
   either rail has still never executed end to end anywhere in this repo.
2. **Task 21's Hedera signer never worked**, which is worth generalising: every Hedera and
   Arc test injects a payment override, so nothing in the suite constructs the real signer
   or the real `GatewayClient`. `test/cli.test.ts` now covers signer construction; the Arc
   equivalent (`payArc` / `arcGatewayBalance`) is still entirely unexercised and may hold
   the same class of mistake.
3. **The future-timestamp gap in `applyAgeCheck`**, described above. Implemented as
   specified; flagging it rather than silently changing the formula.
4. **`--protocol` defaults to `erc4626` for the strict tier.** A vault id carries a chain
   and an address but not a protocol, so a table purchase needs one from somewhere. The
   generic ERC-4626 table is the right default for any `<chainId>:0x...` id, but a Morpho or
   Aave vault bought under `privacy: "strict"` needs `--protocol` passed explicitly or it
   will not appear in the narrowed result.
5. **`chat` is untested**, as scoped. It is thin (argument resolution, the slash commands,
   and a `query()` loop), but the SDK loop itself has only ever been type-checked, not
   run, I have no `ANTHROPIC_API_KEY` here and would not spend on one unasked.
6. **`executePurchase` re-reads balances and health on every call**, so a chat session that
   scans five times makes five mirror-node and facilitator round trips. Correct but
   chatty; no caching, since a stale balance is worse than a slow one.

---

## Fix round 1

Commit: `b6ce4c1`, "fix(agent): reject future-dated attestations, fall back to the
receipt tx id, and buy one table per chain"

```
bun test packages/agent                               → 68 pass, 0 fail, 327 expect() calls, 6 files
bun test                                              → 169 pass, 0 fail, 633 expect() calls, 23 files
bun x tsc -p packages/agent/tsconfig.json --noEmit    → clean (exit 0)
bun x tsc -p packages/service/tsconfig.json --noEmit  → clean (exit 0)
bun x tsc -p packages/core/tsconfig.json --noEmit     → clean (exit 0)
```

### Finding 1, `applyAgeCheck` accepted a future-dated attestation as arbitrarily fresh

`packages/agent/src/policy.ts`. Added `export const CLOCK_SKEW_S = 120` and changed the
bar to reject in both directions:

```ts
if (ageSeconds > p.max_age_seconds || ageSeconds < -CLOCK_SKEW_S) {
  rejected.push({ vaultId: a.vaultId, ageSeconds });
} else {
  accepted.push(a);
}
```

The rejection records the real, possibly negative `ageSeconds`, so the run file shows
which direction it failed in. 120 s is not arbitrary: it matches `TS_WINDOW_S` in
`@vaultradar/core`, the window the service already allows on sealed-request timestamps, so
the agent and the service agree on what counts as clock skew rather than each inventing a
number. `decide()` now reports a future-dated attestation as such,
`"Attestation is dated 121s in the future, beyond the 120s clock-skew allowance"`, instead
of the nonsensical `"-121s old"` a shared message would have produced.

Covering test: `"an attestation dated further into the future than the clock-skew allowance
is rejected"` in `test/policy.test.ts`, with all three cases the review asked for plus the
reason-wording check:

| Timestamp | Outcome |
|---|---|
| `now + CLOCK_SKEW_S + 1` | rejected, `ageSeconds: -121`, reason says "in the future", never "s old" |
| `now + 60` | accepted, decision is `withdraw` |
| `now - (max_age_seconds + 1)` | rejected, `ageSeconds: 901`, reason says "901s old" |

### Finding 2, `decide()`'s citation `txId` had no fallback to the receipt

`packages/agent/src/policy.ts`, in `decide()`'s `citations`:

```ts
txId: result.txId ?? result.receipt.payment.txId,
```

All three sites (`policy.ts`, `watch.ts`, `tools.ts`) now agree, so a tx id `watch` prints
or a tool returns is always one the run file also carries.

Covering test: `"citation txId falls back to the receipt's payment when the rail set no
header"` in `test/policy.test.ts`. `fakeResult` gained a `receiptTxId` option so the
rail-level id and the receipt's can be made to differ: with `txId: null` and
`receipt.payment.txId = "0.0.42@1.0"` the citation reads `"0.0.42@1.0"`, and a present
rail-level id still wins.

**Two existing assertions encoded the old bug and were updated, not worked around.**
`test/watch.test.ts` and `test/tools.test.ts` both asserted `txId: null` on the happy-path
citation. They now assert the receipt's tx id, with a comment explaining why the rail-level
id is absent in-harness; `watch.test.ts` additionally asserts `req.txId` really is null, so
the fallback is visibly a fallback rather than the two values coincidentally matching.

### Minor (a), a strict-tier plan spanning several chains dropped every chain but the first

This was the largest change. A table is per protocol *per chain*, so `executePurchase` now
buys one table per distinct chain in the vault list, in first-seen order, sequentially,
each iteration is a real payment, and it stops at the first verification failure rather
than continuing to spend against a service that just failed a check.

Three things followed from that, and two of them are substantive:

1. **The budget was not being enforced across the fan-out.** `quoteFor` now takes a
   `requests` count and multiplies the table price by it, in atomic micro-USD (`3 × 0.03`
   in binary floats is `0.09000000000000001`, which compares wrong against a budget of
   `"0.09"`). Before this, a three-chain strict run would have spent 3× the policy's cap
   while `chooseRail` reported the rail as affordable. Covered by
   `"a strict-tier plan spanning more chains than the budget covers buys nothing"`: three
   chains under a `0.05` budget exits 2 with `"quote 0.09"` in the message and an empty
   `requests` array.
2. **Vaults absent from every table are now reported.** New exported
   `missingVaultDecisions(requested, purchases)` emits an `insufficient data` decision per
   uncovered vault, reason `"This vault was not present in the fetched table(s), so nothing
   about it was bought."`. Silently returning nothing would have read as "no risk found"
   when the truth is "never looked at". Each cites the receipt of the table bought *for
   that vault's own chain*, which is the document that proves it wasn't in there, so
   `Purchase` gained a `chainId: string | null` field (null for a scan). Keying off the
   chain the table was bought for, rather than off the vaults it returned, is what makes an
   empty table still citable.
3. **`PurchaseOutcome` went plural**: `purchases: Purchase[]` replaces the single
   `result`/`request`/`hcs` triple, on both the success and failure branches, so a failure
   part-way through a fan-out still reports every payment that happened.
   `formatDecisions(purchases, decisions)` takes the array and drives its evidence table
   off each decision's own `citations` (looking the HCS sequence up by the receipt hash
   that row cites), so the terminal output and `runs/*.json` show one set of numbers by
   construction. `RunLog.append` and `runWatch` push all requests. The scan and table tools
   gained a `payments` array; their singular keys describe the first payment, `price_usd`
   is the total, `rejected` is concatenated, `verified` is the AND across payments, and a
   `note` appears when there is more than one payment pointing the model at each vault's
   own `citations.receiptHash`.

Covering test: `"strict privacy across two chains buys one table per chain and reports the
uncovered vault"` in `test/watch.test.ts`, with `--vaults 1:0xaa...,137:0xdd...`. I made the
harness's `table()` chain-aware (it serves chain 1 only, and any other chain legitimately
comes back empty) because the old stub ignored its `chainId` argument, which would have let
the second purchase return chain-1 vaults again and masked the whole bug. The test asserts
two requests with distinct receipt hashes, the second carrying no verdicts; the off-chain
vault's `insufficient data` decision citing request 2's receipt hash with an empty block;
the covered vault still citing request 1's; exactly two decisions; and the printed
`"payment 1 of 2"` / `"payment 2 of 2"` / `"in 2 payments"` / `"$0.06"`.

### Minor (b), `.env.example`

Added `SERVICE_URL=http://localhost:8787` (it was documented in the CLI usage block but
genuinely missing from the file).

### Also

Widened the printed `VAULT` column from 45 to 52. A 7-digit chain id (Arc testnet is
5042002) plus a 42-character address is 50 characters, so the old width silently truncated
the one column a reader has to be able to copy verbatim, visible in the multi-chain run as
`137:0xdddd...dddd...`.

### Regression verification

For each of the three code changes I reverted just that change and re-ran the tests, to
confirm the new tests fail against the old behaviour rather than merely passing against the
new:

- Reverting the age bound to `ageSeconds > p.max_age_seconds` → the future-dated test
  failed on the rejected-array comparison.
- Reverting the citation to `txId: result.txId` → `Expected: "0.0.42@1.0" / Received: null`.
- Reverting `planChains` to the first vault's chain and dropping `missingVaultDecisions` →
  both multi-chain tests failed (`Expected length: 2 / Received length: 1`, and
  `Expected: 2 / Received: 0` decisions).

All restored and re-verified green afterwards.

### Live re-check of the changed output

Re-ran the CLI pipeline as a real process against a loopback stub service to confirm the
restructured printing, since `formatDecisions` changed shape:

```
  policy        privacy strict -> table (sealed), max age 900s
  rails         hedera: quote 0.06, balance 5.00, budget 1.00, facilitator up; arc: quote n/a, ...
  bought        table on hedera for $0.06 in 2 payments (cheapest_usable_rail)

VAULT                                                 VERDICT      SCORE  ACTION             FLAGS
----------------------------------------------------  -----------  -----  -----------------  ----------------------------------------
1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa          alert        55     withdraw           share_price_drawdown_1h,share_price_dra…
137:0xdddddddddddddddddddddddddddddddddddddddd        absent       -      insufficient data  none

VAULT               BLOCK       SOURCE                              TX ID                       RECEIPT         HCS SEQ
------------------  ----------  ----------------------------------  --------------------------  --------------  --------
1:0xaaaaaa…aaaa     4242        substreams:erc4626-vault-metrics    0.0.42@1700000000.0         1463eb2be775…   4321
137:0xdddddd…dddd   -           -                                   0.0.42@1700000000.0         a36a5076cdf8…   4321

  1:0xaaaaaa…aaaa: Verdict alert at score 55 with flags share_price_drawdown_1h, share_price_drawdown_24h: withdraw.
  137:0xdddddd…dddd: This vault was not present in the fetched table(s), so nothing about it was bought.

  rail hedera  tier table  sealed true  price $0.03 (payment 1 of 2)
  ... (one footer block per payment, each with its own receipt hash) ...
```

### Files changed in this round

- `packages/agent/src/policy.ts`, `CLOCK_SKEW_S`, the two-sided age bound, the future-date
  reason wording, the citation `txId` fallback
- `packages/agent/src/watch.ts`, `Purchase`, plural `PurchaseOutcome`, `planChains`,
  `missingVaultDecisions`, the fan-out in `executePurchase`, `quoteFor(..., requests)`,
  `formatDecisions(purchases, decisions)`, `runWatch`'s plural handling, the wider column
- `packages/agent/src/tools.ts`, `RunLog.append` and `buy()` on the plural shape,
  `payments` array, `totalUsd`
- `packages/agent/test/policy.test.ts`, two new tests, `fakeResult({ receiptTxId })`
- `packages/agent/test/watch.test.ts`, two new tests, updated `txId` assertion
- `packages/agent/test/tools.test.ts`, updated `txId` assertion
- `packages/agent/test/harness.ts`, chain-aware `table()`
- `.env.example`, `SERVICE_URL`

### Concerns after this round

1. **Unchanged from the first report: the live check is still blocked.** `vaultradar.fly.dev`
   does not answer, so no real x402 payment has executed on either rail. The multi-chain
   fan-out in particular has only ever run against loopback, and it is the one path that
   makes N payments for one invocation.
2. **A multi-chain strict run is all-or-nothing on budget but not on failure.** If chain 1's
   table verifies and chain 2's does not, chain 1 has been paid for and is recorded, but no
   decisions are emitted for it. That is the safe direction, and the money spent is visible
   in the run file, but an operator reading exit 2 should understand a payment still
   happened.
3. **`missingVaultDecisions` cites an empty `block` and `source`.** `Decision.citations`
   types both as `string`, so "we never looked at this" is expressed as empty strings plus
   the reason text. The dashboard renders them as blanks; if that reads as missing data
   rather than as deliberate, the contract would need a nullable variant, which I did not
   change unilaterally.
4. **The tools' singular `receipt_hash` / `tx_id` describe the first payment only** when a
   fan-out happened. `payments[]` and each decision's `citations.receiptHash` are complete
   and authoritative, and a `note` says so, but a model that reads only the top-level keys
   would under-cite a multi-payment scan. Worth an eye on whether the `note` is enough.

---

## Fix round 2

Commit: `7998216`, "fix(agent): keep verified decisions when a later chain fails, and
harden the on-chain key-hash decode"

```
bun test packages/agent                               → 73 pass, 0 fail, 383 expect() calls, 6 files
bun test                                              → 174 pass, 0 fail, 689 expect() calls, 23 files
bun x tsc -p packages/agent/tsconfig.json --noEmit    → clean (exit 0)
bun x tsc -p packages/service/tsconfig.json --noEmit  → clean (exit 0)
bun x tsc -p packages/core/tsconfig.json --noEmit     → clean (exit 0)
```

### Finding, a later chain's failure discarded the earlier chain's verified decisions

The regression was real and exactly as described. The `ok: false` variant of
`PurchaseOutcome` had no `decisions` field, so the loop's accumulated `decisions` went out
of scope at the `return`. A strict-tier run that verified chain 1 and failed on chain 2
computed chain 1's `decide()` output and threw it away; `runWatch` then printed an empty
table and `tools.ts`'s `buy()` returned only a reason string. The money for chain 1 had
already been spent and its receipt and attestations had verified.

Fix, in `packages/agent/src/watch.ts`:

- `decisions: Decision[]` added to the `ok: false` variant, documented as "decisions from
  the purchases that *did* verify, before the one that didn't", empty when the first
  purchase is the one that failed.
- The verification-failure `return` inside the loop now passes the accumulated `decisions`
  and appends a clause to the reason: `"; N decision(s) from M earlier verified
  purchase(s) still stand"`. The plural reason was also reworded, since
  `"2 purchases are recorded but no action was taken on it"` read badly; it is now
  `"verification failed (receipt) on payment 2 of 2, all 2 purchases are recorded, but
  nothing was derived from the failed one; 1 decision(s) ... still stand"`.
- `runWatch` sets `run.decisions = outcome.decisions` and calls
  `formatDecisions(outcome.purchases, outcome.decisions)` on the failure path, so the rows
  print. **Exit code and reason unchanged at 2**, the run did not complete.
- `RunLog.append` now persists `outcome.decisions` on both branches, not only on success.
  Without this the chat path would still have lost them.
- `tools.ts`'s failure branch returns them: `err()` gained an `extra` argument, and the
  per-payment view was factored into `paymentsOf(purchases)` so both branches report it.
  The result stays `isError: true`, a model must not read a partial failure as a clean
  purchase, but now carries `decisions`, `reports`, `payments` and `run_path`.
  `reportSummary`'s parameter widened from `Extract<PurchaseOutcome, { ok: true }>` to
  `{ purchases; decisions }` so it serves both.

**One thing I did deliberately differently from a literal reading of the finding.** My
first draft also ran `missingVaultDecisions` over the verified purchases on the failure
branch, to keep accounting for every requested vault. An existing single-purchase test
caught that immediately:

```
(fail) a verification failure on the paid response exits 2 and records the request without decisions
- []
+ [{ "action": "insufficient data",
+    "reason": "This vault was not present in the fetched table(s), so nothing about it was bought.", … }]
```

The vault had been bought and had simply failed verification, so "not present in the
fetched table(s)" was a false statement. The same argument applies to the multi-chain case:
chain 137's table *was* fetched, it just could not be verified, so the agent cannot claim
the vault was absent from it. The failure reason is the honest account for those vaults.
`missingVaultDecisions` therefore runs only on the success path, with a comment in the
failure branch explaining why it is absent, and the new test asserts the off-chain vault
gets no decision and that the printed output never says "not present in the fetched
table(s)".

Covering tests in `test/watch.test.ts` and `test/tools.test.ts`, both using a `payingFetch`
that passes the first response through untouched and rewrites the second receipt's
`request_hash` (signature still valid, commitment no longer covering the request):

- `"a later chain failing verification does not throw away the earlier chain's verified
  decisions"`, exit 2, reason matches `verification failed (receipt)` and contains
  `"still stand"`; the run file holds both requests and chain 1's `withdraw` citing
  request 1's receipt hash; no decision cites request 2's hash; the off-chain vault gets
  no decision; the printed text contains the vault id, `withdraw` and `receipt FAILED`.
- `"a failure on the very first purchase carries no decisions"`, the boundary case: one
  request recorded, `decisions: []`, and the reason does *not* say "still stand".
- `"a later chain's verification failure still returns the earlier chain's verified
  decisions"` (tools), `isError: true` with `decisions` length 1, `payments` length 2 with
  the second marked `verified.receipt: false`, and the run file holding both payments and
  the one decision.

### Folded-in (a), strict UTF-8 and hash-shape validation in `erc8004.ts`

`readPqHashOnChain` decoded with `hexToString(raw).trim()` and accepted any non-empty
string. Non-UTF-8 metadata bytes became U+FFFD replacement characters, which were then
compared against the card's `pq.sig.pub_hash` and reported as `matches: false`, an actual
mismatch, which `runWatch` treats as grounds to refuse payment and which reads to an
operator as an attack, when the truth is a malformed registration.

Now:

```ts
const PUB_HASH_RE = /^[0-9a-f]{64}$/;

export function decodePqHash(raw: `0x${string}`): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(raw)).trim();
    return PUB_HASH_RE.test(text) ? text : null;
  } catch {
    return null;
  }
}
```

`readPqHashOnChain` calls it, so there is one copy of the rule. Splitting it out is what
makes the strictness testable at all, the original is unreachable without an RPC endpoint,
which is why the weak decode survived the first two rounds. `null` means "could not
verify" (`matches: null`), which is the right classification for bytes the agent cannot
interpret, and is deliberately distinct from a genuine mismatch.

Covering test in `test/cli.test.ts`, `"decodePqHash is strict: invalid UTF-8 and non-hash
strings are 'could not verify', not a mismatch"`: the happy path including surrounding
whitespace; three invalid-UTF-8 shapes (`0xff`, 64 `0xff` bytes, and a lone continuation
byte appended to a valid hash); and six valid-UTF-8-but-not-a-hash shapes (62 and 66
characters, uppercase, non-hex, prose, empty string, and empty metadata `0x`). Reverting to
the old decode fails it with `Received: "�"`, which is precisely the reported hazard.

### Folded-in (b), `vaultradar_quote` priced one table regardless of chain spread

The tool's input was only `count`, so it could not know the chain spread at all. I added an
optional `vaults` array rather than replacing `count` (the brief's Interfaces block names
`count`, and a model may legitimately want a rough price before it has ids). With `vaults`,
the quote uses `planChains(...)`, the same helper `executePurchase` uses, so the preview
and the purchase cannot disagree, and reports `tables` and `chains`. Without them, the
result carries a `note`: *"This policy buys a table per chain; without the vault ids the
quote assumes one chain. Pass `vaults` for an exact price."* Saying so is the point;
quietly quoting one table was the bug.

Covering test `"a strict-tier quote prices one table per distinct chain when given the
vault ids"`: two chains → `tables: 2`, `chains: ["1","137"]`, `0.06`; two vaults on one
chain → `tables: 1`, `0.03`; no ids → `tables: 1` plus the note; and a scan-tier policy →
no `tables` key and the scan price, since a scan is one request however many chains it
spans.

### Regression verification

Each of the three changes reverted in isolation, tests re-run, then restored:

| Reverted | Result |
|---|---|
| failure branch back to `decisions: []` | both carried-decisions tests failed (watch and tools) |
| `decodePqHash` back to non-fatal `hexToString` | strictness test failed with `Received: "�"` |
| `quoteFor(...)` without `requests` in the quote tool | strict-tier quote test failed |

### Live re-check

Ran the partial-failure case as a real process against a loopback stub service, since the
failure path now prints rows:

```
  rails         hedera: quote 0.06, balance 5.00, budget 1.00, facilitator up; arc: quote n/a, ...

VAULT                                                 VERDICT      SCORE  ACTION             FLAGS
----------------------------------------------------  -----------  -----  -----------------  ----------------------------------------
1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa          alert        55     withdraw           share_price_drawdown_1h,share_price_dra…

VAULT               BLOCK       SOURCE                              TX ID                       RECEIPT         HCS SEQ
------------------  ----------  ----------------------------------  --------------------------  --------------  --------
1:0xaaaaaa…aaaa     4242        substreams:erc4626-vault-metrics    0.0.42@1700000000.0         d35ce5ffc9ff…   4321

  1:0xaaaaaa…aaaa: Verdict alert at score 55 with flags share_price_drawdown_1h, share_price_drawdown_24h: withdraw.

  rail hedera  tier table  sealed true  price $0.03 (payment 1 of 2)
  ... verified      receipt ok, attestations ok
  rail hedera  tier table  sealed true  price $0.03 (payment 2 of 2)
  ... verified      receipt FAILED, attestations ok
  run saved     /tmp/vr-runs5/2026-09-10T02-31-38.993Z-j3d1jd8d.json
error: verification failed (receipt) on payment 2 of 2 — all 2 purchases are recorded, but nothing was derived from the failed one; 1 decision(s) from 1 earlier verified purchase(s) still stand

exit 2
```

The verified `withdraw` survives with full citations, the failed payment is visibly marked
`receipt FAILED`, and the exit code is still 2.

### Files changed in this round

- `packages/agent/src/watch.ts`, `decisions` on the `ok: false` variant, populated at the
  in-loop failure return, reworded plural reason, `runWatch` printing and persisting them
- `packages/agent/src/tools.ts`, `err(message, extra)`, `paymentsOf()`, widened
  `reportSummary`, failure branch returning decisions/reports/payments,
  `RunLog.append` persisting on both branches, `vaultradar_quote` taking `vaults`
- `packages/agent/src/erc8004.ts`, `decodePqHash` with `fatal: true` and `PUB_HASH_RE`
- `packages/agent/test/watch.test.ts`, two new tests
- `packages/agent/test/tools.test.ts`, two new tests
- `packages/agent/test/cli.test.ts`, one new test

### Concerns after this round

1. **Still blocked, unchanged across all three rounds:** `vaultradar.fly.dev` does not
   answer, so no real x402 payment has executed on either rail. Every path here, including
   the partial-failure fan-out that now spends twice in one invocation, has only run against
   loopback.
2. **A partial failure spends real money and exits non-zero.** That is the safe direction
   and the reason string now says what carried, but an operator or a wrapper script that
   keys only on the exit code will see "failed" for a run that both paid twice and produced
   a valid `withdraw`. Anything automating `watch` should read the run file, not just `$?`.
3. **`decodePqHash` requires lowercase hex.** The agent card's `pub_hash` is produced
   lowercase by core's `sha256Hex`, so this matches today, but an ERC-8004 registration
   written by some other tool in uppercase would now read as "could not verify" rather than
   matching. I chose exact-match over case-insensitive because the comparison downstream is
   a plain string equality against the card, and normalising here would hide a real
   encoding disagreement. Worth confirming against whatever script eventually writes the
   registration.
4. **`vaultradar_quote` now has two ways to say the same thing** (`count` and
   `vaults.length`). When both are passed and disagree, `vaults.length` wins and `count` is
   ignored. That is the safer precedence, but a model could be confused by it; tightening
   would mean dropping `count`, which departs from the brief's stated interface.

---

## Typecheck fix

Commit: `774931a`, "fix(agent): type the HCS stub against the service's real lookup
contract, and read the sequence as a string"

Merged `main` (39c4db9) into `ws/agent` first. It fast-forwarded, main already contained
Tasks 22-23 and both fix rounds, so there was nothing to resolve, and `.env.example` did
not conflict. `bun install` picked up the `@x402/fetch` dependency main added to the
service; without it the root typecheck fails earlier, in `packages/service`, before it ever
reaches the agent.

```
bun run typecheck                  → clean (exit 0; core, service, agent in sequence)
bun test packages/agent            → 73 pass, 0 fail, 385 expect() calls, 6 files
bun test packages/service          → 61 pass, 1 skip, 0 fail
bun test                           → 209 pass, 1 skip, 0 fail, 790 expect() calls, 28 files
```

The one skip is `hedera-rail.live.test.ts`, gated behind `LIVE=1`; it came from main and is
untouched.

### The reported error

```
packages/agent/test/harness.ts(106,52): error TS2740: Type '{ lookup: (hash: string) =>
Promise<{ receipt_hash: string; topicId: string; sequence: number; }>; }' is missing the
following properties from type 'HcsQueue': done, q, running, retryMs, and 5 more.
```

Main replaced the service's narrow `HcsLookup` interface with the concrete `HcsQueue` class
(new `packages/service/src/hcs.ts`) and pointed `BuildAppDeps.hcs` and `WellKnownDeps.hcs`
at the class. `HcsQueue` has private fields, so no object literal can satisfy it
structurally, only an instance can. The harness's `{ lookup }` stub, written against the
old interface, became unassignable.

### Fix: the service declares the surface it uses

No cast. `app.ts` calls `deps.hcs?.enqueue(receipt)` and `wellknown.ts` calls
`hcs.lookup(hash)`; that pair is the whole dependency, so it is now named:

```ts
export interface HcsSink {
  enqueue(r: Receipt): void;
  lookup(h: string): Promise<LookupResult>;
}
```

`HcsQueue implements HcsSink`, so production wiring through `main.ts` is unchanged and the
compiler now checks that claim. `BuildAppDeps.hcs` and `WellKnownDeps.hcs` are
`HcsSink | null`, and `HcsSink`/`LookupResult` are re-exported from
`packages/service/src/index.ts` so a test can build a typed stand-in. Four service files
touched, all type-level.

### What the type error was hiding, the substantive half

Typing the stub against `LookupResult` immediately failed on a second count, because
`LookupResult.sequence` is **`string | null`**, not a number. My `pollHcs` had:

```ts
sequence: typeof body.sequence === "number" ? body.sequence : null
```

So against the real service every receipt would have read as `sequence: null`, and `watch`
would have printed `HCS SEQ  pending` forever, for a sequence the service had already
committed. The "HCS sequence per vault" citation the brief requires would never have
appeared outside my own tests. The stub's numeric `1234` had made the tests agree with the
agent instead of with the service; this is exactly the drift the loose `hcs` type allowed.

Correcting the stub first reproduced the bug as two test failures showing
`sequence pending` where `sequence 1234` was expected, which is the red state that
justified the fix:

```
Expected to contain: "sequence 1234"
Received: "…  hcs           topic 0.0.99 sequence pending …"
(fail) watch runs discover -> quote -> scan -> decide, writes a RunRecord, and exits 0
(fail) vaultradar_scan pays, verifies, decides, and appends a RunRecord the dashboard can read
```

Fix in `packages/agent/src/watch.ts`:

- `HcsRecord.sequence` is now `string | null`. An HCS sequence number is an int64, so it
  does not survive a round trip through a JS number, which is why the service sends a
  string. **`packages/dashboard/lib/service.ts` already had `sequence: string | null`**, so
  the agent was the only one of the three packages with it wrong; this aligns them.
- `pollHcs` accepts a string (non-empty) and also coerces a number rather than discarding
  it, so an older or future service shape still yields a usable citation instead of a silent
  "pending".
- The harness fake returns the full `LookupResult`, `sequence` as a string plus
  `consensus_timestamp` and `initial_transaction_id`, so the compiler holds it to the real
  contract from here on. `TEST_HCS_SEQUENCE` is `"1234"`.

Two assertions added to the `pollHcs` test: an int64-max sequence
(`"9223372036854775807"`) survives intact, which is the whole reason the service sends a
string; and a numeric `77` still produces `"77"` rather than null.

The `/v1/receipts/:hash` round trip is exercised for real in these tests, `pollHcs` calls
the in-process service over HTTP, so the JSON encoding of `sequence` is now genuinely
covered rather than assumed.

### Files changed

- `packages/service/src/hcs.ts`, `HcsSink` interface, `HcsQueue implements HcsSink`
- `packages/service/src/app.ts`, `src/wellknown.ts`, depend on `HcsSink | null`
- `packages/service/src/index.ts`, re-export `HcsSink`, `LookupResult`
- `packages/agent/src/watch.ts`, `HcsRecord.sequence: string | null`, `pollHcs` parsing
- `packages/agent/test/harness.ts`, typed `HcsSink` fake returning a full `LookupResult`
- `packages/agent/test/watch.test.ts`, string sequence, int64-max and numeric-fallback
  assertions

### Concerns

1. **This is the second bug found by making a fake honest** (the first was the Hedera CAIP-2
   network id in round 1). Both were invisible to `bun test` because the only consumer of
   the wrong shape was my own stub. The remaining stubs worth the same scrutiny are
   `payingFetch` (stands in for x402 middleware, so the `payment-response` header shape is
   still assumed) and the injected `arcPay`, which no test checks against the real
   `GatewayClient` behaviour.
2. **`watch` does not surface `consensus_timestamp` or `initial_transaction_id`**, though
   the service now returns both and the harness fake carries them. The brief asks only for
   the sequence, so I did not widen the printed output or `HcsRecord`; the consensus
   timestamp is arguably the stronger citation of the two and would be a small follow-up.
3. The service type change is small and type-level, but it is service code edited from the
   agent worktree. `HcsQueue implements HcsSink` means the compiler now enforces the claim,
   and all 61 service tests pass, but a service reviewer should still confirm they are happy
   with `buildApp` depending on the interface rather than the class.
