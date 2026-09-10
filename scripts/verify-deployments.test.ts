import { expect, test } from "bun:test";
import type { Deployment } from "../packages/core/src/standardized/types";
import { endpointsFor, reconcile, summarize, unreachable, verifyAll, type Endpoint, type MetaResult } from "./verify-deployments";

/**
 * The gate's one job is to *detect* a deployment move, not to perform it. These drive it
 * against a fake gateway, because the regression being pinned is a silent write: the old
 * version set `deploymentId` from the query on every run, so a publisher rolling a new
 * subgraph version moved this repo onto it with no diff to review beyond a changed hash.
 *
 * The fake serves both gateway endpoints, because that distinction is the whole check. A
 * pinned `/deployments/id/<pin>` URL addresses one immutable deployment, so its
 * `_meta.deployment` is the pin restated — the comparison can only ever be equal there. Only
 * `/subgraphs/id/<subgraphId>` resolves to whatever the publisher currently points at.
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

test("the two endpoints are the pinned deployment and the subgraph, and they are different URLs", () => {
  // The bug this guards: both queries going to the pinned URL, where `_meta.deployment` is
  // the pin restated, so the comparison is inert.
  const urls = endpointsFor(deployment());
  expect(urls.pinned).toBe(`https://gateway.thegraph.com/api/deployments/id/${PINNED}`);
  expect(urls.subgraph).toBe("https://gateway.thegraph.com/api/subgraphs/id/SubgraphId1");
  expect(urls.pinned).not.toBe(urls.subgraph);
  // With no pin there is only one URL to ask, and it is the subgraph's.
  const unpinned = endpointsFor(deployment({ deploymentId: null }));
  expect(unpinned.pinned).toBe(unpinned.subgraph);
});

test("a pin the subgraph still resolves to is verified and left exactly as it was", () => {
  const { deployment: out, note } = reconcile(deployment(), meta(), PINNED, NOW);
  expect(out.deploymentId).toBe(PINNED);
  expect(out.status).toBe("live");
  expect(out.headLagSeconds).toBe(30);
  expect(out.verifiedAt).toBe(String(NOW));
  expect(note).toContain("live lag=30s");
});

test("a pin the subgraph no longer resolves to is reported as repointed, and NOT overwritten", () => {
  // The finding, directly: the subgraph now resolves to a different deployment than the
  // registry pins. The old code wrote the new id in; this records the disagreement instead.
  const { deployment: out, note } = reconcile(deployment(), meta(), SERVING, NOW);
  expect(out.deploymentId).toBe(PINNED);
  expect(out.deploymentId).not.toBe(SERVING);
  expect(out.status).toBe("repointed");
  expect(out.headLagSeconds).toBe(30);
  // Both ids are named, so following the move is an informed edit.
  expect(note).toContain(`pinned=${PINNED}`);
  expect(note).toContain(`now_serving=${SERVING}`);
  expect(note).toContain("pin left alone");
});

test("the comparison is against the subgraph's answer, never the pinned query's own echo", () => {
  // A pinned URL always answers with the pin, so passing that value as `serving` must not be
  // what decides: here the pinned query echoes the pin (as it always does in production) and
  // the subgraph says something else, and the result is `repointed`.
  const echoed = meta({ deployment: PINNED });
  expect(reconcile(deployment(), echoed, PINNED, NOW).deployment.status).toBe("live");
  expect(reconcile(deployment(), echoed, SERVING, NOW).deployment.status).toBe("repointed");
});

test("a repoint check that could not run says so, rather than reading as agreement", () => {
  const { deployment: out, note } = reconcile(deployment(), meta(), null, NOW);
  expect(out.deploymentId).toBe(PINNED);
  // The head lag still came from the pinned query, so the deployment is not `down`.
  expect(out.status).toBe("live");
  expect(out.headLagSeconds).toBe(30);
  expect(note).toContain("repoint check unavailable");
});

test("an absent pin is the only case the gate writes one", () => {
  const { deployment: out, note } = reconcile(deployment({ deploymentId: null, status: "unverified" }), meta({ deployment: SERVING }), SERVING, NOW);
  expect(out.deploymentId).toBe(SERVING);
  expect(out.status).toBe("live");
  expect(note).toContain("pinned for the first time");
});

test("status follows the indexing lag, and indexing errors are down regardless of lag", () => {
  expect(reconcile(deployment(), meta({ timestamp: String(NOW - 3600) }), PINNED, NOW).deployment.status).toBe("live");
  expect(reconcile(deployment(), meta({ timestamp: String(NOW - 3601) }), PINNED, NOW).deployment.status).toBe("stale");
  expect(reconcile(deployment(), meta({ hasIndexingErrors: true }), PINNED, NOW).deployment.status).toBe("down");
  // A repointed deployment reports `repointed` even when its lag would read `live`: the
  // disagreement is the thing an operator needs to see.
  expect(reconcile(deployment(), meta({ hasIndexingErrors: true }), SERVING, NOW).deployment.status).toBe("repointed");
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
    deployment({ protocol: "spark", subgraphId: "E" }),
  ];
  const asked: { subgraphId: string; endpoint: Endpoint }[] = [];
  /**
   * Serves both endpoints the way the real gateway does: a pinned URL always echoes the pin,
   * and the subgraph URL resolves to whatever the publisher currently points at. A fake that
   * ignored `endpoint` could not tell the fixed check apart from the broken one.
   */
  const fakeGateway = async (d: Deployment, endpoint: Endpoint): Promise<MetaResult> => {
    asked.push({ subgraphId: d.subgraphId, endpoint });
    if (d.subgraphId === "D") throw new Error("gateway 503"); // both endpoints down
    if (endpoint === "pinned") {
      // Exactly the production behaviour: the pin restated, whatever the subgraph now serves.
      return meta({ deployment: d.deploymentId ?? "QmFreshlyPinned" });
    }
    if (d.subgraphId === "B") return meta({ deployment: SERVING }); // repointed
    if (d.subgraphId === "C") return meta({ deployment: "QmFreshlyPinned" }); // first pin
    if (d.subgraphId === "E") throw new Error("subgraph endpoint 500"); // repoint check only
    return meta({ deployment: PINNED }); // agrees
  };

  const result = await verifyAll(registry, fakeGateway, NOW);
  expect(result.deployments.map(d => d.status)).toEqual(["live", "repointed", "live", "down", "live"]);
  expect(result.deployments.map(d => d.deploymentId)).toEqual([PINNED, PINNED, "QmFreshlyPinned", PINNED, PINNED]);

  // Both endpoints are asked for every pinned deployment — which is what makes the
  // comparison mean anything — and only the pinned one for the deployment with no pin.
  expect(asked.filter(a => a.subgraphId === "A")).toEqual([
    { subgraphId: "A", endpoint: "pinned" },
    { subgraphId: "A", endpoint: "subgraph" },
  ]);
  expect(asked.filter(a => a.subgraphId === "C")).toEqual([{ subgraphId: "C", endpoint: "pinned" }]);

  // One line per deployment, in registry order.
  expect(result.lines).toHaveLength(5);
  expect(result.lines[1]).toContain("compound-v3/ethereum: repointed");
  expect(result.lines[3]).toContain("morpho/ethereum: down (gateway 503)");
  // A subgraph endpoint that fails leaves the deployment healthy, with the check reported
  // as unavailable rather than silently as agreement.
  expect(result.lines[4]).toContain("spark/ethereum: live");
  expect(result.lines[4]).toContain("repoint check unavailable");

  // The summary counts every status and calls the repointed ones out by name.
  expect(result.summary).toContain("live: 3");
  expect(result.summary).toContain("repointed: 1");
  expect(result.summary).toContain("down: 1");
  expect(result.summary).toContain("/ 5 total");
  expect(result.summary).toContain("compound-v3/ethereum");
});

test("the summary is one line when nothing is repointed", () => {
  const clean = summarize([deployment(), deployment({ protocol: "x", status: "stale" })]);
  expect(clean).toBe("live: 1, stale: 1 / 2 total");
  expect(clean).not.toContain("\n");
});
