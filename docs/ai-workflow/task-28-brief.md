### Task 28: Dashboard user view (portfolio) and admin view

**Files:**
- Create: `packages/dashboard/app/portfolio/page.tsx`, `packages/dashboard/app/portfolio/ScanForm.tsx` (client component), `packages/dashboard/app/api/scan/route.ts`, `packages/dashboard/app/admin/page.tsx`, `packages/dashboard/lib/scan.ts`, `packages/dashboard/lib/admin.ts`, `packages/dashboard/test/scan.test.ts`
- Modify: `packages/dashboard/app/layout.tsx` (nav links), `packages/dashboard/app/globals.css` (status colours, form styles), `packages/dashboard/README.md` (replace boilerplate), `.env.example` (`ADMIN_TOKEN`, dashboard `AGENT_*` note)

**Interfaces:**
- Consumes: `VaultRadarClient` from `@vaultradar/agent` (server-side only, inside the API route), `runWatch`-equivalent helpers (`chooseRail`, `chooseTier`, `applyAgeCheck`, `decide`, `saveRun`, `listRuns`), and `GET /v1/admin/metrics` per spec §13.1.
- Produces: `POST /api/scan` `{ vaults: string[] }` → `{ runId, requests, decisions, txId, receiptHash, priceUsd }` or `{ error }` with 400 (bad input), 429 (rate limit), 503 (agent keys missing). Rate limit: one paid scan per client IP per 30 s (in-memory). Never returns key material.

- [ ] **Step 1: Failing tests** — vault-list parsing and validation (`<chainId>:0x<40 hex>` per line, max 100, dedupe, lowercase); rate limiter; the `/api/scan` route against the in-process service harness (stub provider, raw handlers, `payingFetch: fetch`, injected `readPqHash`) returning decisions and writing a run file; 503 when keys are missing.
- [ ] **Step 2: Implement `/portfolio`** — textarea plus "Scan now" (disabled while running), results table with colour-coded verdicts, decisions with citations, transaction and receipt links, and a "history" section listing prior runs that include any of the entered vaults (from `listRuns` plus run contents). When `AGENT_HEDERA_KEY` is absent, show a notice and link to the demo run.
- [ ] **Step 3: Implement `/admin`** — server component fetching the metrics with the bearer token from `ADMIN_TOKEN`; sections per spec §13.1; auto-refresh every 15 s via a small client component; a clear "counters reset on restart" note; 401/unreachable states rendered inline.
- [ ] **Step 4: Stretch (only if promised items are green and reviewed)** — wallet address input discovering ERC-4626 positions via `balanceOf` multicall over a new free service endpoint `GET /v1/vaults?chainId=` (Task 27 adds it if trivial); otherwise leave the input as vault list only.
- [ ] **Step 5: Tests, typecheck, `next build`; commit** — `git commit -m "feat(dashboard): portfolio user view with server-side paid scans; admin metrics view"`

Ordering: Task 27 runs in the service worktree after Task 19 (Arc rail) so both rails' settlement hooks exist; Task 28's portfolio view and the admin page's static shell can start in the dashboard worktree immediately against the §13.1 contract, with the admin page wired to the live endpoint after Task 27 merges.
