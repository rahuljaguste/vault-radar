import type { ReactNode } from "react";
import { Table } from "../components/Table";
import { AutoRefresh } from "./AutoRefresh";
import {
  adminMetricsUrl,
  fetchAdminMetrics,
  type AdminMetrics,
  type AdminResult,
  type DeploymentMetrics,
  type HeadMetrics,
  type IdentityMetrics,
  type RailMetrics,
} from "@/lib/admin";

// Live operator counters: never prerendered, never cached.
export const dynamic = "force-dynamic";

export const metadata = { title: "VaultRadar — service metrics" };

export default async function AdminPage() {
  const result = await fetchAdminMetrics();

  return (
    <>
      <section>
        <h2>Service metrics</h2>
        <p className="muted">
          Operator view of the running service, read from <code>GET /v1/admin/metrics</code>. Every counter below lives in
          the service process and <strong>resets when the service restarts</strong>, so these are totals since{" "}
          {result.state === "ok" ? <code>{str(result.metrics.startedAt)}</code> : "the last restart"}, not all-time totals.
        </p>
        <AutoRefresh intervalMs={15_000} />
        {result.state === "ok" && (
          <p className="muted">
            fetched at <code>{result.fetchedAt}</code> from <code>{adminMetricsUrl()}</code>
          </p>
        )}
      </section>

      {result.state === "ok" ? <Metrics metrics={result.metrics} /> : <Unavailable result={result} />}
    </>
  );
}

/* ------------------------------------------------------------------ states */

/**
 * Every failure path renders inline, with the distinction that decides the fix:
 * a token this dashboard does not have, a token the service rejects, an endpoint
 * that is not deployed yet, and a service that cannot be reached at all are four
 * different problems. No message ever contains the token itself.
 */
