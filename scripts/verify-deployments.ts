import { writeFileSync } from "node:fs";
import { DEPLOYMENTS } from "../packages/core/src/standardized/registry";
import { gatewayUrl, queryDeployment } from "../packages/core/src/standardized/gateway";
import type { Deployment } from "../packages/core/src/standardized/types";

/**
 * The deployment verification gate: queries each registered subgraph's `_meta` and records
 * how fresh it is, so `deployments.json` says what was actually observed.
 *
 * It is a *gate*, not a populator. It used to do `deploymentId: data._meta.deployment` for
 * every deployment on every run, which overwrote whatever the registry had pinned with
 * whatever the gateway happened to be serving at that moment. That is the opposite of what a
 * pin is for: a publisher rolling a new subgraph version silently moved this repo onto it,
 * and the gate that existed to *detect* the move performed it instead — with no diff to
 * review beyond a changed hash, and `gatewayUrl` then reading the new deployment as though
 * it had always been the pinned one.
 *
 * Now a pinned id is written only when it is absent, and otherwise compared: a disagreement
 * is reported as `status: "repointed"` with the pinned id left exactly as it was. Following
 * the move is then a deliberate edit by a person.
 */

const LAG_LIVE_S = 3600;

/** The `_meta` fields the gate reads. */
export type MetaResult = { deployment: string; block: string; timestamp: string; hasIndexingErrors: boolean };

/**
 * Which gateway endpoint to ask.
 *
 * - `"pinned"`: `/deployments/id/<deploymentId>` when a pin exists, else
 *   `/subgraphs/id/<subgraphId>` — exactly the URL `gatewayUrl` builds for data queries, so
 *   the head lag this gate reports is the lag of the deployment the service actually reads.
 * - `"subgraph"`: always `/subgraphs/id/<subgraphId>`, which resolves to whatever deployment
 *   the publisher currently points that subgraph at. The only way to notice a repoint.
 */
export type Endpoint = "pinned" | "subgraph";

/** Queries one deployment's `_meta` at one endpoint, or throws. Injectable so the unit test
 *  can stand in a fake gateway serving both. */
export type QueryMeta = (d: Deployment, endpoint: Endpoint) => Promise<MetaResult>;

export const META_QUERY = `{ _meta { block { number timestamp } hasIndexingErrors deployment } }`;

/** One deployment's verification outcome, plus what to say about it. */
export type Reconciled = { deployment: Deployment; note: string };

/**
 * Folds the query results into the registry entry, without ever replacing a pinned
 * `deploymentId`.
 *
 * - no pin yet: adopt the deployment the subgraph resolves to (the populate case, and the
 *   only case that writes a pin).
 * - pin agrees with what the subgraph now serves: a normal verification, status from lag.
 * - pin disagrees: keep the pin, `status: "repointed"`, and name both ids.
 * - the repoint check could not run: status from lag, and the note says so. Silence here
 *   would read as agreement.
 *
 * `serving` is the deployment id the *subgraph-id* endpoint resolves to, or null when that
 * query failed. It cannot be taken from `pinned.deployment`: a pinned URL addresses one
 * immutable deployment, so `_meta.deployment` there is the pin restated and comparing the
 * two could only ever be equal — which is what made the first version of this check inert
 * against the very thing it was added to detect.
 */
export function reconcile(existing: Deployment, pinned: MetaResult, serving: string | null, now: number): Reconciled {
  const lag = now - Number(pinned.timestamp);
  const verifiedAt = String(now);
  const byLag: Deployment["status"] = pinned.hasIndexingErrors ? "down" : lag <= LAG_LIVE_S ? "live" : "stale";

  if (existing.deploymentId === null) {
    // Nothing pinned, so the pinned query *was* the subgraph query; either source names the
    // deployment to adopt.
    const adopt = serving ?? pinned.deployment;
    return {
      deployment: { ...existing, deploymentId: adopt, status: byLag, headLagSeconds: lag, verifiedAt },
      note: `${byLag} lag=${lag}s deployment=${adopt} (pinned for the first time)`,
    };
  }
  if (serving === null) {
    return {
      deployment: { ...existing, status: byLag, headLagSeconds: lag, verifiedAt },
      note: `${byLag} lag=${lag}s deployment=${existing.deploymentId} (repoint check unavailable)`,
    };
  }
  if (existing.deploymentId === serving) {
    return {
      deployment: { ...existing, status: byLag, headLagSeconds: lag, verifiedAt },
      note: `${byLag} lag=${lag}s deployment=${existing.deploymentId}`,
    };
  }
  return {
    // `deploymentId` deliberately untouched: the pin is what `gatewayUrl` reads, and moving
    // it is a decision, not a side effect of running the gate.
    deployment: { ...existing, status: "repointed", headLagSeconds: lag, verifiedAt },
    note: `repointed lag=${lag}s pinned=${existing.deploymentId} now_serving=${serving} (pin left alone)`,
  };
}

