/**
 * The paid-scan handler behind `POST /api/scan`: the one place in this app that
 * spends money.
 *
 * Lives in `lib/` rather than in the route file so its dependencies are
 * injectable and `test/scan.test.ts` can drive it against an in-process service
 * with a non-paying `payingFetch`, exactly the way `packages/agent`'s own client
 * tests do. `app/api/scan/route.ts` is a one-line wrapper over `handleScan`.
 *
 * Secrets discipline: `AGENT_HEDERA_ACCOUNT_ID` and `AGENT_HEDERA_KEY` are read
 * here, handed straight to `VaultRadarClient`, and never written to a response,
 * a log line, or the run file. `RunRecord` has no field that could hold them.
 * Every error that leaves this module goes through `redact` first, because a
 * third-party SDK's exception text is not something to trust with a private key.
 */

import { randomBytes } from "node:crypto";
import { VaultRadarClient, saveRun } from "@vaultradar/agent";
import { receiptHash } from "@vaultradar/core";
import { applyAgeCheck, decide } from "./decide";
import { RateLimiter, clientKey, scanLimiter } from "./ratelimit";
import { runsDir as defaultRunsDir } from "./runs";
import { getServiceUrl } from "./service";
import type { RunRecord } from "./types";
import { parseVaultList } from "./vaults";

/**
 * A hard per-scan ceiling, checked against the quote before anything is paid.
 * The metered price tops out at 0.051 USD for the maximum 100 vaults, so this
 * never rejects a legitimate request; it is a stop against a pricing change or a
 * count bug quietly spending more than intended.
 *
 * TODO: replace with the policy budget from `loadPolicy`/`chooseRail` in
 * `packages/agent/src/policy.ts` once that lands, which is what spec §13.2 asks
 * for. Until then this ceiling is the only cap, and the run file records it as
 * the budget so the record matches what was actually enforced.
 */
export const MAX_PRICE_USD = "0.10";

/**
 * The dashboard's own freshness bar, applied to the signed attestation
 * timestamps. Matches the agent policy's documented default.
 *
 * TODO: read from the loaded policy's `max_age_seconds` alongside the budget.
 */
export const MAX_AGE_SECONDS = 900;

export type ScanDeps = {
  /** Tests inject a client with `payingFetch: fetch` and a stub `readPqHash`. */
  makeClient: (serviceUrl: string, hedera: { accountId: string; privateKey: string }) => VaultRadarClient;
  runsDir: () => string;
  limiter: RateLimiter;
  /** Seconds since the epoch, for the age check. */
  now: () => number;
  env: Record<string, string | undefined>;
};

function defaultDeps(): ScanDeps {
  return {
    makeClient: (serviceUrl, hedera) => new VaultRadarClient({ serviceUrl, hedera }),
    runsDir: defaultRunsDir,
    limiter: scanLimiter,
    now: () => Math.floor(Date.now() / 1000),
    env: process.env,
  };
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

  // 1. Can this dashboard pay at all? Answered first, so a misconfigured deploy
  //    never looks like a bad request.
  const accountId = deps.env.AGENT_HEDERA_ACCOUNT_ID?.trim();
  const privateKey = deps.env.AGENT_HEDERA_KEY?.trim();
  if (!accountId || !privateKey) {
    return json({ error: "agent keys not configured" }, 503);
  }
  const secrets = [privateKey, accountId];

  // 2. Validate the request before touching the rate limiter, so a typo does not
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

  // 3. Price the request and refuse an unexpectedly expensive one before paying.
  const quote = await client.quote(parsed.vaults.length);
  if (quote.hedera === null) {
    return json({ error: "the hedera rail is not configured on this dashboard" }, 503);
  }
  if (Number(quote.hedera) > Number(MAX_PRICE_USD)) {
    return json(
      { error: `the quote of ${quote.hedera} USD for ${parsed.vaults.length} vaults exceeds this dashboard's per-scan ceiling of ${MAX_PRICE_USD} USD` },
      400,
    );
  }

  // 4. Only now spend the caller's rate-limit window, since every check above is
  //    free and deterministic.
  const limit = deps.limiter.check(clientKey(req));
  if (!limit.allowed) {
    return json(
      { error: `one paid scan per 30 seconds; try again in ${limit.retryAfterSeconds}s` },
      429,
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

  // 5. Verify who is being paid before paying them. An unsigned or substituted
  //    card means discovery cannot be trusted, which is the whole point of
  //    anchoring the key hash on chain.
  const startedAt = new Date().toISOString();
  let discovery: Awaited<ReturnType<VaultRadarClient["discover"]>>;
  try {
    discovery = await client.discover();
  } catch (e) {
    return json({ error: `could not reach or verify the service: ${redact(e, secrets)}` }, 502);
  }
  if (!discovery.cardSignatureValid) {
    return json({ error: "the service's agent card signature did not verify; refusing to pay" }, 502);
  }
  const substituted = discovery.onChain.filter((o) => o.matches === false);
  if (substituted.length > 0) {
    return json(
      {
        error: `the service's on-chain ERC-8004 key hash does not match the key on its card (chain ${substituted
          .map((o) => o.chainId)
          .join(", ")}); refusing to pay`,
      },
      502,
    );
  }

  // 6. Pay. Sealed scan on the hedera rail.
  //    TODO: `chooseRail` and `chooseTier` from the agent's policy module decide
  //    these two from the operator's policy; this dashboard only ever holds a
  //    Hedera payment key, so the rail is fixed and the tier is the sealed scan
  //    that a "balanced" privacy policy would pick.
  let result: Awaited<ReturnType<VaultRadarClient["scan"]>>;
  try {
    result = await client.scan(parsed.vaults, "hedera", { seal: true });
  } catch (e) {
    const message = redact(e, secrets);
    console.error(`[api/scan] paid scan failed: ${message}`);
    return json({ error: `the paid scan failed: ${message}` }, 502);
  }

  // 7. The data is only worth showing if its signatures check out. Fail closed,
  //    but still save the run: a service that answers with an unverifiable
  //    receipt is exactly the thing an operator needs the evidence for.
  const hash = receiptHash(result.receipt);
  const age = applyAgeCheck(result, MAX_AGE_SECONDS, deps.now());
  const record = buildRecord({ result, discovery, hash, age, serviceUrl, startedAt });
  try {
    saveRun(deps.runsDir(), record);
  } catch (e) {
    // A run that cannot be persisted is not a reason to withhold a paid answer.
    console.error(`[api/scan] could not write the run file: ${redact(e, secrets)}`);
  }

  if (!result.receiptValid) {
    return json({ error: "the payment settled but the service's receipt signature did not verify", runId: record.id }, 502);
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
}

function buildRecord({
  result,
  discovery,
  hash,
  age,
  serviceUrl,
  startedAt,
}: {
  result: Awaited<ReturnType<VaultRadarClient["scan"]>>;
  discovery: Awaited<ReturnType<VaultRadarClient["discover"]>>;
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
    policy: {
      // What this route actually enforced, not a file it did not read. See the
      // TODOs on MAX_PRICE_USD and MAX_AGE_SECONDS.
      budget: { usdc_hedera: MAX_PRICE_USD, usdc_arc: "0" },
      privacy: "balanced",
      rail_preference: "hedera",
      max_age_seconds: MAX_AGE_SECONDS,
    },
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
    decisions: decide(result, age, hash),
  };
}
