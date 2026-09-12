# Task 14 report: Service skeleton, keys, well-known routes, catalog

## Status: DONE

## What I implemented

All files from the brief's file list, plus `packages/service/src/data/provider.ts`
per the team lead's resolution (the Task 15 `DataProvider` interface stub):

- `packages/service/package.json` — exactly the brief's Step 1 content.
- `packages/service/tsconfig.json` — `{ extends: "../../tsconfig.base.json", include: ["src", "test", "scripts"] }`.
- `packages/service/src/config.ts` — `Config` type and `loadConfig(env = process.env)`
  exactly matching the brief's shape. Throws a clear `Error` if `PQ_SIG_SEED` or
  `PQ_KEM_SEED` is missing; every other field has the stated default or falls back
  to `""`/`null`. `erc8004` is built from `ERC8004_HEDERA_AGENT_ID` (chainId `"296"`)
  and `ERC8004_ARC_AGENT_ID` (chainId `"5042002"`) only when each is set.
- `packages/service/src/keys.ts` — copied verbatim from the brief's Step 3
  (`loadKeys`, `buildAgentCard`).
- `packages/service/src/data/provider.ts` — the `Catalog` type and `DataProvider`
  interface, copied verbatim from the team lead's message (interface-only stub;
  Task 15 fills in the real implementation).
