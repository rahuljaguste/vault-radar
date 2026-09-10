/**
 * Server-side client for the service operator's metrics endpoint,
 * `GET /v1/admin/metrics` (spec §13.1), gated by `Authorization: Bearer
 * <ADMIN_TOKEN>`.
 *
 * Server-only by construction: `ADMIN_TOKEN` is read here and nowhere else, it
 * is never placed in a URL or returned in any result, and it carries no
 * `NEXT_PUBLIC_` prefix so Next.js substitutes `undefined` for it in any client
 * bundle that ever imported this module. `/admin` is a server component and
 * passes the rendered result down, never the token.
 */

import { getServiceUrl } from "./service";

/** Every numeric field is a string, per §13.1, so nothing is silently rounded. */
export type RailMetrics = {
  enabled: boolean;
  facilitatorUrl: string | null;
  healthy: boolean | null;
  checkedAt: string | null;
};

export type HcsMetrics = {
  enabled: boolean;
  topicId: string | null;
  pending: string;
  submitted: string;
  failed: string;
  lastSequence: string | null;
};

export type SettlementMetrics = {
  hedera: { count: string; revenueAtomic: string; asset: string };
  arc: { count: string; revenueUsd: string };
};

export type RequestMetrics = {
  scan: string;
  table: string;
  rejected4xx: string;
  unavailableVerdicts: string;
  lastRequestAt: string | null;
};

export type DeploymentMetrics = {
  protocol: string;
  chain: string;
  chainId: string;
  status: string;
  headLagSeconds: string | null;
  lastQueriedAt: string | null;
  lastError: string | null;
};

export type HeadMetrics = { ts: string; block: string; ok: boolean; checkedAt: string | null };

export type IdentityMetrics = {
  chainId: string;
  agentId: string;
  onChainPubHash: string | null;
  matches: boolean | null;
};

export type AdminMetrics = {
  uptimeSeconds: string;
  startedAt: string;
  rails: { hedera: RailMetrics; arc: RailMetrics };
  hcs: HcsMetrics;
  settlements: SettlementMetrics;
  requests: RequestMetrics;
  deployments: DeploymentMetrics[];
  heads: Record<string, HeadMetrics>;
  keys: { sigPubHash: string; kemKid: string };
  identity: IdentityMetrics[];
};

/**
 * Every way the admin page can fail, as data rather than an exception, so the
 * page renders the reason inline instead of showing an error boundary.
 *
 * `not-configured` and `unauthorized` are different problems with different
 * fixes (set `ADMIN_TOKEN` in the dashboard's environment vs. make it match the
 * service's), so they are separate states. `not-implemented` exists because the
 * endpoint is a separate task: a 404 from a service that is otherwise up is a
 * far more useful message than a bare "bad status".
 */
export type AdminResult =
  | { state: "ok"; metrics: AdminMetrics; fetchedAt: string }
  | { state: "not-configured" }
  | { state: "unauthorized" }
  | { state: "not-implemented"; url: string }
  | { state: "bad-status"; status: number; url: string }
  | { state: "malformed"; url: string }
  | { state: "unreachable"; url: string; detail: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Checks only that the containers are present and of the right kind, not that
 * every leaf has its final type. The endpoint is built by another task against
 * the same spec section; a missing leaf should render as a dash, not turn the
 * whole page into "malformed". The renderer reads leaves defensively for that
 * reason.
 */
function isAdminMetrics(v: unknown): v is AdminMetrics {
  if (!isRecord(v)) return false;
  if (!isRecord(v.rails) || !isRecord(v.rails.hedera) || !isRecord(v.rails.arc)) return false;
  if (!isRecord(v.hcs) || !isRecord(v.settlements) || !isRecord(v.requests)) return false;
  if (!isRecord(v.keys) || !isRecord(v.heads)) return false;
  if (!Array.isArray(v.deployments) || !Array.isArray(v.identity)) return false;
  return true;
}

/** The metrics URL. Public information — the token travels in a header, never here. */
export function adminMetricsUrl(): string {
  return `${getServiceUrl()}/v1/admin/metrics`;
}

/**
 * Fetches the metrics once. `cache: "no-store"` because these are live counters,
 * and a 5-second timeout because an unreachable service must not hold the page
 * render open until the platform's own limit.
 */
export async function fetchAdminMetrics(): Promise<AdminResult> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return { state: "not-configured" };

  const url = adminMetricsUrl();
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    // The message can name the URL and the socket error; it can never contain the
    // token, which only ever appears in a request header.
    return { state: "unreachable", url, detail: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 401 || res.status === 403) return { state: "unauthorized" };
  if (res.status === 404) return { state: "not-implemented", url };
  if (!res.ok) return { state: "bad-status", status: res.status, url };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: "malformed", url };
  }
  if (!isAdminMetrics(body)) return { state: "malformed", url };
  return { state: "ok", metrics: body, fetchedAt: new Date().toISOString() };
}
