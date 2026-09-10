import { z } from "zod";
import {
  ARC_BUCKET_PRICE,
  TABLE_PRICE_USD,
  arcBucket,
  buildSealedRequest,
  checkSig,
  fromB64,
  hederaScanPriceAtomic,
  hederaScanPriceUsd,
  isSealed,
  open,
  requestHash,
  responseHash,
  verifyAttestation,
  verifyReceipt,
  type Attestation,
  type Receipt,
  type RiskReport,
  type Rail,
  type Sealed,
  type Sig,
  type UnifiedVault,
} from "@vaultradar/core";
import { arcAddress, payArc, type ArcPayResult } from "./rails/arc";
import { maxAcceptableAtomic, payingFetchHedera, txIdFromResponse } from "./rails/hedera";
import { readPqHashOnChain } from "./erc8004";

/**
 * Defensive shape-check on the untrusted `/.well-known/agent.json` response, applied
 * before any field is read. `.passthrough()` at every level so unmodeled fields (e.g.
 * `version`, `description`, `hcs`, `docs`, per-endpoint `network`/`asset`) survive
 * intact — this schema only pins down the fields this package actually reads.
 */
const AgentCardSchema = z
  .object({
    name: z.string(),
    pq: z.object({
      sig: z.object({ alg: z.string(), public_key: z.string(), pub_hash: z.string() }).passthrough(),
      kem: z.object({ alg: z.string(), public_key: z.string(), kid: z.string() }).passthrough(),
    }),
    erc8004: z.array(z.object({ chainId: z.string(), agentId: z.string() }).passthrough()).default([]),
    endpoints: z
      .object({
        hedera: z.object({ scan: z.string(), scanHbar: z.string(), table: z.string() }).passthrough(),
        arc: z
          .object({ scan: z.object({ s: z.string(), m: z.string(), l: z.string() }), table: z.string() })
          .passthrough(),
      })
      .passthrough(),
    prices: z.record(z.unknown()),
    limits: z.record(z.unknown()),
    sig: z.object({ alg: z.string(), pub_hash: z.string(), value: z.string() }),
  })
  .passthrough();

export type AgentCard = z.infer<typeof AgentCardSchema>;

export type Discovery = {
  card: AgentCard;
  sigPk: Uint8Array;
  kemPk: Uint8Array;
  cardSignatureValid: boolean;
  onChain: { chainId: string; agentId: string; matches: boolean | null }[];
};

export type PaidResult = {
  rail: Rail;
  tier: "scan" | "table";
  vaults: UnifiedVault[];
  reports: RiskReport[];
  attestations: Attestation[];
  receipt: Receipt;
  /**
   * True only when the receipt's signature verifies against the discovered signing key,
   * its `request_hash`/`response_hash` cover what was actually exchanged, *and* the price
   * it states matches what the agent quoted (see `checkSettledPrice`). Any one of the
   * three failing makes the receipt not a receipt for this purchase.
   */
  receiptValid: boolean;
  attestationsValid: boolean;
  txId: string | null;
  /** What the *receipt* says was charged, not what the agent computed it should be. Null
   * when the receipt's amount cannot be read as a number at all (which also fails
   * `receiptValid`). */
  priceUsd: string | null;
  sealed: boolean;
};

/** USDC's six decimals: every price either side of this protocol handles is an exact
 * integer number of micro-USD, so comparisons are made there rather than on floats. */
const MICRO_PER_USD = 1_000_000;

/** A USD decimal string as integer micro-USD, or null if it is not a finite number. */
function usdToMicro(usd: string): bigint | null {
  const n = Number(usd);
  return Number.isFinite(n) ? BigInt(Math.round(n * MICRO_PER_USD)) : null;
}

/** Integer micro-USD back to the decimal string form the rest of the codebase uses
 * (`hederaScanPriceUsd`'s formatting, so `1500n` reads `"0.0015"`). */
function microToUsd(micro: bigint): string {
  return (Number(micro) / MICRO_PER_USD).toString();
}

/**
 * The price a receipt states, in integer micro-USD, or null when it cannot be read.
 *
 * The two rails write `receipt.price.amount` in different units, because each writes what
 * its own rail settles in (`handlers/scan.ts`): Hedera records the atomic HTS USDC amount
 * (six decimals, e.g. `"1500"`), Arc records the USD decimal string Circle's middleware
 * was configured with (e.g. `"0.003"`). Reading them apart here, rather than guessing from
 * the shape of the string, is the difference between comparing 1500 with 1500 and
 * comparing 1500 with 0.
 */
