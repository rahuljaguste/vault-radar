/**
 * The paid-scan handler behind `POST /api/scan`: the one place in this app that
 * spends money.
 *
 * Lives in `lib/` rather than in the route file so its dependencies are
 * injectable and `test/scan.test.ts` can drive it against an in-process service
 * with a non-paying `payingFetch`, exactly the way `packages/agent`'s own client
 * tests do. `app/api/scan/route.ts` is a one-line wrapper over `handleScan`.
 *
 * The decision logic is the agent's, not a copy of it: `loadPolicy`,
 * `chooseTier`, `applyAgeCheck` and `decide` all come from
 * `packages/agent/src/policy.ts`, so a purchase made from the browser obeys the
 * same operator policy and produces the same `RunRecord` as one made by the
 * agent's watch loop.
 *
 * Secrets discipline: `AGENT_HEDERA_ACCOUNT_ID` and `AGENT_HEDERA_KEY` are read
 * here, handed straight to `VaultRadarClient`, and never written to a response,
 * a log line, or the run file. `RunRecord` has no field that could hold them.
 * Every error that leaves this module goes through `redact` first, because a
 * third-party SDK's exception text is not something to trust with a private key.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  VaultRadarClient,
  applyAgeCheck,
  chooseTier,
  decide,
  identityRefusal,
  loadPolicy,
  saveRun,
  type Policy,
} from "@vaultradar/agent";
import { receiptHash } from "@vaultradar/core";
import { RateLimiter, clientKey, scanLimiter } from "./ratelimit";
import { repoRoot, runsDir as defaultRunsDir } from "./runs";
import { getServiceUrl } from "./service";
import { SpendLedger, scanSpendLedger, usdToMicro } from "./spend";
import type { RunRecord } from "./types";
import { parseVaultList } from "./vaults";

/** Same default as `.env.example` and the agent CLI, resolved against the repo root. */
export function defaultPolicyPath(): string {
  return path.join(repoRoot(), "packages", "agent", "policy.example.json");
}

/**
 * A second, policy-independent ceiling on one purchase. The policy budget and this
 * ceiling are both per-purchase; neither bounds the total, which is what
 * `lib/spend.ts`'s ledger is for. This one guards the case where a policy is
 * written with a budget far larger than any scan should ever cost, so a pricing
 * change or a count bug cannot quietly spend it. The metered price tops out at
 * 0.051 USD for the maximum 100 vaults, so this never rejects a legitimate request.
 */
export const MAX_PRICE_USD = "0.10";

/**
 * USD decimal strings compared as integer micro-USD, the convention
 * `packages/agent/src/watch.ts` uses for the same reason. With this service's
 * own single-vault price, `0.0015 * 3` in binary floats is
 * `0.0045000000000000005`, which compares greater than a budget of `"0.0045"`
 * and would refuse a purchase the policy allows. USDC has 6 decimals, so
 * micro-USD is exact for every amount either side can legitimately hold.
 */
export function toMicroUsd(usd: string): number {
  return Math.round(Number(usd) * 1e6);
}

export type ScanDeps = {
  /** Tests inject a client with `payingFetch: fetch` and a stub `readPqHash`. */
  makeClient: (serviceUrl: string, hedera: { accountId: string; privateKey: string }) => VaultRadarClient;
  runsDir: () => string;
  policyPath: () => string;
  limiter: RateLimiter;
  /** Aggregate spend and scan-count limits across every caller; see `lib/spend.ts`. */
  ledger: SpendLedger;
  /** Seconds since the epoch, for the age check. */
  now: () => number;
  env: Record<string, string | undefined>;
};

function defaultDeps(): ScanDeps {
  return {
    makeClient: (serviceUrl, hedera) => new VaultRadarClient({ serviceUrl, hedera }),
    runsDir: defaultRunsDir,
    policyPath: () => {
      const fromEnv = process.env.POLICY_PATH?.trim();
      return fromEnv ? path.resolve(repoRoot(), fromEnv) : defaultPolicyPath();
    },
    limiter: scanLimiter(),
    ledger: scanSpendLedger(),
    now: () => Math.floor(Date.now() / 1000),
    env: process.env,
  };
}

