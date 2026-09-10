import type { Request, Response } from "express";
import {
  buildAttestation,
  buildReceipt,
  checkSealedRequest,
  checkSealedRequestPayer,
  commitNonce,
  computeRisk,
  isSealed,
  openSealedRequest,
  requestHash,
  responseHash,
  seal,
  fromB64,
  clampCount,
  type NonceStore,
  type ScanRequest,
  type TableRequest,
  type SealedRequest,
  type SourceRef,
  type UnifiedVault,
} from "@vaultradar/core";
import type { DataProvider } from "../data/provider";
import type { ServiceKeys } from "../keys";
import type { Config } from "../config";
import type { Metrics, Verdict } from "../metrics";
import { errBody } from "../util/http";

export type HandlerDeps = {
  keys: ServiceKeys;
  config: Config;
  data: DataProvider;
  nonces: NonceStore;
  rail: "hedera" | "arc";
  tier: "scan" | "table";
  /**
   * What this route charges for `count` vaults, in the units and asset the route is
   * actually priced in — copied verbatim into the signed receipt's `price`.
   *
   * Supplied by the mount rather than derived here from `{rail, tier}`, because a rail can
   * mount the same tier at more than one price: `/hedera/v1/scan-hbar` is the same scan
   * handler priced in tinybars of HBAR, and deriving the receipt from the rail alone
   * labelled its payments as micro-USDC of the configured USDC token. A payer who spent
   * 2,000,000 tinybars got a signed, HCS-committed receipt reading
   * `amount: "2000", asset: "0.0.429274"` — an auditor reading it concludes USDC was paid,
   * and the signature means they have every reason to believe it.
   */
  price: (count: number) => { amount: string; asset: string };
  /** Reads the verified payer off the request once the payment middleware has run. */
  getPayer: (req: Request) => string | null;
  /**
   * The payment identifier the payer already committed to: on Hedera the client-signed
   * transaction id (from the PAYMENT-SIGNATURE payload, parsed before settlement); on
   * Arc `req.payment.transaction` when present else the EIP-3009 nonce. Both identify
   * the payment on-chain once the rail settles it after this handler returns.
   */
  getTxId: (req: Request, res: Response) => string | null;
  /** Test-only override for the handler time cap; production callers never set this. */
  capMs?: number;
  /** Optional: when set, every response this handler produces is recorded (tier,
   * status, and — on a 2xx — the per-vault verdicts). Omitted in most existing tests,
   * which don't care about metrics; production wiring (app.ts) always sets it. */
  metrics?: Metrics;
};

const HANDLER_CAP_MS = 60_000;
const VAULT_ID_RE = /^\d+:0x[0-9a-f]{40}$/i;

/**
 * Shared handler for every {scan, table} × {hedera, arc} route (spec §5.4/§5.5).
 * Accepts a sealed envelope or a clear request body, validates it, runs the tier's
 * DataProvider call under a time cap, computes risk reports and per-vault
 * attestations, signs a receipt, and replies sealed (to the request's `reply_pk`)
 * or in the clear depending on how the request arrived. Payment itself has already
 * happened (or been verified) by the x402 middleware in front of this handler —
 * a 4xx here costs the payer nothing because settlement only follows a 2xx.
 */
