### Task 16: Hedera rail via Blocky402, payer capture, hello-x402 client

**Files:**
- Create: `packages/service/src/rails/hedera.ts`, `packages/service/scripts/hello-x402.ts`, `packages/service/test/hedera-rail.live.test.ts`
- Modify: `packages/service/src/app.ts` (mount when `rails.hedera`)

**Interfaces:**
- Produces: `mountHederaRail(app, deps: { config; keys; data; nonces; onSettled?: (receipt, txId) => void })` registering `POST /hedera/v1/scan` (USDC, dynamic price), `POST /hedera/v1/scan-hbar` (HBAR tinybars, dynamic), `POST /hedera/v1/table` (USDC flat); `hederaPayerFromRequest(req): string | null` and `hederaTxIdFromRequest(req): string | null`.

- [ ] **Step 1: Rail implementation**

```ts
import type { Express, Request } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { Transaction } from "@x402/hedera";
import { clampCount, hederaScanPriceUsd, isSealed, TABLE_PRICE_USD } from "@vaultradar/core";
import { makeScanHandler, type HandlerDeps } from "../handlers/scan";

type Decoded = { payer: string | null; txId: string | null };
const cache = new WeakMap<Request, Decoded>();
export function decodeHederaPayment(req: Request): Decoded {
  const hit = cache.get(req); if (hit) return hit;
  let out: Decoded = { payer: null, txId: null };
  try {
    const h = req.header("payment-signature") ?? req.header("x-payment"); if (!h) return out;
    const p = decodePaymentSignatureHeader(h) as { payload: Record<string, unknown> };
    const b64 = (p.payload.transaction ?? p.payload.signedTransaction) as string | undefined; if (!b64) return out;
    const tx = Transaction.fromBytes(Buffer.from(b64, "base64")) as any;
    const txId = tx.transactionId?.toString?.() ?? null;
    let payer: string | null = null;
    const tokenTransfers = tx.tokenTransfers ?? tx._tokenTransfers; // Map<TokenId, Map<AccountId, Long>>
    for (const [, accts] of tokenTransfers ?? []) for (const [acct, amt] of accts) if (amt.toNumber?.() < 0 || Number(amt) < 0) payer = acct.toString();
    if (!payer) for (const [acct, amt] of tx.hbarTransfers ?? []) if (Number(amt.toTinybars?.() ?? amt) < 0) payer = acct.toString();
    out = { payer, txId };
  } catch { /* leave nulls */ }
  cache.set(req, out); return out;
}
export const hederaPayerFromRequest = (req: Request) => decodeHederaPayment(req).payer;
export const hederaTxIdFromRequest = (req: Request) => decodeHederaPayment(req).txId;

export function mountHederaRail(app: Express, deps: Omit<HandlerDeps, "rail" | "tier" | "getPayer" | "getTxId">) {
  const c = deps.config;
  const facilitator = new HTTPFacilitatorClient({ url: c.hedera.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register("hedera:testnet", new ExactHederaScheme());
  const validateEnvelope = (ctx: any) => { const b = ctx.adapter.getBody(); if (b && typeof b === "object" && ("ct" in b || "kem" in b) && !isSealed(b)) throw new Error("malformed sealed envelope"); };
  const scanPrice = (ctx: any) => { validateEnvelope(ctx); const n = clampCount(ctx.adapter.getHeader("x-vr-count")); if (!n) throw new Error("X-VR-Count must be 1..100"); return `$${hederaScanPriceUsd(n)}`; };
  const hbarPrice = (ctx: any) => { validateEnvelope(ctx); const n = clampCount(ctx.adapter.getHeader("x-vr-count")); if (!n) throw new Error("X-VR-Count must be 1..100"); return { asset: "0.0.0", amount: String(n * 1_000_000) }; }; // 0.01 HBAR per vault, in tinybars (demo rate for the HBAR variant)
  const common = { scheme: "exact", network: "hedera:testnet", payTo: c.hedera.payToAccountId, maxTimeoutSeconds: 120 } as const;
  app.use(paymentMiddleware({
    "POST /hedera/v1/scan": { accepts: [{ ...common, price: scanPrice }], description: "VaultRadar sealed scan (metered per vault)" },
    "POST /hedera/v1/scan-hbar": { accepts: [{ ...common, price: hbarPrice }], description: "VaultRadar scan priced in HBAR" },
    "POST /hedera/v1/table": { accepts: [{ ...common, price: `$${TABLE_PRICE_USD}` }], description: "VaultRadar whole-protocol table (privacy tier)" },
  }, server));
  const h = (tier: "scan" | "table") => makeScanHandler({ ...deps, rail: "hedera", tier, getPayer: hederaPayerFromRequest, getTxId: hederaTxIdFromRequest });
  app.post("/hedera/v1/scan", h("scan")); app.post("/hedera/v1/scan-hbar", h("scan")); app.post("/hedera/v1/table", h("table"));
}
```

