import type { Deployment } from "./types";

export type Meta = { block: string; timestamp: string; hasIndexingErrors: boolean };

export function gatewayUrl(d: Deployment): string {
  return d.deploymentId
    ? `https://gateway.thegraph.com/api/deployments/id/${d.deploymentId}`
    : `https://gateway.thegraph.com/api/subgraphs/id/${d.subgraphId}`;
}

/**
 * Page size for the Messari standardized queries. The `scan` tier filters the fetched
 * page down to the vaults the caller asked about, so any vault outside the first page is
 * invisible to it — at 50 a large protocol's deployment silently hid most of its vaults
 * and a legitimate holding came back as "not found" rather than as data. 200 covers every
 * deployment in the registry with room to spare while staying inside the gateway's
 * per-query limits. Used as the default here and passed explicitly by `fetchStandardized`.
 */
export const PAGE_SIZE = 200;

export async function queryDeployment<T>(
  d: Deployment,
  query: string,
  apiKey: string,
  variables: Record<string, unknown> = { first: PAGE_SIZE },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20000,
): Promise<{ data: T; meta: Meta }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(gatewayUrl(d), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const j = (await res.json()) as {
      data?: T & { _meta: { block: { number: number; timestamp: number }; hasIndexingErrors: boolean } };
      errors?: { message: string }[];
    };
    if (j.errors?.length || !j.data) throw new Error(`graphql: ${j.errors?.map(e => e.message).join("; ") ?? "no data"}`);
    const m = j.data._meta;
    return { data: j.data, meta: { block: String(m.block.number), timestamp: String(m.block.timestamp), hasIndexingErrors: m.hasIndexingErrors } };
  } finally {
    clearTimeout(t);
  }
}
