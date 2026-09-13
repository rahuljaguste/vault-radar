# Task 4 report: Seal and open (hybrid KEM + HKDF + AES-256-GCM)

## Status: DONE

## What I implemented

`packages/core/src/pq/seal.ts`, exactly per the brief's Step 3, with one
necessary addition (see "Deviation from brief" below):

- `Sealed` type: `{ v: 1; kem: "ml-kem768-x25519"; kid: string; ct: string; nonce: string; body: string }`.
- `seal(plain, recipientPk)`: `ml_kem768_x25519.encapsulate` for a fresh
  shared secret + ciphertext, `deriveAead` (HKDF-SHA256, info
  `"vaultradar/seal/v1"`, 32 bytes) to turn the shared secret into an AES key,
  a random 12-byte nonce, AES-256-GCM encrypt of `canonicalBytes(plain)`.
  Returns base64 `ct`/`nonce`/`body` and the recipient's hex `kid`.
- `open<T>(sealed, secretKey, expectKid?)`: rejects unknown `v`/`kem` first,
  then rejects an `expectKid` mismatch *before* decapsulating (no secret-key
  operation happens on a kid mismatch), then decapsulates and AES-GCM
  decrypts, returning `JSON.parse(...)` as `T`.
- `isSealed(x)`: type guard checking `v`, `kem`, and the three string fields.
- `deriveAead` stays module-private (not exported), matching the brief.

Added `export * from "./pq/seal";` to `packages/core/src/index.ts` per the
team lead's resolution, so `Sealed`/`seal`/`open`/`isSealed` are available
both from the barrel and from the direct `./pq/seal` path Task 5/15 use.

Verified `@noble/ciphers/aes` resolves without needing the `.js` suffix
fallback (its package.json exports map has both `./aes` and `./aes.js`
pointing at the same file; `moduleResolution: "Bundler"` handles this) and
confirmed `ml_kem768_x25519.lengths` at runtime matches the values the team
lead gave (`cipherText: 1120`, etc.), no surprises there.

## Deviation from brief: `open()` needed a non-generic overload

The brief's Step 3 `open` is `export function open<T = unknown>(s, secretKey,
expectKid?): T { ... }`. Compiled as given, `bun test` passes but `tsc
--noEmit` fails on the brief's own round-trip test:

```
packages/core/test/pq-seal.test.ts(10,40): error TS2769: No overload matches this call.
  Overload 1 of 2, '(expected: undefined): void', gave the following error.
    Argument of type '{ hello: string; n: string; }' is not assignable to parameter of type 'undefined'.
  Overload 2 of 2, '(expected: undefined): void', gave the following error.
    Argument of type '{ hello: string; n: string; }' is not assignable to parameter of type 'undefined'.
```

Root cause (confirmed with isolated repros under a scratch file, removed
before committing): bun-types' `Expect` interface declares `expect` with
`(actual?: never, customFailMessage?: string): Matchers<undefined>` as its
*first* overload, ahead of the generic `<T = unknown>(actual: T): Matchers<T>`
one. When the argument to `expect(...)` is itself a call to a generic
function whose type parameter cannot be inferred from its own arguments
(exactly `open(s, k.secretKey)`, since `T` only appears in `open`'s return
position), TypeScript defers full checking of that argument while picking an
`expect` overload, and the deferred check doesn't reject the `never`-typed
first overload the way a concrete type would, so `expect` resolves to
`Matchers<undefined>`, and `.toEqual({...})` then fails. I verified this
reproduces with a minimal unrelated generic function (nothing specific to
noble or this codebase), and that giving the call site an explicit type
argument (`open<Foo>(...)`) avoids it, but the brief's round-trip test calls
`open(s, k.secretKey)` with no type argument, so the fix has to live in
`open`'s declared signature, not the test.

Fix: overload `open` with a concrete, non-generic signature first, generic
second:

```ts
export function open(s: Sealed, secretKey: Uint8Array, expectKid?: string): unknown;
export function open<T>(s: Sealed, secretKey: Uint8Array, expectKid?: string): T;
export function open<T = unknown>(s: Sealed, secretKey: Uint8Array, expectKid?: string): T { ... }
```

An untyped call now resolves against the first, fully-concrete overload
(`unknown`, no deferral), while `open<Foo>(sealed, sk)` still resolves against
the second overload exactly as the brief's stated interface
(`open<T>(...): T`) promises. This is additive to the public signature (still
callable exactly as documented) and doesn't change runtime behavior at all,
purely a call-site type-inference fix. Confirmed via isolated repro that (a)
the brief's literal signature reproduces the failure on an unrelated toy
generic function, (b) neither reordering overloads-without-a-default nor
adding overloads in generic-first order fixes it, and (c) concrete-overload-
first does fix it, for both the untyped and explicitly-typed call shapes.

## TDD evidence

RED, module missing, run before `seal.ts` existed:

```
$ bun test packages/core/test/pq-seal.test.ts
bun test v1.3.10 (30e609e0)

