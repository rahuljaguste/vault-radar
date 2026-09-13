# Task 24 report: VaultRadar dashboard

Branch `ws/dashboard`, worktree `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard`.
Commit: `f04d0f7 feat(dashboard): catalog, runs with payments per rail and HCS sequences, receipt verifier`.

## What I implemented

Scaffolded `packages/dashboard` via `bunx create-next-app@latest packages/dashboard --ts --app --no-tailwind --eslint --import-alias "@/*" --use-bun --disable-git --yes` (Next.js resolved to 16.3.4; omitted `--src-dir` since its default is already off, so `--src-dir=false` from the brief needed no flag). Added `@vaultradar/core@workspace:*` and `buffer` as dependencies, renamed the package to `@vaultradar/dashboard` for naming consistency with `@vaultradar/core`/`@vaultradar/service`.

Files (all under `packages/dashboard/` unless noted):

- `lib/types.ts`, the `RunRecord` contract, copied verbatim from the task brief, including the `Receipt` type import from `@vaultradar/core`. Note `decisions[].citations` is a single object, not an array, kept exactly as specified even though the key name is plural.
- `lib/service.ts`, `AgentCard`/`Catalog`/`CatalogEntry`/`ReceiptLookup` types and `fetchCard`/`fetchCatalog`/`fetchReceiptLookup`, all `cache: "no-store"`, all fail closed (return `null` on any error, including connection refused).
- `lib/runs.ts`, `listRuns`/`getRun` reading `path.resolve(process.cwd(), "..", "..", "runs")`, falling back to `public/demo-run.json` when the directory is missing/empty or `DEMO=1`. Exports `RUN_ID_RE` (the brief's exact regex) and `isValidRunId` (see "Deviations" below). Used directly by both the API routes and the server-component pages, no self-HTTP-fetch loop.
- `lib/explorer.ts`, `hederaTxIdToHashScanPath`, `explorerTxUrl(rail, txId)`, `erc8004ExplorerUrl(chainId)`. Pure functions, unit tested.
- `app/components/Table.tsx`, the shared table component the brief's Step 2 calls for.
- `app/page.tsx`, agent card summary (name/version/description, ERC-8004 ids linked to the registry contract per chain, PQ key hashes, prices), catalog table, runs list linking to `/runs/[id]`.
- `app/runs/[id]/page.tsx`, per request: rail/tier/sealed/price, payment tx linked to HashScan or Arcscan, receipt hash, live HCS sequence from `/v1/receipts/:hash`, per-vault verdicts/flags/rejected, and a decisions table with citations (tx link resolved by looking up which request's rail the cited receipt belongs to).
- `app/verify/page.tsx`, client component; textarea, fetches the card from `NEXT_PUBLIC_SERVICE_URL`, runs `verifyReceipt`/`receiptHash`/`fromB64` from `@vaultradar/core` in-browser. See "Deviations" for the Buffer/pg fixes this needed.
- `app/api/runs/route.ts`, `app/api/runs/[id]/route.ts`, thin wrappers over `lib/runs.ts`; the `[id]` route validates with `isValidRunId` and returns 400/404 appropriately.
- `public/demo-run.json`, hand-written, conforms to `RunRecord`: one Hedera `scan` request (two vaults, one `alert` with two flags, one `ok`), one Arc `table` request (one rejected stale vault), three `decisions` (withdraw/hold/insufficient data) with citations back to both requests. Receipt `sig.value` is a placeholder string, as the brief allows.
- `app/layout.tsx`, `app/globals.css`, simple nav (`/`, `/verify`), monospace font stack (no external font fetch, dropped the scaffold's `next/font/google` so the build has no network dependency), zebra-striped tables, no UI libraries.
- `next.config.ts`, `empty-pg.ts`, see "Deviations".
- `test/explorer.test.ts`, `test/runs.test.ts`, see "Tests" below.
- Removed scaffold cruft: `app/page.module.css`, `public/{vercel,next,globe,window,file}.svg`.
- Root `.gitignore`: fixed `runs/` → `/runs/` (see "Deviations").

## Deviations from the literal brief, and why

1. **`turbopack.resolveAlias` + `empty-pg.ts`.** Next.js 16 defaults to Turbopack for `next build`. `@vaultradar/core`'s `package.json` has a single export (`"."` → `src/index.ts`, a barrel that does `export *` from every module, including `substreams/reader.ts`, which imports `Pool` from `pg`). Importing anything from `@vaultradar/core` in a client component (`/verify`) therefore drags `pg` into the browser bundle, and `pg` needs Node's `net`/`tls`/`util`, which don't exist there, a real build failure I hit and captured before fixing it. I don't own `packages/core` so I didn't touch it; instead `next.config.ts` aliases the bare specifier `pg` to `empty-pg.ts` for the browser target only (the exact pattern Next's own migration docs show for this class of problem). Server bundles are unaffected, and Next already treats `pg` as server-external by default (it's in Next's built-in `serverExternalPackages` list), so no server-side change was needed at all.
2. **`Buffer` polyfill in `/verify`.** `@vaultradar/core`'s `fromB64`/`toB64` use the Node `Buffer` global, absent in browsers. Polyfilled once at module scope via the `buffer` npm package (`if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = PolyfillBuffer`).
   I didn't take either of these two on faith, I generated a real ML-DSA-65 keypair and a validly-signed receipt with `deriveSigningKeys`/`buildReceipt` from `@vaultradar/core`, served a matching fake agent card, and drove a real headless Chrome session (`next build && next start`, CDP over `--remote-debugging-port`) through the actual textarea/button. Result: a validly-signed receipt reports "Signature valid", a placeholder-signature receipt (like the one in `demo-run.json`) reports "Signature INVALID" without crashing, and there were zero console errors or exceptions in either case. That's the strongest evidence I could get that the riskiest part of this task, PQ crypto verification actually running client-side under Turbopack, genuinely works, not just that the build is quiet.
3. **`isValidRunId` beyond the brief's literal regex.** `/^[A-Za-z0-9._-]+$/` alone accepts the bare token `".."` (since `.` is an individually-allowed character), which a test I wrote caught immediately. `getRun`'s current implementation is safe regardless (it only accepts an `id` that matches something already returned by `readdir()`, never joins `id` into a path directly), but the brief's own stated intent for this regex was "no path traversal," and a plausible future refactor (join `id` straight into a path) would reopen it. Added `isValidRunId` = regex plus explicit `id !== "." && id !== ".."`, used it at both call sites, kept the literal `RUN_ID_RE` export as specified. This felt like the kind of one-line, clearly-in-scope fix worth making rather than flagging and moving on.
4. **Root `.gitignore` fix.** Line 15 was `runs/` (unanchored), meant to ignore only `<repo-root>/runs/*.json` (the agent's output). Unanchored, it matches a directory named `runs` at *any* depth, which silently swallowed `packages/dashboard/app/runs/` and `packages/dashboard/app/api/runs/`, i.e., two of this task's required routes, from any `git add`. Caught this by checking `git status`/`git add -n` before committing rather than trusting a clean `git commit` output. Changed to `/runs/`; verified the root `runs/` directory is still ignored and the dashboard's route directories no longer are. This touches a shared file outside `packages/dashboard`, but it's within my own worktree/branch (not another worktree), and leaving it broken would have meant two required deliverable files were silently never committed.
5. **Not deployed to Vercel; README not updated with a URL.** The original brief's Step 4 assumes a live/deployed service to point at and video-record. The team lead's brief for this task explicitly said not to run against a live service (none is deployed yet) and didn't ask for a Vercel deploy or README update. I read that as superseding the original Step 4 for now, treating it as a follow-up once the service is actually deployed, and did not attempt it.
6. **Didn't wire `packages/dashboard` into the root `package.json`'s composite `typecheck` script.** That script isn't mine to extend safely, it's presumably being edited concurrently by whichever task owns `packages/agent`, and the team lead gave me the standalone `tsc -p packages/dashboard/tsconfig.json --noEmit` command specifically, so I ran that rather than modifying a shared root script.
7. **`packages/dashboard/tsconfig.json`: added `"test"` to `exclude`.** The Next.js-generated tsconfig has no `"types"` array (relies on auto-inclusion of everything under `node_modules/@types`), and `bun-types` (which provides `bun:test` and `ImportMeta.dir`) isn't under an `@types/` scope, so it's invisible to that tsconfig by default, unlike `packages/core`/`packages/service`, which get it via `tsconfig.base.json`'s explicit `"types": ["bun-types"]`. Rather than fight Next's scaffolded config, I excluded `test/` from the app's own typecheck scope; `bun test` (Bun's own runtime, no separate type-check pass) is what actually verifies those files.
8. Used explicit `Promise<{ id: string }>` prop typing on the dynamic page and both route handlers instead of the generated `PageProps`/`RouteContext` helpers Next 16 offers. Next's own `.next/types` (needed for those helpers) isn't committed to git, so a fresh checkout running `tsc --noEmit` before ever running `next build`/`next dev` would otherwise fail. Also removed `LayoutProps<"/">` from the scaffolded root layout for the same reason.
9. Catalog table renders `vaultCount` per the team lead's concrete `/v1/catalog` shape (`{protocol, chain, status, vaultCount}`); the original brief's prose mentioned a "lag" column that doesn't exist in the actual resolved API contract, so I didn't invent one.

None of the above touch any other task's worktree; the `.gitignore` and `bun.lock` changes are root-level files inside my own `ws/dashboard` worktree/branch.

## Verification

```
bun test packages/dashboard
# 11 pass, 0 fail, 51 expect() calls

bun x tsc -p packages/dashboard/tsconfig.json --noEmit
# clean, no output

cd packages/dashboard && bun run lint
# clean, no output (fixed react/no-unescaped-entities in /verify's copy and
# import/no-anonymous-default-export in empty-pg.ts before this was clean)

SERVICE_URL=http://localhost:8787 bun run --cwd packages/dashboard build
# Turbopack, clean. Routes: ƒ /, ○ /_not-found, ƒ /api/runs, ƒ /api/runs/[id],
# ƒ /runs/[id], ○ /verify
```

Runtime smoke test (no live service, used `DEMO=1` and `next start` on a scratch port):
- `/` and `/runs/demo-run-1` render correctly server-side, including graceful "service unreachable" messaging when `SERVICE_URL`/`/v1/receipts/:hash` aren't reachable (verified via curl against the rendered RSC payload).
- HashScan tx-id conversion verified in the actual rendered page output: `0.0.6421400@1736439600.123456789` → `.../transaction/0.0.6421400-1736439600-123456789`.
- `/api/runs` and `/api/runs/demo-run-1` return correct JSON; `/api/runs/does-not-exist` and `/runs/does-not-exist` both 404.
- `/verify`, exercised in real headless Chrome (Chrome 152) against a locally generated ML-DSA-65 keypair and a validly-signed receipt built with `@vaultradar/core`'s own `buildReceipt`: reports "Signature valid" for the real signature and "Signature INVALID" (no crash) for a placeholder signature, in both cases with zero console errors/exceptions.

## Files changed

27 files (25 new under `packages/dashboard/`, plus root `.gitignore` and `bun.lock`). Full list in the commit; the ones worth knowing about by path:

- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/lib/types.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/lib/service.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/lib/runs.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/lib/explorer.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/app/page.tsx`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/app/runs/[id]/page.tsx`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/app/verify/page.tsx`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/app/api/runs/route.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/app/api/runs/[id]/route.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/public/demo-run.json`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/next.config.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/empty-pg.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/test/explorer.test.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/packages/dashboard/test/runs.test.ts`
- `/Users/rahuljaguste/pq/ethonline-20206/.worktrees/dashboard/.gitignore`

## Self-review

- Every page/route in the brief exists and nothing beyond it: `/`, `/runs/[id]`, `/verify`, `/api/runs`, `/api/runs/[id]`. `lib/runs.ts`, `lib/explorer.ts`, `app/components/Table.tsx`, `empty-pg.ts` are implementation details in direct service of those, not additional features.
- `RunRecord` in `lib/types.ts` matches the contract given to me exactly, field for field, including the singular `citations` object.
- No secrets: no `.env` touched, no keys, demo data uses a placeholder signature and fabricated (but well-formed) hashes/addresses.
- `next build` succeeds (Turbopack); `tsc --noEmit`, `bun test`, and `eslint` are all clean.

## Concerns for the controller

- The `.gitignore` fix (`runs/` → `/runs/`) is a shared root file. If another worktree/branch independently touched the same line, the merge is trivial (both sides converge on the same one-character fix), but worth knowing it happened here first.
- I did not deploy to Vercel or update a README with a live URL, per "Deviations" item 5, flagging in case the controller expected that as part of this task rather than a follow-up once the service is deployed.
- I have not seen the actual agent output shape (`<repo>/runs/<id>.json`) since that's a separate, presumably not-yet-merged task; `RunRecord` in `lib/types.ts` is only as correct as the contract I was given. If the agent's real output ever diverges (e.g., citations as an array after all), the two need to be reconciled together.
