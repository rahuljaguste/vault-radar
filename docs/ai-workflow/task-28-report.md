# Task 28 report: dashboard portfolio and admin views

Branch `ws/dashboard`, worktree `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard`.

Commits:

- `18c006d feat(dashboard): portfolio user view and admin metrics view` (Phase A)
- `31b023e Merge branch 'main' into ws/dashboard` (clean)
- `274a76b feat(dashboard): paid scan route behind /portfolio` (Phase B, first pass)
- `af6e33b merge: main into ws/dashboard (agent policy, watch, tools, balances)` (two conflicts, resolved)
- `35c6efe refactor(dashboard): use the agent's policy helpers in the paid-scan route` (Phase B, final)
- `67e4c2c feat(dashboard): over_budget code, per-scan ceiling guard, env union` (pre-review)

Phase C was skipped; see "Phase C" below.

**Read the "Second merge" section before the Phase B section.** Phase B was
written twice: once against a local stand-in, then again against the real agent
policy helpers once the team lead confirmed they had landed on `main`. The final
state is the second version. The first-pass description is kept because it
explains two commits in the history.

## Phase A: the two views and the pure modules behind them

`lib/vaults.ts`, `parseVaultList(text)` returns a discriminated
`{ ok: true, vaults } | { ok: false, error }` rather than throwing, so the route maps
it straight to a 400 and the browser form can show the same message live. One
`<chainId>:0x<40 hex>` per line, blank lines ignored, CRLF accepted, addresses
lowercased, duplicates dropped keeping first position, capped at 100 (`MAX_VAULTS`,
matching `MAX_SCAN` in `packages/core/src/pricing.ts`). Chain ids must be positive
integers with no leading zero, because `01:0x...` and `1:0x...` name the same vault and
allowing both would defeat deduplication. Deduplication runs before the cap, so
pasting the same vault twice is never what trips the limit. Errors name the line
number, echo the line back truncated to 64 characters, and give the specific reason:
a bare address reports the missing chain prefix, a truncated address reports the hex
length it actually had, and so on. Pure, so it is safe in the client bundle.

`lib/ratelimit.ts`, `RateLimiter(windowMs, now)` with an injectable clock, one call
per key per 30 seconds, `retryAfterSeconds` rounded up and never zero. Expired keys
are swept on every call so the map does not accumulate one entry per client forever.
A refused call does not extend the window, so this is a rate and not a lockout.
`clientKey(req)` takes the first `x-forwarded-for` entry, then `x-real-ip`, then a
single shared `"unknown"` bucket: with no usable address, limiting everyone together
is safer for the operator's wallet than limiting nobody. The module header states
plainly that this is advisory (a direct caller can forge either header, and counters
are per process) and points at the real spending cap.

`lib/admin.ts`, the full spec §13.1 type with every numeric as a string, plus
`fetchAdminMetrics()` returning `AdminResult`, a seven-state union rather than an
exception: `ok`, `not-configured`, `unauthorized`, `not-implemented`, `bad-status`,
`malformed`, `unreachable`. `not-configured` and `unauthorized` are separate because
they have different fixes, and `not-implemented` exists specifically because the
endpoint is Task 27's and a 404 from a live service is a far more useful message than
a bare bad status. The shape check validates containers only, not every leaf, so a
minor difference when Task 27 lands renders as a dash rather than turning the page
into "malformed". `ADMIN_TOKEN` is read here and nowhere else, travels only in a
request header, never appears in a URL or in any returned value, and has no
`NEXT_PUBLIC_` prefix so Next substitutes `undefined` for it in any client bundle.
A 5-second `AbortSignal.timeout` keeps an unreachable service from holding the render
open.

`app/admin/page.tsx` plus `app/admin/AutoRefresh.tsx`, a server component rendering
every §13.1 field (uptime, both rails with facilitator health, request and verdict
counters, settlements and revenue per rail, the HCS queue, every standardized
deployment with head lag and last error, per-chain head state, key hashes, and the
on-chain-versus-local identity check) with status colours: `live`/healthy/`matches`
green, `stale` and non-zero warn counters amber, `down`/unhealthy/`MISMATCH` red,
unknown grey. Counters above zero are highlighted only when above zero, so a quiet
service stays quiet. The "counters reset when the service restarts" note sits above
the numbers, naming the actual `startedAt` when one is available. Refresh is
`router.refresh()` on a 15-second interval from a small client component, which keeps
the token inside the server component and needs no new API route; it also has pause
and refresh-now controls and a last-refresh clock set in an effect so there is no
hydration mismatch.

