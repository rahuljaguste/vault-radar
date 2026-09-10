/**
 * Server-side client for VaultRadar service's public endpoints.
 * All requests use `cache: "no-store"` — the dashboard always shows live data,
 * never a stale build-time snapshot (the service is not deployed at build time).
 */

export type AgentCard = {
  name: string;
  version: string;
  description: string;
  pq: {
    sig: { alg: string; public_key: string; pub_hash: string };
    kem: { alg: string; public_key: string; kid: string };
  };
  erc8004: { chainId: string; agentId: string }[];
  hcs: { topicId: string | null };
  endpoints: {
    hedera: { scan: string; scanHbar: string; table: string; network: string; asset: string };
    arc: { scan: { s: string; m: string; l: string }; table: string; network: string };
  };
  prices: {
    hedera_scan: string;
    hedera_scan_examples: Record<string, string>;
    arc_scan_buckets: Record<string, string>;
    table: string;
  };
  limits: { max_vaults: number; ts_window_seconds: number };
  docs: string;
  sig: { alg: string; pub_hash: string; value: string };
};

export type CatalogEntry = {
  protocol: string;
  chain: string;
  /** Mirrors `Deployment["status"]` in `@vaultradar/core`, including `repointed` — the
   * subgraph now resolves to a different deployment than the one the registry pins, which
   * the service reports as-is. */
  status: "live" | "stale" | "down" | "unverified" | "repointed";
  vaultCount: number;
};

export type Catalog = { protocols: CatalogEntry[]; erc4626Chains: string[] };

export type ReceiptLookup = {
  receipt_hash: string;
  topicId: string | null;
  sequence: string | null;
  consensus_timestamp: string | null;
  initial_transaction_id: string | null;
};

export function getServiceUrl(): string {
  return (process.env.SERVICE_URL ?? "http://localhost:8787").replace(/\/$/, "");
}

/**
 * How long a page will wait for the service before rendering without it.
 *
 * Every caller of `getJson` is a server component rendering a page, and `fetch` has no
 * default timeout: a service that accepts the connection and then never answers held the
 * request open until the platform's own (much longer) limit, so one unresponsive upstream
 * stalled the whole page rather than degrading it. Ten seconds is far above any healthy
 * response from these endpoints and well inside a visitor's patience.
 */
export const SERVICE_FETCH_TIMEOUT_MS = 10_000;

async function getJson<T>(url: string, timeoutMs: number = SERVICE_FETCH_TIMEOUT_MS): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // An abort surfaces here as well, and is treated the same as any other failure to
    // reach the service: the caller renders the "service unavailable" state.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// `timeoutMs` is only ever passed by `test/service-timeout.test.ts`, which shortens it so
// the abort path can be driven against a server that never answers without a ten-second
// wait. No page passes it.
export function fetchCard(timeoutMs?: number): Promise<AgentCard | null> {
  return getJson<AgentCard>(`${getServiceUrl()}/.well-known/agent.json`, timeoutMs);
}

export function fetchCatalog(timeoutMs?: number): Promise<Catalog | null> {
  return getJson<Catalog>(`${getServiceUrl()}/v1/catalog`, timeoutMs);
}

export function fetchReceiptLookup(hash: string, timeoutMs?: number): Promise<ReceiptLookup | null> {
  return getJson<ReceiptLookup>(`${getServiceUrl()}/v1/receipts/${encodeURIComponent(hash)}`, timeoutMs);
}
