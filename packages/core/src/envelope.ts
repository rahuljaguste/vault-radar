import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { fromB64, randomBytes, toB64, toHex } from "./util/bytes";
import { Sealed, open, seal } from "./pq/seal";

export type ScanRequest = { vaults: string[] };
export type TableRequest = { protocol: string; chainId: string };
export type SealedRequest<R> = { request: R; reply_pk: string; payer: string; ts: string; req_nonce: string };
export interface NonceStore { has(n: string): boolean; add(n: string, expiresAt: number): void; sweep(now: number): void }
export class MemoryNonceStore implements NonceStore {
  private m = new Map<string, number>();
  has(n: string) { return this.m.has(n); }
  add(n: string, expiresAt: number) { this.m.set(n, expiresAt); }
  sweep(now: number) { for (const [k, t] of this.m) if (t <= now) this.m.delete(k); }
}
export const TS_WINDOW_S = 120, NONCE_TTL_S = 600;

export function buildSealedRequest<R extends object>(request: R, payer: string, servicePk: Uint8Array, now = Math.floor(Date.now() / 1000)) {
  const reply = ml_kem768_x25519.keygen();
  const plain: SealedRequest<R> = { request, reply_pk: toB64(reply.publicKey), payer, ts: String(now), req_nonce: toHex(randomBytes(16)) };
  const count = Array.isArray((request as { vaults?: unknown }).vaults) ? (request as ScanRequest).vaults.length : 0;
  return { sealed: seal(plain, servicePk), replySecret: reply.secretKey, count };
}
export function openSealedRequest<R>(sealed: Sealed, kemSecret: Uint8Array, kid: string): SealedRequest<R> {
  const p = open<SealedRequest<R>>(sealed, kemSecret, kid);
  if (typeof p.payer !== "string") throw new Error("malformed sealed request: payer");
  if (typeof p.ts !== "string") throw new Error("malformed sealed request: ts");
  if (typeof p.req_nonce !== "string" || !/^[0-9a-f]{32}$/.test(p.req_nonce)) throw new Error("malformed sealed request: req_nonce");
  // fromB64 (Buffer base64 decode) never throws on malformed input — it silently drops
  // invalid characters — so a regex on the wire format plus a decoded-length check against
  // the real KEM public key size are both required to actually reject a bad reply_pk.
  if (typeof p.reply_pk !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.reply_pk) || fromB64(p.reply_pk).length !== ml_kem768_x25519.lengths.publicKey) {
    throw new Error("malformed sealed request: reply_pk");
  }
  return p;
}
type Check = { ok: true } | { ok: false; reason: string };

/**
 * Everything about a sealed request that can be validated *before* a payer is known:
 * the ts window, that the nonce hasn't been seen before (without committing it — see
 * `commitNonce`), and (for scan requests) that the request's own vault count matches
 * the count the payment was priced against. None of this depends on payment state, so
 * it is safe to run ahead of payment processing — the Arc rail does exactly that
 * (`rails/arc.ts`'s pre-payment middleware), since on that rail settlement completes
 * before any handler runs and there is no way to refund a request rejected afterward.
 */
export function checkSealedRequestPrePayment(p: SealedRequest<unknown>, o: { now: number; count?: number; seen: NonceStore }): Check {
  const ts = Number(p.ts);
  if (!Number.isFinite(ts) || Math.abs(o.now - ts) > TS_WINDOW_S) return { ok: false, reason: "ts_window" };
  if (o.seen.has(p.req_nonce)) return { ok: false, reason: "nonce_replay" };
  const vaults = (p.request as { vaults?: unknown }).vaults;
  if (o.count !== undefined && Array.isArray(vaults) && vaults.length !== o.count) return { ok: false, reason: "count_mismatch" };
  return { ok: true };
}

/**
 * The one check that genuinely cannot run before payment on every rail: whether the
 * sealed request's claimed payer matches the payer the rail actually observed. On Arc
 * that payer is only known once `gateway.require` has already verified (and settled)
 * the payment, so a `payer_mismatch` caught here is caught *after* money has moved —
 * see `rails/arc.ts`'s handler-side comment for why this is not refunded there.
 */
export function checkSealedRequestPayer(p: SealedRequest<unknown>, payer: string): Check {
  return p.payer === payer ? { ok: true } : { ok: false, reason: "payer_mismatch" };
}

/**
 * Records the request's nonce as seen, so a replay of the same sealed envelope is
 * rejected by a later `checkSealedRequestPrePayment` call. Deliberately split out from
 * the pre-payment check itself (which only *reads* `seen`) rather than folded into it:
 * committing the nonce as soon as the pre-payment check passes — before the payer check
 * even runs — would permanently burn it even for a request that goes on to fail
 * `checkSealedRequestPayer`, or (on Arc) never reaches payment at all. A caller commits
 * only once every check it cares about has actually passed, mirroring exactly when the
 * combined `checkSealedRequest` below commits.
 */
export function commitNonce(p: SealedRequest<unknown>, seen: NonceStore, now: number): void {
  seen.sweep(now);
  seen.add(p.req_nonce, now + NONCE_TTL_S);
}

/**
 * The full check, as a single call: `checkSealedRequestPrePayment` then
 * `checkSealedRequestPayer`, committing the nonce only if both pass. Kept as the
 * composition of the three pieces above (rather than its own independent
 * implementation) so every existing caller — the Hedera rail, which has no
 * settle-before-handler ordering problem and so never needed the split — and every
 * existing test keeps working unchanged. Note this changes the *tie-break order*
 * between `count_mismatch` and `payer_mismatch` relative to the pre-split
 * implementation (count is now checked first, since it moved into the pre-payment
 * phase) — no existing caller or test depends on which of the two wins when a request
 * fails both simultaneously.
 */
export function checkSealedRequest(p: SealedRequest<unknown>, o: { now: number; payer: string; count?: number; seen: NonceStore }): Check {
  const pre = checkSealedRequestPrePayment(p, o);
  if (!pre.ok) return pre;
  const payerCheck = checkSealedRequestPayer(p, o.payer);
  if (!payerCheck.ok) return payerCheck;
  commitNonce(p, o.seen, o.now);
  return { ok: true };
}