/**
 * Optional bearer gate on the whole route. When `SCAN_ACCESS_TOKEN` is set, a request
 * without `Authorization: Bearer <token>` is 401 and nothing is spent; when it is unset
 * the route stays open, because the spec's promised flow is a visitor pressing "Scan now"
 * on a public page and the aggregate caps are what make that safe. A deployment that would
 * rather not fund strangers sets the token.
 *
 * Compared in constant time over equal-length strings, and the token is never echoed back
 * or logged — a 401 says only that the header was missing or wrong.
 */
function accessDenied(req: Request, env: Record<string, string | undefined>): boolean {
  const expected = env.SCAN_ACCESS_TOKEN?.trim();
  if (!expected) return false;
  const header = req.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const presented = match?.[1]?.trim() ?? "";
  if (presented.length !== expected.length) return true;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff !== 0;
}

const json = (body: unknown, status: number, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * Strips anything secret out of a message before it is returned or logged, and
 * bounds its length. Short values are left alone: redacting a 3-character string
 * would mangle unrelated text without protecting anything.
 */
export function redact(value: unknown, secrets: (string | undefined)[]): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    const bare = secret.replace(/^0x/, "");
    // Longest form first, so a `0x`-prefixed occurrence is swallowed whole rather
    // than leaving a stray `0x` behind.
    for (const form of [`0x${bare}`, secret, bare].sort((a, b) => b.length - a.length)) {
      message = message.split(form).join("[redacted]");
    }
  }
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

/** Pulls a vault list out of an untrusted body, accepting an array or raw text. */
function vaultText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { vaults?: unknown }).vaults;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join("\n");
  return null;
}

