import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { ARC_BUCKET_PRICE, TABLE_PRICE_USD, arcBucket, clampCount, type Receipt } from "@vaultradar/core";
import { makeScanHandler, type HandlerDeps } from "../handlers/scan";
import { asyncHandler } from "../util/async";
import { errBody } from "../util/http";

/** The subset of Circle's `PaymentRequest` this module reads off `req` after
 * `gateway.require(price)` has verified and settled the payment (see the module
 * comment on `mountArcRail` for why both already happened by the time a route handler
 * runs). Declared locally — rather than importing `PaymentRequest` from
 * `@circle-fin/x402-batching/server` — because that type extends Node's raw
 * `IncomingMessage`, not Express's `Request`; intersecting the two here is simpler than
 * reconciling both type hierarchies for a single optional field. */
type PReq = Request & { payment?: { verified: boolean; payer: string; amount: string; network: string; transaction?: string } };

export const arcPayerFromRequest = (req: Request): string | null => (req as PReq).payment?.payer ?? null;
/** Circle settles synchronously inside `gateway.require`, so a settled transaction hash
 * is already on `req.payment.transaction` by the time a route handler runs — this only
 * falls back to "gateway-batch" for the (untested-in-practice) case where Circle's
 * client omits it despite a successful settlement. */
export const arcTxIdFromRequest = (req: Request): string => (req as PReq).payment?.transaction ?? "gateway-batch";

/**
 * Rejects a missing/out-of-range `X-VR-Count` (400 `bad_count`) or a count that doesn't
 * match this route's bucket (422 `bucket_mismatch`) *before* `gateway.require(price)`
 * ever runs.
 *
 * This ordering is load-bearing, not stylistic. Traced against
 * `@circle-fin/x402-batching` 3.4.0's compiled `dist/server/index.js`
 * (`createGatewayMiddleware`'s `require: (price) => async (req, res, next) => {...}`):
 * the returned middleware runs `runVerifyLifecycle` *and* `runSettleLifecycle` — i.e. it
 * calls the facilitator's `/verify` and `/settle` endpoints and only then calls `next()`
 * — entirely before the wrapped route handler executes. Unlike `@x402/express` (used by
 * the Hedera rail), which verifies before the handler but settles only after the
 * handler's response is flushed, Circle's Gateway money has already moved by the time
 * any handler-level validation could reject the request. A `bad_vaults`-style check
 * inside the handler would charge the payer for a request this rail was always going to
 * refuse — there is no settlement-reversal path in this flow. So every check that can
 * reject a scan request outright is mounted ahead of `gateway.require`, mirroring
 * `rails/hedera.ts`'s `validateScanRequest` (mounted ahead of `paymentMiddleware` there
 * for the same reason, just a less strict one — Hedera settlement genuinely happens
 * after the handler, so its own bad_vaults check inside the handler is merely
 * defense-in-depth, not the only line of defense as it is here).
 */
function validateBucket(bucket: "s" | "m" | "l") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const n = clampCount(req.header("x-vr-count"));
    if (!n) {
      res.status(400).json(errBody("bad_count"));
      return;
    }
    if (arcBucket(n) !== bucket) {
      res.status(422).json(errBody("bucket_mismatch"));
      return;
    }
    next();
  };
}

export function mountArcRail(
  app: Express,
  deps: Omit<HandlerDeps, "rail" | "tier" | "getPayer" | "getTxId"> & {
    /** Fires once settlement completes for a request this rail already answered 200 for
     * (same contract as `rails/hedera.ts`'s `onSettled`). */
    onSettled?: (receipt: Receipt, txId: string) => void;
  },
): void {
  const gateway = createGatewayMiddleware({
    sellerAddress: deps.config.arc.sellerAddress,
    networks: [deps.config.arc.network],
    facilitatorUrl: deps.config.arc.facilitatorUrl,
  });

  /**
   * Wires `onSettled` from a per-route wrapper around the scan/table handler — *not*
   * from `gateway.onAfterSettle` — for two independent reasons, either one sufficient
   * on its own:
   *
   * 1. `onAfterSettle`'s hook context (`SettleResultContext`, from this package's
   *    `dist/hooks-BKkPP7ic.d.ts`) is `{ paymentPayload, requirements, result }` — it
   *    carries no reference to `req`/`res` at all, so it has no way to read
   *    `res.locals.receipt` regardless of timing.
   * 2. Even if it did: as the comment on `validateBucket` above traces in detail,
   *    settlement completes *before* `next()` is called, i.e. strictly before this
   *    route's handler ever runs — so `res.locals.receipt` is unset at the moment
   *    `onAfterSettle` would fire even in principle. Relying on it would silently mean
   *    `onSettled` (and therefore the HCS commitment `app.ts` composes onto it) never
   *    fires for Arc at all.
   *
   * Wrapping the handler avoids needing any correlation map at all (unlike
   * `rails/hedera.ts`'s TTL-bounded `receiptByTxKey`/`verifiedPayerByTxKey`): by the time
   * the wrapped handler resolves, verification *and* settlement already happened earlier
   * in this exact same request, so `req.payment` and the handler's own
   * `res.locals.receipt` are simultaneously available with nothing async in between to
   * correlate across.
   */
  const mountTier = (path: string, tier: "scan" | "table", price: string, pre: RequestHandler[]) => {
    const handler = makeScanHandler({ ...deps, rail: "arc", tier, getPayer: arcPayerFromRequest, getTxId: arcTxIdFromRequest });
    app.post(
      path,
      ...pre,
      gateway.require(price),
      asyncHandler(async (req: Request, res: Response) => {
        await handler(req, res);
        if (res.locals.receipt) deps.onSettled?.(res.locals.receipt as Receipt, arcTxIdFromRequest(req));
      }),
    );
  };

  for (const b of ["s", "m", "l"] as const) {
    mountTier(`/arc/v1/scan/${b}`, "scan", `$${ARC_BUCKET_PRICE[b]}`, [validateBucket(b)]);
  }
  mountTier("/arc/v1/table", "table", `$${TABLE_PRICE_USD}`, []);
}