`app/portfolio/page.tsx` plus `app/portfolio/ScanForm.tsx`, the server component
reads the agent-key environment and passes down only a boolean, never a value. The
client form has the textarea, a live validated count using the same parser the route
uses, "Scan now" (disabled while running, when the list is invalid, and when keys are
absent), and a free "Show history" that lists earlier runs covering the same vaults
without buying anything. Results render the purchase summary (run link, price,
payment linked to HashScan or Arcscan, receipt hash with a link to `/verify`), a
verdicts table with colour-coded verdicts, scores and flags, any vaults the max-age
check rejected, and a decisions table with action, reason and full citations (block,
source, receipt hash, transaction link). With no keys configured the page explains
that and links a finished run.

Supporting changes:

- `app/api/runs/route.ts` now accepts `?vaults=<comma or newline separated>` and
  returns `{ matches }` (distinct from the unfiltered `{ runs }`), so the history
  section is one request rather than one per run from the browser.
- `lib/runs.ts` gained `runsDir()` honouring `RUNS_DIR`, used by both the reader and
  the scan writer so they cannot disagree, and `findRunsForVaults()` matching
  case-insensitively on both sides.
- Nav links for both new pages, a `--warn` colour in light and dark, `.muted`,
  `.toolbar` and `label` styles.
- `packages/dashboard/README.md` replaced: every page with its rendering mode and
  what it shows, every API route, every environment variable with who reads it and
  its default, every command, and the file layout.
- `.env.example` gained `ADMIN_TOKEN` (its own section, since the service reads it
  too) and `RUNS_DIR`, plus a dashboard note on the agent keys.

### Two fixes that Phase A's own features depend on

**`getRun` could not find any real run.** `saveRun` in `packages/agent/src/runs.ts`
names files `<startedAt with ':' -> '-'>-<id>.json`, but `getRun` matched only
`<id>.json` or an exact stem. The dashboard's `listRuns` reads `id` out of the file
contents and links to `/runs/<id>`, so every link to a genuine agent-written run
404'd; only the bundled demo run worked. `getRun` now tries the filename forms,
confirms against the `id` field inside the file (still authoritative), and falls back
to a full scan, so a run whose id is a suffix of another's filename resolves to the
right one. Verified at the end of Phase B against a file the scan route actually
wrote.

**`public/demo-run.json` used malformed vault ids.** They were bare 38-hex addresses
with no chain prefix, not the contract's `<chainId>:0x<40 hex>`. Nothing pasted into
`/portfolio` could ever match them, so the history section was dead in demo mode.
Widened to 40 hex and prefixed with the chain id each request already declared.

## Second merge: the real policy helpers landed

The team lead reported `packages/agent/src/policy.ts` and `watch.ts` on `main`
minutes after I first reported. `git merge main` then brought agent Tasks 22-23
with two conflicts:

1. **`packages/agent/src/rails/hedera.ts`**, upstream had independently found
   and fixed the same CAIP-2 network-id bug described below, and their version is
   better: a named `HEDERA_TESTNET_CAIP2` constant used for both the signer option
   and the scheme registration (so the two cannot drift), plus test coverage of
   signer construction. I took `main`'s version wholesale and dropped my parallel
   fix. Textbook duplicated work; the finding still stands, the fix was theirs to
   keep.
2. **`.env.example`**, upstream rewrote the file into a terse
   one-line-per-variable style, discarding the verbose prose. I adopted their
   convention rather than reimposing my blocks: kept `ADMIN_TOKEN` and the
   dashboard section folded into that style, moved `SUBSTREAMS_API_TOKEN` up
   beside the other Graph variables and dropped its "added during merge" note,
   and took `main`'s side everywhere else. There is now one `RUNS_DIR`
   declaration, in the agent section, shared by the agent CLI and the dashboard.
   Note this means **`main`'s removal of `LIVE`, `CHROME_BIN` and `DIAGRAM_SCALE`
   stands**; `LIVE=1` still gates `packages/service/test/hedera-rail.live.test.ts`,
   so if that removal was accidental it needs restoring by whoever owns the file.

