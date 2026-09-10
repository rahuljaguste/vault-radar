import { GatewayClient } from "@circle-fin/x402-batching/client";

/** Hedera testnet mirror node, the read API for account state. */
export const HEDERA_MIRROR_URL = "https://testnet.mirrornode.hedera.com";
/** USDC on Hedera testnet (6 decimals), the asset every Hedera x402 route is priced in. */
export const HEDERA_USDC_TOKEN_ID = "0.0.429274";
/** Blocky402, the Hedera x402 facilitator that settles the rail's payments. */
export const BLOCKY402_URL = "https://api.testnet.blocky402.com";
/** Circle Gateway testnet, the Arc rail's facilitator. */
export const CIRCLE_GATEWAY_URL = "https://gateway-api-testnet.circle.com";

const USDC_DECIMALS = 6;

/**
 * Renders an atomic USDC amount (6 decimals) as a plain decimal string, e.g.
 * `"1500000"` -> `"1.5"`. Done with string arithmetic rather than `Number` division so
 * a large balance can't lose low-order digits, and so the result compares directly
 * against the USD-denominated quotes `VaultRadarClient.quote()` returns.
 */
export function formatUsdc(atomic: string): string {
  if (!/^\d+$/.test(atomic)) return "0";
  const padded = atomic.padStart(USDC_DECIMALS + 1, "0");
  const whole = padded.slice(0, -USDC_DECIMALS);
  const frac = padded.slice(-USDC_DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export type ProbeOpts = { fetchImpl?: typeof fetch };

/**
 * Reads the agent's USDC balance on Hedera from the mirror node, as a USD decimal
 * string. An account that has never held the token returns an empty `tokens` array,
 * which is a real zero rather than an error. A mirror-node failure also reports `"0"`:
 * an unknown balance must never be treated as spendable, and `chooseRail` reads a
 * balance below the quote as "rail unusable", which is the safe outcome.
 */
export async function hederaUsdcBalance(
  accountId: string,
  opts: ProbeOpts & { mirrorUrl?: string; tokenId?: string } = {},
): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const mirror = (opts.mirrorUrl ?? HEDERA_MIRROR_URL).replace(/\/$/, "");
  const token = opts.tokenId ?? HEDERA_USDC_TOKEN_ID;
  try {
    const res = await f(`${mirror}/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?token.id=${encodeURIComponent(token)}`);
    if (!res.ok) return "0";
    const body = (await res.json()) as { tokens?: { token_id?: string; balance?: number | string }[] };
    const entry = body.tokens?.[0];
    if (!entry || entry.balance == null) return "0";
    return formatUsdc(String(entry.balance));
  } catch {
    return "0";
  }
}

/**
 * Reads the agent's *available* Circle Gateway balance on Arc as a USD decimal string.
 * `getGatewayBalance` is private in the installed `@circle-fin/x402-batching` types, so
 * this goes through the public `getBalances()` and takes `gateway.formattedAvailable` —
 * the spendable figure, excluding anything mid-withdrawal. Talks to Arc testnet, so it
 * is never exercised by the test suite; `readBalances` accepts an override for that.
 */
export async function arcGatewayBalance(privateKey: `0x${string}`): Promise<string> {
  try {
    const gateway = new GatewayClient({ chain: "arcTestnet", privateKey });
    const balances = await gateway.getBalances();
    return balances.gateway.formattedAvailable;
  } catch {
    return "0";
  }
}

export type BalanceOpts = ProbeOpts & {
  hederaAccountId?: string | null;
  arcPrivateKey?: `0x${string}` | null;
  mirrorUrl?: string;
  tokenId?: string;
  /** Overrides the live Gateway read; tests inject a fake here. */
  arcBalance?: (privateKey: `0x${string}`) => Promise<string>;
};

/**
 * Spendable balance per rail, as USD decimal strings directly comparable with quotes.
 * A rail with no wallet configured reports `"0"`, which makes it unusable rather than
 * accidentally selectable.
 */
export async function readBalances(o: BalanceOpts): Promise<{ hedera: string; arc: string }> {
  const arcRead = o.arcBalance ?? arcGatewayBalance;
  const [hedera, arc] = await Promise.all([
    o.hederaAccountId ? hederaUsdcBalance(o.hederaAccountId, o) : Promise.resolve("0"),
    o.arcPrivateKey ? arcRead(o.arcPrivateKey) : Promise.resolve("0"),
  ]);
  return { hedera, arc };
}

export type HealthReport = {
  /** The VaultRadar service itself: `/health` answered 2xx with `ok: true`. */
  service: boolean;
  /** Blocky402, the Hedera facilitator. */
  hedera: boolean;
  /** Circle Gateway, the Arc facilitator. */
  arc: boolean;
  /** Anything the caller should know about how a verdict was reached. */
  notes: string[];
};

export type HealthOpts = ProbeOpts & {
  serviceUrl: string;
  facilitatorUrl?: string;
  gatewayUrl?: string;
};

/** 2xx, and when the body is JSON with an `ok` field, `ok !== false`. */
async function ok(f: typeof fetch, url: string): Promise<boolean> {
  try {
    const res = await f(url);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Probes everything a purchase depends on. Each rail's flag covers *its facilitator*
 * only; `service` is reported separately because a dead service fails discovery long
 * before a rail is chosen.
 *
 * Circle's Gateway publishes its x402 support list at `/v1/x402/supported`. If that
 * path 404s (the documented path has moved before), a 2xx on the API root is taken as
 * healthy and a note says so, rather than silently reporting the Arc rail as down and
 * quietly routing every purchase to Hedera.
 */
export async function readHealth(o: HealthOpts): Promise<HealthReport> {
  const f = o.fetchImpl ?? fetch;
  const notes: string[] = [];
  const service = o.serviceUrl.replace(/\/$/, "");
  const facilitator = (o.facilitatorUrl ?? BLOCKY402_URL).replace(/\/$/, "");
  const gateway = (o.gatewayUrl ?? CIRCLE_GATEWAY_URL).replace(/\/$/, "");

  const serviceOk = await (async () => {
    try {
      const res = await f(`${service}/health`);
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean };
      return body.ok !== false;
    } catch {
      return false;
    }
  })();

  const hederaOk = await ok(f, `${facilitator}/supported`);

  let arcOk = false;
  try {
    const res = await f(`${gateway}/v1/x402/supported`);
    if (res.status === 404) {
      arcOk = await ok(f, gateway);
      notes.push(`${gateway}/v1/x402/supported returned 404; treated a 2xx on the API root as healthy`);
    } else {
      arcOk = res.ok;
    }
  } catch {
    arcOk = false;
  }

  if (!serviceOk) notes.push(`${service}/health did not answer ok`);
  if (!hederaOk) notes.push(`${facilitator}/supported did not answer 2xx`);
  if (!arcOk) notes.push(`${gateway} did not answer 2xx`);

  return { service: serviceOk, hedera: hederaOk, arc: arcOk, notes };
}
