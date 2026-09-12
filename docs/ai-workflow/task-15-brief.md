### Task 15: Scan and table handlers with data provider

**Files:**
- Create: `packages/service/src/data/provider.ts`, `packages/service/src/handlers/scan.ts`, `packages/service/test/handlers.test.ts`

**Interfaces:**
- Produces: `interface DataProvider { catalog(): Promise<Catalog>; scan(vaultIds: string[]): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>; table(protocol: string, chainId: string): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }> }`; `class LiveDataProvider implements DataProvider` (constructor `(config, deps?: { fetchImpl?, sql?: SqlQuery | null })`; uses `fetchStandardized` for all live deployments filtered by chain, `readErc4626Vaults` when `sql`, chain head via viem `getBlock({ blockTag: "latest" })` cached 15 s per chain); `makeScanHandler(deps: { keys; config; data; nonces; rail: "hedera" | "arc"; tier: "scan" | "table"; getPayer: (req) => string | null; getTxId: (req, res) => string | null })` returns an Express handler implementing spec §5.4/§5.5: accepts either a sealed envelope (`req.body` passes `isSealed`) or clear `{ vaults }` / `{ protocol, chainId }`; runs checks; computes `reports = vaults.map(v => computeRisk(v, now))`; `attestations` per vault from its first source; `receipt` via `buildReceipt`; sealed response when sealed; sets `res.locals.receipt` for the HCS hook; 60 s cap via `Promise.race` → 504.
- Payment tx id: for the Hedera rail the settlement happens after the handler, so the receipt's `payment.txId` cannot be known inside the handler. Rule: the handler writes `payment: { rail, txId: "pending" }`, and the rail (Task 16) fills `txId` by re-signing? No: receipts must be final when signed. Resolution: the receipt's `payment.txId` is the **payment identifier the payer already committed to**: on Hedera the client-signed transaction id (parsed from the `PAYMENT-SIGNATURE` payload before settlement); on Arc the `req.payment.transaction` when present else the EIP-3009 nonce. Both identify the payment on-chain after settlement. `getTxId` implements this per rail.

- [ ] **Step 1: Failing tests (handler with stub provider, no payment middleware)**

