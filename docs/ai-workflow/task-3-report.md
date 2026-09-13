# Task 3 report: PQ keys from seeds and ML-DSA-65 signatures

## What I implemented

- `packages/core/src/pq/keys.ts`: `SIG_ALG` ("ML-DSA-65"), `KEM_ALG` ("ml-kem768-x25519"), `deriveSigningKeys(seedHex)` (32-byte-seed ML-DSA-65 keygen + `pubHash`), `deriveKemKeys(seedHex)` (HKDF-SHA256-expanded seed into `ml_kem768_x25519.keygen`, with `kid`), `kidOf(publicKey)`.
- `packages/core/src/pq/sign.ts`: `Sig` type, `signJson`/`verifyJson` (canonical-bytes sign/verify over ML-DSA-65, verify swallows exceptions to `false`), `attachSig`/`checkSig` (exclude `obj.sig` from the signed/verified bytes).
- `packages/core/test/pq-sign.test.ts`: the 4 tests from the brief, verbatim.
- `packages/core/src/index.ts`: added `export * from "./pq/keys"; export * from "./pq/sign";` (no `toHex` re-export from `keys.ts`, per the team lead's resolution, to avoid colliding with the root re-export of `util/bytes`).

All code matches the brief's Step 3 samples verbatim except:
1. Dropped `import { toHex } from "../util/bytes"` and `export { toHex };` from `keys.ts` (unused after dropping the re-export; team lead's explicit resolution).
2. `checkSig`'s parameter type changed from `(obj: { sig?: Sig } & object, ...)` to a generic `<T extends { sig?: Sig }>(obj: T, ...)`. This was required to typecheck, see "Issue found and fixed" below. No runtime behavior changed (generics erase at compile time).

## TDD evidence

**RED**, `bun test packages/core/test/pq-sign.test.ts` before creating `src/pq/`:
```
error: Cannot find module '../src/pq/keys' from '.../packages/core/test/pq-sign.test.ts'
0 pass
1 fail
1 error
Ran 1 test across 1 file.
```

**GREEN**, same command after implementing `keys.ts` and `sign.ts`:
```
bun test v1.3.10 (30e609e0)

 4 pass
 0 fail
 11 expect() calls
Ran 4 tests across 1 file. [1.76s]
```

**Full suite before commit**, `bun test`:
```
bun test v1.3.10 (30e609e0)

 15 pass
 0 fail
 24 expect() calls
Ran 15 tests across 3 files. [1.64s]
```

**Typecheck**, `bun x tsc -p packages/core/tsconfig.json --noEmit` exits 0, no output (after the `checkSig` generic fix; see below for the error it fixed).

## `ml_kem768_x25519.lengths` observed at runtime

```json
{"seed":32,"publicKey":1216,"secretKey":32,"msg":32,"msgRand":64,"cipherText":1120}
```

`lengths.seed` is **defined** (32), not `undefined`, so the brief's fallback branch ("if undefined, hard-code the value") never triggers for the installed `@noble/post-quantum@0.7.1`. The code keeps the brief's exact `ml_kem768_x25519.lengths.seed ?? 96` expression, it evaluates to 32 today and the `?? 96` is inert defensive code, left as-is since the brief's verbatim implementation already handles both cases correctly. No console.log was added or needed. Confirmed via `bun -e` printing `ml_kem768_x25519.lengths` directly (one-off shell command, not left in any file).

Also independently verified against the library's `.d.ts` files before implementing (in `node_modules/.bun/@noble+post-quantum@0.7.1/.../ml-dsa.d.ts`, `hybrid.d.ts`, `utils.d.ts`) that `keygen(seed?)`, `sign(msg, secretKey, opts?)`, `verify(sig, msg, publicKey, opts?)`, `encapsulate`/`decapsulate`, and `hkdf(hash, ikm, salt, info, length)` all match the argument order and shapes the brief assumed.

## Issue found and fixed

`bun x tsc -p packages/core/tsconfig.json --noEmit` initially failed on the test file (verbatim from the brief, not edited):

```
packages/core/test/pq-sign.test.ts(29,32): error TS2353: Object literal may only specify known properties, and 'x' does not exist in type '{ sig?: Sig | undefined; } & object'.
```

Cause: `checkSig({ ...signed, x: "z" }, k.publicKey)` is an object-literal argument with a directly-written extra property (`x`), which triggers TypeScript's excess-property check against `checkSig`'s fixed parameter type `{ sig?: Sig } & object`. Fix: made `checkSig` generic, `function checkSig<T extends { sig?: Sig }>(obj: T, publicKey: Uint8Array): boolean`, so the parameter type is inferred from the call site instead of checked against a closed literal type. This is the standard idiom for this exact situation, is erased at compile time, and required no change to the brief's test file. Confirmed `attachSig` didn't need the same fix since it was already generic (`<T extends object>`).

## Self-review

- **Completeness against brief**: all five interface exports present with exact names (`deriveSigningKeys`, `deriveKemKeys`, `kidOf`, `SIG_ALG`, `KEM_ALG`, `Sig`, `signJson`, `verifyJson`, `attachSig`, `checkSig`). `KEM_ALG` is unused within this task itself but is a declared deliverable for later tasks per the brief's interface list.
- **Naming**: matches the brief and the codebase's existing snake/camel conventions (`pub_hash` on the wire type, `pubHash` in JS).
- **YAGNI**: no functions/exports added beyond the brief; the `checkSig` generic is the minimal type-level fix, not a behavior change.
- **Tests verify real behavior**: round-trip sign/verify plus tamper detection at both the raw-message level (test 3: mutating the signed value flips verification to `false`) and the wrapper level (test 4: mutating a field outside `sig` after `attachSig` flips `checkSig` to `false`). None of the assertions are on mocks/stubs; all go through real ML-DSA-65 keygen/sign/verify.
- **Pristine output**: both the targeted and full `bun test` runs show clean `N pass / 0 fail` with no stray logging; typecheck is silent on success.

## Files changed

- `packages/core/src/pq/keys.ts` (new)
- `packages/core/src/pq/sign.ts` (new)
- `packages/core/test/pq-sign.test.ts` (new)
- `packages/core/src/index.ts` (modified: two new re-export lines)

Commit: `9eb9f08`, "feat(core): seeded ML-DSA-65 and hybrid KEM keys, JSON signatures" on branch `ws/core`.

## Concerns

None blocking. One note for whoever consumes `deriveKemKeys`/`deriveSigningKeys` next: `deriveSigningKeys` requires exactly a 32-byte hex seed and throws otherwise; `deriveKemKeys` requires at least 32 bytes and HKDF-expands to whatever `ml_kem768_x25519.lengths.seed` reports (32 today). Both throw on short/malformed hex via `fromHex`, so callers should validate seed provenance (e.g., env var presence) before calling these rather than relying on the thrown message text.

## Fix round 1

Review found two Important issues and two Minor items. Both Important issues were real bugs; both are fixed, with covering tests, and both Minor items folded in.

### What changed

1. **`packages/core/src/pq/keys.ts:22`, HKDF salt/info were swapped.** The resolved `@noble/hashes@1.8.0` signature is `hkdf(hash, ikm, salt, info, length)`. The prior call, `hkdf(sha256, master, utf8("vaultradar/kem/v1"), undefined, need)`, passed the domain label as `salt` and left `info` as `undefined`, backwards from the intended design of deriving KEM key material via HKDF-SHA-256 with `info = "vaultradar/kem/v1"`. Fixed to `hkdf(sha256, master, undefined, utf8("vaultradar/kem/v1"), need)`.
2. **`packages/core/src/pq/sign.ts:16-17`, `checkSig` threw on non-object input.** `checkSig(null, publicKey)` / `checkSig(undefined, publicKey)` dereferenced `obj.sig` with no existence check on `obj` itself, throwing a `TypeError` instead of returning `false`, contradicting the "never throws" contract. Fixed the guard to `if (!obj || typeof obj !== "object" || !obj.sig || obj.sig.alg !== SIG_ALG) return false;` and widened the generic parameter to `obj: T | null | undefined`.
3. **Minor: `keys.ts` duplicated `kidOf`'s logic** instead of calling it. Reordered `kidOf` above `deriveSigningKeys`/`deriveKemKeys` (so it's defined before use in reading order) and changed `deriveKemKeys` to return `kid: kidOf(publicKey)`.
4. **Minor: no determinism assertion for `deriveKemKeys`.** Added a dedicated test asserting two derivations from the same seed produce equal `publicKey` bytes and equal `kid`.

### Covering tests added (`packages/core/test/pq-sign.test.ts`)

- `"kem keys are deterministic from seed"`, two `deriveKemKeys` calls on the same seed produce equal `publicKey` bytes and equal `kid`.
- `"KEM seed derivation feeds the domain label as HKDF info, not salt, regression pin"`, pins `deriveKemKeys("22".repeat(64)).kid.slice(0, 8)` to `"5d376cf9"`, with a comment explaining it guards the HKDF argument order.
- `"checkSig returns false, never throws, on null/undefined/malformed input"`, asserts `checkSig(null as any, ...)`, `checkSig(undefined as any, ...)`, and `checkSig({ sig: { alg: "ML-DSA-65", pub_hash: "x", value: "not-base64!!" } } as any, ...)` all return `false` without throwing.

### RED/GREEN evidence for this round

To confirm the new tests actually catch the two bugs (not just pass incidentally), I stashed only the two source fixes (`keys.ts`, `sign.ts`) while keeping the new tests, ran the suite, restored the fixes, and reran:

**RED** (old buggy source + new tests), `bun test packages/core/test/pq-sign.test.ts`:
```
TypeError: null is not an object (evaluating 'obj.sig')
      at checkSig (.../packages/core/src/pq/sign.ts:17:8)
(fail) checkSig returns false, never throws, on null/undefined/malformed input [4.40ms]

error: expect(received).toBe(expected)
Expected: "__PIN__"
Received: "15abb958"
(fail) KEM seed derivation feeds the domain label as HKDF info, not salt — regression pin [4.77ms]

 5 pass
 2 fail
 14 expect() calls
```
(The pin test's placeholder `"__PIN__"` was intentionally wrong at this point, the diagnostic fact is that the buggy salt/info order produces `15abb958`, a different value than the fixed order.)

**GREEN** (fixes restored, pin filled in with the value observed under the corrected order), `bun test packages/core/test/pq-sign.test.ts`:
```
bun test v1.3.10 (30e609e0)

 7 pass
 0 fail
 17 expect() calls
Ran 7 tests across 1 file. [134.00ms]
```

**Full suite**, `bun test`:
```
bun test v1.3.10 (30e609e0)

 18 pass
 0 fail
 30 expect() calls
Ran 18 tests across 3 files. [153.00ms]
```

**Typecheck**, `bun x tsc -p packages/core/tsconfig.json --noEmit` exits 0, no output. (`checkSig`'s widened parameter type `T | null | undefined` composes cleanly with the existing `if (...) return false;` guard-clause narrowing into the later `const { sig, ...body } = obj;` destructure, no `as` casts or non-null assertions were needed.)

### Files changed (this round)

- `packages/core/src/pq/keys.ts` (HKDF arg order; `kidOf` reordered and reused)
- `packages/core/src/pq/sign.ts` (`checkSig` null-safety)
- `packages/core/test/pq-sign.test.ts` (4 new tests)

Commit: `6305597`, "fix(core): correct HKDF salt/info order and make checkSig null-safe" on branch `ws/core`.

### Concerns

None. Both Important findings were genuine bugs, independently reproduced via the RED step above, and are now covered by regression tests that fail under either the old salt/info order or the old null-unsafe guard.
