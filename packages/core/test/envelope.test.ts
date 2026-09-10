import { expect, test } from "bun:test";
import { deriveKemKeys } from "../src/pq/keys";
import {
  MemoryNonceStore,
  buildSealedRequest,
  checkSealedRequest,
  checkSealedRequestPayer,
  checkSealedRequestPrePayment,
  commitNonce,
  openSealedRequest,
} from "../src/envelope";
import { seal } from "../src/pq/seal";
import { randomBytes, toB64, toHex } from "../src/util/bytes";

const svc = deriveKemKeys("55".repeat(64));
const now = 1_760_000_000;
// Any correctly-sized ML-KEM-768+X25519 public key is a valid reply_pk on the wire —
// svc.publicKey is one, reused here so the malformed-field tests below only vary the one
// field under test.
const validReplyPk = toB64(svc.publicKey);
const validNonce = () => toHex(randomBytes(16));
test("seal → open → check passes with matching payer and count", () => {
  const { sealed, count } = buildSealedRequest({ vaults: ["1:0xabc", "1:0xdef"] }, "0.0.1234", svc.publicKey, now);
  expect(count).toBe(2);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);
  expect(p.request.vaults.length).toBe(2);
  expect(p.reply_pk.length).toBeGreaterThan(100);
  const seen = new MemoryNonceStore();
  expect(checkSealedRequest(p, { now: now + 5, payer: "0.0.1234", count: 2, seen })).toEqual({ ok: true });
  expect(checkSealedRequest(p, { now: now + 5, payer: "0.0.1234", count: 2, seen }).ok).toBe(false); // replayed nonce
});
test("rejects stale ts, payer mismatch, count mismatch", () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.1", svc.publicKey, now);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);
  expect(checkSealedRequest(p, { now: now + 121, payer: "0.0.1", count: 1, seen: new MemoryNonceStore() })).toMatchObject({ ok: false, reason: "ts_window" });
  expect(checkSealedRequest(p, { now, payer: "0.0.2", count: 1, seen: new MemoryNonceStore() })).toMatchObject({ ok: false, reason: "payer_mismatch" });
  expect(checkSealedRequest(p, { now, payer: "0.0.1", count: 3, seen: new MemoryNonceStore() })).toMatchObject({ ok: false, reason: "count_mismatch" });
});

test("openSealedRequest rejects a reply_pk that is not valid base64", () => {
  const plain = { request: { vaults: ["1:0xabc"] }, reply_pk: "not-valid-base64!!!@#$", payer: "0.0.1", ts: String(now), req_nonce: validNonce() };
  const sealed = seal(plain, svc.publicKey);
  expect(() => openSealedRequest(sealed, svc.secretKey, svc.kid)).toThrow(/malformed sealed request/);
});
test("openSealedRequest rejects a reply_pk that decodes to the wrong length", () => {
  const plain = { request: { vaults: ["1:0xabc"] }, reply_pk: toB64(randomBytes(10)), payer: "0.0.1", ts: String(now), req_nonce: validNonce() };
  const sealed = seal(plain, svc.publicKey);
  expect(() => openSealedRequest(sealed, svc.secretKey, svc.kid)).toThrow(/malformed sealed request/);
});
test("openSealedRequest rejects a non-string payer", () => {
  const plain = { request: { vaults: ["1:0xabc"] }, reply_pk: validReplyPk, payer: 42, ts: String(now), req_nonce: validNonce() };
  const sealed = seal(plain, svc.publicKey);
  expect(() => openSealedRequest(sealed, svc.secretKey, svc.kid)).toThrow(/malformed sealed request/);
});
test("openSealedRequest rejects a non-string ts", () => {
  const plain = { request: { vaults: ["1:0xabc"] }, reply_pk: validReplyPk, payer: "0.0.1", ts: now, req_nonce: validNonce() };
  const sealed = seal(plain, svc.publicKey);
  expect(() => openSealedRequest(sealed, svc.secretKey, svc.kid)).toThrow(/malformed sealed request/);
});
test("openSealedRequest rejects a malformed req_nonce", () => {
  const plain = { request: { vaults: ["1:0xabc"] }, reply_pk: validReplyPk, payer: "0.0.1", ts: String(now), req_nonce: "abc" };
  const sealed = seal(plain, svc.publicKey);
  expect(() => openSealedRequest(sealed, svc.secretKey, svc.kid)).toThrow(/malformed sealed request/);
});

