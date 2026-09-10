import { expect, test } from "bun:test";
import express from "express";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { buildSealedRequest, deriveKemKeys, deriveSigningKeys, MemoryNonceStore, open, type SourceRef, type UnifiedVault } from "@vaultradar/core";
import { arcPayerFromRequest, arcTxIdFromRequest } from "../src/rails/arc";
import { buildApp, type BuildAppDeps } from "../src/app";
import { loadConfig } from "../src/config";
import { Metrics } from "../src/metrics";

const SELLER_ADDRESS = "0x" + "1".repeat(40);
// Any syntactically valid address works here: `signAuthorization` (client-side) only
// runs `viem.getAddress()` on it, which just needs a well-formed 20-byte hex string —
// nothing here is ever mined on a real chain.
const VERIFYING_CONTRACT = "0x" + "2".repeat(40);
const USDC_ADDRESS = "0x" + "3".repeat(40);
const ARC_NETWORK = "eip155:5042002";
// Throwaway local key, used only to sign an EIP-712 authorization entirely offline
// (viem's `signTypedData` needs no network access) — never funded, never touches a
// real chain.
const TEST_PRIVATE_KEY = ("0x" + "ab".repeat(32)) as `0x${string}`;
/** One well-formed vault id, for clear bodies that must agree with `X-VR-Count: 1` —
 * `preValidateClearCount` refuses a body whose list length disagrees with the header it
 * is priced on, so `{ vaults: [] }` is no longer a valid stand-in at count 1. */
const ONE_VAULT = "1:0xabababababababababababababababababababab";

type VerifyMode = { isValid: boolean; payer?: string; invalidReason?: string };
type SettleMode = { success: boolean; transaction?: string; payer?: string; errorReason?: string };

/**
 * A minimal Circle Gateway facilitator, hitting the exact paths
 * `@circle-fin/x402-batching` 3.4.0's compiled `dist/server/index.js` calls
 * (`BatchFacilitatorClient.callVerify`/`callSettle`/`getSupported`): `GET
 * /v1/x402/supported`, `POST /v1/x402/verify`, `POST /v1/x402/settle` — distinct from
 * the Hedera rail's facilitator paths (`/supported`, `/verify`, `/settle` with no
 * `/v1/x402` prefix; see hedera-rail.test.ts's `fakeFacilitator`). `/verify` and
 * `/settle` default to a clean failure so most tests here never reach the paid path.
 * Tracks call counts so a rejected request can be asserted to have never reached the
 * facilitator at all.
 */
function fakeFacilitator(opts: { verify?: VerifyMode; settle?: SettleMode } = {}) {
  const verify: VerifyMode = opts.verify ?? { isValid: false, invalidReason: "test_stub" };
  const settle: SettleMode = opts.settle ?? { success: false, errorReason: "test_stub" };
  const calls = { supported: 0, verify: 0, settle: 0 };
  const app = express();
  app.use(express.json());
  app.get("/v1/x402/supported", (_req, res) => {
    calls.supported++;
    // `getAcceptedNetworks` requires `extra.verifyingContract` truthy; `getUsdcAddress`
    // separately requires `extra.assets` to contain a `symbol: "USDC"` entry — both are
    // needed before Circle's middleware will construct a payment requirement at all
    // (traced in dist/server/index.js's `getAcceptedNetworks`/`getUsdcAddress`).
    res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: ARC_NETWORK, extra: { verifyingContract: VERIFYING_CONTRACT, assets: [{ symbol: "USDC", address: USDC_ADDRESS }] } }],
      extensions: [],
      signers: {},
    });
  });
  app.post("/v1/x402/verify", (_req, res) => {
    calls.verify++;
    res.json(verify);
  });
  app.post("/v1/x402/settle", (_req, res) => {
    calls.settle++;
    res.json(settle.success ? { success: true, transaction: settle.transaction ?? "", network: ARC_NETWORK, payer: settle.payer } : { success: false, errorReason: settle.errorReason });
  });
  const srv = app.listen(0);
  const port = (srv.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => srv.close() };
}

type ScanFn = (ids: string[]) => Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>;

