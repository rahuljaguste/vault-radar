import type { Express, Request, Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { extractTransactionFromPayload, inspectHederaTransaction, type ExactHederaPayloadV2 } from "@x402/hedera";
import { clampCount, hederaScanPriceUsd, isSealed, TABLE_PRICE_USD, type Receipt } from "@vaultradar/core";
import { makeScanHandler, type HandlerDeps } from "../handlers/scan";
import { asyncHandler } from "../util/async";

type Decoded = { payer: string | null; txId: string | null };

/**
 * Payer the facilitator itself verified during x402's verify step, keyed by the base64
 * transaction string inside the client's payload. ExactHederaScheme's payment flow is
 * "authorization" (its only default), which verifies before the route handler ever
 * runs (confirmed in @x402/core's x402ResourceServer.verifyPayment doc comment and
 * ExactHederaScheme.paymentFlows in @x402/hedera/exact/server) — so onAfterVerify below
 * always populates this before decodeHederaPayment is asked for a payer on the same
 * request. Preferred over this module's own transfer-list derivation because the
 * facilitator has already checked the payer actually signed the transaction
 * (FacilitatorHederaSigner.verifyPayerSignature); this module's fallback has not.
 */
const verifiedPayerByTxKey = new Map<string, string>();

/**
 * Receipts awaiting settlement observation, keyed the same way. Filled by the route
 * wrapper in mountTier right after the scan/table handler resolves (from
 * res.locals.receipt), consumed by onAfterSettle below.
 *
 * Safe without a lock, despite both writes happening from async continuations: the
 * x402 Express middleware buffers res.end and only calls the facilitator's real
 * /settle endpoint (a genuine network fetch) after that buffered end fires — which is
 * the same event that unblocks the route wrapper's `await handler(req, res)` here.
 * Node/Bun drain all queued microtasks (including the wrapper's continuation that
 * calls receiptByTxKey.set) before any I/O-driven callback such as a fetch response
 * runs, so the receipt is always stored before onAfterSettle can possibly look it up.
 */
const receiptByTxKey = new Map<string, Receipt>();

const decodedCache = new WeakMap<Request, Decoded>();

/** Extracts the base64 transaction string from the request's payment header, or null. */
function txKeyFromRequest(req: Request): string | null {
  const header = req.header("payment-signature") ?? req.header("x-payment");
  if (!header) return null;
  try {
    const { payload } = decodePaymentSignatureHeader(header);
    return extractTransactionFromPayload(payload as unknown as ExactHederaPayloadV2);
  } catch {
    return null;
  }
}

/** First account with a negative (debit) amount in a transfer list, or null. */
function payerFromTransfers(entries: { accountId: string; amount: string }[]): string | null {
  for (const e of entries) if (BigInt(e.amount) < 0n) return e.accountId;
  return null;
}

/**
 * Decodes payer + tx id for the current request from the `payment-signature` (or
 * `x-payment`) header. Cached per request since makeScanHandler calls both
 * hederaPayerFromRequest and hederaTxIdFromRequest on the same request.
 *
 * Never throws: a missing or malformed payment header just yields both fields null,
 * which the caller (makeScanHandler) turns into a 422 `payer_unknown` — a request-path
 * concern, not something this decoder should raise as an exception.
 */
export function decodeHederaPayment(req: Request): Decoded {
  const hit = decodedCache.get(req);
  if (hit) return hit;
  let out: Decoded = { payer: null, txId: null };
  try {
    const b64 = txKeyFromRequest(req);
    if (b64) {
      const inspected = inspectHederaTransaction(b64);
      let payer = verifiedPayerByTxKey.get(b64) ?? null;
      if (!payer) {
        for (const transfers of Object.values(inspected.tokenTransfers)) {
          payer = payerFromTransfers(transfers);
          if (payer) break;
        }
      }
      if (!payer) payer = payerFromTransfers(inspected.hbarTransfers);
      out = { payer, txId: inspected.transactionId };
    }
  } catch {
    /* malformed transaction bytes or payload shape: leave both fields null */
  }
  decodedCache.set(req, out);
  return out;
}

export const hederaPayerFromRequest = (req: Request): string | null => decodeHederaPayment(req).payer;
export const hederaTxIdFromRequest = (req: Request): string | null => decodeHederaPayment(req).txId;

export function mountHederaRail(
  app: Express,
  deps: Omit<HandlerDeps, "rail" | "tier" | "getPayer" | "getTxId"> & {
    /** Fires once settlement completes for a request this rail already answered 200 for. */
    onSettled?: (receipt: Receipt, txId: string) => void;
  },
): void {
  const c = deps.config;
  const facilitator = new HTTPFacilitatorClient({ url: c.hedera.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register("hedera:testnet", new ExactHederaScheme());

  server.onAfterVerify(async ctx => {
    const payer = ctx.result.payer;
    if (!payer) return;
    try {
      const b64 = extractTransactionFromPayload(ctx.paymentPayload.payload as unknown as ExactHederaPayloadV2);
      verifiedPayerByTxKey.set(b64, payer);
    } catch {
      /* not an exact-Hedera payload; nothing to key on */
    }
  });

  server.onAfterSettle(async ctx => {
    try {
      const b64 = extractTransactionFromPayload(ctx.paymentPayload.payload as unknown as ExactHederaPayloadV2);
      const receipt = receiptByTxKey.get(b64);
      verifiedPayerByTxKey.delete(b64);
      receiptByTxKey.delete(b64);
      if (receipt) deps.onSettled?.(receipt, ctx.result.transaction);
    } catch {
      /* not an exact-Hedera payload; nothing to correlate */
    }
  });

  const validateEnvelope = (ctx: HTTPRequestContext) => {
    const b = ctx.adapter.getBody?.();
    if (b && typeof b === "object" && ("ct" in b || "kem" in b) && !isSealed(b)) throw new Error("malformed sealed envelope");
  };
  const countFromCtx = (ctx: HTTPRequestContext): number => {
    const n = clampCount(ctx.adapter.getHeader("x-vr-count"));
    if (!n) throw new Error("X-VR-Count must be 1..100");
    return n;
  };
  const scanPrice = (ctx: HTTPRequestContext) => {
    validateEnvelope(ctx);
    return `$${hederaScanPriceUsd(countFromCtx(ctx))}`;
  };
  // 0.01 HBAR per vault (1_000_000 tinybars) — a demo rate for this HBAR-priced
  // variant, independent of the USD-pegged hederaScanPriceUsd the default scan route uses.
  const hbarPrice = (ctx: HTTPRequestContext) => {
    validateEnvelope(ctx);
    return { asset: "0.0.0", amount: String(countFromCtx(ctx) * 1_000_000) };
  };

  const common = { scheme: "exact", network: "hedera:testnet", payTo: c.hedera.payToAccountId, maxTimeoutSeconds: 120 } as const;
  app.use(paymentMiddleware({
    "POST /hedera/v1/scan": { accepts: [{ ...common, price: scanPrice }], description: "VaultRadar sealed scan (metered per vault)" },
    "POST /hedera/v1/scan-hbar": { accepts: [{ ...common, price: hbarPrice }], description: "VaultRadar scan priced in HBAR" },
    "POST /hedera/v1/table": { accepts: [{ ...common, price: `$${TABLE_PRICE_USD}` }], description: "VaultRadar whole-protocol table (privacy tier)" },
  }, server));

  const mountTier = (path: string, tier: "scan" | "table") => {
    const handler = makeScanHandler({ ...deps, rail: "hedera", tier, getPayer: hederaPayerFromRequest, getTxId: hederaTxIdFromRequest });
    app.post(path, asyncHandler(async (req: Request, res: Response) => {
      const b64 = txKeyFromRequest(req);
      await handler(req, res);
      if (b64 && res.locals.receipt) receiptByTxKey.set(b64, res.locals.receipt as Receipt);
    }));
  };
  mountTier("/hedera/v1/scan", "scan");
  mountTier("/hedera/v1/scan-hbar", "scan");
  mountTier("/hedera/v1/table", "table");
}
