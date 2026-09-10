import { expect, test } from "bun:test";
import express from "express";
import { TransferTransaction, TransactionId, AccountId, Hbar, TokenId } from "@x402/hedera";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { deriveKemKeys, deriveSigningKeys, hederaScanPriceAtomic, MemoryNonceStore, type SourceRef, type UnifiedVault } from "@vaultradar/core";
import { decodeHederaPayment, hederaPayerFromRequest, hederaTxIdFromRequest, _mapSizesForTests } from "../src/rails/hedera";
import { buildApp, type BuildAppDeps } from "../src/app";
import { loadConfig } from "../src/config";
import { Metrics } from "../src/metrics";

const TOKEN_ID = "0.0.429274";
const PAYER_ACCOUNT = "0.0.1234";
const PAYTO_ACCOUNT = "0.0.5678";
// Deliberately a different account than PAYER_ACCOUNT: in the x402 Hedera exact scheme
// the transaction id's embedded account is the fee payer (the facilitator), never the
// business payer, so a test where they coincide couldn't tell decodeHederaPayment's
// transfer-based derivation apart from a (wrong) transactionId-based one.
const FEE_PAYER_ACCOUNT = "0.0.999";
// Matches fakeFacilitator's default `feePayer` below. ExactHederaScheme's server-side
// enhancePaymentRequirements merges the facilitator's declared feePayer into
// requirements.extra.feePayer, and x402's findMatchingRequirements requires every key
// in the server's computed `extra` to be present (with an equal value) in the client
// payload's `accepted.extra` (@x402/core's paymentRequirementsMatchAccepted /
// objectContainsSubset) — so a payload built with a different (or missing) feePayer
// here would fail to match and never reach verify/settle at all.
const DEFAULT_FEE_PAYER = "0.0.7162784";

/**
 * Builds a `payment-signature` header value carrying a real, freeze-able Hedera
 * transfer. `amount`/`asset`/`payTo`/`feePayer` must match what the mounted rail will
 * itself compute for the same X-VR-Count (1, by default across these tests) and the
 * same fake facilitator, or x402's own requirements-matching step rejects the payload
 * before this rail ever sees it.
 */
function buildPaymentSignatureHeader(payerAccount = PAYER_ACCOUNT, feePayer = DEFAULT_FEE_PAYER): string {
  const tx = new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(TOKEN_ID), AccountId.fromString(payerAccount), -1500)
    .addTokenTransfer(TokenId.fromString(TOKEN_ID), AccountId.fromString(PAYTO_ACCOUNT), 1500)
    .setTransactionId(TransactionId.generate(AccountId.fromString(FEE_PAYER_ACCOUNT)))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .freeze();
  const transactionB64 = Buffer.from(tx.toBytes()).toString("base64");
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: { scheme: "exact", network: "hedera:testnet", asset: TOKEN_ID, amount: "1500", payTo: PAYTO_ACCOUNT, maxTimeoutSeconds: 120, extra: { feePayer } },
    payload: { transaction: transactionB64 },
  };
  return encodePaymentSignatureHeader(payload);
}

/**
 * The same thing for the HBAR-priced scan route: native HBAR rather than an HTS token, so
 * the transfer is an hbar transfer and `accepted.asset` is `0.0.0`. The amount must equal
 * what the route computes for the same `X-VR-Count` (1_000_000 tinybars per vault) or
 * x402's requirements matching rejects the payload before the rail sees it.
 */
function buildHbarPaymentSignatureHeader(tinybars: number, feePayer = DEFAULT_FEE_PAYER): string {
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(PAYER_ACCOUNT), Hbar.fromTinybars(-tinybars))
    .addHbarTransfer(AccountId.fromString(PAYTO_ACCOUNT), Hbar.fromTinybars(tinybars))
    .setTransactionId(TransactionId.generate(AccountId.fromString(FEE_PAYER_ACCOUNT)))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .freeze();
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: {
      scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: String(tinybars),
      payTo: PAYTO_ACCOUNT, maxTimeoutSeconds: 120, extra: { feePayer },
    },
    payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
  };
  return encodePaymentSignatureHeader(payload);
}