test("MemoryNonceStore.sweep removes expired entries and keeps unexpired ones", () => {
  const store = new MemoryNonceStore();
  store.add("expired", 100);
  store.add("future", 200);
  store.sweep(100);
  expect(store.has("expired")).toBe(false);
  expect(store.has("future")).toBe(true);
});

test("replayed nonce reports reason: nonce_replay", () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.7", svc.publicKey, now);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);
  const seen = new MemoryNonceStore();
  expect(checkSealedRequest(p, { now, payer: "0.0.7", count: 1, seen })).toEqual({ ok: true });
  expect(checkSealedRequest(p, { now, payer: "0.0.7", count: 1, seen })).toMatchObject({ ok: false, reason: "nonce_replay" });
});

// --- the split: checkSealedRequestPrePayment / checkSealedRequestPayer / commitNonce ---

test("checkSealedRequestPrePayment passes on valid ts/nonce/count and does not itself commit the nonce", () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.1", svc.publicKey, now);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);
  const seen = new MemoryNonceStore();
  expect(checkSealedRequestPrePayment(p, { now, count: 1, seen })).toEqual({ ok: true });
  // Calling it again with the same (never-committed) nonce still passes — proves this
  // function alone never marks the nonce seen.
  expect(checkSealedRequestPrePayment(p, { now, count: 1, seen })).toEqual({ ok: true });
  expect(seen.has(p.req_nonce)).toBe(false);
});

test("checkSealedRequestPrePayment rejects stale ts, nonce replay, and count mismatch independently of any payer", () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.1", svc.publicKey, now);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);

  expect(checkSealedRequestPrePayment(p, { now: now + 121, count: 1, seen: new MemoryNonceStore() })).toMatchObject({ ok: false, reason: "ts_window" });
  expect(checkSealedRequestPrePayment(p, { now, count: 3, seen: new MemoryNonceStore() })).toMatchObject({ ok: false, reason: "count_mismatch" });

  const seenAlready = new MemoryNonceStore();
  seenAlready.add(p.req_nonce, now + 600);
  expect(checkSealedRequestPrePayment(p, { now, count: 1, seen: seenAlready })).toMatchObject({ ok: false, reason: "nonce_replay" });

  // count is optional (table requests have none): omitting it never rejects on count.
  expect(checkSealedRequestPrePayment(p, { now, seen: new MemoryNonceStore() })).toEqual({ ok: true });
});

test("checkSealedRequestPayer matches or rejects payer alone, independent of ts/nonce/count", () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.9", svc.publicKey, now);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);
  expect(checkSealedRequestPayer(p, "0.0.9")).toEqual({ ok: true });
  expect(checkSealedRequestPayer(p, "0.0.other")).toEqual({ ok: false, reason: "payer_mismatch" });
});

test("commitNonce marks the nonce seen, so a subsequent pre-payment check reports nonce_replay", () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.1", svc.publicKey, now);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);
  const seen = new MemoryNonceStore();
  expect(checkSealedRequestPrePayment(p, { now, count: 1, seen })).toEqual({ ok: true });
  commitNonce(p, seen, now);
  expect(seen.has(p.req_nonce)).toBe(true);
  expect(checkSealedRequestPrePayment(p, { now, count: 1, seen })).toMatchObject({ ok: false, reason: "nonce_replay" });
});

test("checkSealedRequest (composed) still commits the nonce only once every check passes, same as before the split", () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.1", svc.publicKey, now);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);
  const seen = new MemoryNonceStore();
  // A failing payer check must not burn the nonce — a legitimate retry with the correct
  // payer (same nonce) should still succeed afterward.
  expect(checkSealedRequest(p, { now, payer: "0.0.wrong", count: 1, seen })).toMatchObject({ ok: false, reason: "payer_mismatch" });
  expect(seen.has(p.req_nonce)).toBe(false);
  expect(checkSealedRequest(p, { now, payer: "0.0.1", count: 1, seen })).toEqual({ ok: true });
  expect(seen.has(p.req_nonce)).toBe(true);
});