async function mountRail(facilitatorUrl: string, opts: { onSettled?: (receipt: unknown, txId: string) => void; scan?: ScanFn; metrics?: Metrics } = {}) {
  const config = loadConfig({
    PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "77".repeat(32), PQ_KEM_SEED: "88".repeat(64),
    GRAPH_STUDIO_API_KEY: "k", ARC_SELLER_ADDRESS: SELLER_ADDRESS, ARC_FACILITATOR_URL: facilitatorUrl,
  });
  const keys = { sig: deriveSigningKeys(config.sigSeed), kem: deriveKemKeys(config.kemSeed) };
  const data = {
    catalog: async () => ({ protocols: [], erc4626Chains: [] }),
    scan: opts.scan ?? (async () => ({ vaults: [], sources: [] })),
    table: async () => ({ vaults: [], sources: [] }),
  };
  // mountArcRail's own deps type carries `onSettled` (app.ts forwards BuildAppDeps
  // straight through by reference, same as the Hedera rail), which BuildAppDeps itself
  // doesn't declare — typed as a variable rather than an inline literal so this doesn't
  // trip an excess-property check on a field the production type genuinely doesn't have.
  const deps: BuildAppDeps & { onSettled?: (receipt: unknown, txId: string) => void } = {
    config, keys, data, hcs: null, nonces: new MemoryNonceStore(), rails: { arc: true }, onSettled: opts.onSettled, metrics: opts.metrics,
  };
  const app = await buildApp(deps);
  const srv = app.listen(0);
  const port = (srv.address() as any).port;
  return { base: `http://127.0.0.1:${port}`, keys, close: () => srv.close() };
}

/** Manually decodes a base64-JSON header, rather than `@x402/core/http`'s
 * `decodePaymentRequiredHeader` (used for the Hedera rail's equivalent test): Circle's
 * Gateway middleware builds this header itself (`dist/server/index.js`'s `require()`,
 * `Buffer.from(JSON.stringify(paymentRequired)).toString("base64")`) rather than going
 * through `@x402/core`'s own encoder, and this test has no need to assert the two are
 * schema-identical — only that this service's mounted rail produces what Circle's own
 * client (used below) already knows how to consume. */
function decodeB64Json(header: string): any {
  return JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
}

test("an unpaid scan request returns 402 with a payment-required header advertising eip155:5042002", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/arc/v1/scan/s`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify({ vaults: [ONE_VAULT] }),
    });
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const decoded = decodeB64Json(header!);
    expect(decoded.accepts[0].network).toBe(ARC_NETWORK);
    expect(fac.calls.verify).toBe(0);
    expect(fac.calls.settle).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("a missing X-VR-Count returns 400 bad_count (with an error alias) without ever calling the facilitator", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/arc/v1/scan/s`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vaults: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "bad_count", error: "bad_count" });
    expect(fac.calls.supported).toBe(0);
    expect(fac.calls.verify).toBe(0);
    expect(fac.calls.settle).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("an out-of-range X-VR-Count returns 400 bad_count without ever calling the facilitator", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/arc/v1/scan/m`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "0" }, body: JSON.stringify({ vaults: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "bad_count", error: "bad_count" });
    expect(fac.calls.supported).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("a count outside the route's bucket returns 422 bucket_mismatch without ever calling the facilitator", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    // count 10 belongs to bucket "m" (6-20), not "s" (1-5).
    const res = await fetch(`${rail.base}/arc/v1/scan/s`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "10" }, body: JSON.stringify({ vaults: [] }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ reason: "bucket_mismatch", error: "bucket_mismatch" });
    expect(fac.calls.supported).toBe(0);
    expect(fac.calls.verify).toBe(0);
    expect(fac.calls.settle).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("the table route has no bucket check and reaches the facilitator for a valid unpaid request", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/arc/v1/table`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: "erc4626", chainId: "1" }),
    });
    expect(res.status).toBe(402);
    expect(fac.calls.supported).toBe(1);
  } finally {
    rail.close();
    fac.close();
  }
});

// --- sealed-envelope pre-payment checks (Finding 1, fix round 1) -------------------
//
// checkSealedRequestPrePayment runs from a middleware mounted ahead of
// gateway.require — see rails/arc.ts's preValidateSealed — so any of these violations
// must 422 without ever reaching the (fake) facilitator, exactly like the
// bad_count/bucket_mismatch tests above.