export async function handleScan(req: Request, overrides: Partial<ScanDeps> = {}): Promise<Response> {
  const deps = { ...defaultDeps(), ...overrides };

  // 0. The optional access gate, ahead of everything else: when a deployment has set a
  //    token, an unauthenticated caller learns nothing about this dashboard's
  //    configuration, not even whether it has payment keys.
  if (accessDenied(req, deps.env)) {
    return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="vaultradar-scan"' });
  }

  // 1. Can this dashboard pay at all? Answered first, so a misconfigured deploy
  //    never looks like a bad request.
  const accountId = deps.env.AGENT_HEDERA_ACCOUNT_ID?.trim();
  const privateKey = deps.env.AGENT_HEDERA_KEY?.trim();
  if (!accountId || !privateKey) {
    return json({ error: "agent keys not configured" }, 503);
  }
  const secrets = [privateKey, accountId];

  // 2. The operator's standing instructions. `loadPolicy` throws with the offending
  //    field named rather than inferring a spending cap, so a policy problem is a
  //    configuration error and never a silent default.
  let policy: Policy;
  try {
    policy = loadPolicy(deps.policyPath());
  } catch (e) {
    console.error(`[api/scan] policy unusable: ${redact(e, secrets)}`);
    return json({ error: `the agent policy could not be loaded: ${redact(e, secrets)}` }, 503);
  }

  // A `strict` privacy policy buys the whole protocol table so the vendor never
  // learns which vault is held. That needs a protocol and chain id, which a vault
  // list does not supply, and quietly downgrading to a scan would disclose exactly
  // what the policy exists to hide.
  const tier = chooseTier(policy);
  if (tier.tier !== "scan") {
    return json(
      { error: `the policy's "${policy.privacy}" privacy tier buys whole protocol tables, which this page cannot request from a vault list; use the agent CLI for table purchases` },
      503,
    );
  }

  // 3. Validate the request before touching the rate limiter, so a typo does not
  //    cost the caller their 30-second window.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "request body must be JSON" }, 400);
  }
  const text = vaultText(body);
  if (text === null) {
    return json({ error: 'expected a JSON body of { "vaults": ["<chainId>:0x<40 hex address>", ...] }' }, 400);
  }
  const parsed = parseVaultList(text);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const serviceUrl = deps.env.SERVICE_URL?.trim() ? deps.env.SERVICE_URL.trim().replace(/\/$/, "") : getServiceUrl();

  let client: VaultRadarClient;
  try {
    client = deps.makeClient(serviceUrl, { accountId, privateKey });
  } catch (e) {
    // A malformed AGENT_HEDERA_KEY throws here, inside the Hedera SDK's key parser.
    console.error(`[api/scan] could not build the paying client: ${redact(e, secrets)}`);
    return json({ error: "the agent payment key could not be loaded" }, 503);
  }

  // 4. Price the purchase and refuse it before paying if either cap says no: the
  //    policy's budget for this rail, then the absolute per-scan ceiling. The
  //    agent's `chooseRail` additionally weighs wallet balance and facilitator
  //    health across both rails; this dashboard only ever holds a Hedera key, so
  //    the rail is fixed and the budget is the gate that matters here.
  const quote = await client.quote(parsed.vaults.length);
  if (quote.hedera === null) {
    return json({ error: "the hedera rail is not configured on this dashboard" }, 503);
  }
  const quoteMicro = toMicroUsd(quote.hedera);
  if (quoteMicro > toMicroUsd(policy.budget.usdc_hedera)) {
    // A short machine-readable code: the caller knows the quote and the budget it
    // configured, and `/portfolio` turns this into a sentence for the reader.
    return json({ error: "over_budget", quoteUsd: quote.hedera, budgetUsd: policy.budget.usdc_hedera }, 400);
  }
  if (quoteMicro > toMicroUsd(MAX_PRICE_USD)) {
    return json({ error: "over_per_scan_ceiling", quoteUsd: quote.hedera, ceilingUsd: MAX_PRICE_USD }, 400);
  }

  // 5. The aggregate caps, which are the ones that actually bound the bill: would this
  //    purchase take the rolling 24-hour total past `DASHBOARD_SPEND_CAP_USD`, or is the
  //    global hourly scan allowance already used up?
  //
  //    Reserved, not merely checked. Everything from here to the payment awaits — discovery
  //    is a network round trip and so is the purchase — and a check whose effect lands only
  //    afterwards is no cap at all against requests that arrive together: each would see an
  //    empty ledger, each would pass, and each would pay. `reserve` holds the quote
  //    synchronously, so a concurrent caller sees it held before it looks.
  const reservation = deps.ledger.reserve(quoteMicro);
  if (!reservation.ok) {
    // 429, not 400: the request is fine, the deployment is simply out of allowance for now.
    return json({ error: reservation.refusal.reason, ...reservation.refusal }, 429);
  }
  // Released by the `finally` below on every path that provably did not pay; the one path
  // whose outcome is unknown (a throw out of `client.scan`) settles instead.
  let settled = false;
  try {
    // 6. Only now spend the caller's rate-limit window, since every check above is
    //    free and deterministic.
    const limit = deps.limiter.check(clientKey(req, deps.env));
    if (!limit.allowed) {
      return json(
        { error: `one paid scan per 30 seconds; try again in ${limit.retryAfterSeconds}s` },
        429,
        { "retry-after": String(limit.retryAfterSeconds) },
      );
    }

    // 7. Verify who is being paid before paying them. An unsigned or substituted
    //    card means discovery cannot be trusted, which is the whole point of
    //    anchoring the key hash on chain.
    //
    //    The rule itself is the agent's `identityRefusal`, imported rather than restated:
    //    a browser-initiated purchase and an agent-initiated one must refuse the same
    //    services, and this route previously refused strictly less (it passed a card with
    //    no ERC-8004 identity at all, and one whose every on-chain read failed — both of
    //    which leave the key unanchored). Its sentences already read the way this route's
    //    own did, so the returned reason is used verbatim as the error text.
    const startedAt = new Date().toISOString();
    let discovery: Awaited<ReturnType<VaultRadarClient["discover"]>>;
    try {
      discovery = await client.discover();
    } catch (e) {
      return json({ error: `could not reach or verify the service: ${redact(e, secrets)}` }, 502);
    }
    const refusal = identityRefusal(discovery);
    if (refusal) {
      return json({ error: refusal }, 502);
    }

    // 8. Pay, sealed or clear exactly as the policy's privacy tier dictates.
    let result: Awaited<ReturnType<VaultRadarClient["scan"]>>;
    try {
      result = await client.scan(parsed.vaults, "hedera", { seal: tier.seal });
    } catch (e) {
      const message = redact(e, secrets);
      console.error(`[api/scan] paid scan failed: ${message}`);
      // The payment may or may not have gone through — `client.scan` throws both for a
      // refused 402 (nothing spent) and for a failure after the transfer was signed. Settle
      // the reservation at the quote rather than releasing it: an unknown outcome has to
      // count against the cap, or a rail that fails after paying would be an unmetered way
      // to drain the wallet.
      deps.ledger.settle(reservation.id, quoteMicro);
      settled = true;
      // Record the failure as a run too, so the attempt is visible in `/runs` instead of
      // vanishing. There is no tx id and no receipt to build a `RunRecord`'s `requests[]`
      // from, so the run carries the reason as an `insufficient data` decision per vault —
      // `RunRecord`'s own vocabulary for "paid, nothing trustworthy came back".
      const failed = buildFailedRecord({ vaults: parsed.vaults, discovery, policy, serviceUrl, startedAt, txId: null, reason: `the paid scan failed: ${message}` });
      persist(deps, failed, secrets);
      return json({ error: `the paid scan failed: ${message}`, runId: failed.id }, 502);
    }

    // 9. The purchase happened: settle the reservation immediately, before anything else
    //    can throw or return, at the greater of the quote and the price the receipt states.
    //
    //    The max matters. The receipt's figure is the payee's own statement, and this is a
    //    spending cap — a service that answered every purchase with `price: "0"` would
    //    otherwise consume no allowance at all while still being paid the quote, turning
    //    the cap off entirely. The agent refuses a receipt whose price disagrees with the
    //    quote (`receiptValid` goes false below), but that refusal comes after the money
    //    moved, so the ledger must not take the lower number on trust. A figure *above*
    //    the quote is recorded as stated: that is the service claiming to have charged
    //    more, which the cap should believe.
    deps.ledger.settle(reservation.id, chargedMicroUsd(quoteMicro, result.priceUsd));
    settled = true;

    // 10. The data is only worth showing if its signatures check out. Fail closed,
    //     but still save the run: a service that answers with an unverifiable
    //     receipt is exactly the thing an operator needs the evidence for.
    const hash = receiptHash(result.receipt);
    const age = applyAgeCheck(result, policy, deps.now());
    const record = buildRecord({ result, discovery, policy, hash, age, serviceUrl, startedAt });
    persist(deps, record, secrets);

    if (!result.receiptValid) {
      return json({ error: "the payment settled but the service's receipt did not verify", runId: record.id }, 502);
    }
    if (!result.attestationsValid) {
      return json({ error: "the payment settled but the per-vault attestations did not verify", runId: record.id }, 502);
    }

    return json(
      {
        runId: record.id,
        requests: record.requests,
        decisions: record.decisions,
        txId: record.requests[0].txId,
        receiptHash: hash,
        priceUsd: result.priceUsd,
      },
      200,
    );
  } finally {
    // Any exit that did not reach a settle provably did not pay: an early 4xx/5xx above, or
    // an unexpected throw from code that all runs before `client.scan`. Give the allowance
    // back so a failed discovery does not eat into the day's budget.
    if (!settled) deps.ledger.release(reservation.id);
  }
}

