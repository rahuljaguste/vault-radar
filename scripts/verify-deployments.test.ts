import { expect, test } from "bun:test";
import type { Deployment } from "../packages/core/src/standardized/types";
import { reconcile, summarize, unreachable, verifyAll, type MetaResult } from "./verify-deployments";

/**
 * The gate's one job is to *detect* a deployment move, not to perform it. These drive it
 * against a fake gateway, because the regression being pinned is a silent write: the old
 * version set `deploymentId` from the query on every run, so a publisher rolling a new
 * subgraph version moved this repo onto it with no diff to review beyond a changed hash.
 */

const NOW = 1_700_000_000;
const PINNED = "QmPinnedDeployment";
const SERVING = "QmSomethingElseEntirely";

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    protocol: "aave-v3",
    chain: "ethereum",
    chainId: "1",
    schema: "lending",
    subgraphId: "SubgraphId1",
    deploymentId: PINNED,
    status: "live",
    headLagSeconds: 10,
    verifiedAt: "1690000000",
    ...over,
  };
}

function meta(over: Partial<MetaResult> = {}): MetaResult {
  return { deployment: PINNED, block: "19000000", timestamp: String(NOW - 30), hasIndexingErrors: false, ...over };
}

test("a pinned id that agrees is verified and left exactly as it was", () => {
  const { deployment: out, note } = reconcile(deployment(), meta(), NOW);
  expect(out.deploymentId).toBe(PINNED);
  expect(out.status).toBe("live");
  expect(out.headLagSeconds).toBe(30);
  expect(out.verifiedAt).toBe(String(NOW));
  expect(note).toContain("live lag=30s");
});

test("a pinned id that disagrees is reported as repointed, and the pin is NOT overwritten", () => {
  // The finding, directly: the gateway now serves a different deployment than the registry
  // pins. The old code wrote the new id in; this records the disagreement instead.
  const { deployment: out, note } = reconcile(deployment(), meta({ deployment: SERVING }), NOW);
  expect(out.deploymentId).toBe(PINNED);
  expect(out.deploymentId).not.toBe(SERVING);
  expect(out.status).toBe("repointed");
  expect(out.headLagSeconds).toBe(30);
  // Both ids are named, so following the move is an informed edit.
  expect(note).toContain(`pinned=${PINNED}`);
  expect(note).toContain(`now_serving=${SERVING}`);
  expect(note).toContain("pin left alone");
});

test("an absent pin is the only case the gate writes one", () => {
  const { deployment: out, note } = reconcile(deployment({ deploymentId: null, status: "unverified" }), meta({ deployment: SERVING }), NOW);
  expect(out.deploymentId).toBe(SERVING);
  expect(out.status).toBe("live");
  expect(note).toContain("pinned for the first time");
});

test("status follows the indexing lag, and indexing errors are down regardless of lag", () => {
  expect(reconcile(deployment(), meta({ timestamp: String(NOW - 3600) }), NOW).deployment.status).toBe("live");
  expect(reconcile(deployment(), meta({ timestamp: String(NOW - 3601) }), NOW).deployment.status).toBe("stale");
  expect(reconcile(deployment(), meta({ hasIndexingErrors: true }), NOW).deployment.status).toBe("down");
  // A repointed deployment reports `repointed` even when its lag would read `live`: the
  // disagreement is the thing an operator needs to see.
  expect(reconcile(deployment(), meta({ deployment: SERVING, hasIndexingErrors: true }), NOW).deployment.status).toBe("repointed");
});

test("an unreachable deployment is down, with its pin and subgraph id untouched", () => {
  const { deployment: out, note } = unreachable(deployment(), "gateway 502", NOW);
  expect(out.deploymentId).toBe(PINNED);
  expect(out.subgraphId).toBe("SubgraphId1");
  expect(out.status).toBe("down");
  expect(out.headLagSeconds).toBeNull();
  expect(note).toBe("down (gateway 502)");
});

test("verifyAll runs the whole registry against a fake gateway and never rewrites a pin", async () => {
  const registry: Deployment[] = [
    deployment({ protocol: "aave-v3", subgraphId: "A" }),
    deployment({ protocol: "compound-v3", subgraphId: "B" }),
    deployment({ protocol: "yearn-v3", subgraphId: "C", deploymentId: null, status: "unverified" }),
    deployment({ protocol: "morpho", subgraphId: "D" }),
  ];
  const fakeGateway = async (d: Deployment): Promise<MetaResult> => {
    if (d.subgraphId === "B") return meta({ deployment: SERVING }); // repointed
    if (d.subgraphId === "C") return meta({ deployment: "QmFreshlyPinned" }); // first pin
    if (d.subgraphId === "D") throw new Error("gateway 503");
    return meta(); // agrees
  };

  const result = await verifyAll(registry, fakeGateway, NOW);
  expect(result.deployments.map(d => d.status)).toEqual(["live", "repointed", "live", "down"]);
  expect(result.deployments.map(d => d.deploymentId)).toEqual([PINNED, PINNED, "QmFreshlyPinned", PINNED]);
  // One line per deployment, in registry order.
  expect(result.lines).toHaveLength(4);
  expect(result.lines[1]).toContain("compound-v3/ethereum: repointed");
  expect(result.lines[3]).toContain("morpho/ethereum: down (gateway 503)");

  // The summary counts every status and calls the repointed ones out by name.
  expect(result.summary).toContain("live: 2");
  expect(result.summary).toContain("repointed: 1");
  expect(result.summary).toContain("down: 1");
  expect(result.summary).toContain("/ 4 total");
  expect(result.summary).toContain("compound-v3/ethereum");
});

test("the summary is one line when nothing is repointed", () => {
  const clean = summarize([deployment(), deployment({ protocol: "x", status: "stale" })]);
  expect(clean).toBe("live: 1, stale: 1 / 2 total");
  expect(clean).not.toContain("\n");
});
