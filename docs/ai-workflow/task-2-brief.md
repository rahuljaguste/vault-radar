### Task 2: Canonical JSON and hashing

**Files:**
- Create: `packages/core/src/util/bytes.ts`, `packages/core/src/canonical.ts`, `packages/core/test/canonical.test.ts`

**Interfaces:**
- Produces: `canonicalize(value: unknown): string`, `canonicalBytes(value: unknown): Uint8Array`, `sha256Hex(bytes: Uint8Array): string`, `hashJson(value: unknown): string` (sha256 hex of canonical bytes); `bytes.ts` exports `toHex`, `fromHex`, `toB64`, `fromB64`, `utf8`, `randomBytes`.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { canonicalize, hashJson } from "../src/canonical";

test("sorts keys recursively and strips whitespace", () => {
  expect(canonicalize({ b: 1, a: { d: "x", c: [3, { z: 1, y: 2 }] } }))
    .toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":"x"},"b":1}');
});
test("rejects non-integer numbers (numerics must be strings)", () => {
  expect(() => canonicalize({ a: 1.5 })).toThrow();
});
test("hash is stable across key order", () => {
  expect(hashJson({ a: "1", b: "2" })).toBe(hashJson({ b: "2", a: "1" }));
  expect(hashJson({ a: "1" })).toMatch(/^[0-9a-f]{64}$/);
});
test("undefined properties are dropped, null kept", () => {
  expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
});
```

- [ ] **Step 2: Run, expect failure**, `bun test packages/core/test/canonical.test.ts` → module not found.

- [ ] **Step 3: Implement**

`packages/core/src/util/bytes.ts`:

```ts
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
export const toHex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2) throw new Error("odd hex length");
  return Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
};
export const toB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
export const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
```

`packages/core/src/canonical.ts`:

```ts
import { sha256 } from "@noble/hashes/sha2";
import { toHex, utf8 } from "./util/bytes";

function enc(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("canonical JSON: non-integer number; use a decimal string");
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return "[" + v.map(x => enc(x === undefined ? null : x)).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + enc(o[k])).join(",") + "}";
  }
  throw new Error(`canonical JSON: unsupported type ${typeof v}`);
}
export const canonicalize = (v: unknown): string => enc(v);
export const canonicalBytes = (v: unknown): Uint8Array => utf8(canonicalize(v));
export const sha256Hex = (b: Uint8Array): string => toHex(sha256(b));
export const hashJson = (v: unknown): string => sha256Hex(canonicalBytes(v));
```

- [ ] **Step 4: Run, expect pass**, `bun test packages/core/test/canonical.test.ts` → 4 pass.

- [ ] **Step 5: Commit**, `git add -A && git commit -m "feat(core): canonical JSON and sha256 hashing"`

