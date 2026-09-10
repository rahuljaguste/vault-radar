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
  status: "live" | "stale" | "down" | "unverified";
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

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function fetchCard(): Promise<AgentCard | null> {
  return getJson<AgentCard>(`${getServiceUrl()}/.well-known/agent.json`);
}

export function fetchCatalog(): Promise<Catalog | null> {
  return getJson<Catalog>(`${getServiceUrl()}/v1/catalog`);
}

export function fetchReceiptLookup(hash: string): Promise<ReceiptLookup | null> {
  return getJson<ReceiptLookup>(`${getServiceUrl()}/v1/receipts/${encodeURIComponent(hash)}`);
}