The `price` function receiving `HTTPRequestContext` is confirmed in the type facts. The Hedera payload field name (`transaction` vs another key) must be confirmed once: run `hello-x402` (below) with `DEBUG_X402=1` which logs `Object.keys(payload)` (never the value) in `decodeHederaPayment`, then remove the fallback that is not needed. The USDC default asset for `$` prices on `hedera:testnet` is `0.0.429274` (from the `@x402/hedera` default asset table).

- [ ] **Step 2: Payment tx id after settlement**

Register an after-settle hook for the HCS commitment (Task 17 consumes it): `server.onAfterSettle?.(ctx => …)` if present on `x402ResourceServer` in 2.25.0; otherwise wrap `res.json` in `app.use` before the payment middleware to read the `PAYMENT-RESPONSE` header the middleware sets on the response (`res.getHeader("payment-response")`), decode with `decodePaymentResponseHeader` from `@x402/core/http`, and call `deps.onSettled?.(res.locals.receipt, settled.transaction)`. Implement the `res.json` wrapper path; it needs no hook API.

- [ ] **Step 3: hello-x402 client script (day-one de-risk)**

```ts
// packages/service/scripts/hello-x402.ts — pays one sealed scan on the running service
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { buildSealedRequest, fromB64, open, verifyReceipt } from "@vaultradar/core";
const base = process.env.SERVICE_URL ?? "http://localhost:8787";
const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
const signer = createClientHederaSigner(process.env.AGENT_HEDERA_ACCOUNT_ID!, PrivateKey.fromStringECDSA(process.env.AGENT_HEDERA_KEY!), { network: "testnet" } as any);
const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer));
const payFetch = wrapFetchWithPayment(fetch, client);
const { sealed, replySecret } = buildSealedRequest({ vaults: [process.env.VAULT ?? "1:0x0000000000000000000000000000000000000000"] }, process.env.AGENT_HEDERA_ACCOUNT_ID!, fromB64(card.pq.kem.public_key));
const res = await payFetch(card.endpoints.hedera.scan, { method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify(sealed) });
console.log("status", res.status, "payment-response", res.headers.get("payment-response") ? decodePaymentResponseHeader(res.headers.get("payment-response")!) : null);
const j = await res.json(); if (res.status !== 200) { console.log(j); process.exit(1); }
console.log("receipt ok:", verifyReceipt(j.receipt, fromB64(card.pq.sig.public_key)), "receipt txId:", j.receipt.payment.txId);
console.log("opened:", JSON.stringify(open(j.sealed, replySecret)).slice(0, 300));
```

Prerequisites (spec §12): both accounts associated with `0.0.429274` (`TokenAssociateTransaction` via a tiny `scripts/associate.ts`, or through the Hedera portal), agent account holds testnet USDC from `faucet.circle.com`. Run the service with `HEDERA_*` set, then:

`SERVICE_URL=http://localhost:8787 AGENT_HEDERA_ACCOUNT_ID=0.0.x AGENT_HEDERA_KEY=… bun run packages/service/scripts/hello-x402.ts`

Expected: `status 200`, a `payment-response` with a Hedera transaction id, `receipt ok: true`. Open HashScan testnet, search the transaction id, confirm the USDC transfer. Paste the HashScan URL into `docs/verification-log.md`.

- [ ] **Step 4: Live test (env-gated)**

`hedera-rail.live.test.ts`: skipped unless `LIVE=1`; spins up the app with real config and `LiveDataProvider`, runs the same flow as the script, asserts 200 and a verified receipt.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(service): Hedera x402 rail via Blocky402 with metered pricing and payer capture; hello-x402 client"`