/**
 * What to charge the ledger for a completed purchase: never less than the quote, and more
 * only when the receipt says so. `priceUsd` is absent or unreadable for a receipt this
 * service mangled, and an unreadable figure must not read as zero.
 */
export function chargedMicroUsd(quoteMicro: number, receiptPriceUsd: string | null): number {
  if (!receiptPriceUsd) return quoteMicro;
  const stated = usdToMicro(receiptPriceUsd);
  return Number.isFinite(stated) ? Math.max(quoteMicro, stated) : quoteMicro;
}

/** Writes a run, treating a write failure as a logged problem rather than a reason to
 * withhold (or change) the answer the caller already paid for. */
function persist(deps: ScanDeps, record: RunRecord, secrets: (string | undefined)[]): void {
  try {
    saveRun(deps.runsDir(), record);
  } catch (e) {
    console.error(`[api/scan] could not write the run file: ${redact(e, secrets)}`);
  }
}

/**
 * A run record for a purchase that failed *after* the request went out, where there is no
 * receipt to build a `requests[]` entry from.
 *
 * `RunRecord` has no field for "this attempt failed", and inventing one would break the
 * cross-package contract `lib/types.ts` holds with the agent. It does have a vocabulary for
 * exactly this situation: a `decisions[]` entry of `insufficient data` with a reason, which
 * is what the agent itself emits whenever it cannot stand behind a vault's data. So the
 * failure is recorded the way the agent would record it — one `insufficient data` decision
 * per vault asked about, carrying the redacted reason, and whatever payment reference is
 * known. `requests` stays empty, which is itself the signal that nothing verifiable came
 * back.
 */