`35c6efe` then swapped the route onto the real helpers and deleted
`lib/decide.ts`. What changed in behaviour:

- **The policy's `budget.usdc_hedera` is enforced** against the quote before
  paying, which is what §13.2 asked for. The stand-in ceiling is gone. `chooseRail`
  is deliberately still not used: it also weighs wallet balance and facilitator
  health across both rails, and this app only ever holds a Hedera key, so the rail
  is fixed and the budget is the gate that matters here.
- **`chooseTier` decides sealed vs clear**, so a `cheap` privacy policy now sends
  the request in the clear as designed.
- **A `strict` policy is refused, not downgraded.** It buys whole protocol tables,
  which need a protocol and chain id rather than a vault list. Silently serving a
  scan instead would disclose exactly the holding the strict tier exists to hide,
  so the route returns 503 with that explanation and points at the agent CLI.
- **`max_age_seconds` comes from the policy** rather than a constant.
- **An unreadable or invalid policy is a 503 naming the offending field**, never a
  silent default budget, because `loadPolicy` refuses to infer a spending cap.
- `POLICY_PATH` is now read, resolved against the repo root through a new
  `repoRoot()` helper in `lib/runs.ts` that `runsDir()` also uses.
- The run file's `policy` block is the loaded policy verbatim, so it is now simply
  true rather than a description of what the route happened to enforce.

The deviation noted below (a local age check) and the promised-budget gap are both
**closed** by this commit. Everything the brief listed for Phase B
(`loadPolicy`, `chooseTier`, `applyAgeCheck`, `decide`, `saveRun`) is now the
agent's own code.

## Phase B, first pass: which path, and the paid-scan route

This section describes `274a76b`, superseded by `35c6efe` above.

**Path taken: the fallback.** `packages/agent/src/policy.ts` and `watch.ts` exist on
`ws/agent` but have not landed on `main`; after `git merge main` (which brought
service Tasks 17-18) `packages/agent/src/` still contains only `client.ts`,
`erc8004.ts`, `index.ts`, `rails/`, and `runs.ts`. So the route uses
`VaultRadarClient` plus a local `lib/decide.ts`.

`lib/scan.ts` holds the handler with injectable dependencies
(`makeClient`, `runsDir`, `limiter`, `now`, `env`); `app/api/scan/route.ts` is a
one-line wrapper. That split exists because Next.js type-checks route files against a
known set of exports, so a testable seam cannot live there, and the brief's own file
list called for `lib/scan.ts`.

Order of operations, which matters:

1. Keys absent, before the body is even read, so a misconfigured deploy never looks
   like a bad request. `503 { error: "agent keys not configured" }`.
2. Body and vault list validated. `400`.
3. Quote checked against a hard per-scan ceiling. `400` if over.
4. Only now is the rate-limit window consumed, since every check above is free and
   deterministic. A typo therefore does not cost the caller their 30 seconds.
   `429` with a `retry-after` header.
5. `discover()` and refuse to pay a service whose card signature does not verify, or
   whose on-chain ERC-8004 key hash disagrees with the key on its card. `502`.
   A `matches: null` (no RPC configured) does not block.
6. Pay: sealed `scan` on the Hedera rail.
7. Verify the receipt and every attestation. If either fails, return `502` rather
   than unverified verdicts, but still write the run, because a service answering
   with an unverifiable receipt is exactly what an operator needs the evidence for.
8. Apply the max-age bar to the signed attestation timestamps, build the
   `RunRecord`, `saveRun` into `runsDir()`, and return
   `{ runId, requests, decisions, txId, receiptHash, priceUsd }`.

`txId` prefers the x402 `payment-response` header and falls back to the
service-signed `receipt.payment.txId`, so a run is never recorded without the
reference it has.

Secrets discipline: the keys are read in one place, handed straight to the client,
and never written to a response, a log line, or the run file. Every error leaving the
module goes through `redact()`, which strips the bare, `0x`-prefixed and as-given
forms of each secret (longest first) and caps the message at 300 characters, because
a third-party SDK's exception text is not something to trust with a private key. The
test asserts a rail that puts the key in its own error message cannot leak it.

