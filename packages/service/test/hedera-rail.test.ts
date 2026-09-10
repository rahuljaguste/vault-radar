import { expect, test } from "bun:test";
import express from "express";
import { TransferTransaction, TransactionId, AccountId, TokenId } from "@x402/hedera";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { deriveKemKeys, deriveSigningKeys, MemoryNonceStore } from "@vaultradar/core";
import { decodeHederaPayment, hederaPayerFromRequest, hederaTxIdFromRequest } from "../src/rails/hedera";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";

const TOKEN_ID = "0.0.429274";
const PAYER_ACCOUNT = "0.0.1234";
const PAYTO_ACCOUNT = "0.0.5678";
// Deliberately a different account than PAYER_ACCOUNT: in the x402 Hedera exact scheme
// the transaction id's embedded account is the fee payer (the facilitator), never the
// business payer, so a test where they coincide couldn't tell decodeHederaPayment's
// transfer-based derivation apart from a (wrong) transactionId-based one.
const FEE_PAYER_ACCOUNT = "0.0.999";

/** Builds a `payment-signature` header value carrying a real, freeze-able Hedera transfer. */
function buildPaymentSignatureHeader(payerAccount = PAYER_ACCOUNT): string {
  const tx = new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(TOKEN_ID), AccountId.fromString(payerAccount), -1500)
    .addTokenTransfer(TokenId.fromString(TOKEN_ID), AccountId.fromString(PAYTO_ACCOUNT), 1500)
    .setTransactionId(TransactionId.generate(AccountId.fromString(FEE_PAYER_ACCOUNT)))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .freeze();
  const transactionB64 = Buffer.from(tx.toBytes()).toString("base64");
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: { scheme: "exact", network: "hedera:testnet", asset: TOKEN_ID, amount: "1500", payTo: PAYTO_ACCOUNT, maxTimeoutSeconds: 120, extra: {} },
    payload: { transaction: transactionB64 },
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

/**
 * A minimal x402 facilitator: /supported succeeds, /verify and /settle report failure.
 * Tracks call counts so tests can assert a rejected request never reached the
 * facilitator at all (see the two 400-path tests below).
 */
function fakeFacilitator(feePayer = "0.0.7162784") {
  const calls = { supported: 0, verify: 0, settle: 0 };
  const app = express();
  app.use(express.json());
  app.get("/supported", (_req, res) => {
    calls.supported++;
    res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer } }] });
  });
  app.post("/verify", (_req, res) => {
    calls.verify++;
    res.json({ isValid: false, invalidReason: "test_stub" });
  });
  app.post("/settle", (_req, res) => {
    calls.settle++;
    res.json({ success: false, transaction: "", network: "hedera:testnet", errorReason: "test_stub" });
  });
  const srv = app.listen(0);
  const port = (srv.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => srv.close() };
}

async function mountRail(facilitatorUrl: string) {
  const config = loadConfig({
    PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "77".repeat(32), PQ_KEM_SEED: "88".repeat(64),
    GRAPH_STUDIO_API_KEY: "k", HEDERA_PAYTO_ACCOUNT_ID: PAYTO_ACCOUNT, HEDERA_OPERATOR_ID: "0.0.1",
    HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), HEDERA_FACILITATOR_URL: facilitatorUrl,
  });
  const keys = { sig: deriveSigningKeys(config.sigSeed), kem: deriveKemKeys(config.kemSeed) };
  const data = {
    catalog: async () => ({ protocols: [], erc4626Chains: [] }),
    scan: async () => ({ vaults: [], sources: [] }),
    table: async () => ({ vaults: [], sources: [] }),
  };
  const app = await buildApp({ config, keys, data, hcs: null, nonces: new MemoryNonceStore(), rails: { hedera: true } });
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
    // TABLE_PRICE_USD = "0.03" -> convertToTokenAmount("0.03", 6) = "30000".
    expect(decoded.accepts[0].amount).toBe("30000");
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
    expect(await res.json()).toEqual({ reason: "bad_count" });
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
    expect(await res.json()).toEqual({ reason: "bad_count" });
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
    expect(await res.json()).toEqual({ reason: "malformed_envelope" });
    expect(fac.calls.verify).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});
