### Task 4: Seal and open (hybrid KEM + HKDF + AES-256-GCM)

**Files:**
- Create: `packages/core/src/pq/seal.ts`, `packages/core/test/pq-seal.test.ts`

**Interfaces:**
- Produces: `type Sealed = { v: 1; kem: "ml-kem768-x25519"; kid: string; ct: string; nonce: string; body: string }` (all base64 except `kid` hex); `seal(plain: unknown, recipientPk: Uint8Array): Sealed`; `open<T>(sealed: Sealed, secretKey: Uint8Array, expectKid?: string): T`; `deriveAead(sharedSecret)` internal.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { deriveKemKeys } from "../src/pq/keys";
import { open, seal } from "../src/pq/seal";

const k = deriveKemKeys("33".repeat(64));
test("round trip", () => {
  const s = seal({ hello: "world", n: "1" }, k.publicKey);
  expect(s.kem).toBe("ml-kem768-x25519");
  expect(s.kid).toBe(k.kid);
  expect(open(s, k.secretKey)).toEqual({ hello: "world", n: "1" });
});
test("tampered ciphertext fails", () => {
  const s = seal({ a: "b" }, k.publicKey);
  const bad = { ...s, body: s.body.slice(0, -4) + "AAAA" };
  expect(() => open(bad, k.secretKey)).toThrow();
});
test("wrong recipient fails", () => {
  const other = deriveKemKeys("44".repeat(64));
  const s = seal({ a: "b" }, k.publicKey);
  expect(() => open(s, other.secretKey)).toThrow();
});
test("kid mismatch rejected before decrypt", () => {
  const s = seal({ a: "b" }, k.publicKey);
  expect(() => open({ ...s, kid: "0000000000000000" }, k.secretKey, k.kid)).toThrow(/kid/);
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```ts
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { canonicalBytes } from "../canonical";
import { fromB64, fromUtf8, randomBytes, toB64, utf8 } from "../util/bytes";
import { KEM_ALG, kidOf } from "./keys";

export type Sealed = { v: 1; kem: typeof KEM_ALG; kid: string; ct: string; nonce: string; body: string };
const INFO = utf8("vaultradar/seal/v1");
const deriveAead = (ss: Uint8Array) => hkdf(sha256, ss, undefined, INFO, 32);

export function seal(plain: unknown, recipientPk: Uint8Array): Sealed {
  const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(recipientPk);
  const nonce = randomBytes(12);
  const body = gcm(deriveAead(sharedSecret), nonce).encrypt(canonicalBytes(plain));
  return { v: 1, kem: KEM_ALG, kid: kidOf(recipientPk), ct: toB64(cipherText), nonce: toB64(nonce), body: toB64(body) };
}
export function open<T = unknown>(s: Sealed, secretKey: Uint8Array, expectKid?: string): T {
  if (s.v !== 1 || s.kem !== KEM_ALG) throw new Error("unsupported envelope");
  if (expectKid && s.kid !== expectKid) throw new Error("kid mismatch");
  const ss = ml_kem768_x25519.decapsulate(fromB64(s.ct), secretKey);
  const plain = gcm(deriveAead(ss), fromB64(s.nonce)).decrypt(fromB64(s.body));
  return JSON.parse(fromUtf8(plain)) as T;
}
export function isSealed(x: unknown): x is Sealed {
  const s = x as Sealed;
  return !!s && s.v === 1 && s.kem === KEM_ALG && typeof s.ct === "string" && typeof s.nonce === "string" && typeof s.body === "string" && typeof s.kid === "string";
}
```

- [ ] **Step 4: Run, expect 4 pass.**

- [ ] **Step 5: Commit**, `git add -A && git commit -m "feat(core): hybrid PQ sealing with AES-256-GCM"`

