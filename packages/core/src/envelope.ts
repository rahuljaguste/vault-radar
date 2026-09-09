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
  if (typeof p.reply_pk !== "string" || typeof p.payer !== "string" || typeof p.ts !== "string" || !/^[0-9a-f]{32}$/.test(p.req_nonce)) throw new Error("malformed sealed request");
  fromB64(p.reply_pk);
  return p;
}
export function checkSealedRequest(p: SealedRequest<unknown>, o: { now: number; payer: string; count?: number; seen: NonceStore }): { ok: true } | { ok: false; reason: string } {
  const ts = Number(p.ts);
  if (!Number.isFinite(ts) || Math.abs(o.now - ts) > TS_WINDOW_S) return { ok: false, reason: "ts_window" };
  if (o.seen.has(p.req_nonce)) return { ok: false, reason: "nonce_replay" };
  if (p.payer !== o.payer) return { ok: false, reason: "payer_mismatch" };
  const vaults = (p.request as { vaults?: unknown }).vaults;
  if (o.count !== undefined && Array.isArray(vaults) && vaults.length !== o.count) return { ok: false, reason: "count_mismatch" };
  o.seen.sweep(o.now); o.seen.add(p.req_nonce, o.now + NONCE_TTL_S);
  return { ok: true };
}