`lib/decide.ts` is the local stand-in: `applyAgeCheck` and `decide`, mirroring the
signatures in `packages/agent/src/policy.ts` so the swap is an import change plus
passing a loaded `Policy` instead of a bare `maxAgeSeconds`. A file-header TODO names
them.

### Deviation from the letter of the brief, with the reason (now moot)

The brief said the local `lib/decide.ts` should contain "only the verdict→action
mapping". It also contains the age split. Without it `rejected` would always be
empty, and `RunRecord.policy.max_age_seconds` would have to carry a number the route
does not enforce, which `/runs/[id]` renders verbatim as "max age Ns". Putting a
false number into a signed-evidence artifact to preserve a six-line abstraction
boundary was the wrong trade, so the bar is real (900 seconds, the agent policy's
documented default) and the recorded value is true. Deleting those six lines is the
whole cost when `applyAgeCheck` lands.

### The promised-but-missing policy budget (now closed)

Spec §13.2 says purchases are "capped by the policy budget". Without `loadPolicy`
there is no policy to read, and writing a second policy loader here would be exactly
the parallel implementation that makes the later merge worse. Instead the route
enforces a hard `MAX_PRICE_USD = "0.10"` ceiling checked against the quote before
anything is paid, and the run record records that as the budget so the record matches
what actually ran. The metered price tops out at 0.051 USD for 100 vaults, so the
ceiling never rejects a legitimate request; it is a stop against a pricing change or
a count bug. The `/portfolio` copy and the README both say "per-scan price ceiling",
not "policy budget", and `POLICY_PATH` is documented as **not read by this app yet**
in both the README and `.env.example`. TODOs in `lib/scan.ts` name `loadPolicy` and
`chooseRail`/`chooseTier` as the swap-ins.

### A real blocker found in `packages/agent` (upstream fixed it too)

`packages/agent/src/rails/hedera.ts` passed `{ network: "testnet" } as any` to
`createClientHederaSigner`. That function accepts only CAIP-2 identifiers
(`SUPPORTED_HEDERA_NETWORKS = ["hedera:mainnet", "hedera:testnet"]`) and throws
`Unsupported Hedera network: testnet` from `assertSupportedHederaNetwork` before any
request is made, so the real Hedera paying fetch could not be constructed at all.
The next line in the same function already registers the scheme under the correct
`"hedera:testnet"`, and the `as any` is what hid the mismatch. Every agent test
injects `payingFetch`, so nothing exercised it.

I changed it to `{ network: "hedera:testnet" }` and dropped the `as any`, which
type-checks without it; the browser run below is the proof. The second merge then
showed upstream had made the same discovery, so **their version is what ships** and
mine was discarded in the conflict resolution. The finding was real and the flow was
dead without it; the work was duplicated.

## Phase C: skipped entirely

The stretch item needs a free vault-list endpoint (`GET /v1/vaults?chainId=`). After
the merge, `grep -rn "v1/vaults" packages/service/src/` finds nothing; the service's
only public catalog route is `GET /v1/catalog`, which returns per-protocol counts and
no vault ids. Per the brief's instruction, Phase C is skipped rather than
half-built. No wallet-address input, no `lib/positions.ts`, no `viem` multicall, and
no claim anywhere that browser-wallet payment or position discovery exists. The §13.1
stretch (a settlements table of the last 50 receipt hashes) is likewise absent,
because the metrics shape carries no per-settlement list.

## Verification

Final state, after the policy swap:

```
bun test packages/dashboard
# 78 pass, 0 fail, 251 expect() calls, 6 files

bun test packages/agent
# 73 pass, 0 fail, 383 expect() calls, 6 files

bun x tsc -p packages/dashboard/tsconfig.json --noEmit   # clean
bun x tsc -p packages/core/tsconfig.json --noEmit        # clean
bun x tsc -p packages/service/tsconfig.json --noEmit     # clean
bun run --cwd packages/dashboard lint                    # clean

SERVICE_URL=http://localhost:8787 bun run --cwd packages/dashboard build
# exit 0. Routes: ƒ /, ○ /_not-found, ƒ /admin, ƒ /api/runs, ƒ /api/runs/[id],
#                ƒ /api/scan, ƒ /portfolio, ƒ /runs/[id], ○ /verify
```