export function makeScanHandler(d: HandlerDeps) {
  const handler = async (req: Request, res: Response) => {
    const now = Math.floor(Date.now() / 1000);
    const sealedIn = isSealed(req.body);
    let request: ScanRequest | TableRequest;
    let replyPk: Uint8Array | null = null;

    if (sealedIn) {
      let opened: SealedRequest<ScanRequest | TableRequest>;
      // res.locals.opened is set by rails/arc.ts's pre-payment middleware, which already
      // opened this envelope and ran checkSealedRequestPrePayment (ts window, nonce not
      // yet seen, count) *before* payment ever started — Circle settles before this
      // handler runs, so that check has to happen ahead of gateway.require, not here.
      // Re-opening (a real KEM decrypt) or re-running the pre-payment check would be
      // redundant; only the payer check and the nonce commit remain for this handler to
      // do. The Hedera rail never sets this — its own settle-after-response ordering has
      // no such problem, so it takes the unsplit `checkSealedRequest` path below,
      // unchanged from before this split existed.
      const preOpened = res.locals.opened as SealedRequest<ScanRequest | TableRequest> | undefined;
      if (preOpened) {
        opened = preOpened;
        const payer = d.getPayer(req);
        if (!payer) return res.status(422).json(errBody("payer_unknown"));
        const payerCheck = checkSealedRequestPayer(opened, payer);
        // A payer_mismatch caught here, on Arc, is caught *after* settlement already
        // happened (see rails/arc.ts's pre-payment middleware comment) — this request's
        // payer already paid and is not refunded. Not something this handler can fix;
        // documented as a known limitation of the Circle Gateway flow (README.md).
        if (!payerCheck.ok) return res.status(422).json(errBody(payerCheck.reason));
        commitNonce(opened, d.nonces, now);
      } else {
        try {
          opened = openSealedRequest<ScanRequest | TableRequest>(req.body, d.keys.kem.secretKey, d.keys.kem.kid);
        } catch {
          return res.status(422).json(errBody("envelope_open_failed"));
        }
        const payer = d.getPayer(req);
        if (!payer) return res.status(422).json(errBody("payer_unknown"));
        const count = d.tier === "scan" ? clampCount(req.header("x-vr-count")) ?? undefined : undefined;
        const chk = checkSealedRequest(opened, { now, payer, count, seen: d.nonces });
        if (!chk.ok) return res.status(422).json(errBody(chk.reason));
      }
      request = opened.request;
      replyPk = fromB64(opened.reply_pk);
    } else {
      request = req.body;
    }

    if (d.tier === "scan") {
      const vaults = (request as ScanRequest).vaults;
      if (!Array.isArray(vaults) || !vaults.length || vaults.length > 100 || !vaults.every(v => VAULT_ID_RE.test(v))) {
        return res.status(422).json(errBody("bad_vaults"));
      }
      // The price of a scan is `X-VR-Count`, and the work is `request.vaults`, so the two
      // must be the same number or the request is underpriced. The sealed branch above
      // already enforces this (checkSealedRequestPrePayment's count check, or
      // checkSealedRequest's); a clear body reached the data call without it, so
      // `X-VR-Count: 1` with a hundred vaults in the body bought a hundred vaults'
      // worth of upstream work for the one-vault price. Checked here, before the
      // DataProvider call, so the refusal costs nothing upstream — and, on Hedera, ahead
      // of settlement so it costs the payer nothing either. Arc settles before any
      // handler runs, so that rail enforces the same rule in a pre-payment middleware
      // (rails/arc.ts's preValidateClearCount); this remains the rail-independent
      // backstop, and the only line of defence for a handler mounted without a rail.
      if (!sealedIn && clampCount(req.header("x-vr-count")) !== vaults.length) {
        return res.status(422).json(errBody("count_mismatch"));
      }
    } else {
      const table = request as TableRequest;
      if (typeof table.protocol !== "string" || typeof table.chainId !== "string") {
        return res.status(422).json(errBody("bad_table_request"));
      }
    }

    const work = d.tier === "scan"
      ? d.data.scan((request as ScanRequest).vaults.map(v => v.toLowerCase()))
      : d.data.table((request as TableRequest).protocol, (request as TableRequest).chainId);

    let result: { vaults: UnifiedVault[]; sources: SourceRef[] };
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          capTimer = setTimeout(() => reject(new Error("cap")), d.capMs ?? HANDLER_CAP_MS);
        }),
      ]);
    } catch (e) {
      const isCap = e instanceof Error && e.message === "cap";
      // Log only the error message — never the request body or the upstream response —
      // so an upstream failure is diagnosable without leaking payload contents.
      if (!isCap) console.error(`${d.tier} upstream failed:`, e instanceof Error ? e.message : String(e));
      return res.status(isCap ? 504 : 502).json({ reason: isCap ? "handler_cap" : "upstream_failed" });
    } finally {
      clearTimeout(capTimer);
    }

    const reports = result.vaults.map(v => computeRisk(v, now));
    // Stashed on res.locals (alongside res.locals.receipt below) rather than passed some
    // other way, so the metrics wrapper in makeScanHandler — which only has access to
    // req/res, not this closure — can read the per-vault verdicts for
    // Metrics.recordRequest's unavailableVerdicts count.
    res.locals.verdicts = reports.map(r => r.verdict);
    const attestations = result.vaults.map(v => {
      const s = v.sources[0];
      return buildAttestation(
        {
          vaultId: v.id,
          chainId: v.chainId,
          block: s?.block ?? "0",
          timestamp: s?.timestamp ?? "0",
          sharePrice: v.sharePrice,
          tvlUsd: v.tvlUsd,
          source: s ? `${s.kind}:${s.ref}` : "none",
        },
        d.keys.sig,
      );
    });
    const body = { vaults: result.vaults, reports, attestations };

    const count = d.tier === "scan" ? (request as ScanRequest).vaults.length : 0;
    const price = d.price(count);

    // getTxId is read here, before buildReceipt runs, since the receipt's payment.txId
    // must be the identifier the payer already committed to at the time this handler
    // answers — not something derived after the fact.
    const txId = d.getTxId(req, res) ?? "unknown";
    const receipt = buildReceipt(
      {
        service: { erc8004: d.config.erc8004 },
        request_hash: requestHash(request),
        response_hash: responseHash(body),
        sealed: sealedIn,
        sources: result.sources,
        price: { amount: price.amount, asset: price.asset, rail: d.rail },
        payment: { rail: d.rail, txId },
        tier: d.tier,
        hcs: { topicId: d.config.hedera.hcsTopicId ?? "" },
      },
      d.keys.sig,
    );

    // res.locals.receipt is read by the HCS-enqueue hook the rails install after this
    // handler (Task 17); status(200) is explicit (not just res.json's implicit 200) so
    // that hook can rely on res.locals.receipt being set on every successful response.
    res.locals.receipt = receipt;
    return res.status(200).json(replyPk ? { sealed: seal(body, replyPk), receipt } : { ...body, receipt });
  };

  // Wrapping (rather than instrumenting every return statement above) keeps every early
  // 4xx/5xx return in `handler` a plain, unannotated `res.status(...).json(...)` — this
  // is the single place that observes the final status code and verdicts regardless of
  // which branch produced them.
  return async (req: Request, res: Response) => {
    await handler(req, res);
    d.metrics?.recordRequest(d.tier, res.statusCode, res.locals.verdicts as Verdict[] | undefined);
  };
}