- `packages/service/src/wellknown.ts` — `mountWellKnown(app, { config, keys, data, hcs })`
  builds the signed card once (via `buildAgentCard`), then registers on a single
  `express.Router()` with `router.use(cors())` applied to that router only:
  `GET /health`, `GET /.well-known/agent.json`, `GET /.well-known/ucp`,
  `GET /.well-known/erc8004.json`, `GET /v1/catalog`, `GET /v1/receipts/:hash`
  (returns `{ receipt_hash, topicId, sequence: null }` when `hcs` is `null`, else
  `await hcs.lookup(hash)`), and `GET /skill.md` (serves
  `skills/vaultradar/SKILL.md` resolved via `import.meta.dir` — repo-root-relative,
  independent of `cwd` — or 404s with `{ error: "skill not yet published" }` since
  Task 25 hasn't created that file yet). Exports `HcsLookup` (`{ lookup(hash): Promise<unknown> }`),
  the minimal shape Task 17's `HcsQueue` must satisfy.
- `packages/service/src/app.ts` — `buildApp(deps): Promise<express.Express>` (async
  per the team lead's resolution). Applies `express.json({ limit: "256kb" })` first,
  then `mountWellKnown`, then conditionally `await import("./rails/hedera")` /
  `"./rails/arc"` only when `deps.rails?.hedera` / `.arc` is true. Since those two
  modules don't exist until Tasks 16/19, each dynamic import is marked
  `// @ts-expect-error` with a comment explaining it — this makes tsc fail loudly
  (unused-suppression error) the moment either module is actually added, forcing
  whoever lands that task to remove the directive rather than leaving it stale.
- `packages/service/src/main.ts` — loads config/keys, builds the app with a
  placeholder `DataProvider` (catalog returns empty lists; `scan`/`table` throw
  "not yet implemented (Task 15)"), `hcs: null`, `nonces: new MemoryNonceStore()`,
  `rails: {}`, and listens on `config.port`. All three are marked with `TODO(Task N)`
  comments pointing at the tasks that replace them. This keeps `bun run start`
  actually bootable today (serves `/health`, `/.well-known/*`, `/v1/catalog`,
  `/v1/receipts/:hash`, `/skill.md`) rather than crashing on missing modules.
- `packages/service/test/wellknown.test.ts` — the brief's Step 2 test, with
  `await buildApp(...)` per the team lead's instruction, plus three tests I added
  beyond the brief's minimum (see "Self-review" below).
- `.env.example` — appended the brief's Step 1 block after the existing four
  lines, unchanged.

## TDD evidence

**RED** — test file written first, referencing not-yet-created `../src/app`:

```
$ bun test packages/service
bun test v1.3.10 (30e609e0)
packages/service/test/wellknown.test.ts:
# Unhandled error between tests
-------------------------------
error: Cannot find module '../src/app' from '.../packages/service/test/wellknown.test.ts'
-------------------------------
 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [11.00ms]
```

**GREEN** — after implementing `config.ts`, `keys.ts`, `data/provider.ts`,
`wellknown.ts`, `app.ts`, `main.ts`:

```
$ bun test packages/service
bun test v1.3.10 (30e609e0)
 2 pass
 0 fail
 8 expect() calls
Ran 2 tests across 1 file. [212.00ms]
```

**GREEN (final, after self-review additions)**:

```
$ bun test packages/service
bun test v1.3.10 (30e609e0)
 5 pass
 0 fail
 13 expect() calls
Ran 5 tests across 1 file. [193.00ms]

$ bun test   # whole workspace, no regressions
bun test v1.3.10 (30e609e0)
 64 pass
 0 fail
 145 expect() calls
Ran 64 tests across 13 files. [446.00ms]

$ bun x tsc -p packages/service/tsconfig.json --noEmit
(no output, exit 0)
```

I did not run the root `typecheck` script (it references `packages/agent`,
which doesn't exist yet, per the team lead's instruction) or `packages/agent`'s
tsconfig. I did run `packages/core`'s tsconfig as a sanity check — still clean,
unaffected by this task.

## Dependency install

Wrote `package.json` with the brief's exact pinned versions, then ran
`bun install` from the repo root (equivalent end state to `bun add` per
dependency — both just resolve what's declared in `package.json` into the
lockfile). All four x402/Circle packages resolved at the exact pinned version:

```
@x402/express        2.25.0
@x402/core           2.25.0
@x402/hedera         2.25.0
@circle-fin/x402-batching  3.4.0
```

`@vaultradar/core` resolved via the `workspace:*` symlink
(`packages/service/node_modules/@vaultradar/core -> ../../../core`). Two
non-fatal peer-dependency warnings (`protobufjs@8.2.0`, from `@hashgraph/sdk`'s
tree) — not used by any code in this task, not blocking.

## Self-review

- **Completeness**: every route in the brief's Interfaces section is
  implemented and exercised by an HTTP test — `/health`, all three
  `/.well-known/*` files, `/v1/catalog`, `/v1/receipts/:hash`, and `/skill.md`.
  The brief's own Step 2 test only covers four of these; I added three more
  tests (`/health`, `/v1/receipts/:hash` with `hcs: null`, `/skill.md` 404) plus
  a CORS header assertion, so every route the brief specifies now has a real
  HTTP-level check, not just a code-read confirmation. Card fields (`pq.sig`,
  `pq.kem`, `erc8004`, `hcs.topicId`, both `endpoints` blocks, `prices`,
  `limits`, `docs`) all match the brief's Step 3 code verbatim, and I
  cross-checked `MAX_SCAN = 100` in `@vaultradar/core`'s `pricing.ts` against
  the card's `limits.max_vaults: 100` — consistent.
- **Naming**: `HcsLookup` (in `wellknown.ts`) is a deliberately distinct name
  from Task 17's future `HcsQueue`, so that task can define its own, richer
  type without a collision; `app.ts` imports it as a type only, does not
  re-export it (nothing yet consumes that re-export — trimmed during
  self-review as unnecessary surface).
- **YAGNI**: `main.ts`'s placeholder `DataProvider` and `rails: {}` are the
  minimal glue to make the skeleton boot today; no speculative abstraction
  beyond what Tasks 15/16/17/19 will need to slot into.
- **Tests verify real behaviour over HTTP**: all 5 tests in
  `wellknown.test.ts` start a real `http.Server` via `app.listen(0)` and use
  `fetch` against `127.0.0.1:<port>` — no supertest/mocking of Express
  internals.
- **Pristine output**: both final `bun test` runs show clean pass counts with
  no stray console output; `tsc --noEmit` produces no output.
- **No secrets logged**: `main.ts`'s only `console.log` prints `config.port`
  and `config.publicUrl`; nothing touches `sigSeed`, `kemSeed`, or
  `operatorKey`. `loadConfig` and `keys.ts` never log.
- **Git hygiene**: confirmed via `git add -n` before staging that only the
  intended 9 new files plus `.env.example`/`bun.lock` diffs were picked up —
  no `node_modules`, no `.env`.

## Concerns / notes for later tasks

- The `@ts-expect-error` suppressions in `app.ts` around the two rails dynamic
  imports are intentional and self-expiring (tsc will error on an unused
  suppression once `./rails/hedera.ts` / `./rails/arc.ts` exist), but whoever
  picks up Task 16 or Task 19 needs to actually delete the corresponding
  comment line, not just add the file — flagging this so it isn't missed in
  review.
- `main.ts` currently always passes `rails: {}` (both rails off), so the
  service today only serves the well-known/catalog/health surface. Tasks 16
  and 19 will need to flip these on (likely gated by config, e.g. whether
  Hedera/Arc credentials are present) — I left `main.ts` as the natural place
  for that follow-up edit rather than guessing at the gating logic now.
- `GET /skill.md` and `GET /v1/receipts/:hash` use synchronous `fs` calls
  (`existsSync`/`readFileSync`) and a straightforward `if (hcs)` branch
  respectively — both are fine at this scale (a single small doc file, a
  cheap conditional) and I didn't see a reason to complicate either for a
  skeleton task.

## Files changed

- `packages/service/package.json` (new)
- `packages/service/tsconfig.json` (new)
- `packages/service/src/config.ts` (new)
- `packages/service/src/keys.ts` (new)
- `packages/service/src/data/provider.ts` (new)
- `packages/service/src/wellknown.ts` (new)
- `packages/service/src/app.ts` (new)
- `packages/service/src/main.ts` (new)
- `packages/service/test/wellknown.test.ts` (new)
- `.env.example` (modified — appended Step 1's block)
- `bun.lock` (modified — new workspace package + its dependencies)

Commit: `5859f36` on branch `ws/service` — "feat(service): skeleton, seeded
keys, signed agent card, UCP and ERC-8004 files, catalog"

## Fix round 1

Review raised two Important findings. Both confirmed accurate against the
committed code; both fixed.

### Finding 1: CORS leaked onto every route, not just the public ones

`wellknown.ts` did `router.use(cors())` with no path restriction, and that
router was mounted app-wide (`app.use(router)`) before `app.ts` conditionally
mounts the Hedera/Arc rails on the same app instance. Express invokes
`router.use` middleware for any request path under the router's mount point
regardless of whether one of the router's own routes ends up matching, so
`cors()` ran (and set the header) even for requests this router doesn't
handle at all — e.g. a future `POST /hedera/v1/scan` — before falling through
to Express's 404.

**Fix**: replaced `router.use(cors())` with a single `const pub = cors();`
applied as a per-route middleware argument (`router.get(path, pub, handler)`)
on each of the seven public routes. Per-route application ties `cors()`'s
execution to the exact same path+method match as the real handler, so it can
never run for a path this router doesn't define — the fix in `wellknown.ts:34-95`.

### Finding 2: unhandled rejections in the async route handlers

`/v1/catalog` and `/v1/receipts/:hash` were `async` handlers with no
try/catch. Express 4 does not catch a promise rejected by a route handler, so
a throwing `DataProvider.catalog()` or `HcsQueue.lookup()` would leave the
request hanging with no response ever sent.

**Fix**:
- Added `packages/service/src/util/async.ts` exporting `asyncHandler(fn)`,
  which wraps an async handler and calls `.catch(next)` on its returned
  promise so a rejection is forwarded to Express's error-handling middleware
  instead of vanishing.
- Wrapped both `/v1/catalog` and `/v1/receipts/:hash` in `wellknown.ts` with
  `asyncHandler(...)`. The other five routes are synchronous (Express 4
  catches synchronous throws in a handler automatically), so they didn't need
  it.
- Added a final error-handling middleware in `app.ts` (`buildApp`, registered
  last, after the well-known routes and both conditional rail mounts, so it
  catches errors from either): logs `err.message` only via `console.error`
  (never the request/response body, headers, config, or keys) and always
  replies `res.status(500).json({ error: "internal_error" })`, so no internal
  detail reaches the client.

### Covering tests added (`packages/service/test/wellknown.test.ts`)

1. `"CORS is scoped to the public routes only, not the whole app"` —
   `GET /v1/catalog` still carries `access-control-allow-origin: *`;
   `POST /hedera/v1/scan` (unmatched today, since `rails: {}`) 404s with no
   CORS header at all.
2. `"GET /v1/catalog returns 500 with a generic body when the provider
   rejects, instead of hanging"` — builds a second app instance with a
   `catalog()` that throws, asserts the response is `500` with
   `{ error: "internal_error" }`, and (by temporarily swapping `console.error`
   the same way `packages/core/test/standardized-fetch.test.ts` already does)
   asserts the error was logged exactly once and that the logged text
   contains the original message — confirming logging happens without
   asserting on stdout noise.

### TDD evidence for the fix

**RED** — confirmed by temporarily reverting only the two fixed source files
to their pre-fix committed state (`git stash push -- src/wellknown.ts
src/app.ts`, keeping the new test file and `util/async.ts`) and re-running:

```
$ bun test packages/service
 (fail) CORS is scoped to the public routes only, not the whole app [5.74ms]
   error: expect(received).toBeNull()
   Received: "*"
 (fail) GET /v1/catalog returns 500 with a generic body when the provider rejects, instead of hanging [16.37ms]
   error: boom
     at catalog (.../test/wellknown.test.ts:50:38)
     at <anonymous> (.../src/wellknown.ts:69:25)
     ... (unhandled rejection surfaces through Express/cors internals, exactly
         the "hangs instead of a clean 500" failure mode the finding described)

 5 pass
 2 fail
 16 expect() calls
Ran 7 tests across 1 file. [429.00ms]
```

Then restored the fix (`git stash pop`) and reran:

**GREEN**:

```
$ bun test packages/service
bun test v1.3.10 (30e609e0)
 7 pass
 0 fail
 20 expect() calls
Ran 7 tests across 1 file. [191.00ms]

$ bun test   # whole workspace
bun test v1.3.10 (30e609e0)
 66 pass
 0 fail
 152 expect() calls
Ran 66 tests across 13 files. [442.00ms]

$ bun x tsc -p packages/service/tsconfig.json --noEmit
(no output, exit 0)
```

### Files changed (fix round 1)

- `packages/service/src/wellknown.ts` (modified — per-route `cors()`, both
  async handlers wrapped in `asyncHandler`)
- `packages/service/src/app.ts` (modified — final error-handling middleware)
- `packages/service/src/util/async.ts` (new — `asyncHandler`)
- `packages/service/test/wellknown.test.ts` (modified — two new tests)

Commit: `97aa551` on branch `ws/service` — "fix(service): scope CORS to
public routes only, catch async handler rejections"

### Concerns

None outstanding from this round. Both findings were real, reproduced RED
before the fix, and are GREEN after with no regressions elsewhere in the
workspace.
