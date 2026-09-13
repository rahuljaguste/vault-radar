### Task 5: Request envelope, replay checks, receipts, attestations

**Files:**
- Create: `packages/core/src/envelope.ts`, `packages/core/src/receipts.ts`, `packages/core/test/envelope.test.ts`, `packages/core/test/receipts.test.ts`

**Interfaces:**
- Produces (envelope): `type ScanRequest = { vaults: string[] }`; `type TableRequest = { protocol: string; chainId: string }`; `type SealedRequest<R> = { request: R; reply_pk: string /* b64 */; payer: string; ts: string /* unix seconds */; req_nonce: string /* hex 32 */ }`; `buildSealedRequest<R>(request: R, payer: string, servicePk: Uint8Array, now?: number): { sealed: Sealed; replySecret: Uint8Array; count: number }`; `openSealedRequest<R>(sealed: Sealed, kemSecret: Uint8Array, kid: string): SealedRequest<R>`; `checkSealedRequest(p: SealedRequest<unknown>, opts: { now: number; payer: string; count?: number; seen: NonceStore }): { ok: true } | { ok: false; reason: string }`; `class MemoryNonceStore implements NonceStore { has(n): boolean; add(n, expiresAt): void; sweep(now): void }`; `NonceStore` interface.
- Produces (receipts): `type SourceRef = { ref: string; chainId: string; block: string; timestamp: string }`; `type Receipt = { v: 1; service: { erc8004: { chainId: string; agentId: string }[] }; request_hash: string; response_hash: string; sealed: boolean; sources: SourceRef[]; price: { amount: string; asset: string; rail: "hedera" | "arc" }; payment: { rail: "hedera" | "arc"; txId: string }; tier: "scan" | "table"; issued_at: string; nonce: string; hcs: { topicId: string }; sig: Sig }`; `type Attestation = { v: 1; vaultId: string; chainId: string; block: string; timestamp: string; sharePrice: string; tvlUsd: string | null; source: string; sig: Sig }`; `buildReceipt(input: Omit<Receipt, "v" | "sig" | "nonce" | "issued_at"> & { issued_at?: string }, keys): Receipt`; `receiptHash(r: Receipt): string` (sha256 of canonical receipt without `sig`); `verifyReceipt(r: Receipt, pk: Uint8Array): boolean`; `buildAttestation(a: Omit<Attestation, "v" | "sig">, keys): Attestation`; `verifyAttestation(a, pk)`; `responseHash(body: { vaults; reports; attestations }): string`; `requestHash(request: unknown): string`.

- [ ] **Step 1: Failing tests (envelope)**

```ts
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
```

- [ ] **Step 2: Failing tests (receipts)**

```ts
import { expect, test } from "bun:test";
import { deriveSigningKeys } from "../src/pq/keys";
import { buildAttestation, buildReceipt, receiptHash, requestHash, responseHash, verifyAttestation, verifyReceipt } from "../src/receipts";

const keys = deriveSigningKeys("66".repeat(32));
const base = {
  service: { erc8004: [{ chainId: "296", agentId: "7" }] },
  request_hash: requestHash({ vaults: ["1:0xabc"] }),
  response_hash: responseHash({ vaults: [], reports: [], attestations: [] }),
  sealed: true, sources: [{ ref: "Qm123", chainId: "1", block: "100", timestamp: "1760000000" }],
  price: { amount: "1500", asset: "0.0.429274", rail: "hedera" as const },
  payment: { rail: "hedera" as const, txId: "0.0.5@1760000000.000000001" },
  tier: "scan" as const, hcs: { topicId: "0.0.99" },
};
test("receipt signs, verifies, hashes without sig", () => {
  const r = buildReceipt(base, keys);
  expect(verifyReceipt(r, keys.publicKey)).toBe(true);
  expect(r.nonce).toMatch(/^[0-9a-f]{32}$/);
  const h1 = receiptHash(r);
  expect(h1).toBe(receiptHash({ ...r, sig: { ...r.sig, value: "AAAA" } }));
  expect(verifyReceipt({ ...r, tier: "table" }, keys.publicKey)).toBe(false);
});
test("attestation signs and verifies", () => {
  const a = buildAttestation({ vaultId: "1:0xabc", chainId: "1", block: "100", timestamp: "1760000000", sharePrice: "1.0213", tvlUsd: null, source: "substreams:erc4626-vault-metrics" }, keys);
  expect(verifyAttestation(a, keys.publicKey)).toBe(true);
  expect(verifyAttestation({ ...a, sharePrice: "9" }, keys.publicKey)).toBe(false);
});
```

- [ ] **Step 3: Run both, expect failure.**

- [ ] **Step 4: Implement `envelope.ts`**

```ts
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
```

- [ ] **Step 5: Implement `receipts.ts`**

```ts
import { hashJson } from "./canonical";
import { Sig, attachSig, checkSig } from "./pq/sign";
import { randomBytes, toHex } from "./util/bytes";

export type Rail = "hedera" | "arc";
export type SourceRef = { ref: string; chainId: string; block: string; timestamp: string };
export type Receipt = {
  v: 1; service: { erc8004: { chainId: string; agentId: string }[] };
  request_hash: string; response_hash: string; sealed: boolean; sources: SourceRef[];
  price: { amount: string; asset: string; rail: Rail }; payment: { rail: Rail; txId: string };
  tier: "scan" | "table"; issued_at: string; nonce: string; hcs: { topicId: string }; sig: Sig;
};
export type Attestation = { v: 1; vaultId: string; chainId: string; block: string; timestamp: string; sharePrice: string; tvlUsd: string | null; source: string; sig: Sig };
type Keys = { secretKey: Uint8Array; pubHash: string };

export const requestHash = (request: unknown) => hashJson(request);
export const responseHash = (body: { vaults: unknown; reports: unknown; attestations: unknown }) =>
  hashJson({ vaults: body.vaults, reports: body.reports, attestations: body.attestations });
export function buildReceipt(input: Omit<Receipt, "v" | "sig" | "nonce" | "issued_at"> & { issued_at?: string }, keys: Keys): Receipt {
  const body = { v: 1 as const, ...input, issued_at: input.issued_at ?? String(Math.floor(Date.now() / 1000)), nonce: toHex(randomBytes(16)) };
  return attachSig(body, keys);
}
export const receiptHash = (r: Receipt) => { const { sig: _s, ...rest } = r; return hashJson(rest); };
export const verifyReceipt = (r: Receipt, pk: Uint8Array) => checkSig(r, pk);
export const buildAttestation = (a: Omit<Attestation, "v" | "sig">, keys: Keys): Attestation => attachSig({ v: 1 as const, ...a }, keys);
export const verifyAttestation = (a: Attestation, pk: Uint8Array) => checkSig(a, pk);
```

- [ ] **Step 6: Run, expect all pass. Commit**, `git add -A && git commit -m "feat(core): sealed request envelope with replay checks; PQ-signed receipts and attestations"`

