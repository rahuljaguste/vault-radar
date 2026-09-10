# `@vaultradar/dashboard`

The VaultRadar web UI: a Next.js 16 app (App Router, Turbopack, plain CSS, no UI
library) with three audiences on one site.

- **Anyone** can read what the service sells and inspect finished runs.
- **A portfolio owner** can buy a risk scan of their own vaults and see the
  verdicts, the decisions, the payment and the receipt.
- **The service operator** can watch the running service's counters.

Everything that costs money or touches a key happens in a server component or a
route handler. No private key, payment key or admin token is ever sent to the
browser.

## Pages

| Route | Rendering | What it shows |
|---|---|---|
| `/` | server | The service's agent card (name, ERC-8004 identities linked per chain, ML-DSA-65 and KEM key hashes, prices), the protocol catalog from `GET /v1/catalog`, and every run on disk. |
| `/runs/[id]` | server | One run in full: each paid request's rail, tier, sealed flag, price, payment transaction linked to HashScan or Arcscan, receipt hash, live HCS sequence from `GET /v1/receipts/:hash`, per-vault verdicts and flags, and the decisions with their citations. |
| `/portfolio` | server shell plus a client form | Paste a vault list, press **Scan now**, and the server buys a real x402 scan, verifies the receipt and attestations, saves a run, and returns verdicts, decisions with citations, the payment link and the receipt hash. **Show history (free)** lists earlier runs that covered the same vaults without buying anything. |
| `/verify` | client | Paste any receipt JSON and verify its ML-DSA-65 signature in the browser against the service's published key. No server involved. |
| `/admin` | server plus a 15-second client refresher | The operator's view of `GET /v1/admin/metrics`: uptime, both rails' facilitator health, request and verdict counters, settlement counts and revenue per rail, the HCS queue, every standardized deployment's status and head lag, per-chain head state, and the on-chain-versus-local key-hash check. |

### `/portfolio`, precisely

The payer is **the operator's funded agent account**, not a wallet in the
visitor's browser. A scan bought here settles on chain from
`AGENT_HEDERA_ACCOUNT_ID`. There is no browser-wallet payment path.

Requests are sealed with the hybrid post-quantum KEM before they leave the
dashboard's server, so nothing on the network path learns which vaults were
asked about. When `AGENT_HEDERA_ACCOUNT_ID` or `AGENT_HEDERA_KEY` is missing, the
page says so and links a finished run instead.

The decision logic is the agent's own, not a copy of it: `lib/scan.ts` calls
`loadPolicy`, `chooseTier`, `applyAgeCheck` and `decide` from
`packages/agent/src/policy.ts`, so a purchase made here obeys the same operator
policy and writes the same `RunRecord` as one made by the agent's watch loop.

The policy decides what gets bought. A `balanced` privacy tier buys a sealed
scan, `cheap` the same scan in the clear, and `strict` would buy a whole
protocol table, which needs a protocol and chain id rather than a vault list, so
this page refuses it with an explanation instead of quietly downgrading to a
scan and disclosing what the policy exists to hide.

Before paying, the handler verifies the service's signed agent card and refuses
if its on-chain ERC-8004 key hash disagrees with the key on the card. After
paying, it verifies the ML-DSA-65 receipt and every per-vault attestation, and
returns an error rather than unverified verdicts if either check fails (the run
file is still written, as evidence). It then applies the policy's
`max_age_seconds` to the signed attestation timestamps, so a vault the service
called fresh can still be refused.

Spending limits: the policy's `budget.usdc_hedera`, checked against the quote
before anything is paid, plus one scan per client address per 30 seconds (in
memory, per server instance). The rail is always Hedera, because that is the
only payment key this app reads; the agent's `chooseRail`, which also weighs
wallet balance and facilitator health across both rails, is not used here.

### `/admin`, precisely

The metrics endpoint is read server-side with `Authorization: Bearer
$ADMIN_TOKEN`. The token is read in `lib/admin.ts` and nowhere else; it is never
put in a URL, never returned in a response and never reaches the browser. The
page distinguishes four failure modes inline, because they have four different
fixes: no token configured here, a token the service rejects, an endpoint the
service does not implement, and a service that cannot be reached at all.

Every counter on that page lives in the service process and **resets when the
service restarts**. The page states this above the numbers.

## API routes