function receiptPriceMicro(rail: Rail, amount: string): bigint | null {
  if (typeof amount !== "string" || amount.trim() === "") return null;
  if (rail === "hedera") {
    return /^\d+$/.test(amount.trim()) ? BigInt(amount.trim()) : null;
  }
  return usdToMicro(amount);
}

/**
 * Does the amount actually charged match what the agent quoted?
 *
 * `priceUsd` used to be the agent's *own* arithmetic, restated — so a service that
 * charged any amount at all still had its price reported as the catalogue price, and a
 * run record cited a number nobody had verified. This reads the figure off the signed
 * receipt instead and checks it against the quote, with the same one-percent band the
 * pre-payment policy (`rails/hedera.ts`'s `quoteCeilingPolicy`) applies to the 402's
 * demand, so the two cannot disagree about what is acceptable.
 *
 * The band is closed on both sides: under the quote fails too. The agent and the service
 * compute prices from the same `@vaultradar/core` constants, so a receipt that understates
 * the price is not a cheaper purchase, it is a receipt that does not describe this one —
 * and `priceUsd` is cited in run records and decisions, where an unverified number is
 * worse than a refusal.
 */
function checkSettledPrice(
  rail: Rail,
  receipt: Receipt,
  quoteAtomic: string,
  settledAtomic: bigint | null,
): { priceUsd: string | null; agrees: boolean } {
  const quote = BigInt(quoteAtomic);
  const max = maxAcceptableAtomic(quoteAtomic);
  const inBand = (v: bigint) => v >= quote && v <= max;

  const stated = receiptPriceMicro(rail, receipt.price?.amount);
  if (stated === null) return { priceUsd: null, agrees: false };
  // Report the receipt's own wording where it already is a USD string, so nothing is
  // reformatted on the way through; derive it from the atomic amount on Hedera.
  const priceUsd = rail === "hedera" ? microToUsd(stated) : receipt.price.amount;
  // `settledAtomic` is what the rail itself reported moving (Circle's `PayResult.amount`);
  // only the Arc branch has it. Both must agree with the quote when both are known.
  const agrees = inBand(stated) && (settledAtomic === null || inBand(settledAtomic));
  return { priceUsd, agrees };
}

export type PayingFetch = (url: string, init: RequestInit) => Promise<Response>;

export type VaultRadarClientOpts = {
  serviceUrl: string;
  hedera?: { accountId: string; privateKey: string };
  arc?: { privateKey: `0x${string}` };
  fetchImpl?: typeof fetch;
  /** Defaults to an on-chain ERC-8004 `getMetadata` read (see `./erc8004`). */
  readPqHash?: (chainId: string, agentId: string) => Promise<string | null>;
  /**
   * Overrides the Hedera paying fetch entirely. Tests inject plain `fetch` here to
   * round-trip sealing/receipt/attestation verification against a service mounted
   * without payment middleware, without constructing a real Hedera signer.
   */
  payingFetch?: PayingFetch;
  /**
   * Overrides Arc payment entirely. `payArc` (via `arc.privateKey`) is used by default
   * when `arc` is configured. Tests inject a fake here to exercise `paid()`'s Arc
   * branch (bucket URL selection, payer address, opening a sealed reply) without a
   * real `GatewayClient` or network call.
   */
  arcPay?: (url: string, body: unknown, headers: Record<string, string>) => Promise<ArcPayResult<ServiceResponse>>;
};

type ScanResponseBody = { vaults: UnifiedVault[]; reports: RiskReport[]; attestations: Attestation[] };
type SealedEnvelopeResponse = { sealed: Sealed; receipt: Receipt };
type ClearResponse = ScanResponseBody & { receipt: Receipt };
type ServiceResponse = SealedEnvelopeResponse | ClearResponse;

const isSealedResponse = (r: ServiceResponse): r is SealedEnvelopeResponse =>
  typeof r === "object" && r !== null && "sealed" in r && isSealed((r as { sealed: unknown }).sealed);