packages/core/test/pq-seal.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module '../src/pq/seal' from '.../packages/core/test/pq-seal.test.ts'
-------------------------------

 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [16.00ms]
```

GREEN, after implementing `seal.ts` (brief's code verbatim, before the
overload fix was even needed, this step doesn't typecheck, just runs):

```
$ bun test packages/core/test/pq-seal.test.ts
bun test v1.3.10 (30e609e0)

 4 pass
 0 fail
 6 expect() calls
Ran 4 tests across 1 file. [112.00ms]
```

Full suite + typecheck, after the overload fix, immediately before
committing:

```
$ bun test
bun test v1.3.10 (30e609e0)

 22 pass
 0 fail
 36 expect() calls
Ran 22 tests across 4 files. [267.00ms]

$ bun x tsc -p packages/core/tsconfig.json --noEmit
(exit 0, no output)
```

## Files changed

- `packages/core/src/pq/seal.ts` (new), `Sealed`, `seal`, `open`, `isSealed`, private `deriveAead`.
- `packages/core/test/pq-seal.test.ts` (new), brief's 4 tests verbatim.
- `packages/core/src/index.ts`, added `export * from "./pq/seal";`.

Commit: `d28b842`, `feat(core): hybrid PQ sealing with AES-256-GCM` (branch `ws/core`).

## Self-review

- **Completeness against brief**: `Sealed`, `seal`, `open`, `deriveAead`
  (internal), `isSealed` all present with the brief's exact field names and
  behavior (v, kem, kid hex, ct/nonce/body base64). `open` checks
  `expectKid` before decapsulating, as required.
- **Naming**: matches the brief and the existing `pq/keys.ts` / `pq/sign.ts`
  style (`KEM_ALG`, `kidOf`, `fromB64`/`toB64`, etc.), no renaming.
- **YAGNI**: no extra exports, options, or config beyond what the brief and
  the team lead's resolutions called for. The only addition beyond the
  brief's literal text is the `open` overload line, which is required for
  the brief's own test to typecheck, not a feature addition.
- **Tests verify real behavior, not vacuous passes**:
  - *Tamper*: mutates the last 4 base64 chars of `body` (the AES-GCM
    authentication tag lives in those trailing bytes), so decrypt fails on
    tag verification, not on a decoding error.
  - *Wrong recipient*: `ml-kem768-x25519` decapsulation never throws on a
    mismatched secret key (implicit-rejection FO transform, it always
    returns *some* shared secret), so this test actually exercises the
    AES-GCM authentication failure path once the wrong-derived AEAD key is
    used, not a KEM-level exception. Confirmed by running it.
  - *Kid mismatch*: confirmed the check runs before decapsulation by reading
    the implementation order, not just the test passing.
  - *Round trip*: asserts on `s.kem`, `s.kid`, and the decrypted plaintext
    equality, not just "didn't throw."
- **Pristine output**: `bun test` full run is 22 pass / 0 fail / 0 errors,
  `tsc --noEmit` exits 0 with no output.

## Concerns

None blocking. One thing worth the team lead's or a reviewer's attention:
the `open` overload fix is a real (if narrow) TypeScript quirk tied to this
exact bun-types version's `Expect` interface ordering; if bun-types changes
that ordering later, the extra overload becomes unnecessary but not harmful
to leave in place. Documented inline in `seal.ts` with a comment explaining
why it's there, so a future reader doesn't mistake it for stray code and
delete it.

*(Superseded by Fix round 1 below, the overload was removed.)*

## Fix round 1

Review (verbatim finding, reproduced from `seal.ts:17-19`) found the
overload fix above was wrong on two counts, both checked with an
out-of-tree reproduction against the real installed dependencies before
touching any code:

1. **The fix didn't need to live in `open`'s signature.** With the brief's
   original single-generic `open<T = unknown>(...)`, changing only the
   test's round-trip assertion to two statements, assign to a local, then
   `expect()` the local, makes `tsc --noEmit` pass with zero changes to
   `open`. I confirmed this in isolation with an unrelated toy generic
   function before touching `seal.ts`: `const decoded = open(1); expect(decoded).toEqual({ hello: "world" });`
   typechecks cleanly, because `decoded` is a concretely-resolved `unknown`
   by the time it reaches `expect`, not a deferred generic call, the
   deferred-inference quirk only triggers when the generic call sits
   directly inside `expect(...)`'s argument position.
2. **The overload was not behavior-preserving.** I confirmed with the same
   isolated setup that with the concrete-overload-first version,
   `const contextual: Payload = open(1)` fails with `TS2322: Type 'unknown'
   is not assignable to type 'Payload'`, the first, non-generic overload
   always wins regardless of the caller's contextual type, so `open` can
   never again infer `T` from an assignment target. With the brief's
   original single-generic signature, the same call correctly infers
   `T = Payload` with no explicit type argument. This is exactly the shape
   Task 5 and Task 15 need (`const body: RequestBody = open(sealed, sk)`),
   so the overload would have silently broken every such call once those
   tasks landed.

### What changed

- `packages/core/src/pq/seal.ts`: reverted `open` to the brief's literal
  `export function open<T = unknown>(s: Sealed, secretKey: Uint8Array, expectKid?: string): T`,
  removing both overload signatures and the comment explaining them.
- `packages/core/test/pq-seal.test.ts`:
  - `round trip` test: replaced
    `expect(open(s, k.secretKey)).toEqual({ hello: "world", n: "1" });`
    with
    ```ts
    const decoded = open(s, k.secretKey);
    expect(decoded).toEqual({ hello: "world", n: "1" });
    ```
  - Added a new covering test:
    ```ts
    test("open infers T from a contextual type without an explicit type argument", () => {
      const decoded2: { a: string } = open(seal({ a: "b" }, k.publicKey), k.secretKey);
      expect(decoded2.a).toBe("b");
    });
    ```
    This is the regression guard: it fails to typecheck under the
    concrete-overload-first version (confirmed above) and passes under the
    reverted single-generic version, so it pins the exact property the
    review flagged as broken.

### Commands and output

Focused test:

```
$ bun test packages/core/test/pq-seal.test.ts
bun test v1.3.10 (30e609e0)

 5 pass
 0 fail
 7 expect() calls
Ran 5 tests across 1 file. [190.00ms]
```

Full suite:

```
$ bun test
bun test v1.3.10 (30e609e0)

 23 pass
 0 fail
 37 expect() calls
Ran 23 tests across 4 files. [179.00ms]
```

Typecheck:

```
$ bun x tsc -p packages/core/tsconfig.json --noEmit
(exit 0, no output)
```

Commit: `169c5c1`, `fix(core): revert open() to single-generic signature, fix test instead` (branch `ws/core`), on top of `d28b842`.

### Concerns

None. The public `open<T>(...)` interface now matches the brief exactly,
with a regression test guarding the contextual-inference property the
review identified as at risk.
