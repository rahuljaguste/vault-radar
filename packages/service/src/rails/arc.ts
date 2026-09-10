import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import {
  ARC_BUCKET_PRICE,
  TABLE_PRICE_USD,
  arcBucket,
  checkSealedRequestPrePayment,
  clampCount,
  isSealed,
  openSealedRequest,
  type Receipt,
  type ScanRequest,
  type SealedRequest,
  type TableRequest,
} from "@vaultradar/core";
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

/**
 * When the request body is a sealed envelope, opens it with the service's own KEM key
 * and runs `checkSealedRequestPrePayment` (ts window, nonce not yet seen, and — for scan
 * requests — the envelope's own vault count against `X-VR-Count`) *before*
 * `gateway.require` ever runs — for exactly the reason `validateBucket` above traces in
 * detail: Circle's settlement already happened by the time a handler-level check could
 * reject the request, so anything checkable without knowing the payer has to be checked
 * here instead. A clear (unsealed) body skips this middleware entirely (`next()`
 * immediately) and falls through to the handler's own bad_vaults/bad_table_request
 * checks, same as always — those remain sufficient for a clear body since nothing about
 * a clear request depends on payment state.
 *
 * The payer check is deliberately *not* done here: `req.payment.payer` doesn't exist
 * until `gateway.require` has already verified (and settled) the payment on this rail,
 * so there is no way to know it this early. The opened plaintext is stashed on
 * `res.locals.opened` so `handlers/scan.ts` — once the payment has gone through — runs
 * only `checkSealedRequestPayer` and `commitNonce` against it, rather than re-opening the
 * envelope or re-running a check that already passed. A `payer_mismatch` caught by the
 * handler at that point is therefore caught *after* settlement, and this rail has no way
 * to refund it — a real, documented limitation of Circle Gateway's settle-before-handler
 * design, not a gap this middleware can close. (Surfaced in README.md's Arc section.)
 */
function preValidateSealed(tier: "scan" | "table", deps: Pick<HandlerDeps, "keys" | "nonces">) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isSealed(req.body)) {
      next();
      return;
    }
    let opened: SealedRequest<ScanRequest | TableRequest>;
    try {
      opened = openSealedRequest<ScanRequest | TableRequest>(req.body, deps.keys.kem.secretKey, deps.keys.kem.kid);
    } catch {
      res.status(422).json(errBody("envelope_open_failed"));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const count = tier === "scan" ? clampCount(req.header("x-vr-count")) ?? undefined : undefined;
    const pre = checkSealedRequestPrePayment(opened, { now, count, seen: deps.nonces });
    if (!pre.ok) {
      res.status(422).json(errBody(pre.reason));
      return;
    }
    res.locals.opened = opened;
    next();
  };
}

/**
 * The clear-body sibling of `preValidateSealed`: for the scan tier, rejects a request
 * whose own `vaults` list disagrees with the `X-VR-Count` the route is about to be priced
 * against (422 `count_mismatch`), before `gateway.require` ever runs.
 *
 * `validateBucket` above only ever reads the header, so it cannot see this: `X-VR-Count:
 * 1` on `/arc/v1/scan/s` with a hundred vaults in a clear body passes the bucket check,
 * pays the one-vault `s` price, and then asks the DataProvider for a hundred vaults.
 * `handlers/scan.ts` enforces the same rule rail-independently, but on this rail a
 * handler-level refusal comes after Circle has already settled (see `validateBucket`'s
 * comment for the trace), so the money would be gone — which is why the check is mounted
 * here as well rather than only there.
 *
 * A sealed body is left to `preValidateSealed` (which checks the same thing against the
 * envelope's plaintext); a `table` request has no count. `Array.isArray` guards the read
 * exactly as `checkSealedRequestPrePayment` does, so a clear body with a non-array
 * `vaults` keeps reaching the handler's own `bad_vaults` check rather than being
 * relabelled a count mismatch.
 */
function preValidateClearCount(tier: "scan" | "table") {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (tier !== "scan" || isSealed(req.body)) {
      next();
      return;
    }
    const vaults = (req.body as { vaults?: unknown })?.vaults;
    if (Array.isArray(vaults) && vaults.length !== clampCount(req.header("x-vr-count"))) {
      res.status(422).json(errBody("count_mismatch"));
      return;
    }
    next();
  };
}

export function mountArcRail(
  app: Express,
  deps: Omit<HandlerDeps, "rail" | "tier" | "price" | "getPayer" | "getTxId"> & {
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
  const mountTier = (path: string, tier: "scan" | "table", price: string, receiptPrice: HandlerDeps["price"], pre: RequestHandler[]) => {
    const handler = makeScanHandler({ ...deps, rail: "arc", tier, price: receiptPrice, getPayer: arcPayerFromRequest, getTxId: arcTxIdFromRequest });
    app.post(
      path,
      ...pre,
      preValidateSealed(tier, deps),
      preValidateClearCount(tier),
      gateway.require(price),
      asyncHandler(async (req: Request, res: Response) => {
        // `req.payment` is always populated here: reaching this wrapper at all means
        // `gateway.require` already called `next()`, which — per the module comment
        // above — only happens after settlement has already succeeded for this exact
        // request. Recorded unconditionally (not gated on the handler's own response
        // status), because the settlement itself already happened regardless of what
        // the handler goes on to do with it — unlike `onSettled` below, which is
        // specifically about committing *this handler's receipt* to HCS and so needs
        // one to exist.
        //
        // Wrapped in its own try/catch, ahead of the handler call: this rail's payer
        // already paid by this point (Circle settles before `next()`, as traced above),
        // so a metrics-recording failure here must never turn into a 500 for a request
        // that already succeeded on-chain — `asyncHandler` would otherwise forward any
        // throw straight to the app's error handler, which has no way to know the
        // payment already went through. `Metrics.recordSettlement` no longer throws on
        // malformed input (it validates and no-ops instead), but this isolation doesn't
        // depend on that staying true.
        const payment = (req as PReq).payment;
        if (payment) {
          try {
            deps.metrics?.recordSettlement("arc", payment.amount);
          } catch {
            /* metrics must never turn an already-paid request into a 500 */
          }
        }
        await handler(req, res);
        if (res.locals.receipt) deps.onSettled?.(res.locals.receipt as Receipt, arcTxIdFromRequest(req));
      }),
    );
  };

  // Two prices per mount, and they are not duplicates of each other: `price` is the string
  // Circle's middleware charges (`$`-prefixed USD), `receiptPrice` is what the signed
  // receipt states for a given vault count. On this rail they agree on a USD decimal and
  // the asset is simply "USDC", which is what the receipt said before this was threaded
  // through — identical values, now stated by the mount that knows them.
  for (const b of ["s", "m", "l"] as const) {
    mountTier(`/arc/v1/scan/${b}`, "scan", `$${ARC_BUCKET_PRICE[b]}`, count => ({ amount: ARC_BUCKET_PRICE[arcBucket(count)], asset: "USDC" }), [
      validateBucket(b),
    ]);
  }
  mountTier("/arc/v1/table", "table", `$${TABLE_PRICE_USD}`, () => ({ amount: TABLE_PRICE_USD, asset: "USDC" }), []);
}