/**
 * Paying client for a VaultRadar service instance: verifies the service's identity
 * (signed agent card, cross-checked against an ERC-8004 on-chain key-hash pin), quotes
 * and pays for scan/table requests on either the Hedera or Arc x402 rail, and verifies
 * every receipt and attestation the service returns before handing results back.
 */
export class VaultRadarClient {
  private disc: Discovery | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly readPqHash: (chainId: string, agentId: string) => Promise<string | null>;
  private readonly payingFetch: PayingFetch | null;
  private readonly arcPay: ((url: string, body: unknown, headers: Record<string, string>) => Promise<ArcPayResult<ServiceResponse>>) | null;
  /**
   * Expected atomic amount for the paid request currently in flight, read by the x402
   * payment policy when a 402 arrives (`rails/hedera.ts`'s `quoteCeilingPolicy`). It has
   * to be a field rather than an argument because `@x402/core`'s policy signature is
   * `(version, requirements)` — it gets no handle on the request — and the client, with
   * its signer, is built once. Set immediately before the paying fetch and cleared after,
   * so one client serves a sequence of differently priced requests; a caller that runs
   * two `paid()` calls *concurrently* on the same client would have them overwrite each
   * other's quote, which is why nothing in this package does (the watch loop and the
   * dashboard route are both strictly sequential).
   */
  private quoteAtomic: string | null = null;

  constructor(private readonly opts: VaultRadarClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.readPqHash = opts.readPqHash ?? readPqHashOnChain;
    // `payingFetch` wins when supplied (tests rely on this to avoid ever constructing a
    // real Hedera signer); otherwise build the real one lazily-but-eagerly here, once,
    // only when a Hedera account was actually configured.
    this.payingFetch =
      opts.payingFetch ?? (opts.hedera ? payingFetchHedera(opts.hedera.accountId, opts.hedera.privateKey, () => this.quoteAtomic) : null);
    // Same pattern for Arc: `arcPay` wins when supplied (tests inject a fake to avoid a
    // real GatewayClient); otherwise default to `payArc` bound to `arc.privateKey`.
    // Captured to a local so the closure keeps the narrowed (non-optional) type.
    const arc = opts.arc;
    this.arcPay = opts.arcPay ?? (arc ? (url, body, headers) => payArc<ServiceResponse>(arc.privateKey, url, body, headers) : null);
  }