test("a sealed request with a stale ts is rejected 422 ts_window before any facilitator call", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const staleNow = Math.floor(Date.now() / 1000) - 1000; // TS_WINDOW_S is 120
    const { sealed } = buildSealedRequest({ vaults: ["1:0xabababababababababababababababababababab"] }, "0xanypayer", rail.keys.kem.publicKey, staleNow);
    const res = await fetch(`${rail.base}/arc/v1/scan/s`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify(sealed),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ reason: "ts_window", error: "ts_window" });
    expect(fac.calls.supported).toBe(0);
    expect(fac.calls.verify).toBe(0);
    expect(fac.calls.settle).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("a sealed envelope whose own vault count disagrees with X-VR-Count is rejected 422 count_mismatch before any facilitator call", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    // One vault sealed inside the envelope, but the header (still a valid "s"-bucket
    // value on its own) claims three — validateBucket alone can't catch this since it
    // only ever looks at the header.
    const { sealed } = buildSealedRequest({ vaults: ["1:0xabababababababababababababababababababab"] }, "0xanypayer", rail.keys.kem.publicKey);
    const res = await fetch(`${rail.base}/arc/v1/scan/s`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "3" }, body: JSON.stringify(sealed),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ reason: "count_mismatch", error: "count_mismatch" });
    expect(fac.calls.supported).toBe(0);
    expect(fac.calls.verify).toBe(0);
    expect(fac.calls.settle).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

// --- clear-body count binding (pre-payment, because this rail settles first) --------
//
// `validateBucket` only reads the header, so a clear body could name any number of vaults
// inside a bucket-valid `X-VR-Count` and get them all for the bucket price. Circle settles
// inside `gateway.require` — before any handler runs — so the handler's own
// `count_mismatch` would land after the money moved; `preValidateClearCount` is mounted
// ahead of `gateway.require` for exactly that reason, which is what the facilitator call
// counts below assert.