function buildFailedRecord({
  vaults,
  discovery,
  policy,
  serviceUrl,
  startedAt,
  txId,
  reason,
}: {
  vaults: string[];
  discovery: Awaited<ReturnType<VaultRadarClient["discover"]>>;
  policy: Policy;
  serviceUrl: string;
  startedAt: string;
  txId: string | null;
  reason: string;
}): RunRecord {
  return {
    id: `web-${randomBytes(6).toString("hex")}`,
    startedAt,
    serviceUrl,
    policy,
    discovery: {
      cardSignatureValid: discovery.cardSignatureValid,
      pubHash: discovery.card.pq.sig.pub_hash,
      kid: discovery.card.pq.kem.kid,
      onChain: discovery.onChain,
    },
    requests: [],
    decisions: vaults.map((vaultId) => ({
      vaultId,
      action: "insufficient data" as const,
      reason,
      citations: { block: "", source: "", txId, receiptHash: "" },
    })),
  };
}

function buildRecord({
  result,
  discovery,
  policy,
  hash,
  age,
  serviceUrl,
  startedAt,
}: {
  result: Awaited<ReturnType<VaultRadarClient["scan"]>>;
  discovery: Awaited<ReturnType<VaultRadarClient["discover"]>>;
  policy: Policy;
  hash: string;
  age: ReturnType<typeof applyAgeCheck>;
  serviceUrl: string;
  startedAt: string;
}): RunRecord {
  // `result.txId` comes from the x402 `payment-response` header; the receipt's
  // own `payment.txId` is signed by the service. Prefer the header and fall back
  // to the receipt, so a run is never recorded without the reference it has.
  const txId = result.txId ?? (result.receipt.payment.txId || null);

  return {
    id: `web-${randomBytes(6).toString("hex")}`,
    startedAt,
    serviceUrl,
    policy,
    discovery: {
      cardSignatureValid: discovery.cardSignatureValid,
      pubHash: discovery.card.pq.sig.pub_hash,
      kid: discovery.card.pq.kem.kid,
      onChain: discovery.onChain,
    },
    requests: [
      {
        rail: result.rail,
        tier: result.tier,
        sealed: result.sealed,
        priceUsd: result.priceUsd,
        txId,
        receiptHash: hash,
        receipt: result.receipt,
        verdicts: result.reports.map((r) => ({
          vaultId: r.vaultId,
          verdict: r.verdict,
          score: r.score,
          flags: r.flags.map((f) => ({ name: f.name, value: f.value, threshold: f.threshold, window: f.window })),
        })),
        rejected: age.rejected,
      },
    ],
    decisions: decide(result, age),
  };
}
