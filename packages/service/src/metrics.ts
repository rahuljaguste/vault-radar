import type { Config } from "./config";
import type { HcsSink } from "./hcs";
import type { ServiceKeys } from "./keys";
import type { readPqHash as ReadPqHashFn } from "./erc8004";

export type RequestTier = "scan" | "table";
export type SettlementRail = "hedera" | "arc";
export type Verdict = "ok" | "watch" | "alert" | "unavailable";

export type DeploymentRef = { protocol: string; chain: string; chainId: string };
export type DeploymentOutcome = { ok: boolean; lagSeconds: number | null; error: string | null };
export type ChainHead = { ts: number; block: number };

type RailHealth = { enabled: boolean; facilitatorUrl: string; healthy: boolean; checkedAt: string };
type HcsStatus = { enabled: boolean; topicId: string | null; pending: string; submitted: string; failed: string; lastSequence: string | null };
type SettlementStatus = {
  hedera: { count: string; revenueAtomic: string; asset: string };
  arc: { count: string; revenueUsd: string };
};
type RequestStatus = { scan: string; table: string; rejected4xx: string; unavailableVerdicts: string; lastRequestAt: string | null };
type DeploymentStatus = { protocol: string; chain: string; chainId: string; status: string; headLagSeconds: string | null; lastQueriedAt: string; lastError: string | null };
type HeadStatus = { ts: string; block: string; ok: boolean; checkedAt: string };
type IdentityStatus = { chainId: string; agentId: string; onChainPubHash: string | null; matches: boolean };

/** The exact JSON shape of `GET /v1/admin/metrics`, spec §13.1 — every numeric field is
 * a string; only booleans (`enabled`/`healthy`/`ok`/`matches`) are not. */
export type AdminMetrics = {
  uptimeSeconds: string;
  startedAt: string;
  rails: { hedera: RailHealth; arc: RailHealth };
  hcs: HcsStatus;
  settlements: SettlementStatus;
  requests: RequestStatus;
  deployments: DeploymentStatus[];
  heads: Record<string, HeadStatus>;
  keys: { sigPubHash: string; kemKid: string };
  identity: IdentityStatus[];
};

export type SnapshotDeps = {
  config: Config;
  hcs: HcsSink | null;
  keys: ServiceKeys;
  /** Injected so tests can supply a fake without touching real chain RPC — production
   * wiring (app.ts) defaults this to the real `readPqHash` from `./erc8004`. */
  readPqHash: typeof ReadPqHashFn;
  /** Which rails are actually mounted — the same flags `buildApp`/`main.ts` already
   * compute, threaded through rather than re-derived from raw config fields so there is
   * exactly one source of truth for "is this rail on". */
  rails?: { hedera?: boolean; arc?: boolean };
};

type FetchLike = (url: string) => Promise<Response>;
type Cached<T> = { value: T; expiresAt: number; checkedAt: number };

// Spec §13.1: "Rail health probes hit each facilitator's supported-kinds endpoint,
// cached 30 seconds" / "identity ... refreshed every 10 minutes".
const HEALTH_TTL_S = 30;
const IDENTITY_TTL_S = 10 * 60;

/**
 * In-process counters and cached freshness/health/identity snapshotting for the admin
 * metrics endpoint (spec §13.1, served by `admin.ts`'s `mountAdmin`). Every counter here
 * resets when the process restarts — there is no persistence, and the admin dashboard
 * states that explicitly rather than implying these are durable totals.
 *
 * Fed by: `handlers/scan.ts` (`recordRequest`, per request), both rails' settlement
 * hooks (`recordSettlement`, per settled payment — Hedera's `onAfterSettle`, Arc's
 * post-handler wrapper), `data/provider.ts` (`recordDeployment`/`recordHead`, per
 * upstream query), and `snapshot()` itself (rail health probes and the identity check,
 * both cached here rather than in `admin.ts` so this class is testable standalone
 * without standing up Express).
 */