function Unavailable({ result }: { result: Exclude<AdminResult, { state: "ok" }> }) {
  return (
    <section>
      <div className="card">
        {result.state === "not-configured" && (
          <>
            <p className="error">ADMIN_TOKEN is not set for this dashboard.</p>
            <p className="muted">
              Set <code>ADMIN_TOKEN</code> in the dashboard&apos;s environment to the same value the service was started
              with, then restart the dashboard. The token is read server-side only and is never sent to the browser.
            </p>
          </>
        )}
        {result.state === "unauthorized" && (
          <>
            <p className="error">The service rejected this dashboard&apos;s ADMIN_TOKEN.</p>
            <p className="muted">
              <code>{adminMetricsUrl()}</code> answered 401/403. The dashboard&apos;s <code>ADMIN_TOKEN</code> and the
              service&apos;s do not match.
            </p>
          </>
        )}
        {result.state === "not-implemented" && (
          <>
            <p className="error">This service has no admin metrics endpoint.</p>
            <p className="muted">
              <code>{result.url}</code> answered 404. The service is up but <code>GET /v1/admin/metrics</code> is not
              deployed on it yet, so there is nothing to show.
            </p>
          </>
        )}
        {result.state === "bad-status" && (
          <>
            <p className="error">The service answered {result.status}.</p>
            <p className="muted">
              <code>{result.url}</code> returned an unexpected status. Check the service logs.
            </p>
          </>
        )}
        {result.state === "malformed" && (
          <>
            <p className="error">The metrics response was not the expected shape.</p>
            <p className="muted">
              <code>{result.url}</code> answered, but the body is not the spec §13.1 metrics object. The dashboard and the
              service are out of sync.
            </p>
          </>
        )}
        {result.state === "unreachable" && (
          <>
            <p className="error">Endpoint unreachable.</p>
            <p className="muted">
              Could not reach <code>{result.url}</code>: {result.detail}. Check that the service is running and that{" "}
              <code>SERVICE_URL</code> points at it.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- metrics */

function Metrics({ metrics }: { metrics: AdminMetrics }) {
  const railRows: (RailMetrics & { rail: string })[] = [
    { rail: "hedera", ...metrics.rails.hedera },
    { rail: "arc", ...metrics.rails.arc },
  ];
  const headRows = Object.entries(metrics.heads ?? {}).map(([chainId, head]) => ({ chainId, ...(head as HeadMetrics) }));
  const uptime = humanUptime(metrics.uptimeSeconds);

  return (
    <>
      <section>
        <h2>Uptime</h2>
        <dl>
          <dt>Started at</dt>
          <dd>
            <code>{str(metrics.startedAt)}</code>
          </dd>
          <dt>Uptime seconds</dt>
          <dd>
            <code>{str(metrics.uptimeSeconds)}</code>
            {uptime && <span className="muted"> ({uptime})</span>}
          </dd>
        </dl>
      </section>

      <section>
        <h2>Payment rails</h2>
        <Table
          columns={[
            { key: "rail", label: "Rail" },
            { key: "enabled", label: "Enabled", render: (r) => <Flag value={r.enabled} on="enabled" off="disabled" /> },
            {
              key: "healthy",
              label: "Facilitator",
              render: (r) => <span className={healthTone(r.healthy)}>{healthLabel(r.healthy)}</span>,
            },
            { key: "facilitatorUrl", label: "Facilitator URL", render: (r) => <code>{str(r.facilitatorUrl)}</code> },
            { key: "checkedAt", label: "Checked at", render: (r) => str(r.checkedAt) },
          ]}
          rows={railRows}
          rowKey={(r) => r.rail}
        />
        <p className="muted">Health probes hit each facilitator&apos;s supported-kinds endpoint and are cached 30 seconds.</p>
      </section>

      <section>
        <h2>Requests</h2>
        <dl>
          <dt>Scan requests</dt>
          <dd>
            <code>{str(metrics.requests?.scan)}</code>
          </dd>
          <dt>Table requests</dt>
          <dd>
            <code>{str(metrics.requests?.table)}</code>
          </dd>
          <dt>Rejected (4xx)</dt>
          <dd>
            <span className={nonZeroTone(metrics.requests?.rejected4xx, "warn")}>
              <code>{str(metrics.requests?.rejected4xx)}</code>
            </span>
          </dd>
          <dt>Unavailable verdicts</dt>
          <dd>
            <span className={nonZeroTone(metrics.requests?.unavailableVerdicts, "warn")}>
              <code>{str(metrics.requests?.unavailableVerdicts)}</code>
            </span>
          </dd>
          <dt>Last request at</dt>
          <dd>{str(metrics.requests?.lastRequestAt)}</dd>
        </dl>
      </section>

      <section>
        <h2>Settlements</h2>
        <dl>
          <dt>Hedera</dt>
          <dd>
            <code>{str(metrics.settlements?.hedera?.count)}</code> settled, revenue{" "}
            <code>{str(metrics.settlements?.hedera?.revenueAtomic)}</code> atomic units of{" "}
            <code>{str(metrics.settlements?.hedera?.asset)}</code>
          </dd>
          <dt>Arc</dt>
          <dd>
            <code>{str(metrics.settlements?.arc?.count)}</code> settled, revenue{" "}
            <code>{str(metrics.settlements?.arc?.revenueUsd)}</code> USD
          </dd>
        </dl>
      </section>

      <section>
        <h2>HCS audit trail</h2>
        <dl>
          <dt>Enabled</dt>
          <dd>
            <Flag value={metrics.hcs?.enabled} on="enabled" off="disabled" />
          </dd>
          <dt>Topic</dt>
          <dd>
            <code>{str(metrics.hcs?.topicId)}</code>
          </dd>
          <dt>Pending</dt>
          <dd>
            <span className={nonZeroTone(metrics.hcs?.pending, "warn")}>
              <code>{str(metrics.hcs?.pending)}</code>
            </span>
          </dd>
          <dt>Submitted</dt>
          <dd>
            <code>{str(metrics.hcs?.submitted)}</code>
          </dd>
          <dt>Failed</dt>
          <dd>
            <span className={nonZeroTone(metrics.hcs?.failed, "error")}>
              <code>{str(metrics.hcs?.failed)}</code>
            </span>
          </dd>
          <dt>Last sequence</dt>
          <dd>
            <code>{str(metrics.hcs?.lastSequence)}</code>
          </dd>
        </dl>
      </section>

      <section>
        <h2>Standardized deployments</h2>
        <Table<DeploymentMetrics>
          columns={[
            { key: "protocol", label: "Protocol" },
            { key: "chain", label: "Chain" },
            { key: "chainId", label: "Chain id" },
            { key: "status", label: "Status", render: (d) => <span className={statusTone(d.status)}>{str(d.status)}</span> },
            { key: "headLagSeconds", label: "Head lag (s)", render: (d) => <code>{str(d.headLagSeconds)}</code> },
            { key: "lastQueriedAt", label: "Last queried" },
            {
              key: "lastError",
              label: "Last error",
              render: (d) => (d.lastError ? <span className="error">{d.lastError}</span> : <span className="muted">-</span>),
            },
          ]}
          rows={metrics.deployments ?? []}
          rowKey={(d, i) => `${d.protocol}-${d.chainId}-${i}`}
          empty="No deployments reported."
        />
      </section>

      <section>
        <h2>Chain heads</h2>
        <Table
          columns={[
            { key: "chainId", label: "Chain id" },
            { key: "ok", label: "RPC", render: (h) => <span className={healthTone(h.ok)}>{h.ok ? "ok" : "failing"}</span> },
            { key: "block", label: "Head block", render: (h) => <code>{str(h.block)}</code> },
            { key: "ts", label: "Head timestamp", render: (h) => <code>{str(h.ts)}</code> },
            { key: "checkedAt", label: "Checked at", render: (h) => str(h.checkedAt) },
          ]}
          rows={headRows}
          rowKey={(h) => h.chainId}
          empty="No chain heads reported."
        />
      </section>

      <section>
        <h2>Keys and identity</h2>
        <dl>
          <dt>ML-DSA-65 pub hash</dt>
          <dd>
            <code>{str(metrics.keys?.sigPubHash)}</code>
          </dd>
          <dt>KEM kid</dt>
          <dd>
            <code>{str(metrics.keys?.kemKid)}</code>
          </dd>
        </dl>
        <Table<IdentityMetrics>
          columns={[
            { key: "chainId", label: "Chain id" },
            { key: "agentId", label: "ERC-8004 agent id" },
            { key: "onChainPubHash", label: "On-chain pub hash", render: (i) => <code>{str(i.onChainPubHash)}</code> },
            {
              key: "matches",
              label: "Matches local key",
              render: (i) => (
                <span className={healthTone(i.matches)}>
                  {i.matches === true ? "matches" : i.matches === false ? "MISMATCH" : "unknown"}
                </span>
              ),
            },
          ]}
          rows={metrics.identity ?? []}
          rowKey={(i, idx) => `${i.chainId}-${idx}`}
          empty="No ERC-8004 identity registered."
        />
        <p className="muted">The on-chain hash is re-read every 10 minutes. A mismatch means discovery can no longer be trusted.</p>
      </section>
    </>
  );
}

/* ----------------------------------------------------------------- helpers */

type Tone = "ok" | "warn" | "error" | "muted";

/** Renders any leaf defensively: a missing or empty value shows as a dash, never "undefined". */
function str(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function Flag({ value, on, off }: { value: unknown; on: string; off: string }): ReactNode {
  if (value === true) return <span className="ok">{on}</span>;
  if (value === false) return <span className="muted">{off}</span>;
  return <span className="muted">unknown</span>;
}

function healthTone(value: unknown): Tone {
  return value === true ? "ok" : value === false ? "error" : "muted";
}

function healthLabel(value: unknown): string {
  return value === true ? "healthy" : value === false ? "unhealthy" : "unknown";
}

function statusTone(status: string): Tone {
  if (status === "live") return "ok";
  if (status === "stale") return "warn";
  if (status === "down") return "error";
  return "muted";
}

/** Highlights a counter only once it is above zero, so a quiet service stays quiet. */
function nonZeroTone(value: unknown, tone: Tone): Tone | "" {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? tone : "";
}

/** A readable duration beside the raw seconds string, which is shown unrounded. */
function humanUptime(seconds: unknown): string | null {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  const days = Math.floor(n / 86400);
  const hours = Math.floor((n % 86400) / 3600);
  const minutes = Math.floor((n % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${Math.floor(n % 60)}s`);
  return parts.join(" ");
}
