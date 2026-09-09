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
