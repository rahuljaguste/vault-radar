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
test("kem keys are deterministic from seed", () => {
  const a = deriveKemKeys("22".repeat(64)), b = deriveKemKeys("22".repeat(64));
  expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
  expect(a.kid).toBe(b.kid);
});
test("KEM seed derivation feeds the domain label as HKDF info, not salt — regression pin", () => {
  // Guards the argument order of hkdf(hash, ikm, salt, info, length) inside deriveKemKeys.
  // If salt and info are ever swapped again, this pinned prefix changes and the test fails.
  const k = deriveKemKeys("22".repeat(64));
  expect(k.kid.slice(0, 8)).toBe("5d376cf9");
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
test("checkSig returns false, never throws, on null/undefined/malformed input", () => {
  const k = deriveSigningKeys(SEED);
  expect(checkSig(null as any, k.publicKey)).toBe(false);
  expect(checkSig(undefined as any, k.publicKey)).toBe(false);
  expect(checkSig({ sig: { alg: "ML-DSA-65", pub_hash: "x", value: "not-base64!!" } } as any, k.publicKey)).toBe(false);
});
test("checkSig binds sig.pub_hash to the verifying key, so a mislabelled signature fails", () => {
  // The attack this closes: sign with key A, label the signature with the hash of a
  // *different* key B that a caller has pinned on chain. Without the binding the caller
  // verifies against A (valid) and compares pub_hash to B's pin (matches), and reports a
  // receipt as key-bound that the pinned key never signed.
  const a = deriveSigningKeys(SEED);
  const b = deriveSigningKeys("22".repeat(32));
  const signed = attachSig({ x: "y" }, a);
  expect(checkSig(signed, a.publicKey)).toBe(true);

  // Same valid ML-DSA signature by A, relabelled with B's public-key hash.
  const mislabelled = { ...signed, sig: { ...signed.sig, pub_hash: b.pubHash } };
  expect(verifyJson({ x: "y" }, mislabelled.sig.value, a.publicKey)).toBe(true); // the signature itself is still good
  expect(checkSig(mislabelled, a.publicKey)).toBe(false); // but the object is not
  expect(checkSig(mislabelled, b.publicKey)).toBe(false); // and B never signed it either

  // Any other shape of wrong hash is refused on the same grounds.
  for (const pub_hash of ["", "00".repeat(32), a.pubHash.toUpperCase(), a.pubHash.slice(0, 63)]) {
    expect(checkSig({ ...signed, sig: { ...signed.sig, pub_hash } }, a.publicKey)).toBe(false);
  }
  expect(checkSig({ ...signed, sig: { ...signed.sig, pub_hash: undefined } } as any, a.publicKey)).toBe(false);
});