`bun x tsc -p packages/agent/tsconfig.json --noEmit` does **not** pass:

```
packages/agent/test/harness.ts(106,52): error TS2740: Type '{ lookup: ... }' is
missing the following properties from type 'HcsQueue': done, q, running, retryMs, and 5 more.
```

That file is byte-identical to `main`'s and the error reproduces with my changes
stashed, so it arrived with the merge and is not mine. It does break the repo-root
`bun run typecheck`, which includes the agent project. Left for the agent task;
see concerns.

The dashboard build prints three "dynamic filesystem access" warnings from
`lib/runs.ts`. They pre-date this task (Task 24's `path.resolve(process.cwd(), ...)`
plus `fs.readFile` produces them) and the build exits 0.

Dashboard test counts by file: `vaults.test.ts` 14, `ratelimit.test.ts` 13,
`runs-dir.test.ts` 11, `scan.test.ts` 30, plus Task 24's `explorer.test.ts` 5 and
`runs.test.ts` 5.

`test/scan.test.ts` drives `handleScan` against a real in-process service the way
`packages/agent/test/client.test.ts` does: `buildApp` for discovery, a raw
`/hedera/v1/scan` mount with a fixed payer and tx id, `payingFetch: fetch`, a stubbed
`readPqHash`. No Hedera signer is constructed and nothing is paid. Policies are real
files on disk parsed by the agent's own `loadPolicy`, not hand-built objects. It
covers the happy path, the written run file and its policy block, every
verdict-to-action mapping with real risk flags computed by `computeRisk`,
`unavailable` and age-rejected both becoming "insufficient data" for different stated
reasons, an unknown vault, a missing policy file, an invalid policy naming the field,
`strict` refused, `cheap` answering unsealed, a budget too small for the quote, a
tighter `max_age_seconds` rejecting a vault the default accepts, the budget gate not
consuming the rate-limit window, all four 503 key-absence shapes, 400 on non-JSON, on
a wrong-typed `vaults`, on a malformed id, on an empty list and on 101 vaults, a raw
string body, 429 with its header plus per-address independence, 502 for a substituted
on-chain key hash, 502 for an unreachable service, key redaction through a rail that
leaks it, and a client that cannot be constructed.

### Driven in a real browser

Headless Chrome 152 over CDP, no test-automation dependencies. Run once before the
policy swap and again after it, with matching results.

Admin page against a stub endpoint serving the §13.1 shape: every field rendered
(checked as extracted text), `uptimeSeconds` shown unrounded with a readable duration
beside it, 8 `ok` / 3 `warn` / 6 `error` colour classes applied, and zero occurrences
of the token in the HTML. Re-run with a wrong token and with an unreachable port: the
401 and "Endpoint unreachable" states render inline with the right remedy.

Portfolio, full purchase flow against an in-process service with the dashboard's real
`/api/scan` and a real `VaultRadarClient`:

- Three vaults pasted with uppercase addresses, normalised and accepted; live hint
  read "3 vaults ready", and an invalid line showed the parser's own message.
- While the request was in flight, both buttons and the textarea were disabled and the
  label read "Paying and scanning...".
- Result: run `web-c3f4177a2ba5`, price 0.0025 USD, payment linked to
  `hashscan.io/testnet/transaction/0.0.42-1700000000-000000001`, receipt hash with a
  "verify it" link; verdicts `ok 0`, `alert 55` (two drawdown flags with values and
  thresholds), `watch 25`, in green, red and amber; decisions `hold`, `withdraw`,
  `rebalance` with reasons naming the flags and citations carrying block, source,
  receipt hash and transaction link.
- History refreshed itself after the purchase and found the new run.
- A second click was refused with "one paid scan per 30 seconds; try again in 30s".
- Zero console messages and zero exceptions throughout.
- The private key appeared nowhere in the page and nowhere in the run file.