| Route | Returns |
|---|---|
| `GET /api/runs` | `{ runs: [{ id, startedAt, requestCount }] }` for every run on disk. |
| `GET /api/runs?vaults=<comma-separated ids>` | `{ matches: [...] }`: the prior runs covering any of those vaults, newest first, with the verdict and action each matched vault got. `400` with `{ error }` on an unparseable list. |
| `GET /api/runs/[id]` | The full `RunRecord`, `400` on an invalid id, `404` when no run carries it. |
| `POST /api/scan` | `{ vaults: string[] }` buys one sealed scan and returns `{ runId, requests, decisions, txId, receiptHash, priceUsd }`. `503` when the agent keys are absent, `400` on a bad vault list, `429` when rate-limited, `502` when the service cannot be verified or paid. The implementation is `lib/scan.ts`; the route file is a wrapper so the handler's dependencies can be injected by its test. |

## Environment

Read from the process environment at request time. The repo root's
`.env.example` documents all of these alongside the service's and agent's.

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `SERVICE_URL` | server components, `lib/service.ts`, `lib/admin.ts` | `http://localhost:8787` | The VaultRadar service this dashboard reads. |
| `NEXT_PUBLIC_SERVICE_URL` | `/verify` in the browser | none | Inlined at build time, which is why `/verify` needs its own variable. |
| `RUNS_DIR` | `lib/runs.ts`, `POST /api/scan` | `<repo root>/runs` | Where run files are read from and written to. Reader and writer share one resolver, so they cannot disagree. |
| `DEMO` | `lib/runs.ts` | unset | `DEMO=1` ignores `RUNS_DIR` entirely and serves `public/demo-run.json`, which is what a hosted deployment with no local runs uses. |
| `ADMIN_TOKEN` | `/admin` (server only) | none | Must equal the service's `ADMIN_TOKEN`. Unset means `/admin` explains that rather than failing. |
| `AGENT_HEDERA_ACCOUNT_ID` | `POST /api/scan` (server only) | none | The paying Hedera account. Absent disables paid scans. |
| `AGENT_HEDERA_KEY` | `POST /api/scan` (server only) | none | That account's ECDSA private key. Never logged, never returned, never bundled for the browser. Every error that leaves the handler is redacted against it first. |
| `POLICY_PATH` | `POST /api/scan` (server only) | `packages/agent/policy.example.json` | The operator's budget, privacy tier and `max_age_seconds`, read by the agent's own `loadPolicy`. Resolved against the repo root. An unreadable or invalid policy is a 503 naming the offending field, never a silent default. |

## Commands

Run from the repo root:

```bash
bun install
bun run --cwd packages/dashboard dev      # http://localhost:3000
bun run --cwd packages/dashboard build
bun run --cwd packages/dashboard start
bun run --cwd packages/dashboard lint
bun test packages/dashboard
bun x tsc -p packages/dashboard/tsconfig.json --noEmit
```

`dev`/`build`/`start` must run with `packages/dashboard` as the working
directory, which is what `--cwd` above does: the default runs directory is
resolved two levels up from it.

## Layout

```
app/
  layout.tsx          nav and global CSS
  page.tsx            /          catalog and runs
  portfolio/          /portfolio page.tsx (server) + ScanForm.tsx (client)
  admin/              /admin     page.tsx (server) + AutoRefresh.tsx (client)
  runs/[id]/          /runs/:id
  verify/             /verify    (client, runs ML-DSA-65 verification in-browser)
  api/runs/           run listing and lookup
  components/Table.tsx
lib/
  types.ts            RunRecord, shared verbatim with packages/agent/src/runs.ts
  runs.ts             read and search run files
  service.ts          the service's public endpoints
  admin.ts            the operator metrics endpoint, with its failure states
  explorer.ts         HashScan and Arcscan link building
  vaults.ts           vault-list parsing, shared by the form and the scan route
  ratelimit.ts        the paid-scan rate limiter
  scan.ts             the POST /api/scan handler, with injectable dependencies
test/                 bun tests for every pure module above
empty-pg.ts           browser stub; see next.config.ts
```

`lib/types.ts`'s `RunRecord` is a cross-package contract with
`packages/agent/src/runs.ts`. Change both together or neither. Anything that
imports `@vaultradar/service` must stay under `test/`, which this package's
tsconfig excludes: pulling the service's sources into the dashboard's compile
fails `next build`.

`next.config.ts` aliases `pg` to `empty-pg.ts` for the browser target only:
`@vaultradar/core` exposes a single barrel that reaches its Postgres-backed
Substreams reader, so any client-side import from that package would otherwise
drag `pg` (and Node's `net`/`tls`) into the browser bundle. Server bundles get
the real `pg`.
