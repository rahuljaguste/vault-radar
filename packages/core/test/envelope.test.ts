import { expect, test } from "bun:test";
import { deriveKemKeys } from "../src/pq/keys";
import { MemoryNonceStore, buildSealedRequest, checkSealedRequest, openSealedRequest } from "../src/envelope";

const svc = deriveKemKeys("55".repeat(64));
const now = 1_760_000_000;
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
