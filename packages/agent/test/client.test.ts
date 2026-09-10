import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryNonceStore } from "@vaultradar/core";
import { buildApp, loadConfig, loadKeys, makeScanHandler, type DataProvider, type HandlerDeps } from "@vaultradar/service";
import { VaultRadarClient } from "../src/client";
import { readPqHashOnChain } from "../src/erc8004";
import { listRuns, saveRun, type RunRecord } from "../src/runs";

const now = Math.floor(Date.now() / 1000);
const VAULT_ID = "1:0x" + "a".repeat(40);
// Never parsed for real: every test below supplies `payingFetch`, so the constructor
// never calls into `payingFetchHedera`/`PrivateKey.fromStringECDSA` with this value.
const UNUSED_HEDERA_KEY = "11".repeat(32);

const vault = {
  id: VAULT_ID, kind: "erc4626", protocol: "erc4626", chain: "ethereum", chainId: "1",
  asset: null, sharePrice: "1.01", tvlUsd: null, inputTokenBalance: "100", depositLimit: null,
  history: [],
  sources: [{ kind: "substreams", ref: "erc4626-vault-metrics", block: "10", timestamp: String(now - 5), ageSeconds: "5", freshness: "fresh" }],
  freshness: "fresh",
} as const;

const data: DataProvider = {
  catalog: async () => ({ protocols: [], erc4626Chains: ["1"] }),
  scan: async (ids: string[]) => ({
    vaults: ids.includes(VAULT_ID) ? [vault as any] : [],
    sources: [{ ref: "erc4626-vault-metrics", chainId: "1", block: "10", timestamp: String(now - 5) }],
  }),
  table: async () => ({ vaults: [vault as any], sources: [] }),
};

/**
 * The agent card bakes `config.publicUrl` into `endpoints.hedera.scan`/`.table`, and
 * `VaultRadarClient` follows those discovered URLs rather than any URL the test
 * happens to know out of band — so the card's declared origin must be the same origin
 * the test server actually listens on. Reserve a free port first (bind-then-release),
 * fold it into `PUBLIC_URL` before building the config/app, then listen on that same
 * port, so the card's self-described endpoints are genuinely reachable.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as any).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  PORT: String(port), PUBLIC_URL: base, PQ_SIG_SEED: "aa".repeat(32), PQ_KEM_SEED: "bb".repeat(64),
  GRAPH_STUDIO_API_KEY: "k", HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1",
  HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), HEDERA_HCS_TOPIC_ID: "0.0.99",
  ERC8004_HEDERA_AGENT_ID: "7",
};
const config = loadConfig(env);
const keys = loadKeys(config);

// One in-process service, shared by every test in this file: `buildApp` mounts the
// well-known/discovery routes (rails: {}), and the Hedera scan/table routes are
// mounted directly with a fixed test payer/tx id, standing in for what the real
// Hedera x402 middleware (Task 16) would set once payment has cleared.
const nonces = new MemoryNonceStore();
const app = await buildApp({ config, keys, data, hcs: null, nonces, rails: {} });
const scanDeps: HandlerDeps = {
  keys, config, data, nonces, rail: "hedera", tier: "scan",
  getPayer: () => "0.0.42", getTxId: () => "0.0.42@1.0",
};
app.post("/hedera/v1/scan", makeScanHandler(scanDeps));
app.post("/hedera/v1/table", makeScanHandler({ ...scanDeps, tier: "table" }));
const srv = app.listen(port);

function client(readPqHash: () => Promise<string | null> = async () => keys.sig.pubHash) {
  return new VaultRadarClient({
    serviceUrl: base,
    hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
    payingFetch: fetch,
    readPqHash,
  });
}

test("discover verifies the card and compares on-chain hash", async () => {
  const d = await client().discover();
  expect(d.cardSignatureValid).toBe(true);
  expect(d.onChain).toEqual([{ chainId: "296", agentId: "7", matches: true }]);
});

test("a readPqHash returning a different hash yields matches: false", async () => {
  const d = await client(async () => "0".repeat(64)).discover();
  expect(d.onChain[0].matches).toBe(false);
});

test("scan without payment middleware still round-trips sealing and verification", async () => {
  const r = await client().scan([VAULT_ID], "hedera");
  expect(r.rail).toBe("hedera");
  expect(r.tier).toBe("scan");
  expect(r.sealed).toBe(true);
  expect(r.receiptValid).toBe(true);
  expect(r.attestationsValid).toBe(true);
  // `txId` on the result comes from the `payment-response` HTTP header, which only a
  // real x402 payment middleware (Task 16) sets — not mounted in this test — so it's
  // correctly null here. The handler's txId still reaches the signed receipt, which
  // the client surfaces untouched.
  expect(r.txId).toBeNull();
  expect(r.receipt.payment.txId).toBe("0.0.42@1.0");
  expect(r.priceUsd).not.toBeNull();
  expect(r.vaults[0].id).toBe(VAULT_ID);
  expect(r.reports[0].vaultId).toBe(VAULT_ID);
  expect(r.attestations[0].vaultId).toBe(VAULT_ID);
});

test("scan with seal:false sends a clear request and still verifies the (unsealed) receipt", async () => {
  const r = await client().scan([VAULT_ID], "hedera", { seal: false });
  expect(r.sealed).toBe(false);
  expect(r.receiptValid).toBe(true);
  expect(r.vaults[0].id).toBe(VAULT_ID);
});

test("table works on the hedera rail", async () => {
  const r = await client().table("erc4626", "1", "hedera");
  expect(r.tier).toBe("table");
  expect(r.sealed).toBe(true);
  expect(r.receiptValid).toBe(true);
  expect(r.attestationsValid).toBe(true);
  expect(r.vaults[0].id).toBe(VAULT_ID);
});

test("quote reflects which rails are configured", async () => {
  const hederaOnly = client();
  const q = await hederaOnly.quote(3);
  expect(q.hedera).not.toBeNull();
  expect(q.arc).toBeNull();
});

test("scanning a rail with no matching wallet configured throws a clear error", async () => {
  const noArc = new VaultRadarClient({ serviceUrl: base, payingFetch: fetch, readPqHash: async () => keys.sig.pubHash });
  await expect(noArc.scan([VAULT_ID], "arc")).rejects.toThrow(/arc rail not configured/);
});

test("readPqHashOnChain returns null for a chain with no configured RPC, without a network call", async () => {
  expect(await readPqHashOnChain("999999", "1")).toBeNull();
});

test("saveRun and listRuns round-trip through a temp directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultradar-runs-"));
  const run: RunRecord = {
    id: "abc123",
    startedAt: "2026-09-10T12:00:00.000Z",
    serviceUrl: base,
    policy: { budget: { usdc_hedera: "1", usdc_arc: "1" }, privacy: "balanced", rail_preference: "cheapest", max_age_seconds: 900 },
    discovery: { cardSignatureValid: true, pubHash: keys.sig.pubHash, kid: keys.kem.kid, onChain: [] },
    requests: [],
    decisions: [],
  };
  const path = saveRun(dir, run);
  expect(path).toBe(join(dir, "2026-09-10T12-00-00.000Z-abc123.json"));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(run);
  expect(listRuns(dir)).toEqual([{ id: "abc123", path, startedAt: "2026-09-10T12:00:00.000Z" }]);
});

test("listRuns returns [] for a directory that does not exist", () => {
  expect(listRuns(join(tmpdir(), "vaultradar-runs-missing-" + Math.random().toString(36).slice(2)))).toEqual([]);
});
