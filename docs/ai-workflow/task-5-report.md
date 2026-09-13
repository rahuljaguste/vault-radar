# Task 5 report: Request envelope, replay checks, receipts, attestations

## Status: DONE

## What I implemented

Both new modules were implemented exactly per the brief's Step 4 and Step 5 code blocks, verbatim, with no deviations.

`packages/core/src/envelope.ts`:
- `ScanRequest = { vaults: string[] }`, `TableRequest = { protocol: string; chainId: string }`.
- `SealedRequest<R> = { request: R; reply_pk: string; payer: string; ts: string; req_nonce: string }`.
- `NonceStore` interface + `MemoryNonceStore` (in-memory `Map<nonce, expiresAt>` with `has`/`add`/`sweep`).
- `TS_WINDOW_S = 120`, `NONCE_TTL_S = 600`.
- `buildSealedRequest<R extends object>(request, payer, servicePk, now?)`: generates a fresh ML-KEM-768+X25519 reply keypair, builds the plaintext `SealedRequest<R>` (ts as a decimal-second string, `req_nonce` as 16 random hex bytes), seals it to `servicePk` via `seal()` from `pq/seal.ts`, and returns `{ sealed, replySecret, count }` where `count` is `request.vaults.length` when present (0 otherwise, `TableRequest` has no vaults).
- `openSealedRequest<R>(sealed, kemSecret, kid)`: opens via `open<SealedRequest<R>>(sealed, kemSecret, kid)` (the `kid` argument is passed as `open`'s `expectKid`, so a sealed request encrypted to a different service key is rejected before decryption), then validates shape (`reply_pk`/`payer`/`ts` are strings, `req_nonce` matches `^[0-9a-f]{32}$`, `reply_pk` is valid base64) before returning.
- `checkSealedRequest(p, { now, payer, count?, seen })`: ordered checks, timestamp window (`|now - ts| <= 120s`), nonce replay (`seen.has`), payer match, then count match (only when `count` is given and `request.vaults` is an array), returning `{ ok: true }` or `{ ok: false, reason }`. The nonce is recorded (`seen.sweep` + `seen.add`) only after every check passes, so a rejected request never consumes a nonce slot.

`packages/core/src/receipts.ts`:
- `Rail = "hedera" | "arc"`, `SourceRef`, `Receipt` (v1, ERC-8004 service refs, request/response hashes, sources, price, payment, tier, `issued_at`, `nonce`, HCS topic, `sig`), `Attestation` (v1, vault/chain/block/timestamp/sharePrice/tvlUsd/source, `sig`).
- `requestHash`/`responseHash`: thin wrappers over `hashJson` (canonical SHA3... actually SHA-256 per `canonical.ts`'s `sha256Hex`) over the request, and over `{ vaults, reports, attestations }` respectively.
- `buildReceipt(input, keys)`: defaults `issued_at` to the current Unix time (decimal string) when omitted, generates a 16-random-byte hex `nonce`, and signs via `attachSig` (which itself strips any pre-existing `sig` before re-signing).
- `receiptHash(r)`: `hashJson` of the receipt with `sig` stripped, so it's stable regardless of signature bytes.
- `verifyReceipt`/`verifyAttestation`: delegate to `checkSig`, which returns `false` (never throws) on any mismatch, missing/wrong-alg `sig`, or tampered field.
- `buildAttestation(a, keys)`: same signing pattern as `buildReceipt`, no `issued_at`/`nonce` (not part of `Attestation`).

`packages/core/src/index.ts`: added `export * from "./envelope";` and `export * from "./receipts";` after the existing `pq/seal` export, per the team lead's resolution. `tsc` confirms no export-name collisions with the existing barrel (`canonical`, `util/bytes`, `pq/keys`, `pq/sign`, `pq/seal`).

No deviations from the brief were needed, the brief's Step 4/5 code typechecked cleanly as given under `strict: true` (verified below), including the `R extends object` constraint on `buildSealedRequest` (needed so `request as { vaults?: unknown }` type-asserts cleanly, an unconstrained generic can't be cast to an unrelated object shape) and the `Omit<Receipt, ...> & { issued_at?: string }` input type on `buildReceipt` (lets the brief's own test pass a `base` object that omits `issued_at` entirely).

## TDD evidence

RED, both test files written verbatim from the brief's Step 1/2 before either module existed:

```
$ bun test packages/core/test/envelope.test.ts packages/core/test/receipts.test.ts
bun test v1.3.10 (30e609e0)

packages/core/test/receipts.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module '../src/receipts' from '.../packages/core/test/receipts.test.ts'
-------------------------------

packages/core/test/envelope.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module '../src/envelope' from '.../packages/core/test/envelope.test.ts'
-------------------------------

 0 pass
 2 fail
 2 errors
Ran 2 tests across 2 files. [84.00ms]
```

GREEN, after implementing `envelope.ts`, `receipts.ts`, and the barrel exports:

```
$ bun test packages/core/test/envelope.test.ts packages/core/test/receipts.test.ts
bun test v1.3.10 (30e609e0)

 4 pass
 0 fail
 14 expect() calls
Ran 4 tests across 2 files. [189.00ms]
```

Full suite + typecheck, immediately before committing:

```
$ bun test
bun test v1.3.10 (30e609e0)

 27 pass
 0 fail
 51 expect() calls
Ran 27 tests across 6 files. [316.00ms]

$ bun x tsc -p packages/core/tsconfig.json --noEmit
(exit 0, no output)
```

## Files changed

- `packages/core/src/envelope.ts` (new), `ScanRequest`, `TableRequest`, `SealedRequest`, `NonceStore`, `MemoryNonceStore`, `TS_WINDOW_S`, `NONCE_TTL_S`, `buildSealedRequest`, `openSealedRequest`, `checkSealedRequest`.
- `packages/core/src/receipts.ts` (new), `Rail`, `SourceRef`, `Receipt`, `Attestation`, `requestHash`, `responseHash`, `buildReceipt`, `receiptHash`, `verifyReceipt`, `buildAttestation`, `verifyAttestation`.
- `packages/core/test/envelope.test.ts` (new), brief's 2 tests verbatim.
- `packages/core/test/receipts.test.ts` (new), brief's 2 tests verbatim.
- `packages/core/src/index.ts`, added `export * from "./envelope";` and `export * from "./receipts";`.

Commit: `7be9b9a`, `feat(core): sealed request envelope with replay checks; PQ-signed receipts and attestations` (branch `ws/core`, on top of `169c5c1`).

## Self-review

- **Completeness against brief**: every name in the brief's Interfaces block for both files is exported with the exact specified shape (checked field-by-field against the brief's type literals). Barrel exports added as instructed.
- **Naming**: matches the brief's wire-field snake_case (`req_nonce`, `reply_pk`, `issued_at`, `pub_hash` via existing `Sig`) and is consistent with the existing `pq/keys.ts`/`pq/sign.ts`/`pq/seal.ts` style. No renaming from the brief.
- **YAGNI**: no functions, options, or fields beyond what the brief specifies. `count`'s "0 for non-vault requests" behavior and `checkSealedRequest`'s "skip count check when `request.vaults` isn't an array" behavior are both exactly what the brief's own code does for `TableRequest`, not an addition.
- **Tests verify real behavior, not vacuous passes**:
  - *Replay rejection*: the envelope test opens one sealed request, checks it once (`ok: true`), then checks the *same opened request* again with the *same* `MemoryNonceStore` and asserts `.ok === false`, this actually exercises `seen.has()` returning `true` on the second call, not just a shape check.
  - *Stale ts / payer / count mismatch*: each uses a fresh `MemoryNonceStore` per assertion specifically so only the one condition under test can trip, and asserts the exact `reason` string via `toMatchObject`.
  - *Receipt tamper detection*: `verifyReceipt({ ...r, tier: "table" }, keys.publicKey)` mutates a signed field post-hoc and asserts `false`, this exercises `checkSig`'s re-verification against the mutated body, not a stub.
  - *Receipt hash stability*: `receiptHash(r)` vs. `receiptHash({ ...r, sig: { ...r.sig, value: "AAAA" } })` confirms the hash is computed over the receipt with `sig` excluded (same hash despite a different, garbage `sig.value`).
  - *Attestation tamper detection*: `verifyAttestation({ ...a, sharePrice: "9" }, ...)` mutates a signed field and asserts `false`.
  - Confirmed by actually running these (GREEN output above), not by inspection alone.
- **Pristine output**: `bun test` full run is 27 pass / 0 fail / 0 errors across 6 files; `tsc --noEmit` exits 0 with no output. No skipped/todo tests, no console warnings.

## Concerns

None. No blockers, no deviations, no open questions.

## Fix round 1

Review found two Important issues in `openSealedRequest`'s validation, both fixed.

### Issue 1: `reply_pk` "decodes as base64" check was a no-op

`fromB64` is `new Uint8Array(Buffer.from(s, "base64"))`. Node/Bun's `Buffer`
base64 decoder never throws on malformed input, it silently drops characters
outside the base64 alphabet and decodes whatever remains. The original code
called `fromB64(p.reply_pk)` and discarded the result, relying on it to throw;
it never does. Confirmed at runtime before fixing anything:

```
$ bun run <scratch file importing ml_kem768_x25519>
Buffer decode of garbage: 12   // Buffer.from("not-valid-base64!!!@#$", "base64").length
Buffer decode of empty: 0
Buffer decode of hashes: 0     // Buffer.from("####", "base64").length
lengths {"seed":32,"publicKey":1216,"secretKey":32,"msg":32,"msgRand":64,"cipherText":1120}
```

So any string was accepted as `reply_pk`, a syntactically garbage value would
decode to some arbitrary byte string and be returned to the caller unmodified.

**Fix** (`packages/core/src/envelope.ts`, `openSealedRequest`): split the
single combined `if` into per-field checks, each throwing a message that
names the field (`malformed sealed request: payer` / `: ts` / `: req_nonce` /
`: reply_pk`), and made the `reply_pk` check real:

```ts
if (typeof p.reply_pk !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.reply_pk) || fromB64(p.reply_pk).length !== ml_kem768_x25519.lengths.publicKey) {
  throw new Error("malformed sealed request: reply_pk");
}
```

`ml_kem768_x25519.lengths.publicKey` is read from the library at runtime
(confirmed `1216` above), not hard-coded. The strict base64 regex catches
non-base64 characters (e.g. the `-` and `!@#$` in the reviewer's example);
the decoded-length check catches syntactically-valid-but-wrong-content base64
(e.g. a correctly-formatted encoding of 10 bytes instead of 1216).

### Issue 2: zero test coverage for the validation branch

Added to `packages/core/test/envelope.test.ts`, each building a
`SealedRequest`-shaped plaintext by hand with exactly one bad field (all
other fields valid, so each test isolates the one check under test), sealing
it directly with `seal(plain, svc.publicKey)` from `src/pq/seal.ts`, and
asserting `openSealedRequest(...)` throws `/malformed sealed request/`:

- `reply_pk: "not-valid-base64!!!@#$"`, non-base64 characters.
- `reply_pk: toB64(randomBytes(10))`, valid base64, wrong decoded length (10 bytes, not 1216).
- `payer: 42` (number, not string).
- `ts: now` (number, not string).
- `req_nonce: "abc"` (fails the 32-hex-char regex).

Plus two more the reviewer asked for:
- `MemoryNonceStore.sweep(now)` removes an entry whose expiry is `<= now` and keeps one that expires later (adds `"expired"` at `100`, `"future"` at `200`, sweeps at `100`, asserts `has("expired") === false` and `has("future") === true`).
- A dedicated replay test asserting the specific `reason: "nonce_replay"` (not just `.ok === false`) on the second `checkSealedRequest` call with the same nonce and store.

`validReplyPk = toB64(svc.publicKey)` is reused across the payer/ts/req_nonce
tests as a stand-in valid `reply_pk`: `svc.publicKey` is itself a correctly
sized ML-KEM-768+X25519 hybrid public key (same `keygen()` call as any real
reply key), so it satisfies both the regex and the length check without
needing a second keypair.

**Verified the new tests actually catch the bug**, not just pass vacuously:
temporarily `git stash`'d the fixed `envelope.ts` (restoring the pre-fix
committed version) and re-ran the new test file against it. Result: the two
`reply_pk` tests failed exactly as expected (`openSealedRequest` returned the
garbage-decoded value instead of throwing); the payer/ts/req_nonce tests
passed even against the old code, confirming the reviewer's finding was
scoped precisely to `reply_pk`, those three checks were already correct,
just untested.

```
$ bun test packages/core/test/envelope.test.ts   # old envelope.ts (stashed fix)
(fail) openSealedRequest rejects a reply_pk that is not valid base64
  Expected pattern: /malformed sealed request/
  Received function did not throw
(fail) openSealedRequest rejects a reply_pk that decodes to the wrong length
  Expected pattern: /malformed sealed request/
  Received function did not throw

 7 pass
 2 fail
 17 expect() calls
Ran 9 tests across 1 file. [1329.00ms]
```

Then `git stash pop` to restore the fix.

### Commands and output (after restoring the fix)

```
$ bun test packages/core/test/envelope.test.ts
bun test v1.3.10 (30e609e0)

 9 pass
 0 fail
 17 expect() calls
Ran 9 tests across 1 file. [809.00ms]

$ bun test
bun test v1.3.10 (30e609e0)

 34 pass
 0 fail
 60 expect() calls
Ran 34 tests across 6 files. [867.00ms]

$ bun x tsc -p packages/core/tsconfig.json --noEmit
(exit 0, no output)
```

### Files changed

- `packages/core/src/envelope.ts`, `openSealedRequest`'s validation: per-field error messages, real `reply_pk` regex + decoded-length check against `ml_kem768_x25519.lengths.publicKey`.
- `packages/core/test/envelope.test.ts`, 7 new tests (5 malformed-field cases, `MemoryNonceStore.sweep` expiry semantics, `nonce_replay` reason string); the original 2 brief-verbatim tests are unchanged.

Commit: `7a59bf6`, `fix(core): actually validate reply_pk in openSealedRequest, add malformed-field test coverage` (branch `ws/core`, on top of `7be9b9a`).

### Concerns

None. Both Important findings are fixed and covered by tests that fail
against the pre-fix code (verified directly, not assumed).