The written run file recorded `packages/agent/policy.example.json` verbatim
(`budget 1.00/1.00`, `balanced`, `cheapest`, `max_age_seconds 900`) and rendered
correctly on the pre-existing `/runs/<id>` page, which is what confirms the `getRun`
fix against a genuinely agent-named file rather than a fixture.

All four policy paths were also exercised over real HTTP against the running app with
`POLICY_PATH` pointed at purpose-built files:

| Policy | Result |
|---|---|
| `privacy: strict` | 503, "buys whole protocol tables, which this page cannot request from a vault list" |
| `budget.usdc_hedera: 0.0005` | 400, "the quote of 0.0015 USD for 1 vaults exceeds the policy's hedera budget of 0.0005 USD" |
| `privacy: cheap` | 200 with `sealed: false` |
| file absent | 503, "the agent policy could not be loaded: policy not readable at ..." |

Final route sweep with no service reachable and no keys: `/`, `/portfolio`,
`/verify`, `/admin`, `/runs/demo-run-1`, `/api/runs`, `/api/runs/demo-run-1` all 200;
`/runs/nope` and `/api/runs/nope` 404; `POST /api/scan` returns exactly
`{"error":"agent keys not configured"}` with 503.

## Files changed

New, all under `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/`:

- `lib/vaults.ts`, vault-list parsing
- `lib/ratelimit.ts`, the paid-scan limiter and `clientKey`
- `lib/admin.ts`, the §13.1 types and the seven-state metrics fetch
- `lib/scan.ts`, the `POST /api/scan` handler with injectable dependencies
- `app/portfolio/page.tsx`, `app/portfolio/ScanForm.tsx`
- `app/admin/page.tsx`, `app/admin/AutoRefresh.tsx`
- `app/api/scan/route.ts`
- `test/vaults.test.ts`, `test/ratelimit.test.ts`, `test/runs-dir.test.ts`, `test/scan.test.ts`