```ts
import { expect, test } from "bun:test";
import express from "express";
import { buildSealedRequest, deriveKemKeys, deriveSigningKeys, MemoryNonceStore, open, verifyReceipt, verifyAttestation, requestHash } from "@vaultradar/core";
import { makeScanHandler } from "../src/handlers/scan";
import { loadConfig } from "../src/config";
const env = { PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "77".repeat(32), PQ_KEM_SEED: "88".repeat(64), GRAPH_STUDIO_API_KEY: "k", HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1", HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), HEDERA_HCS_TOPIC_ID: "0.0.99" };
const config = loadConfig(env); const keys = { sig: deriveSigningKeys(env.PQ_SIG_SEED), kem: deriveKemKeys(env.PQ_KEM_SEED) };
const now = Math.floor(Date.now() / 1000);
const vault = { id: "1:0xabc", kind: "erc4626", protocol: "erc4626", chain: "ethereum", chainId: "1", asset: null, sharePrice: "1.01", tvlUsd: null, inputTokenBalance: "100", depositLimit: null, history: [], sources: [{ kind: "substreams", ref: "erc4626-vault-metrics", block: "10", timestamp: String(now - 5), ageSeconds: "5", freshness: "fresh" }], freshness: "fresh" } as const;
const data = { catalog: async () => ({ protocols: [], erc4626Chains: ["1"] }), scan: async (ids: string[]) => ({ vaults: ids.includes("1:0xabc") ? [vault] : [], sources: [{ ref: "erc4626-vault-metrics", chainId: "1", block: "10", timestamp: String(now - 5) }] }), table: async () => ({ vaults: [vault], sources: [] }) };
const app = express(); app.use(express.json());
app.post("/scan", makeScanHandler({ keys, config, data, nonces: new MemoryNonceStore(), rail: "hedera", tier: "scan", getPayer: () => "0.0.1234", getTxId: () => "0.0.1234@1.000" }));
const srv = app.listen(0); const url = () => `http://127.0.0.1:${(srv.address() as any).port}/scan`;
test("sealed scan returns sealed body and verifiable receipt", async () => {
  const { sealed, replySecret } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.1234", keys.kem.publicKey);
  const res = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify(sealed) });
  expect(res.status).toBe(200); const j = await res.json();
  expect(j.sealed).toBeDefined(); expect(verifyReceipt(j.receipt, keys.sig.publicKey)).toBe(true);
  expect(j.receipt.request_hash).toBe(requestHash({ vaults: ["1:0xabc"] })); expect(j.receipt.sealed).toBe(true);
  const body = open<any>(j.sealed, replySecret); expect(body.vaults[0].id).toBe("1:0xabc"); expect(body.reports[0].verdict).toBe("ok");
  expect(verifyAttestation(body.attestations[0], keys.sig.publicKey)).toBe(true);
});
test("payer mismatch → 422", async () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.9999", keys.kem.publicKey);
  const res = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify(sealed) });
  expect(res.status).toBe(422); expect((await res.json()).reason).toBe("payer_mismatch");
});
test("clear request works and receipt says sealed:false", async () => {
  const res = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify({ vaults: ["1:0xabc"] }) });
  const j = await res.json(); expect(j.vaults[0].id).toBe("1:0xabc"); expect(j.receipt.sealed).toBe(false);
});
```

- [ ] **Step 2: Implement `handlers/scan.ts`**

```ts
import type { Request, Response } from "express";
import { buildAttestation, buildReceipt, checkSealedRequest, computeRisk, isSealed, openSealedRequest, requestHash, responseHash, seal, fromB64, clampCount, type NonceStore, type ScanRequest, type TableRequest, type SourceRef, hederaScanPriceAtomic, TABLE_PRICE_USD, arcBucket, ARC_BUCKET_PRICE } from "@vaultradar/core";
import type { DataProvider } from "../data/provider"; import type { ServiceKeys } from "../keys"; import type { Config } from "../config";
export type HandlerDeps = { keys: ServiceKeys; config: Config; data: DataProvider; nonces: NonceStore; rail: "hedera" | "arc"; tier: "scan" | "table"; getPayer: (req: Request) => string | null; getTxId: (req: Request, res: Response) => string | null };
const HANDLER_CAP_MS = 60_000;
export function makeScanHandler(d: HandlerDeps) {
  return async (req: Request, res: Response) => {
    const now = Math.floor(Date.now() / 1000);
    const sealedIn = isSealed(req.body);
    let request: ScanRequest | TableRequest; let replyPk: Uint8Array | null = null;
    if (sealedIn) {
      let p; try { p = openSealedRequest<ScanRequest | TableRequest>(req.body, d.keys.kem.secretKey, d.keys.kem.kid); } catch { return res.status(422).json({ reason: "envelope_open_failed" }); }
      const payer = d.getPayer(req); if (!payer) return res.status(422).json({ reason: "payer_unknown" });
      const count = d.tier === "scan" ? clampCount(req.header("x-vr-count")) ?? undefined : undefined;
      const chk = checkSealedRequest(p, { now, payer, count, seen: d.nonces }); if (!chk.ok) return res.status(422).json({ reason: chk.reason });
      request = p.request; replyPk = fromB64(p.reply_pk);
    } else { request = req.body; }
    if (d.tier === "scan") { const v = (request as ScanRequest).vaults; if (!Array.isArray(v) || !v.length || v.length > 100 || !v.every(x => /^\d+:0x[0-9a-f]{40}$/i.test(x))) return res.status(422).json({ reason: "bad_vaults" }); }
    else { const t = request as TableRequest; if (typeof t.protocol !== "string" || typeof t.chainId !== "string") return res.status(422).json({ reason: "bad_table_request" }); }
    const work = d.tier === "scan" ? d.data.scan((request as ScanRequest).vaults.map(x => x.toLowerCase())) : d.data.table((request as TableRequest).protocol, (request as TableRequest).chainId);
    let result; try { result = await Promise.race([work, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("cap")), HANDLER_CAP_MS))]); }
    catch (e) { return res.status((e as Error).message === "cap" ? 504 : 502).json({ reason: (e as Error).message === "cap" ? "handler_cap" : "upstream_failed" }); }
    const reports = result.vaults.map(v => computeRisk(v, now));
    const attestations = result.vaults.map(v => { const s = v.sources[0]; return buildAttestation({ vaultId: v.id, chainId: v.chainId, block: s?.block ?? "0", timestamp: s?.timestamp ?? "0", sharePrice: v.sharePrice, tvlUsd: v.tvlUsd, source: s ? `${s.kind}:${s.ref}` : "none" }, d.keys.sig); });
    const body = { vaults: result.vaults, reports, attestations };
    const count = d.tier === "scan" ? (request as ScanRequest).vaults.length : 0;
    const amount = d.rail === "hedera" ? (d.tier === "scan" ? hederaScanPriceAtomic(count) : String(Math.round(Number(TABLE_PRICE_USD) * 1e6))) : (d.tier === "scan" ? ARC_BUCKET_PRICE[arcBucket(count)] : TABLE_PRICE_USD);
    const receipt = buildReceipt({ service: { erc8004: d.config.erc8004 }, request_hash: requestHash(request), response_hash: responseHash(body), sealed: sealedIn,
      sources: result.sources as SourceRef[], price: { amount, asset: d.rail === "hedera" ? d.config.hedera.usdcToken : "USDC", rail: d.rail },
      payment: { rail: d.rail, txId: d.getTxId(req, res) ?? "unknown" }, tier: d.tier, hcs: { topicId: d.config.hedera.hcsTopicId ?? "" } }, d.keys.sig);
    res.locals.receipt = receipt;
    return res.status(200).json(replyPk ? { sealed: seal(body, replyPk), receipt } : { ...body, receipt });
  };
}
```

- [ ] **Step 3: Implement `data/provider.ts`** with `LiveDataProvider`: `catalog()` from the registry (`status`, count of cached vaults per deployment, refreshed every 5 minutes) plus `erc4626Chains` from `sql ? ["1", "8453"] : []`; `scan(ids)`: group ids by chain; for each chain run `fetchStandardized` over live deployments of that chain (cache results 60 s) and filter by id, plus `readErc4626Vaults(sql, chainId, addresses)`; merge by id preferring the entry with a `fresh` source and concatenating `sources`; `table(protocol, chainId)`: if `protocol === "erc4626"` → `readErc4626Vaults(sql, chainId, null)`, else all vaults from the matching deployments. Chain head: `createPublicClient({ transport: http(rpcUrl) }).getBlock()` → `Number(block.timestamp)`, cached 15 s; on failure use `now` and mark heads as failed so freshness becomes `stale` (pass `headTs = Number.MAX_SAFE_INTEGER` to force stale).

- [ ] **Step 4: Run tests, expect pass. Commit** — `git add -A && git commit -m "feat(service): sealed scan/table handlers, attestations, receipts, live data provider"`

