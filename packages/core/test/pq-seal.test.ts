import { expect, test } from "bun:test";
import { deriveKemKeys } from "../src/pq/keys";
import { open, seal } from "../src/pq/seal";

const k = deriveKemKeys("33".repeat(64));
test("round trip", () => {
  const s = seal({ hello: "world", n: "1" }, k.publicKey);
  expect(s.kem).toBe("ml-kem768-x25519");
  expect(s.kid).toBe(k.kid);
  const decoded = open(s, k.secretKey);
  expect(decoded).toEqual({ hello: "world", n: "1" });
});
test("open infers T from a contextual type without an explicit type argument", () => {
  const decoded2: { a: string } = open(seal({ a: "b" }, k.publicKey), k.secretKey);
  expect(decoded2.a).toBe("b");
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