Created then deleted in the same task: `lib/decide.ts` (the local policy stand-in,
removed by `35c6efe` in favour of the agent's own helpers).

Modified:

- `packages/dashboard/lib/runs.ts`, `repoRoot()`, `runsDir()` honouring `RUNS_DIR`,
  the `getRun` fix, `findRunsForVaults`
- `packages/dashboard/lib/types.ts`, `RunMatch`, declared here so the client
  component can import it without pulling in `node:fs`
- `packages/dashboard/app/api/runs/route.ts`, the `?vaults=` filter
- `packages/dashboard/app/layout.tsx`, nav
- `packages/dashboard/app/globals.css`, `--warn`, `.muted`, `.toolbar`, `label`
- `packages/dashboard/public/demo-run.json`, vault-id format
- `packages/dashboard/README.md`, boilerplate replaced
- `packages/dashboard/package.json`, `@vaultradar/agent` dependency,
  `@vaultradar/service` devDependency for the test harness
- `.env.example`, `ADMIN_TOKEN` and a dashboard section, folded into `main`'s terse
  style during the second merge
- `bun.lock`

Touched and then reverted: `packages/agent/src/rails/hedera.ts`. My CAIP-2 fix was
dropped in the second merge in favour of `main`'s equivalent, so the final diff
against `main` contains **no** changes to `packages/agent`.

Nothing under `.next/`, `runs/` or `node_modules/` was committed.

## Self-review

- **Every §13.1 promised field is rendered**, checked by extracting the text of a page
  served against a stub endpoint rather than by reading the JSX. The §13.1 stretch
  (last-50 settlements table) is absent, as is every §13.2 stretch. No stretch item
  is half-present and none is claimed anywhere.
- **Every §13.2 promised item is present**: paste, "Scan now", a server-side paid x402
  scan with the operator's account under the operator's policy, receipt and
  attestation verification, a saved run, verdicts, flags, decisions with citations,
  payment link, receipt hash, history for the same vaults, the 30-second rate limit,
  the policy budget, and the keys-absent notice with a link to a finished run. After
  `35c6efe` there is nothing in §13's promised scope standing in for something else.
- **§13.3 honesty**: `/portfolio` and the README both state the payer is the
  operator's funded agent account and not a wallet in the browser. Nothing describes
  browser-wallet payment.
- **No key material client-side**: the server component passes a boolean, not a
  value; the rendered HTML was grepped for the key across several runs; the run file
  was grepped for the key and the account id; and errors are redacted before being
  returned *or* logged (the test output shows `[redacted]` in the log line).
- **No parallel implementation left behind.** `lib/decide.ts` is gone and the CAIP-2
  fix is upstream's. The only remaining dashboard-local policy decision is "the rail
  is always Hedera", which is a fact about this app's configuration rather than a
  reimplementation of `chooseRail`, and it says so in a comment.
- Build, three of four typechecks, eslint and all 151 tests clean; the fourth
  typecheck failure arrived with the merge and reproduces without my changes.

## Concerns for the controller

1. **`bun run typecheck` is red at the repo root**, on
   `packages/agent/test/harness.ts(106,52)`. It came in with agent Tasks 22-23, is
   byte-identical to `main`, and reproduces with my work stashed. `bun test` passes
   because Bun does not type-check. It looks like a one-line cast in their test
   harness, but it is their file and I deliberately did not touch it after the CAIP-2
   duplication. Worth routing to the agent task.
2. **I duplicated upstream's CAIP-2 fix.** I found and fixed it in
   `packages/agent/src/rails/hedera.ts`; upstream found the same thing independently
   and shipped a better version. I took theirs in the conflict. Nothing to reconcile,
   but it cost a commit's worth of work on both sides, and the lesson is to check
   `ws/agent` before fixing anything in `packages/agent` from here.
3. **`.env.example` lost `LIVE`, `CHROME_BIN` and `DIAGRAM_SCALE`** when `main`
   rewrote the file into its terse style; I took `main`'s side rather than reimposing
   removed content. `LIVE=1` still gates
   `packages/service/test/hedera-rail.live.test.ts`, so if that removal was
   accidental it should be restored by whoever owns the file.
4. **`/admin` has never run against the real endpoint**, because Task 27 has not
   landed. It was verified against a stub serving the §13.1 shape plus the 401, 404
   and unreachable paths. If Task 27's field names or nesting differ from §13.1, the
   page shows "the metrics response was not the expected shape" rather than crashing,
   but the two will need a pass together.
5. **The rate limiter is per process.** On a platform that scales the dashboard out,
   N instances means N scans per 30 seconds. The policy budget now backs it up, but
   the budget is also evaluated per request rather than accumulated across a run, so
   it caps the size of any single purchase, not the total spend over time. If the
   demo deployment is public, consider a small absolute float in the payer account
   rather than relying on either limit.
6. **No live testnet purchase has been made from this dashboard.** Everything ran
   against an in-process service with the payment middleware unmounted, so the
   402-pay-retry leg of `payingFetchHedera` is still unexercised end to end. Given
   that both the agent task and I independently found that signer construction was
   broken there, that leg deserves one real testnet purchase before the video. It is
   the highest-risk remaining unknown in the user flow.
7. **`public/demo-run.json`'s vault-id fix and the `getRun` fix** both touch Task
   24's files. Both were blocking the history and run-link features in this task.
8. **`@vaultradar/service` is a devDependency of the dashboard** for the test harness
   only. Keep any file that imports it under `test/`, which the dashboard tsconfig
   excludes: importing it from a file inside the tsconfig program pulls the service's
   sources into the dashboard's ES2017/no-bun-types compile and fails `next build`
   with two unrelated errors. I hit that with a scratch file and moved it.

## Pre-review: real policy helpers

The team lead's pre-review asked for the swap onto the agent's policy helpers.
I had already merged `main` and done most of it in `af6e33b` and `35c6efe`
(see "Second merge" above, and the note at the top about Phase B being written
twice) before their message arrived. Three of their instructions differed from
what I had shipped, and all three were improvements. Commit `67e4c2c` closes
them.

### 1. `.env.example` resolved by union, not by taking one side

Their instruction was "resolve by union keeping every variable name". I had taken
`main`'s side, which silently dropped **nine** variable names that existed before
the merge. I restored all nine in `main`'s terse style and verified the result is
a superset of both sides (40 names; `comm` against both parents reports nothing
missing either way):

| Variable | Read by | Why losing it mattered |
|---|---|---|
| `DEPLOYER_KEY_HEDERA`, `DEPLOYER_KEY_ARC` | `packages/service/scripts/identity.ts` | The identity bootstrap cannot run without them, and they had just been added by service Tasks 17-18. |
| `LIVE` | `packages/service/test/hedera-rail.live.test.ts` | Gates the tests that spend real testnet USDC. |
| `VAULT` | `packages/service/scripts/hello-x402.ts` | The demo client's vault id. |
| `DEPOSIT` | nothing yet (designed, for `hello-arc`) | Documented deploy config for a built task. |
| `RPC_URL_10`, `RPC_URL_137` | `packages/core` freshness, per chain | Commented-out examples for registry chains. |
| `CHROME_BIN`, `DIAGRAM_SCALE` | `scripts/render-diagrams.mjs` | Commented-out examples for the diagram renderer. |

This is the one place where my own merge resolution was wrong rather than merely
different, and it is worth noting that taking "their side" on a conflicted shared
file is not a safe default: `main`'s rewrite of this file was lossy, and a
side-taking resolution propagated the loss.

### 2. `400 { error: "over_budget" }` as a code, with the amounts

I had returned a full English sentence. Now the wire carries the code plus the
two amounts, `{ error: "over_budget", quoteUsd, budgetUsd }`, which is what a
programmatic caller wants.

One addition they did not ask for but which the change requires: `/portfolio`
renders `body.error` directly for a 400, so shipping the code alone would have
put a bare `over_budget` in front of a portfolio owner. `ScanForm` now maps both
spending codes to sentences built from the returned amounts. Verified in headless
Chrome against a 0.001 USD budget policy: the page reads "Over budget: this scan
costs 0.002 USD and the agent policy allows 0.001 USD per purchase on the Hedera
rail. Scan fewer vaults or raise the policy budget.", and `over_budget` appears
nowhere in the rendered text.

### 3. The per-scan ceiling kept as an additional guard

I had deleted `MAX_PRICE_USD` when the policy budget became real. It is back as a
second, policy-independent cap, refusing with
`400 { error: "over_per_scan_ceiling", quoteUsd, ceilingUsd }`. The two are
checked in order: policy budget first, then the absolute ceiling. Page copy and
README now say "policy budget and a per-scan ceiling".

### 4. The micro-USD comparison

Both caps now compare in integer micro-USD via a small `toMicroUsd`, rather than
on raw floats. There is no exported comparison helper in `@vaultradar/agent` to
reuse; `watch.ts` open-codes `Math.round(Number(x) * 1e6)` and documents why, so
this adopts that convention rather than duplicating a function.

Worth flagging: `watch.ts`'s comment justifies it with `0.03 * 3` being
`0.09000000000000001`. That is not true; `0.03 * 3` is exactly `0.09` in IEEE
754 double arithmetic. The hazard is real at other values, including this
service's own prices, so I used a case that actually misbehaves in both the test
and the comment: `0.0015 * 3` is `0.0045000000000000005`, which compares greater
than a budget of exactly `"0.0045"` and would refuse a purchase the policy
allows. The agent's comment has a wrong example for a right conclusion; someone
may want to correct it there too.

### Verification of the pre-review commit

```
bun test packages/dashboard
# 81 pass, 0 fail, 260 expect() calls, 6 files  (up from 78)

bun x tsc -p packages/dashboard/tsconfig.json --noEmit   # clean
bun run --cwd packages/dashboard lint                    # clean
SERVICE_URL=http://localhost:8787 bun run --cwd packages/dashboard build   # exit 0
```

New tests: `over_budget` asserted as the exact body `{ error, quoteUsd,
budgetUsd }` against a tiny-budget policy file; a quote exactly equal to the
budget allowed, pinning the cap as inclusive; the 100-vault maximum confirmed to
sit under the ceiling so the ceiling never rejects a legitimate request; and
`toMicroUsd` covering the float case that motivates it. The earlier
"budget refusal does not consume the rate-limit window" test still passes.

Over real HTTP against the in-process service: a 0.001 USD budget policy returns
`{"error":"over_budget","quoteUsd":"0.002","budgetUsd":"0.001"}` with 400, and the
default policy still buys three vaults for 0.0025 USD sealed, with actions
hold/withdraw/rebalance.