  /**
   * Fetches and validates `/.well-known/agent.json`: checks the card's ML-DSA-65
   * self-signature, then cross-checks `card.pq.sig.pub_hash` against every ERC-8004
   * identity the card lists via `readPqHash`. The signature is checked against the
   * untouched response object (not the zod-validated copy) so it reflects exactly the
   * bytes the service sent. Caches the result for subsequent `scan`/`table`/`quote`
   * calls; call again to force a refresh.
   */
  async discover(): Promise<Discovery> {
    const base = this.opts.serviceUrl.replace(/\/$/, "");
    const res = await this.fetchImpl(`${base}/.well-known/agent.json`);
    if (!res.ok) throw new Error(`discover failed: service returned ${res.status}`);
    const raw: unknown = await res.json();
    const parsed = AgentCardSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`discover failed: malformed agent card (${parsed.error.issues[0]?.message ?? "invalid shape"})`);
    }
    const card = parsed.data;
    const sigPk = fromB64(card.pq.sig.public_key);
    const kemPk = fromB64(card.pq.kem.public_key);
    const cardSignatureValid = checkSig(raw as { sig?: Sig }, sigPk);
    const onChain = await Promise.all(
      card.erc8004.map(async e => {
        const hash = await this.readPqHash(e.chainId, e.agentId);
        return { chainId: e.chainId, agentId: e.agentId, matches: hash == null ? null : hash === card.pq.sig.pub_hash };
      }),
    );
    const discovery: Discovery = { card, sigPk, kemPk, cardSignatureValid, onChain };
    this.disc = discovery;
    return discovery;
  }

  private async ensureDiscovery(): Promise<Discovery> {
    return this.disc ?? this.discover();
  }

  /** Price quotes for a scan of `count` vaults, on whichever rails are configured. */
  async quote(count: number): Promise<{ hedera: string | null; arc: string | null }> {
    return {
      hedera: this.opts.hedera ? hederaScanPriceUsd(count) : null,
      arc: this.opts.arc ? ARC_BUCKET_PRICE[arcBucket(count)] : null,
    };
  }

  private payerFor(rail: Rail): string {
    if (rail === "hedera") {
      if (!this.opts.hedera) throw new Error("hedera rail not configured: pass `hedera` to the VaultRadarClient constructor");
      return this.opts.hedera.accountId;
    }
    if (!this.opts.arc) throw new Error("arc rail not configured: pass `arc` to the VaultRadarClient constructor");
    return arcAddress(this.opts.arc.privateKey);
  }

  private priceFor(rail: Rail, tier: "scan" | "table", count: number): string {
    if (rail === "hedera") return tier === "scan" ? hederaScanPriceUsd(count) : TABLE_PRICE_USD;
    return tier === "scan" ? ARC_BUCKET_PRICE[arcBucket(count)] : TABLE_PRICE_USD;
  }

  /**
   * What this request should cost, as an integer atomic amount (micro-USD / six-decimal
   * USDC) — the unit both a 402's `amount` and a Hedera receipt's `price.amount` are in.
   * Derived from the same `@vaultradar/core` price functions the service prices with, so a
   * disagreement is a disagreement about the request, not about arithmetic.
   */
  private quoteAtomicFor(rail: Rail, tier: "scan" | "table", count: number): string {
    if (rail === "hedera" && tier === "scan") return hederaScanPriceAtomic(count);
    return String(Math.round(Number(this.priceFor(rail, tier, count)) * MICRO_PER_USD));
  }

  /**
   * Shared paid-request path for both `scan` and `table`, on either rail: seals the
   * request (unless `doSeal` is false), pays and posts it, opens/verifies the sealed
   * reply (or reads the clear one), and verifies the receipt and every attestation
   * against the service's discovered signing key.
   */
  private async paid(
    rail: Rail,
    tier: "scan" | "table",
    url: string,
    request: object,
    count: number,
    doSeal: boolean,
  ): Promise<PaidResult> {
    const d = await this.ensureDiscovery();
    const env = doSeal ? buildSealedRequest(request, this.payerFor(rail), d.kemPk) : null;
    const body: unknown = env ? env.sealed : request;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(tier === "scan" ? { "x-vr-count": String(count) } : {}),
    };

    // The ceiling the payment policy enforces when the 402 comes back, and the figure the
    // receipt's own price is checked against afterwards. One value, so the agent cannot
    // refuse to pay an amount pre-payment that it would have accepted post-payment.
    const quoteAtomic = this.quoteAtomicFor(rail, tier, count);

    let raw: ServiceResponse;
    let txId: string | null;
    /** What the rail itself reported moving, when it reports one (Arc only). */
    let settledAtomic: bigint | null = null;
    if (rail === "hedera") {
      this.quoteAtomic = quoteAtomic;
      let res: Response;
      try {
        res = await (this.payingFetch ?? this.fetchImpl)(url, { method: "POST", headers, body: JSON.stringify(body) });
      } finally {
        // Cleared even when the payment was refused, so a later request on this client
        // can never be priced against a stale quote.
        this.quoteAtomic = null;
      }
      txId = txIdFromResponse(res);
      const parsedJson: unknown = await res.json();
      if (res.status !== 200) throw new Error(`service ${res.status}: ${JSON.stringify(parsedJson)}`);
      raw = parsedJson as ServiceResponse;
    } else {
      if (!this.arcPay) throw new Error("arc rail not configured: pass `arc` (or `arcPay`) to the VaultRadarClient constructor");
      let arcResult: ArcPayResult<ServiceResponse>;
      try {
        arcResult = await this.arcPay(url, body, headers);
      } catch (e) {
        // GatewayClient.pay() throws on any non-2xx response instead of returning a
        // PayResult with a non-200 `status` (pre-payment: "Request failed with status
        // ${status}"; post-payment: "Payment failed: ${error.error || statusText}"), so
        // there is no live path where checking `.status` after a successful `await`
        // would ever see a failure — the throw is the only failure signal, which is why
        // there's no `status !== 200` check below. Note Circle's client only reads a
        // JSON `{ error }` field from the service's response, not VaultRadar's
        // `{ reason }` convention (handlers/scan.ts), so a service 4xx may surface here
        // as a bare status/statusText rather than the structured reason.
        throw new Error(`arc payment failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      txId = arcResult.transaction;
      raw = arcResult.data;
      // `PayResult.amount` is the USDC atomic amount Circle's client actually authorized —
      // the nearest thing this rail has to an independent statement of what was paid, so
      // it is checked against the quote alongside the receipt's own figure. Guarded
      // because it arrives from a third-party SDK: a non-bigint here must not throw past
      // a payment that already happened.
      settledAtomic = typeof arcResult.amount === "bigint" ? arcResult.amount : null;
    }

    // The service must mirror the request's sealed-ness exactly. Treating a mismatch
    // as an error (rather than, say, silently trusting whatever shape came back) means
    // `sealed` on the result always reflects what was actually observed on the wire,
    // never just what the client asked for.
    if (env && !isSealedResponse(raw)) throw new Error("service returned a clear response to a sealed request");
    if (!env && isSealedResponse(raw)) throw new Error("service returned a sealed response to a clear request");

    const sealedOnWire = isSealedResponse(raw);
    const opened: ScanResponseBody = env ? open<ScanResponseBody>((raw as SealedEnvelopeResponse).sealed, env.replySecret) : (raw as ClearResponse);
    const receipt = raw.receipt;
    const attestations = opened.attestations ?? [];
    // An attestation count that doesn't match the vault count, an attestation for a
    // vault that isn't in the response, or two attestations naming the same vault are
    // all unverified results even if every attestation present carries a valid
    // signature. Requiring distinct vault ids alongside the count and membership
    // checks makes the attestation set a bijection with the returned vaults, so every
    // vault is provably attested exactly once.
    const vaultIds = new Set(opened.vaults.map(v => v.id));
    const attestedIds = new Set(attestations.map(a => a.vaultId));
    const attestationsValid =
      attestations.length === opened.vaults.length &&
      attestedIds.size === attestations.length &&
      attestations.every(a => vaultIds.has(a.vaultId) && verifyAttestation(a, d.sigPk));

    // A correctly signed receipt still isn't a receipt for *this* purchase unless it
    // commits to the request that was sent and the body that came back — otherwise a
    // service could replay any previously signed receipt against any response — and
    // unless the price it states is the price that was quoted.
    const price = checkSettledPrice(rail, receipt, quoteAtomic, settledAtomic);
    const receiptValid =
      verifyReceipt(receipt, d.sigPk) &&
      receipt.request_hash === requestHash(request) &&
      receipt.response_hash === responseHash({ vaults: opened.vaults, reports: opened.reports, attestations }) &&
      price.agrees;

    return {
      rail,
      tier,
      vaults: opened.vaults,
      reports: opened.reports,
      attestations,
      receipt,
      receiptValid,
      attestationsValid,
      txId,
      // The receipt's figure, not the agent's own arithmetic restated: this is the number
      // that ends up cited in run records, so it has to be the one the service signed.
      priceUsd: price.priceUsd,
      // Read off the response that actually arrived, not off what the client asked
      // for. The two throw-guards above already reject a mismatch, so this can only
      // agree with `!!env` — stating it this way keeps the reported value tied to an
      // observation rather than to intent, even if those guards are ever relaxed.
      sealed: sealedOnWire,
    };
  }

  /** Buys a risk scan of `vaults` (each `"<chainId>:<address>"`) on `rail`. Sealed by
   *  default; pass `{ seal: false }` for the `cheap` privacy tier. */
  async scan(vaults: string[], rail: Rail, opts: { seal?: boolean } = {}): Promise<PaidResult> {
    const d = await this.ensureDiscovery();
    const url = rail === "hedera" ? d.card.endpoints.hedera.scan : d.card.endpoints.arc.scan[arcBucket(vaults.length)];
    return this.paid(rail, "scan", url, { vaults }, vaults.length, opts.seal ?? true);
  }

  /** Buys the full risk table for one protocol on one chain, on `rail`. Always sealed. */
  async table(protocol: string, chainId: string, rail: Rail): Promise<PaidResult> {
    const d = await this.ensureDiscovery();
    const url = rail === "hedera" ? d.card.endpoints.hedera.table : d.card.endpoints.arc.table;
    return this.paid(rail, "table", url, { protocol, chainId }, 0, true);
  }
}