export class Metrics {
  readonly startedAt: number;
  requests = { scan: 0, table: 0, rejected4xx: 0, unavailableVerdicts: 0, lastRequestAt: null as number | null };
  settlements = {
    hedera: { count: 0, revenueAtomic: 0n },
    // Arc settlement amounts arrive as USDC atomic units (6 decimals, from
    // `req.payment.amount`); accumulated as an integer here and only divided down to
    // dollars once, at snapshot time, so summing many small settlements never drifts
    // the way repeatedly adding floating-point dollar amounts would.
    arc: { count: 0, revenueUsdMicros: 0 },
  };

  private deployments = new Map<string, { ref: DeploymentRef; outcome: DeploymentOutcome; queriedAt: number }>();
  private heads = new Map<string, { head: ChainHead; ok: boolean; checkedAt: number }>();
  private healthCache = new Map<"hedera" | "arc", Cached<boolean>>();
  private identityCache: Cached<IdentityStatus[]> | null = null;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;

  constructor(deps: { now?: () => number; fetchImpl?: FetchLike } = {}) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.fetchImpl = deps.fetchImpl ?? (url => fetch(url));
    this.startedAt = this.now();
  }

  recordRequest(tier: RequestTier, status: number, verdicts?: Verdict[]): void {
    if (status >= 200 && status < 300) this.requests[tier]++;
    if (status >= 400 && status < 500) this.requests.rejected4xx++;
    if (verdicts) this.requests.unavailableVerdicts += verdicts.filter(v => v === "unavailable").length;
    this.requests.lastRequestAt = this.now();
  }

  /**
   * `amount` is the rail's own atomic unit, straight from where each rail observes
   * settlement: Hedera passes the settled `PaymentRequirements.amount` (tinybars for the
   * HBAR-priced route, USDC-atomic for the default one — kept as a raw running sum since
   * the two are never added *together*, only accumulated per rail); Arc always passes
   * `req.payment.amount` (USDC atomic, 6 decimals).
   */
  recordSettlement(rail: SettlementRail, amount: string): void {
    if (rail === "hedera") {
      this.settlements.hedera.count++;
      this.settlements.hedera.revenueAtomic += BigInt(amount);
    } else {
      this.settlements.arc.count++;
      this.settlements.arc.revenueUsdMicros += Number(amount);
    }
  }

  /** Records the most recent query outcome for one deployment (protocol × chain).
   * Keyed by chainId+protocol, so a later call for the same deployment replaces its
   * entry rather than accumulating history — the admin view only promises "last
   * outcome", not a log. */
  recordDeployment(ref: DeploymentRef, outcome: DeploymentOutcome): void {
    this.deployments.set(`${ref.chainId}:${ref.protocol}`, { ref, outcome, queriedAt: this.now() });
  }

  /** Records the most recently observed head for one chain (also keyed to replace, not
   * accumulate — see `recordDeployment`). */
  recordHead(chainId: string, head: ChainHead, ok: boolean): void {
    this.heads.set(chainId, { head, ok, checkedAt: this.now() });
  }

  /** GETs `${url}${path}`, cached `HEALTH_TTL_S` per rail. Never throws: a network
   * failure or non-2xx both just mean `healthy: false`, since a facilitator hiccup
   * should degrade the admin view, not break it. */
  private async probeHealth(rail: "hedera" | "arc", url: string, path: string): Promise<{ healthy: boolean; checkedAt: number }> {
    const now = this.now();
    const cached = this.healthCache.get(rail);
    if (cached && cached.expiresAt > now) return { healthy: cached.value, checkedAt: cached.checkedAt };
    let healthy: boolean;
    try {
      const res = await this.fetchImpl(`${url.replace(/\/$/, "")}${path}`);
      healthy = res.ok;
    } catch {
      healthy = false;
    }
    this.healthCache.set(rail, { value: healthy, expiresAt: now + HEALTH_TTL_S, checkedAt: now });
    return { healthy, checkedAt: now };
  }

  /** Reads each configured ERC-8004 identity's on-chain PQ key hash, cached
   * `IDENTITY_TTL_S` as a whole (not per-entry — the list is small and always read
   * together). `readPqHash` is documented never to throw, but this wraps it anyway since
   * a test-injected fake has no such guarantee, and a broken identity check should
   * degrade to "unverified" rather than fail the whole snapshot. */
  private async getIdentity(deps: SnapshotDeps): Promise<IdentityStatus[]> {
    const now = this.now();
    if (this.identityCache && this.identityCache.expiresAt > now) return this.identityCache.value;
    const value = await Promise.all(
      deps.config.erc8004.map(async e => {
        const onChainPubHash = await deps.readPqHash(e.chainId, e.agentId).catch(() => null);
        return { chainId: e.chainId, agentId: e.agentId, onChainPubHash, matches: onChainPubHash !== null && onChainPubHash === deps.keys.sig.pubHash };
      }),
    );
    this.identityCache = { value, expiresAt: now + IDENTITY_TTL_S, checkedAt: now };
    return value;
  }

  async snapshot(deps: SnapshotDeps): Promise<AdminMetrics> {
    const now = this.now();
    const railsEnabled = deps.rails ?? {};

    const [hederaProbe, arcProbe, identity] = await Promise.all([
      railsEnabled.hedera ? this.probeHealth("hedera", deps.config.hedera.facilitatorUrl, "/supported") : Promise.resolve({ healthy: false, checkedAt: now }),
      railsEnabled.arc ? this.probeHealth("arc", deps.config.arc.facilitatorUrl, "/v1/x402/supported") : Promise.resolve({ healthy: false, checkedAt: now }),
      this.getIdentity(deps),
    ]);

    const hcsStats = deps.hcs?.stats() ?? { pending: 0, submitted: 0, failed: 0, lastSequence: null };

    const deployments: DeploymentStatus[] = [...this.deployments.values()].map(({ ref, outcome, queriedAt }) => ({
      protocol: ref.protocol,
      chain: ref.chain,
      chainId: ref.chainId,
      status: outcome.ok ? "ok" : "unavailable",
      headLagSeconds: outcome.lagSeconds === null ? null : String(outcome.lagSeconds),
      lastQueriedAt: String(queriedAt),
      lastError: outcome.error,
    }));

    const heads: Record<string, HeadStatus> = {};
    for (const [chainId, h] of this.heads) heads[chainId] = { ts: String(h.head.ts), block: String(h.head.block), ok: h.ok, checkedAt: String(h.checkedAt) };

    return {
      uptimeSeconds: String(now - this.startedAt),
      startedAt: String(this.startedAt),
      rails: {
        hedera: { enabled: !!railsEnabled.hedera, facilitatorUrl: deps.config.hedera.facilitatorUrl, healthy: hederaProbe.healthy, checkedAt: String(hederaProbe.checkedAt) },
        arc: { enabled: !!railsEnabled.arc, facilitatorUrl: deps.config.arc.facilitatorUrl, healthy: arcProbe.healthy, checkedAt: String(arcProbe.checkedAt) },
      },
      hcs: {
        enabled: deps.hcs !== null,
        topicId: deps.config.hedera.hcsTopicId,
        pending: String(hcsStats.pending),
        submitted: String(hcsStats.submitted),
        failed: String(hcsStats.failed),
        lastSequence: hcsStats.lastSequence,
      },
      settlements: {
        // `asset` reflects the rail's *configured* token (a config fact, always known),
        // not something derived from settlement activity — so it's populated even
        // before this process has settled anything.
        hedera: { count: String(this.settlements.hedera.count), revenueAtomic: this.settlements.hedera.revenueAtomic.toString(), asset: deps.config.hedera.usdcToken },
        arc: { count: String(this.settlements.arc.count), revenueUsd: String(this.settlements.arc.revenueUsdMicros / 1e6) },
      },
      requests: {
        scan: String(this.requests.scan),
        table: String(this.requests.table),
        rejected4xx: String(this.requests.rejected4xx),
        unavailableVerdicts: String(this.requests.unavailableVerdicts),
        lastRequestAt: this.requests.lastRequestAt === null ? null : String(this.requests.lastRequestAt),
      },
      deployments,
      heads,
      keys: { sigPubHash: deps.keys.sig.pubHash, kemKid: deps.keys.kem.kid },
      identity,
    };
  }
}
