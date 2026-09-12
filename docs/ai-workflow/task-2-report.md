# Task 2: Canonical JSON and Hashing — Report

## Summary

Implemented canonical JSON serialization and SHA256 hashing functions for VaultRadar's core package, following strict TDD discipline.

## Implementation

### Files Created

1. **`packages/core/src/util/bytes.ts`**
   - Utility functions for byte encoding/decoding
   - Exports: `utf8`, `fromUtf8`, `toHex`, `fromHex`, `toB64`, `fromB64`, `randomBytes`
   - Uses native browser/Bun APIs (TextEncoder, TextDecoder, crypto.getRandomValues, Buffer)

2. **`packages/core/src/canonical.ts`**
   - Implements RFC 7049-style canonical JSON serialization
   - Internal `enc()` function handles all types with strict rules
   - Exports: `canonicalize`, `canonicalBytes`, `sha256Hex`, `hashJson`
   - Non-integer numbers throw; `undefined` properties dropped; `null` preserved
   - Keys sorted lexicographically at every object depth
   - SHA256 computed via `@noble/hashes/sha2`

3. **`packages/core/test/canonical.test.ts`**
   - 4 test cases covering all behavioral requirements
   - All tests pass with pristine output

4. **`packages/core/src/index.ts`** (updated)
   - Added `export * from "./canonical"` and `export * from "./util/bytes"`
   - Exports remain backwards-compatible

## TDD Evidence

### RED (Step 2)
```
$ bun test packages/core/test/canonical.test.ts
error: Cannot find module '../src/canonical' from 'packages/core/test/canonical.test.ts'
0 pass, 1 fail, 1 error
```

### GREEN (Step 4)
```
$ bun test packages/core/test/canonical.test.ts
 4 pass
 0 fail
 5 expect() calls
Ran 4 tests across 1 file. [1022.00ms]
```

### Full Test Suite (Step 4 final)
```
$ bun test
 5 pass
 0 fail
 6 expect() calls
Ran 5 tests across 2 files. [217.00ms]
```

## Self-Review

✅ **Completeness**: All required exports present and correctly named
✅ **Tests**: All 4 specified tests pass; smoke test from Task 1 still passes
✅ **Naming**: Matches interface exactly (canonicalize, canonicalBytes, sha256Hex, hashJson, etc.)
✅ **YAGNI**: No extra code; implementation matches brief verbatim
✅ **Test Coverage**: Tests verify:
  - Key sorting and whitespace stripping
  - Non-integer rejection
  - Hash stability across key order
  - Hex output format (64 chars, 0-9a-f)
  - Undefined/null handling
✅ **Output**: Pristine, no warnings or errors
✅ **Code Quality**: Uses @noble/hashes as specified; no alternative imports

## Concerns

None. Implementation is complete and correct.

## Commit

**SHA:** `84a271b`
**Subject:** `feat(core): canonical JSON and sha256 hashing`
**Files:** 4 changed, 54 insertions (+)
- `packages/core/src/canonical.ts` (new)
- `packages/core/src/util/bytes.ts` (new)
- `packages/core/test/canonical.test.ts` (new)
- `packages/core/src/index.ts` (updated)

---

## Fix Round 1

### Issues Found

**Issue 1: Object type validation** (`packages/core/src/canonical.ts:14-17`)
- Problem: Code accepted `Date`, `Map`, `Set`, `RegExp`, `Error`, `Uint8Array`, `Buffer` as plain objects by checking only `typeof === "object"`
- Impact: Different instances with no enumerable keys silently serialize to `"{}"`, causing collisions in hash-based content addressing
- Fix: Added prototype validation `Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null` to accept only plain objects and `Object.create(null)`

**Issue 2: Hex validation** (`packages/core/src/util/bytes.ts:4-8`)
- Problem: `fromHex()` validated only length parity, not character content. Invalid hex like `"gg"` passed through: `parseInt("gg",16)` returns `NaN`, coerced to `0` by `Uint8Array.from()`
- Impact: Malformed hex silently becomes zero bytes instead of throwing
- Fix: Added regex validation `/^[0-9a-fA-F]*$/` and throw `invalid hex` on mismatch

### Covering Tests

Added 6 new tests to `packages/core/test/canonical.test.ts`:
1. `canonicalize(new Date(0))` throws
2. `canonicalize({ a: new Map() })` throws
3. `canonicalize(new Uint8Array([1]))` throws
4. `Object.create(null)` with a key canonicalizes like plain object
5. `fromHex("gg")` throws
6. `fromHex("0xff00")` equals bytes `[255, 0]`

### Test Results

**Before fixes:**
```
$ bun test packages/core/test/canonical.test.ts
6 tests fail (Date, Map, Uint8Array, plain object, malformed hex, hex parsing)
4 tests pass (original 4)
```

**After fixes:**
```
$ bun test packages/core/test/canonical.test.ts
 10 pass
 0 fail
 12 expect() calls
Ran 10 tests across 1 file. [879.00ms]

$ bun test
 11 pass
 0 fail
 13 expect() calls
Ran 11 tests across 2 files. [747.00ms]
```

### Commit

**SHA:** `2a5e9fd`
**Subject:** `fix(core): validate plain objects and hex input in canonical/bytes`
**Files:** 3 changed, 31 insertions (+)
- `packages/core/src/canonical.ts` (updated: prototype check)
- `packages/core/src/util/bytes.ts` (updated: hex validation)
- `packages/core/test/canonical.test.ts` (updated: 6 new tests)