/** A deployment the gate could not reach at all: `down`, with the pin and every other field
 *  left as it was. */
export function unreachable(existing: Deployment, message: string, now: number): Reconciled {
  return {
    deployment: { ...existing, status: "down", headLagSeconds: null, verifiedAt: String(now) },
    note: `down (${message})`,
  };
}

export type VerifyResult = { deployments: Deployment[]; lines: string[]; summary: string };

/** Verifies every deployment and returns the new registry contents plus what to print.
 *  Pure apart from `query`, so the unit test drives the whole gate with a fake gateway. */
export async function verifyAll(deployments: Deployment[], query: QueryMeta, now: number): Promise<VerifyResult> {
  const out: Deployment[] = [];
  const lines: string[] = [];
  for (const d of deployments) {
    let result: Reconciled;
    try {
      // The pinned endpoint answers "how fresh is the deployment we actually read"; that
      // query failing is what makes a deployment `down`.
      const pinned = await query(d, "pinned");
      // The subgraph endpoint answers "what does this subgraph resolve to now". Only
      // meaningful when there is a pin to compare it against, and its failure must not turn
      // a healthy deployment into a `down` one — so it is caught separately and reported as
      // an unavailable check.
      let serving: string | null = null;
      if (d.deploymentId !== null) {
        try {
          serving = (await query(d, "subgraph")).deployment;
        } catch {
          serving = null;
        }
      }
      result = reconcile(d, pinned, serving, now);
    } catch (e) {
      result = unreachable(d, e instanceof Error ? e.message : String(e), now);
    }
    out.push(result.deployment);
    lines.push(`${d.protocol}/${d.chain}: ${result.note}`);
  }
  return { deployments: out, lines, summary: summarize(out) };
}

/** One line naming every status present, so a run's outcome is readable without scrolling
 *  back through the per-deployment lines. Repointed deployments are called out by name,
 *  because they are the ones that need a person to decide something. */
export function summarize(deployments: Deployment[]): string {
  const counts = new Map<string, number>();
  for (const d of deployments) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
  const order = ["live", "stale", "repointed", "down", "unverified"];
  const parts = order.filter(s => counts.has(s)).map(s => `${s}: ${counts.get(s)}`);
  const head = `${parts.join(", ")} / ${deployments.length} total`;
  const repointed = deployments.filter(d => d.status === "repointed");
  if (repointed.length === 0) return head;
  return `${head}\nrepointed (pins left unchanged; follow them by editing deployments.json): ${repointed
    .map(d => `${d.protocol}/${d.chain}`)
    .join(", ")}`;
}

export const REGISTRY_PATH = "packages/core/src/standardized/deployments.json";

/**
 * The real gateway query, used when this file is run as a script.
 *
 * `queryDeployment` takes the whole `Deployment` and builds its URL with `gatewayUrl`, which
 * prefers `deploymentId` when set. Asking for the subgraph endpoint is therefore a matter of
 * handing it the same deployment with the pin blanked — no second URL builder, and
 * `gatewayUrl` stays the single place that knows the gateway's shape. `DEPLOYMENTS` is read
 * only; the copy is local to this call.
 */
function gatewayQuery(apiKey: string): QueryMeta {
  return async (d, endpoint) => {
    const target = endpoint === "subgraph" ? { ...d, deploymentId: null } : d;
    const { meta, data } = await queryDeployment<{ _meta: { deployment: string } }>(target, META_QUERY, apiKey, {});
    return { deployment: data._meta.deployment, block: meta.block, timestamp: meta.timestamp, hasIndexingErrors: meta.hasIndexingErrors };
  };
}

/** The two URLs the gate uses for one deployment, so a run can state where it looked. */
export function endpointsFor(d: Deployment): { pinned: string; subgraph: string } {
  return { pinned: gatewayUrl(d), subgraph: gatewayUrl({ ...d, deploymentId: null }) };
}

// `import.meta.main` so the test can import `verifyAll`/`reconcile` without the gate running
// (and without needing a GRAPH_STUDIO_API_KEY in the environment).
if (import.meta.main) {
  const key = process.env.GRAPH_STUDIO_API_KEY;
  if (!key) throw new Error("GRAPH_STUDIO_API_KEY missing");
  const now = Math.floor(Date.now() / 1000);
  const result = await verifyAll(DEPLOYMENTS, gatewayQuery(key), now);
  for (const line of result.lines) console.log(line);
  writeFileSync(REGISTRY_PATH, JSON.stringify(result.deployments, null, 2) + "\n");
  console.log(result.summary);
}
