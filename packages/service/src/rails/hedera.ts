import type { Express, NextFunction, Request, Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { extractTransactionFromPayload, inspectHederaTransaction, type ExactHederaPayloadV2 } from "@x402/hedera";
import { clampCount, hederaScanPriceAtomic, hederaScanPriceUsd, isSealed, TABLE_PRICE_USD, type Receipt } from "@vaultradar/core";
import { makeScanHandler, type HandlerDeps } from "../handlers/scan";
import { asyncHandler } from "../util/async";
import { errBody } from "../util/http";

type Decoded = { payer: string | null; txId: string | null };

/**
 * Both settlement-correlation maps below expire an entry 10 minutes after it's
 * written. Cleanup normally happens synchronously via onAfterSettle/onSettleFailure
 * (see mountHederaRail), but a client can verify a payment and then abandon the
 * request before ever settling — no hook fires for that at all, so without a TTL
 * those two entries would sit forever. Swept on every insert rather than with a
 * timer, so idle test processes (and idle production processes with no further
 * traffic) don't have a background interval to leak or to make tests
 * non-deterministic.
 */
const ENTRY_TTL_MS = 10 * 60_000;
type Expiring<T> = { value: T; expiresAt: number };

function sweepExpired<T>(map: Map<string, Expiring<T>>, now: number): void {
  for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
}

/** Inserts (or refreshes) an entry with a fresh TTL, sweeping expired entries first. */
function putWithTtl<T>(map: Map<string, Expiring<T>>, key: string, value: T): void {
  const now = Date.now();
  sweepExpired(map, now);
  map.set(key, { value, expiresAt: now + ENTRY_TTL_MS });
}

/** Reads a live entry; an entry past its TTL reads as absent even if not yet swept. */
function getFresh<T>(map: Map<string, Expiring<T>>, key: string): T | undefined {
  const entry = map.get(key);
  return entry && entry.expiresAt > Date.now() ? entry.value : void 0;
}

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
const verifiedPayerByTxKey = new Map<string, Expiring<string>>();

/**
 * Receipts awaiting settlement observation, keyed the same way. Filled by the route
 * wrapper in mountTier right after the scan/table handler resolves (from
 * res.locals.receipt), consumed by onAfterSettle (success) or onSettleFailure
 * (failure) below — both delete their entry unconditionally, so a failed settle never
 * leaves it behind, and the TTL above catches the remaining case: a verified payment
 * whose request is abandoned before either hook ever fires.
 *
 * Safe without a lock, despite both writes happening from async continuations: the
 * x402 Express middleware buffers res.end and only calls the facilitator's real
 * /settle endpoint (a genuine network fetch) after that buffered end fires — which is
 * the same event that unblocks the route wrapper's `await handler(req, res)` here.
 * Node/Bun drain all queued microtasks (including the wrapper's continuation that
 * calls receiptByTxKey.set) before any I/O-driven callback such as a fetch response
 * runs, so the receipt is always stored before onAfterSettle can possibly look it up.
 */
const receiptByTxKey = new Map<string, Expiring<Receipt>>();

const decodedCache = new WeakMap<Request, Decoded>();

/**
 * The HBAR-priced scan variant's rate, in one place.
 *
 * 0.01 HBAR per vault (1_000_000 tinybars) — a demo rate for `/hedera/v1/scan-hbar`,
 * deliberately independent of the USD-pegged `hederaScanPriceUsd` the default scan route
 * uses. `HBAR_ASSET` is x402's id for native HBAR rather than an HTS token.
 *
 * Shared between the 402's price function and the receipt the handler signs, because those
 * two stating different things is precisely the bug this consolidates away: the route
 * charged tinybars of HBAR while the receipt claimed micro-USDC of the configured USDC
 * token.
 */
const HBAR_ASSET = "0.0.0";
const TINYBARS_PER_VAULT = 1_000_000;
const hbarScanAmount = (count: number): string => String(count * TINYBARS_PER_VAULT);

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
      let payer = getFresh(verifiedPayerByTxKey, b64) ?? null;
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

/**
 * Rejects bad scan/scan-hbar input as a plain 400 before payment processing ever
 * starts, so an invalid request never triggers a facilitator call (no verify/settle
 * attempt) and never reaches the price functions' own throw path — which
 * @x402/express 2.25.0 turns into a 500, not a 4xx, since processHTTPRequest has no
 * try/catch around resolving a route's dynamic `price` function (see task-16-report.md,
 * "Correction to the brief"). Mounted only on the two count-priced routes; /table's
 * price is a flat string, not a function, so it never needed this input in the first
 * place. validateEnvelope/countFromCtx below still throw too, as a defensive fallback
 * the price functions should now never actually hit through this mounted rail.
 */
function validateScanRequest(req: Request, res: Response, next: NextFunction): void {
  if (!clampCount(req.header("x-vr-count"))) {
    res.status(400).json(errBody("bad_count"));
    return;
  }
  const body = req.body;
  if (body && typeof body === "object" && ("ct" in body || "kem" in body) && !isSealed(body)) {
    res.status(400).json(errBody("malformed_envelope"));
    return;
  }
  next();
}

export function mountHederaRail(
  app: Express,
  deps: Omit<HandlerDeps, "rail" | "tier" | "price" | "getPayer" | "getTxId"> & {
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
      putWithTtl(verifiedPayerByTxKey, b64, payer);
    } catch {
      /* not an exact-Hedera payload; nothing to key on */
    }
  });

  server.onAfterSettle(async ctx => {
    // Recorded unconditionally, ahead of the correlation logic below, in its own
    // dedicated try/catch: by the time this hook fires, @x402/core has already confirmed
    // the facilitator settled this payment for the "hedera:testnet" scheme this `server`
    // is scoped to — that's true regardless of whether this rail's own txKey-based
    // correlation (below) manages to find a matching receipt, so a settlement counts
    // here even if the correlation step itself throws. `Metrics.recordSettlement` no
    // longer throws on malformed input (it validates and no-ops instead), but this is
    // wrapped anyway: a metrics-recording failure of any kind must never be able to skip
    // the onSettled call below it, which is what actually fires the HCS commitment for a
    // request that already settled — a bare statement here, with no isolation of its
    // own, would let exactly that happen if this method's implementation ever changes.
    try {
      deps.metrics?.recordSettlement("hedera", ctx.requirements.amount, ctx.requirements.asset);
    } catch {
      /* metrics must never suppress the HCS commitment below */
    }
    try {
      const b64 = extractTransactionFromPayload(ctx.paymentPayload.payload as unknown as ExactHederaPayloadV2);
      const receipt = getFresh(receiptByTxKey, b64);
      verifiedPayerByTxKey.delete(b64);
      receiptByTxKey.delete(b64);
      if (receipt) deps.onSettled?.(receipt, ctx.result.transaction);
    } catch {
      /* not an exact-Hedera payload; nothing to correlate */
    }
  });

  // @x402/core calls onAfterSettle only when settlement succeeds — a facilitator that
  // answers /settle with a clean `{success: false}` (or one whose call throws) instead
  // routes through onSettleFailure (confirmed in @x402/core's compiled settlePayment:
  // `if (!settleResult.success) { ...run onSettleFailure hooks...; return settleResult }`,
  // a separate branch from the onAfterSettle one below it). Without this hook, a failed
  // settle after a successful verify would never delete the entries onAfterVerify and
  // the route wrapper just wrote — this mirrors onAfterSettle's cleanup, minus the
  // onSettled call, since the payment never actually settled.
  server.onSettleFailure(async ctx => {
    try {
      const b64 = extractTransactionFromPayload(ctx.paymentPayload.payload as unknown as ExactHederaPayloadV2);
      verifiedPayerByTxKey.delete(b64);
      receiptByTxKey.delete(b64);
    } catch {
      /* not an exact-Hedera payload; nothing to clean up */
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
  const hbarPrice = (ctx: HTTPRequestContext) => {
    validateEnvelope(ctx);
    return { asset: HBAR_ASSET, amount: hbarScanAmount(countFromCtx(ctx)) };
  };

  app.use(["/hedera/v1/scan", "/hedera/v1/scan-hbar"], validateScanRequest);

  const common = { scheme: "exact", network: "hedera:testnet", payTo: c.hedera.payToAccountId, maxTimeoutSeconds: 120 } as const;
  app.use(paymentMiddleware({
    "POST /hedera/v1/scan": { accepts: [{ ...common, price: scanPrice }], description: "VaultRadar sealed scan (metered per vault)" },
    "POST /hedera/v1/scan-hbar": { accepts: [{ ...common, price: hbarPrice }], description: "VaultRadar scan priced in HBAR" },
    "POST /hedera/v1/table": { accepts: [{ ...common, price: `$${TABLE_PRICE_USD}` }], description: "VaultRadar whole-protocol table (privacy tier)" },
  }, server));

  // `price` is passed per mount, not derived inside the handler, because this rail mounts
  // the same scan tier twice at two genuinely different prices — the USD-pegged route and
  // the HBAR one — and the receipt has to state the one the payer actually paid.
  const mountTier = (path: string, tier: "scan" | "table", price: HandlerDeps["price"]) => {
    const handler = makeScanHandler({ ...deps, rail: "hedera", tier, price, getPayer: hederaPayerFromRequest, getTxId: hederaTxIdFromRequest });
    app.post(path, asyncHandler(async (req: Request, res: Response) => {
      const b64 = txKeyFromRequest(req);
      await handler(req, res);
      if (b64 && res.locals.receipt) putWithTtl(receiptByTxKey, b64, res.locals.receipt as Receipt);
    }));
  };
  mountTier("/hedera/v1/scan", "scan", count => ({ amount: hederaScanPriceAtomic(count), asset: c.hedera.usdcToken }));
  mountTier("/hedera/v1/scan-hbar", "scan", count => ({ amount: hbarScanAmount(count), asset: HBAR_ASSET }));
  mountTier("/hedera/v1/table", "table", () => ({ amount: String(Math.round(Number(TABLE_PRICE_USD) * 1e6)), asset: c.hedera.usdcToken }));
}

/**
 * Test-only introspection of the settlement-correlation maps' sizes, to verify the
 * cleanup invariant (every entry written by onAfterVerify/mountTier is removed by
 * onAfterSettle or onSettleFailure, or eventually by the TTL sweep). Not part of the
 * rail's public API — nothing outside this module's own tests should import it.
 */
export const _mapSizesForTests = () => ({ payer: verifiedPayerByTxKey.size, receipt: receiptByTxKey.size });
