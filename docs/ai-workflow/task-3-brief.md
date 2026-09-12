### Task 3: PQ keys from seeds and ML-DSA-65 signatures

**Files:**
- Create: `packages/core/src/pq/keys.ts`, `packages/core/src/pq/sign.ts`, `packages/core/test/pq-sign.test.ts`

**Interfaces:**
- Produces: `deriveSigningKeys(seedHex: string): { publicKey: Uint8Array; secretKey: Uint8Array; pubHash: string }` (deterministic, ML-DSA-65); `deriveKemKeys(seedHex: string): { publicKey; secretKey; kid: string }` (ML-KEM-768+X25519); `signJson(value, secretKey): string` (base64 signature over canonical bytes); `verifyJson(value, sigB64, publicKey): boolean`; `Sig = { alg: "ML-DSA-65"; pub_hash: string; value: string }`; `attachSig(obj, keys)` / `checkSig(obj, publicKey)` where `obj.sig` is excluded from the signed bytes.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { deriveSigningKeys, deriveKemKeys } from "../src/pq/keys";
import { attachSig, checkSig, signJson, verifyJson } from "../src/pq/sign";

const SEED = "11".repeat(32);
test("signing keys are deterministic from seed", () => {
  const a = deriveSigningKeys(SEED), b = deriveSigningKeys(SEED);
  expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
  expect(a.pubHash).toMatch(/^[0-9a-f]{64}$/);
  expect(a.publicKey.length).toBe(1952);
});
test("kem keys derive with kid", () => {
  const k = deriveKemKeys("22".repeat(64));
  expect(k.kid).toMatch(/^[0-9a-f]{16}$/);
  expect(k.publicKey.length).toBeGreaterThan(1000);
});
test("sign/verify round trip and tamper detection", () => {
  const k = deriveSigningKeys(SEED);
  const sig = signJson({ a: "1" }, k.secretKey);
  expect(verifyJson({ a: "1" }, sig, k.publicKey)).toBe(true);
  expect(verifyJson({ a: "2" }, sig, k.publicKey)).toBe(false);
});
test("attachSig/checkSig exclude the sig field", () => {
  const k = deriveSigningKeys(SEED);
  const signed = attachSig({ x: "y" }, k);
  expect(signed.sig.alg).toBe("ML-DSA-65");
  expect(signed.sig.pub_hash).toBe(k.pubHash);
  expect(checkSig(signed, k.publicKey)).toBe(true);
  expect(checkSig({ ...signed, x: "z" }, k.publicKey)).toBe(false);
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

`packages/core/src/pq/keys.ts`:

```ts
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { fromHex, toHex, utf8 } from "../util/bytes";
import { sha256Hex } from "../canonical";

export const SIG_ALG = "ML-DSA-65" as const;
export const KEM_ALG = "ml-kem768-x25519" as const;

export function deriveSigningKeys(seedHex: string) {
  const seed = fromHex(seedHex);
  if (seed.length !== 32) throw new Error("PQ_SIG_SEED must be 32 bytes hex");
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  return { publicKey, secretKey, pubHash: sha256Hex(publicKey) };
}

export function deriveKemKeys(seedHex: string) {
  const master = fromHex(seedHex);
  if (master.length < 32) throw new Error("PQ_KEM_SEED must be at least 32 bytes hex");
  const need = ml_kem768_x25519.lengths.seed ?? 96;
  const seed = hkdf(sha256, master, utf8("vaultradar/kem/v1"), undefined, need);
  const { publicKey, secretKey } = ml_kem768_x25519.keygen(seed);
  return { publicKey, secretKey, kid: sha256Hex(publicKey).slice(0, 16) };
}
export const kidOf = (publicKey: Uint8Array) => sha256Hex(publicKey).slice(0, 16);
export { toHex };
```

`packages/core/src/pq/sign.ts`:

```ts
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { canonicalBytes } from "../canonical";
import { fromB64, toB64 } from "../util/bytes";
import { SIG_ALG } from "./keys";

export type Sig = { alg: typeof SIG_ALG; pub_hash: string; value: string };
export const signJson = (value: unknown, secretKey: Uint8Array): string =>
  toB64(ml_dsa65.sign(canonicalBytes(value), secretKey));
export const verifyJson = (value: unknown, sigB64: string, publicKey: Uint8Array): boolean => {
  try { return ml_dsa65.verify(fromB64(sigB64), canonicalBytes(value), publicKey); } catch { return false; }
};
export function attachSig<T extends object>(obj: T, keys: { secretKey: Uint8Array; pubHash: string }): T & { sig: Sig } {
  const { sig: _drop, ...body } = obj as T & { sig?: Sig };
  return { ...(body as T), sig: { alg: SIG_ALG, pub_hash: keys.pubHash, value: signJson(body, keys.secretKey) } };
}
export function checkSig(obj: { sig?: Sig } & object, publicKey: Uint8Array): boolean {
  if (!obj.sig || obj.sig.alg !== SIG_ALG) return false;
  const { sig, ...body } = obj;
  return verifyJson(body, sig.value, publicKey);
}
```

- [ ] **Step 4: Run, expect 4 pass.** If `ml_kem768_x25519.lengths.seed` is undefined at runtime, print `ml_kem768_x25519.lengths` once and hard-code the value it reports; remove the print.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): seeded ML-DSA-65 and hybrid KEM keys, JSON signatures"`