test("a clear scan body whose vault count disagrees with X-VR-Count is rejected 422 count_mismatch before any facilitator call", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: "0xtestpayer" },
    settle: { success: true, transaction: "0xshouldnothappen", payer: "0xtestpayer" },
  });
  const scanCalls: string[][] = [];
  const rail = await mountRail(fac.url, { scan: async ids => { scanCalls.push(ids); return { vaults: [], sources: [] }; } });
  try {
    // Count 3 is a valid "s"-bucket value, so validateBucket passes it; the body names
    // five vaults, which is also in the "s" bucket — the mismatch is the whole point.
    const res = await fetch(`${rail.base}/arc/v1/scan/s`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "3" },
      body: JSON.stringify({
        vaults: [
          "1:0xabababababababababababababababababababab",
          "1:0xacacacacacacacacacacacacacacacacacacacac",
          "1:0xadadadadadadadadadadadadadadadadadadadad",
          "1:0xaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae",
          "1:0xafafafafafafafafafafafafafafafafafafafaf",
        ],
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ reason: "count_mismatch", error: "count_mismatch" });
    expect(scanCalls).toEqual([]);
    expect(fac.calls.supported).toBe(0);
    expect(fac.calls.verify).toBe(0);
    expect(fac.calls.settle).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("a clear scan body whose count matches X-VR-Count still reaches the facilitator", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/arc/v1/scan/s`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "1" },
      body: JSON.stringify({ vaults: ["1:0xabababababababababababababababababababab"] }),
    });
    expect(res.status).toBe(402); // unpaid, so the 402 is the expected answer
    expect(fac.calls.supported).toBe(1);
  } finally {
    rail.close();
    fac.close();
  }
});

test("a clear table body is unaffected by the count check, since a table has no count", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const res = await fetch(`${rail.base}/arc/v1/table`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vr-count": "99" },
      body: JSON.stringify({ protocol: "erc4626", chainId: "1" }),
    });
    expect(res.status).toBe(402);
    expect(fac.calls.supported).toBe(1);
  } finally {
    rail.close();
    fac.close();
  }
});

test("a corrupted sealed envelope is rejected 422 envelope_open_failed before any facilitator call", async () => {
  const fac = fakeFacilitator();
  const rail = await mountRail(fac.url);
  try {
    const { sealed } = buildSealedRequest({ vaults: ["1:0xabababababababababababababababababababab"] }, "0xanypayer", rail.keys.kem.publicKey);
    const tampered = { ...sealed, nonce: "A".repeat(sealed.nonce.length) }; // same length, guaranteed-different: GCM tag no longer verifies
    const res = await fetch(`${rail.base}/arc/v1/scan/s`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify(tampered),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ reason: "envelope_open_failed", error: "envelope_open_failed" });
    expect(fac.calls.supported).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

test("a sealed request's nonce, once committed by a successful paid round trip, is rejected as a replay on resubmission — with no further facilitator calls", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: "0xtestpayer" },
    settle: { success: true, transaction: "0xfirsttx", payer: "0xtestpayer" },
  });
  const rail = await mountRail(fac.url);
  try {
    const { sealed } = buildSealedRequest({ vaults: ["1:0xabababababababababababababababababababab"] }, "0xtestpayer", rail.keys.kem.publicKey);

    const gw = new GatewayClient({ chain: "arcTestnet", privateKey: TEST_PRIVATE_KEY });
    const first = await gw.pay<{ receipt: unknown }>(`${rail.base}/arc/v1/scan/s`, {
      method: "POST", body: sealed, headers: { "x-vr-count": "1" },
    });
    expect(first.status).toBe(200);
    expect(fac.calls.verify).toBe(1);
    expect(fac.calls.settle).toBe(1);

    // Resubmit the identical sealed envelope. Rejected by the pre-payment middleware —
    // no payment-signature header needed for this call to prove the point, since
    // preValidateSealed runs (and, here, rejects) before gateway.require is ever reached.
    const replay = await fetch(`${rail.base}/arc/v1/scan/s`, {
      method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify(sealed),
    });
    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual({ reason: "nonce_replay", error: "nonce_replay" });
    expect(fac.calls.verify).toBe(1); // unchanged
    expect(fac.calls.settle).toBe(1); // unchanged
  } finally {
    rail.close();
    fac.close();
  }
});

test("a valid sealed request still completes the full paid round trip and replies sealed", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: "0xtestpayer" },
    settle: { success: true, transaction: "0xsealedtx", payer: "0xtestpayer" },
  });
  const rail = await mountRail(fac.url);
  try {
    const { sealed, replySecret } = buildSealedRequest({ vaults: ["1:0xabababababababababababababababababababab"] }, "0xtestpayer", rail.keys.kem.publicKey);
    const gw = new GatewayClient({ chain: "arcTestnet", privateKey: TEST_PRIVATE_KEY });
    const result = await gw.pay<{ sealed: unknown; receipt: unknown }>(`${rail.base}/arc/v1/scan/s`, {
      method: "POST", body: sealed, headers: { "x-vr-count": "1" },
    });
    expect(result.status).toBe(200);
    expect(result.data.receipt).toBeDefined();
    expect((result.data.receipt as any).sealed).toBe(true);
    const opened = open<{ vaults: unknown[] }>(result.data.sealed as any, replySecret);
    expect(Array.isArray(opened.vaults)).toBe(true);
  } finally {
    rail.close();
    fac.close();
  }
});

// --- the paid path: a real (offline) Gateway client round trip ---------------------
//
// `GatewayClient.pay()` and the `BatchEvmScheme` it delegates to sign the EIP-3009
// authorization with pure local EIP-712 signing (viem's `signTypedData` on a
// `privateKeyToAccount` signer) — confirmed against the compiled
// `dist/client/index.js`'s `createPaymentPayload`/`signAuthorization`, which never call
// out to an RPC. The only network calls `pay()` makes are the two HTTP round trips to
// the URL it's paying (this test's mounted rail) — so a fully real client, real
// signature, and real (if fake) facilitator round trip is practical entirely offline,
// with no chain, faucet, or live Gateway account needed.

test("a verified and settled Arc payment reaches the handler, returns 200 with a receipt, and fires onSettled", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: undefined },
    settle: { success: true, transaction: "0xdeadbeef", payer: undefined },
  });
  const settledCalls: [unknown, string][] = [];
  const rail = await mountRail(fac.url, { onSettled: (r, t) => settledCalls.push([r, t]) });
  try {
    const gw = new GatewayClient({ chain: "arcTestnet", privateKey: TEST_PRIVATE_KEY });
    const result = await gw.pay<{ receipt: unknown }>(`${rail.base}/arc/v1/scan/s`, {
      method: "POST",
      body: { vaults: ["1:0xabababababababababababababababababababab"] },
      headers: { "x-vr-count": "1" },
    });

    expect(result.status).toBe(200);
    expect(result.transaction).toBe("0xdeadbeef");
    expect(result.data.receipt).toBeDefined();
    expect(fac.calls.verify).toBe(1);
    expect(fac.calls.settle).toBe(1);

    expect(settledCalls.length).toBe(1);
    expect(settledCalls[0][1]).toBe("0xdeadbeef");
    expect(settledCalls[0][0]).toEqual(result.data.receipt);
  } finally {
    rail.close();
    fac.close();
  }
});

// Finding 2, fix round 1: recordSettlement previously ran directly in the route
// wrapper, ahead of `await handler(...)`, with no isolation of its own — a throw there
// would have propagated through asyncHandler to the app's error handler, turning an
// already-settled (already-paid) request into a 500. It's now wrapped in its own
// dedicated try/catch specifically so this can't happen regardless of what
// recordSettlement's implementation does.
test("a metrics.recordSettlement that throws does not turn an already-paid request into a 500", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: undefined },
    settle: { success: true, transaction: "0xthrown", payer: undefined },
  });
  class ThrowingMetrics extends Metrics {
    recordSettlement(): never {
      throw new Error("boom");
    }
  }
  const settledCalls: [unknown, string][] = [];
  const rail = await mountRail(fac.url, { onSettled: (r, t) => settledCalls.push([r, t]), metrics: new ThrowingMetrics() });
  try {
    const gw = new GatewayClient({ chain: "arcTestnet", privateKey: TEST_PRIVATE_KEY });
    const result = await gw.pay<{ receipt: unknown }>(`${rail.base}/arc/v1/scan/s`, {
      method: "POST",
      body: { vaults: ["1:0xabababababababababababababababababababab"] },
      headers: { "x-vr-count": "1" },
    });
    expect(result.status).toBe(200);
    expect(result.data.receipt).toBeDefined();
    expect(settledCalls.length).toBe(1);
    expect(settledCalls[0][1]).toBe("0xthrown");
  } finally {
    rail.close();
    fac.close();
  }
});

test("a failed settle after a successful verify never reaches the handler and never fires onSettled", async () => {
  const fac = fakeFacilitator({
    verify: { isValid: true, payer: undefined },
    settle: { success: false, errorReason: "insufficient_balance" },
  });
  const settledCalls: unknown[] = [];
  const rail = await mountRail(fac.url, { onSettled: (...args) => settledCalls.push(args) });
  try {
    const gw = new GatewayClient({ chain: "arcTestnet", privateKey: TEST_PRIVATE_KEY });
    await expect(
      gw.pay(`${rail.base}/arc/v1/scan/s`, { method: "POST", body: { vaults: [ONE_VAULT] }, headers: { "x-vr-count": "1" } }),
    ).rejects.toThrow();
    expect(settledCalls.length).toBe(0);
  } finally {
    rail.close();
    fac.close();
  }
});

// --- arcPayerFromRequest / arcTxIdFromRequest ---------------------------------------

test("arcPayerFromRequest / arcTxIdFromRequest read off req.payment, with sensible defaults when absent", () => {
  const noPayment = { payment: undefined } as any;
  expect(arcPayerFromRequest(noPayment)).toBeNull();
  expect(arcTxIdFromRequest(noPayment)).toBe("gateway-batch");

  const withPayment = { payment: { verified: true, payer: "0xpayer", amount: "3000", network: ARC_NETWORK, transaction: "0xtx" } } as any;
  expect(arcPayerFromRequest(withPayment)).toBe("0xpayer");
  expect(arcTxIdFromRequest(withPayment)).toBe("0xtx");
});