/** Runs `fn(req)` inside a real Express request handler and returns its JSON result. */
async function probe<T>(fn: (req: express.Request) => T, headers: Record<string, string> = {}): Promise<T> {
  const app = express();
  app.get("/probe", (req, res) => res.json(fn(req)));
  const srv = app.listen(0);
  try {
    const port = (srv.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/probe`, { headers });
    return (await res.json()) as T;
  } finally {
    srv.close();
  }
}

// --- (a) decodeHederaPayment ------------------------------------------------------

test("decodeHederaPayment recovers the debited payer and a non-empty tx id from a real transaction", async () => {
  const header = buildPaymentSignatureHeader();
  const decoded = await probe(decodeHederaPayment, { "payment-signature": header });
  expect(decoded.payer).toBe(PAYER_ACCOUNT);
  expect(decoded.payer).not.toBe(FEE_PAYER_ACCOUNT);
  expect(typeof decoded.txId).toBe("string");
  expect((decoded.txId as string).length).toBeGreaterThan(0);
});

test("hederaPayerFromRequest / hederaTxIdFromRequest are null with no payment header", async () => {
  const decoded = await probe(req => ({ payer: hederaPayerFromRequest(req), txId: hederaTxIdFromRequest(req) }));
  expect(decoded).toEqual({ payer: null, txId: null });
});

test("a malformed payment-signature header decodes to nulls instead of throwing", async () => {
  const decoded = await probe(decodeHederaPayment, { "payment-signature": "not-valid-base64-json!!" });
  expect(decoded).toEqual({ payer: null, txId: null });
});

// --- (b)/(c) mounted rail: pricing, validation, and the 402 payment-required body --

type VerifyMode = { isValid: boolean; payer?: string; invalidReason?: string };
type SettleMode = { success: boolean; transaction?: string; payer?: string; errorReason?: string };

/**
 * A minimal x402 facilitator: /supported always succeeds; /verify and /settle default
 * to a clean failure (the shape most of these tests want — nothing here should ever
 * reach the resource server's paid path). Pass `verify`/`settle` to exercise the paid
 * path instead (see the onAfterVerify/onAfterSettle/onSettleFailure tests below).
 * Tracks call counts so tests can assert a rejected request never reached the
 * facilitator at all.
 */
function fakeFacilitator(opts: { feePayer?: string; verify?: VerifyMode; settle?: SettleMode } = {}) {
  const feePayer = opts.feePayer ?? DEFAULT_FEE_PAYER;
  const verify: VerifyMode = opts.verify ?? { isValid: false, invalidReason: "test_stub" };
  const settle: SettleMode = opts.settle ?? { success: false, errorReason: "test_stub" };
  const calls = { supported: 0, verify: 0, settle: 0 };
  const app = express();
  app.use(express.json());
  app.get("/supported", (_req, res) => {
    calls.supported++;
    res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer } }] });
  });
  app.post("/verify", (_req, res) => {
    calls.verify++;
    res.json(verify);
  });
  app.post("/settle", (_req, res) => {
    calls.settle++;
    res.json({ transaction: "", network: "hedera:testnet", ...settle });
  });
  const srv = app.listen(0);
  const port = (srv.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => srv.close() };
}

type ScanFn = (ids: string[]) => Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>;

async function mountRail(
  facilitatorUrl: string,
  opts: { onSettled?: (receipt: unknown, txId: string) => void; scan?: ScanFn; metrics?: Metrics } = {},
) {
  const config = loadConfig({
    PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "77".repeat(32), PQ_KEM_SEED: "88".repeat(64),
    GRAPH_STUDIO_API_KEY: "k", HEDERA_PAYTO_ACCOUNT_ID: PAYTO_ACCOUNT, HEDERA_OPERATOR_ID: "0.0.1",
    HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), HEDERA_FACILITATOR_URL: facilitatorUrl,
  });
  const keys = { sig: deriveSigningKeys(config.sigSeed), kem: deriveKemKeys(config.kemSeed) };
  const data = {
    catalog: async () => ({ protocols: [], erc4626Chains: [] }),
    scan: opts.scan ?? (async () => ({ vaults: [], sources: [] })),
    table: async () => ({ vaults: [], sources: [] }),
  };
  // mountHederaRail's own deps type carries `onSettled` (app.ts forwards BuildAppDeps
  // straight through by reference), which BuildAppDeps itself doesn't declare — typed
  // as a variable rather than an inline literal so this doesn't trip an excess-property
  // check on a field the production type genuinely doesn't have.
  const deps: BuildAppDeps & { onSettled?: (receipt: unknown, txId: string) => void } = {
    config, keys, data, hcs: null, nonces: new MemoryNonceStore(), rails: { hedera: true }, onSettled: opts.onSettled, metrics: opts.metrics,
  };
  const app = await buildApp(deps);
  const srv = app.listen(0);
  const port = (srv.address() as any).port;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

test("an unpaid scan request returns 402 with a payment-required header for $0.0015 at count 1", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify({ vaults: [] }),
    });
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = decodePaymentRequiredHeader(header!);
    expect(decoded.accepts[0].network).toBe("hedera:testnet");
    // hederaScanPriceUsd(1) = "0.0015" -> ExactHederaScheme.parsePrice's defaultMoneyConversion
    // -> convertToTokenAmount("0.0015", 6) = "1500" (traced against @x402/hedera 2.25.0's
    // compiled exact/server/index.js; matches hederaScanPriceAtomic(1) in @vaultradar/core).
    expect(decoded.accepts[0].amount).toBe("1500");
    expect(decoded.accepts[0].asset).toBe(TOKEN_ID);
  } finally {
    rail.close();
    fac.close();
  }
});

test("the scan price scales with X-VR-Count (count 5 -> $0.0035 -> atomic 3500)", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "5" }, body: JSON.stringify({ vaults: [] }),
    });
    expect(res.status).toBe(402);
    const decoded = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(decoded.accepts[0].amount).toBe("3500");
  } finally {
    rail.close();
    fac.close();
  }
});

test("the HBAR scan variant prices in tinybars: count 5 -> amount 5000000, asset 0.0.0", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/hedera/v1/scan-hbar`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "5" }, body: JSON.stringify({ vaults: [] }),
    });
    expect(res.status).toBe(402);
    const decoded = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(decoded.accepts[0].asset).toBe("0.0.0");
    expect(decoded.accepts[0].amount).toBe("5000000");
  } finally {
    rail.close();
    fac.close();
  }
});

