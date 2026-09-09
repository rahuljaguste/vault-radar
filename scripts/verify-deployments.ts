import { writeFileSync } from "node:fs";
import { DEPLOYMENTS } from "../packages/core/src/standardized/registry";
import { queryDeployment } from "../packages/core/src/standardized/gateway";
import type { Deployment } from "../packages/core/src/standardized/types";

const key = process.env.GRAPH_STUDIO_API_KEY!;
if (!key) throw new Error("GRAPH_STUDIO_API_KEY missing");

const Q = `{ _meta { block { number timestamp } hasIndexingErrors deployment } }`;
const now = Math.floor(Date.now() / 1000);
const out: Deployment[] = [];

for (const d of DEPLOYMENTS) {
  try {
    const { meta, data } = await queryDeployment<{ _meta: { deployment: string } }>(d, Q, key, {});
    const lag = now - Number(meta.timestamp);
    out.push({ ...d, deploymentId: data._meta.deployment, headLagSeconds: lag, status: meta.hasIndexingErrors ? "down" : lag <= 3600 ? "live" : "stale", verifiedAt: String(now) });
    console.log(`${d.protocol}/${d.chain}: ${out.at(-1)!.status} lag=${lag}s deployment=${data._meta.deployment}`);
  } catch (e) {
    out.push({ ...d, status: "down", headLagSeconds: null, verifiedAt: String(now) });
    console.log(`${d.protocol}/${d.chain}: down (${(e as Error).message})`);
  }
}

writeFileSync("packages/core/src/standardized/deployments.json", JSON.stringify(out, null, 2) + "\n");
console.log(`live: ${out.filter(x => x.status === "live").length} / ${out.length}`);
