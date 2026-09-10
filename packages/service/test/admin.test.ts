import { expect, test } from "bun:test";
import { z } from "zod";
import { deriveKemKeys, deriveSigningKeys, MemoryNonceStore } from "@vaultradar/core";
import { buildApp, type BuildAppDeps } from "../src/app";
import { loadConfig } from "../src/config";
import { Metrics } from "../src/metrics";

const baseEnv = {
  PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "33".repeat(32), PQ_KEM_SEED: "44".repeat(64),
  GRAPH_STUDIO_API_KEY: "k", HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1", HEDERA_OPERATOR_KEY: "00",
  ARC_SELLER_ADDRESS: "0x" + "1".repeat(40),
};

const noIdentity = async () => null;

function makeData(overrides: { vaultList?: (chainId: string) => Promise<{ id: string; protocol: string; kind: string }[]> } = {}) {
  return {
    catalog: async () => ({ protocols: [], erc4626Chains: [] }),
    scan: async () => ({ vaults: [], sources: [] }),
    table: async () => ({ vaults: [], sources: [] }),
    ...(overrides.vaultList ? { vaultList: overrides.vaultList } : {}),
  };
}

async function mountApp(env: Record<string, string | undefined> = {}, deps: Partial<BuildAppDeps> = {}) {
  const config = loadConfig({ ...baseEnv, ...env });
  const keys = { sig: deriveSigningKeys(config.sigSeed), kem: deriveKemKeys(config.kemSeed) };
  const data = deps.data ?? makeData({ vaultList: async chainId => (chainId === "1" ? [{ id: "1:0xabc", protocol: "erc4626", kind: "erc4626" }] : []) });
  const app = await buildApp({ config, keys, data, hcs: null, nonces: new MemoryNonceStore(), rails: {}, readPqHash: noIdentity, ...deps });
  const srv = app.listen(0);
  const port = (srv.address() as any).port;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

// --- GET /v1/admin/metrics: the bearer gate --------------------------------------

test("without ADMIN_TOKEN configured, the endpoint answers 503 admin_disabled regardless of what the request sends", async () => {
  const app = await mountApp();
  try {
    const noAuth = await fetch(`${app.base}/v1/admin/metrics`);
    expect(noAuth.status).toBe(503);
    expect(await noAuth.json()).toEqual({ reason: "admin_disabled" });

    const withBogusAuth = await fetch(`${app.base}/v1/admin/metrics`, { headers: { authorization: "Bearer anything" } });
    expect(withBogusAuth.status).toBe(503);
  } finally {
    app.close();
  }
});

test("with ADMIN_TOKEN configured: 401 with no/wrong bearer token, 200 with the right one", async () => {
  const app = await mountApp({ ADMIN_TOKEN: "s3cr3t" });
  try {
    const noAuth = await fetch(`${app.base}/v1/admin/metrics`);
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({ reason: "unauthorized", error: "unauthorized" });

    const wrongAuth = await fetch(`${app.base}/v1/admin/metrics`, { headers: { authorization: "Bearer wrong" } });
    expect(wrongAuth.status).toBe(401);

    const malformedHeader = await fetch(`${app.base}/v1/admin/metrics`, { headers: { authorization: "s3cr3t" } }); // missing "Bearer " prefix
    expect(malformedHeader.status).toBe(401);

    const ok = await fetch(`${app.base}/v1/admin/metrics`, { headers: { authorization: "Bearer s3cr3t" } });
    expect(ok.status).toBe(200);
  } finally {
    app.close();
  }
});

// --- shape: exactly spec §13.1 -----------------------------------------------------

const RailHealth = z.object({ enabled: z.boolean(), facilitatorUrl: z.string(), healthy: z.boolean(), checkedAt: z.string() });

const AdminMetricsSchema = z
  .object({
    uptimeSeconds: z.string(),
    startedAt: z.string(),
    rails: z.object({ hedera: RailHealth, arc: RailHealth }),
    hcs: z.object({
      enabled: z.boolean(),
      topicId: z.string().nullable(),
      pending: z.string(),
      submitted: z.string(),
      failed: z.string(),
      lastSequence: z.string().nullable(),
    }),
    settlements: z.object({
      hedera: z.object({ count: z.string(), revenueAtomic: z.string(), asset: z.string() }),
      arc: z.object({ count: z.string(), revenueUsd: z.string() }),
    }),
    requests: z.object({
      scan: z.string(),
      table: z.string(),
      rejected4xx: z.string(),
      unavailableVerdicts: z.string(),
      lastRequestAt: z.string().nullable(),
    }),
    deployments: z.array(
      z.object({
        protocol: z.string(),
        chain: z.string(),
        chainId: z.string(),
        status: z.string(),
        headLagSeconds: z.string().nullable(),
        lastQueriedAt: z.string(),
        lastError: z.string().nullable(),
      }),
    ),
    heads: z.record(z.object({ ts: z.string(), block: z.string(), ok: z.boolean(), checkedAt: z.string() })),
    keys: z.object({ sigPubHash: z.string(), kemKid: z.string() }),
    identity: z.array(z.object({ chainId: z.string(), agentId: z.string(), onChainPubHash: z.string().nullable(), matches: z.boolean() })),
  })
  .strict(); // .strict() so an accidental extra/renamed field fails the test, not just a missing one

test("a 200 response matches spec §13.1's shape exactly, field for field", async () => {
  const metrics = new Metrics({ fetchImpl: async () => new Response("{}", { status: 200 }) });
  const app = await mountApp({ ADMIN_TOKEN: "s3cr3t", HEDERA_HCS_TOPIC_ID: "0.0.9" }, { rails: { hedera: true, arc: true }, metrics });
  try {
    const res = await fetch(`${app.base}/v1/admin/metrics`, { headers: { authorization: "Bearer s3cr3t" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = AdminMetricsSchema.safeParse(body);
    if (!parsed.success) console.error("admin metrics shape mismatch:", JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.success).toBe(true);
    expect(body.rails.hedera.enabled).toBe(true);
    expect(body.rails.arc.enabled).toBe(true);
  } finally {
    app.close();
  }
});

// --- rail health probe: injectable fetch, never throws ----------------------------

test("a failing facilitator probe reports healthy:false through the mounted route, without erroring the request", async () => {
  const metrics = new Metrics({ fetchImpl: async () => { throw new Error("network down"); } });
  const app = await mountApp({ ADMIN_TOKEN: "s3cr3t" }, { rails: { hedera: true, arc: true }, metrics });
  try {
    const res = await fetch(`${app.base}/v1/admin/metrics`, { headers: { authorization: "Bearer s3cr3t" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rails.hedera.healthy).toBe(false);
    expect(body.rails.arc.healthy).toBe(false);
  } finally {
    app.close();
  }
});

// --- GET /v1/vaults: free, CORS-enabled -------------------------------------------

test("GET /v1/vaults?chainId= is public (no token needed), CORS-enabled, and returns the provider's list", async () => {
  const app = await mountApp();
  try {
    const res = await fetch(`${app.base}/v1/vaults?chainId=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ chainId: "1", vaults: [{ id: "1:0xabc", protocol: "erc4626", kind: "erc4626" }] });
  } finally {
    app.close();
  }
});

test("GET /v1/vaults without chainId returns 400 bad_chain_id", async () => {
  const app = await mountApp();
  try {
    const res = await fetch(`${app.base}/v1/vaults`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "bad_chain_id", error: "bad_chain_id" });
  } finally {
    app.close();
  }
});

test("GET /v1/vaults falls back to an empty list when the provider has no vaultList method", async () => {
  const app = await mountApp({}, { data: makeData() }); // makeData() with no vaultList override
  try {
    const res = await fetch(`${app.base}/v1/vaults?chainId=999`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chainId: "999", vaults: [] });
  } finally {
    app.close();
  }
});