test("the table route prices flat at TABLE_PRICE_USD regardless of X-VR-Count", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/hedera/v1/table`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: "erc4626", chainId: "1" }),
    });
    expect(res.status).toBe(402);
    const decoded = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    // TABLE_PRICE_USD = "0.06" -> convertToTokenAmount("0.06", 6) = "60000".
    expect(decoded.accepts[0].amount).toBe("60000");
  } finally {
    rail.close();
    fac.close();
  }
});

// A missing/invalid X-VR-Count and a malformed sealed envelope are now rejected by
// validateScanRequest — mounted before paymentMiddleware — as a plain 400, before
// payment processing (and therefore any facilitator call) ever starts. Previously
// these fell through to the price function's own throw, which @x402/express 2.25.0
// turns into a 500 (processHTTPRequest has no try/catch around resolving a route's
// dynamic `price` function); that finding is preserved in task-16-report.md.
test("a missing X-VR-Count returns 400 bad_count without ever calling the facilitator", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vaults: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "bad_count", error: "bad_count" });
    expect(fac.calls.verify).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("an out-of-range X-VR-Count returns 400 bad_count without ever calling the facilitator", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/hedera/v1/scan-hbar`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "0" }, body: JSON.stringify({ vaults: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "bad_count", error: "bad_count" });
    expect(fac.calls.verify).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("a body that claims to be a sealed envelope but fails isSealed returns 400 malformed_envelope without ever calling the facilitator", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify({ ct: "not-actually-sealed" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "malformed_envelope", error: "malformed_envelope" });
    expect(fac.calls.verify).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

// --- onAfterVerify / onAfterSettle / onSettleFailure: the paid path -----------------

const SCAN_BODY = JSON.stringify({ vaults: ["1:0xabababababababababababababababababababab"] });
const VERIFIED_PAYER = "0.0.4242"; // distinct from PAYER_ACCOUNT (0.0.1234, the transfer-decoded payer)
const SETTLED_TX = "0.0.4242@1700000000.000000001";

test("a verified and settled payment reaches the handler, returns 200 with a receipt, invokes onSettled exactly once, and empties both maps", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: VERIFIED_PAYER },
    settle: { success: true, transaction: SETTLED_TX, payer: VERIFIED_PAYER },
  });
  const settledCalls: [unknown, string][] = [];
  const rail = await mountRail(fac.url, { onSettled: (receipt, txId) => settledCalls.push([receipt, txId]) });
  try {
    const header = buildPaymentSignatureHeader();
    const res = await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "1", "payment-signature": header },
      body: SCAN_BODY,
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.receipt).toBeDefined();
    // The USDC-priced route: micro-USDC of the configured HTS token (TOKEN_ID is this
    // config's `hedera.usdcToken`), which is what this payer actually transferred.
    expect(j.receipt.price).toEqual({ amount: hederaScanPriceAtomic(1), asset: TOKEN_ID, rail: "hedera" });

    expect(settledCalls.length).toBe(1);
    // The settled tx id comes from the facilitator's settle response (ctx.result.transaction),
    // not from j.receipt.payment.txId — that field is the client-signed tx id decoded before
    // settlement ever runs (HandlerDeps.getTxId's contract in handlers/scan.ts), which for
    // this fixture is a different, freshly-generated Hedera transaction id. Both identify
    // the same real transaction on Hedera; they're just captured at two different times.
    expect(settledCalls[0][1]).toBe(SETTLED_TX);
    expect(settledCalls[0][0]).toEqual(j.receipt);

    expect(_mapSizesForTests()).toEqual({ payer: 0, receipt: 0 });
  } finally {
    rail.close();
    fac.close();
  }
});

// The HBAR-priced scan route charges tinybars of native HBAR, but the receipt used to be
// built from the rail and tier alone — so it stated micro-USDC of the configured USDC
// token. A payer who spent 2,000,000 tinybars got a signed, HCS-committed receipt reading
// `amount: "2000", asset: "0.0.429274"`, and an auditor reading it would conclude USDC was
// paid. The receipt's price now comes from the mount, which is the only thing that knows
// what the route charges.
test("a paid HBAR scan's receipt states tinybars of HBAR, not micro-USDC", async () => {
  const vaults = [
    "1:0xabababababababababababababababababababab",
    "1:0xacacacacacacacacacacacacacacacacacacacac",
  ];
  const tinybars = vaults.length * 1_000_000;
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: VERIFIED_PAYER },
    settle: { success: true, transaction: SETTLED_TX, payer: VERIFIED_PAYER },
  });
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/hedera/v1/scan-hbar`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vr-count": String(vaults.length),
        "payment-signature": buildHbarPaymentSignatureHeader(tinybars),
      },
      body: JSON.stringify({ vaults }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    // Exactly what the 402 demanded and the payer signed for.
    expect(j.receipt.price).toEqual({ amount: String(tinybars), asset: "0.0.0", rail: "hedera" });
    expect(fac.calls.settle).toBe(1);
  } finally {
    rail.close();
    fac.close();
  }
});

// Finding 2, fix round 1: recordSettlement previously ran ahead of (not inside) any
// try/catch in onAfterSettle, so a throw from it would have skipped the receipt
// correlation and onSettled below — silently dropping the HCS commitment for an
// already-settled payment. It's now wrapped in its own dedicated try/catch specifically
// so this can't happen regardless of what recordSettlement's implementation does.
test("a metrics.recordSettlement that throws does not suppress onSettled or the map cleanup", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: VERIFIED_PAYER },
    settle: { success: true, transaction: SETTLED_TX, payer: VERIFIED_PAYER },
  });
  class ThrowingMetrics extends Metrics {
    recordSettlement(): never {
      throw new Error("boom");
    }
  }
  const settledCalls: [unknown, string][] = [];
  const rail = await mountRail(fac.url, { onSettled: (receipt, txId) => settledCalls.push([receipt, txId]), metrics: new ThrowingMetrics() });
  try {
    const header = buildPaymentSignatureHeader();
    const res = await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "1", "payment-signature": header },
      body: SCAN_BODY,
    });
    expect(res.status).toBe(200);
    expect(settledCalls.length).toBe(1);
    expect(settledCalls[0][1]).toBe(SETTLED_TX);
    expect(_mapSizesForTests()).toEqual({ payer: 0, receipt: 0 });
  } finally {
    rail.close();
    fac.close();
  }
});

test("a failed settle after a successful verify does not invoke onSettled, and both maps are cleaned up via onSettleFailure", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: VERIFIED_PAYER },
    settle: { success: false, errorReason: "test_stub" },
  });
  const settledCalls: unknown[] = [];
  const rail = await mountRail(fac.url, { onSettled: (...args) => settledCalls.push(args) });
  try {
    const header = buildPaymentSignatureHeader();
    await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "1", "payment-signature": header },
      body: SCAN_BODY,
    });
    expect(settledCalls.length).toBe(0);
    expect(_mapSizesForTests()).toEqual({ payer: 0, receipt: 0 });
  } finally {
    rail.close();
    fac.close();
  }
});

test("hederaPayerFromRequest prefers the facilitator-verified payer over the transfer-decoded one", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: VERIFIED_PAYER },
    settle: { success: true, transaction: SETTLED_TX, payer: VERIFIED_PAYER },
  });
  const header = buildPaymentSignatureHeader(); // transfer-decoded payer would be PAYER_ACCOUNT ("0.0.1234")
  let capturedPayer: string | null | undefined;
  // data.scan runs inside the handler, strictly between the middleware's verify step
  // (which has already populated the payer map by the time the handler is dispatched)
  // and its settle step (which only runs after the handler's response is fully
  // written) — the one window where the map genuinely holds a value to prefer over
  // the transfer-decoded fallback. A minimal object with just `.header()` stands in
  // for the Express Request here since hederaPayerFromRequest only ever calls that.
  const rail = await mountRail(fac.url, {
    scan: async () => {
      const fakeReq = { header: (name: string) => (name === "payment-signature" ? header : undefined) } as unknown as express.Request;
      capturedPayer = hederaPayerFromRequest(fakeReq);
      return { vaults: [], sources: [] };
    },
  });
  try {
    const res = await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "1", "payment-signature": header },
      body: SCAN_BODY,
    });
    expect(res.status).toBe(200);
    expect(capturedPayer).toBe(VERIFIED_PAYER);
    expect(capturedPayer).not.toBe(PAYER_ACCOUNT);
  } finally {
    rail.close();
    fac.close();
  }
});

// --- clear-mode count binding -------------------------------------------------------
//
// `X-VR-Count` is what the route is priced on and `request.vaults` is what the handler
// works on, so a clear body must not be able to name more vaults than it paid for. The
// sealed path always checked this (`checkSealedRequest`'s count check); the clear path did
// not, so `X-VR-Count: 1` with a hundred vaults in the body bought a hundred vaults of
// upstream work for the one-vault price. On this rail @x402/express settles only after a
// 2xx, so the handler's own 422 is itself pre-settlement — which is what the facilitator's
// settle count asserts below.
//
// Placed last in this file on purpose: the mismatch test verifies a payment the request
// then refuses, so no settle/settle-failure hook ever fires for it and its entry stays in
// `verifiedPayerByTxKey` until the 10-minute TTL sweeps it. That is the documented
// abandoned-request case (see the TTL comment in rails/hedera.ts), not a regression — but
// the maps are module-level, so running this before the `_mapSizesForTests` assertions
// above would make them fail on a leak they are not about.

test("a clear scan body whose vault count disagrees with X-VR-Count is refused 422 count_mismatch, and never settles", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: VERIFIED_PAYER },
    settle: { success: true, transaction: SETTLED_TX, payer: VERIFIED_PAYER },
  });
  const scanCalls: string[][] = [];
  const rail = await mountRail(fac.url, { scan: async ids => { scanCalls.push(ids); return { vaults: [], sources: [] }; } });
  try {
    // Paid for one vault (the payment header carries amount 1500 = count 1), asked for three.
    const res = await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "1", "payment-signature": buildPaymentSignatureHeader() },
      body: JSON.stringify({
        vaults: [
          "1:0xabababababababababababababababababababab",
          "1:0xacacacacacacacacacacacacacacacacacacacac",
          "1:0xadadadadadadadadadadadadadadadadadadadad",
        ],
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ reason: "count_mismatch", error: "count_mismatch" });
    // No upstream work for the under-paid request...
    expect(scanCalls).toEqual([]);
    // ...and the 4xx meant the verified payment was never settled, so nothing was charged.
    expect(fac.calls.verify).toBe(1);
    expect(fac.calls.settle).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("a clear scan body whose count matches X-VR-Count still completes and settles", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: VERIFIED_PAYER },
    settle: { success: true, transaction: SETTLED_TX, payer: VERIFIED_PAYER },
  });
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/hedera/v1/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "1", "payment-signature": buildPaymentSignatureHeader() },
      body: SCAN_BODY,
    });
    expect(res.status).toBe(200);
    expect(fac.calls.settle).toBe(1);
  } finally {
    rail.close();
    fac.close();
  }
});
