import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARC_BUCKET_PRICE,
  MemoryNonceStore,
  buildAttestation,
  buildReceipt,
  fromB64,
  openSealedRequest,
  requestHash,
  responseHash,
  seal,
  type Sealed,
} from "@vaultradar/core";
import { buildApp, loadConfig, loadKeys, makeScanHandler, type DataProvider, type HandlerDeps } from "@vaultradar/service";
import { VaultRadarClient } from "../src/client";
import { readPqHashOnChain } from "../src/erc8004";
import { arcAddress } from "../src/rails/arc";
import { listRuns, saveRun, type RunRecord } from "../src/runs";

const now = Math.floor(Date.now() / 1000);
const VAULT_ID = "1:0x" + "a".repeat(40);
// Never parsed for real: every test below supplies `payingFetch`, so the constructor
// never calls into `payingFetchHedera`/`PrivateKey.fromStringECDSA` with this value.
const UNUSED_HEDERA_KEY = "11".repeat(32);
// A syntactically valid secp256k1 key, used only to derive a payer address locally
// (viem's `privateKeyToAccount`, no network) — every Arc test below injects `arcPay`,
// so this key is never used to actually sign or send a payment.
const TEST_ARC_KEY = ("0x" + "22".repeat(32)) as `0x${string}`;
const report = { vaultId: VAULT_ID, flags: [], score: 0, verdict: "ok" as const, evidence: [] };

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

test("attestationsValid is false when the response has fewer attestations than vaults", async () => {
  // The real handler always emits exactly one attestation per returned vault, so this
  // (one vault, zero attestations) shape can only come from a misbehaving or
  // compromised service — a hand-built fake response via `payingFetch`, not the
  // in-process handler, is the only way to produce it for the test.
  const receipt = buildReceipt(
    {
      service: { erc8004: config.erc8004 },
      request_hash: requestHash({ vaults: [VAULT_ID] }),
      response_hash: responseHash({ vaults: [vault], reports: [report], attestations: [] }),
      sealed: false,
      sources: [],
      price: { amount: "1500", asset: config.hedera.usdcToken, rail: "hedera" },
      payment: { rail: "hedera", txId: "test-tx" },
      tier: "scan",
      hcs: { topicId: config.hedera.hcsTopicId ?? "" },
    },
    keys.sig,
  );
  const c = new VaultRadarClient({
    serviceUrl: base,
    hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
    payingFetch: async () =>
      new Response(JSON.stringify({ vaults: [vault], reports: [report], attestations: [], receipt }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    readPqHash: async () => keys.sig.pubHash,
  });
  const r = await c.scan([VAULT_ID], "hedera", { seal: false });
  expect(r.receiptValid).toBe(true);
  expect(r.attestationsValid).toBe(false);
});

test("a sealed request answered with a clear body throws, instead of silently reporting sealed: true", async () => {
  const c = new VaultRadarClient({
    serviceUrl: base,
    hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
    payingFetch: async () =>
      new Response(JSON.stringify({ vaults: [], reports: [], attestations: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    readPqHash: async () => keys.sig.pubHash,
  });
  // Default seal:true — the fake response above has no `sealed` field at all.
  await expect(c.scan([VAULT_ID], "hedera")).rejects.toThrow(/clear response to a sealed request/);
});

test("a clear request answered with a sealed body throws, instead of silently reporting sealed: false", async () => {
  // Sealed to the service's own KEM key — irrelevant to the test, since the client
  // must reject this before ever attempting to open it.
  const bogusSealed: Sealed = seal({ vaults: [], reports: [], attestations: [] }, keys.kem.publicKey);
  const c = new VaultRadarClient({
    serviceUrl: base,
    hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
    payingFetch: async () =>
      new Response(JSON.stringify({ sealed: bogusSealed }), { status: 200, headers: { "content-type": "application/json" } }),
    readPqHash: async () => keys.sig.pubHash,
  });
  await expect(c.scan([VAULT_ID], "hedera", { seal: false })).rejects.toThrow(/sealed response to a clear request/);
});

test("scan on the arc rail pays via the injected arcPay: bucket URL, payer address, and the sealed round trip all check out", async () => {
  const attestation = buildAttestation(
    {
      vaultId: VAULT_ID, chainId: "1", block: "10", timestamp: String(now - 5),
      sharePrice: vault.sharePrice, tvlUsd: vault.tvlUsd, source: "substreams:erc4626-vault-metrics",
    },
    keys.sig,
  );
  const receipt = buildReceipt(
    {
      service: { erc8004: config.erc8004 },
      request_hash: requestHash({ vaults: [VAULT_ID] }),
      response_hash: responseHash({ vaults: [vault], reports: [report], attestations: [attestation] }),
      sealed: true,
      sources: [],
      price: { amount: ARC_BUCKET_PRICE.s, asset: "USDC", rail: "arc" },
      payment: { rail: "arc", txId: "arc-tx-1" },
      tier: "scan",
      hcs: { topicId: config.hedera.hcsTopicId ?? "" },
    },
    keys.sig,
  );

  let capturedUrl = "";
  let capturedBody: Sealed | undefined;
  const c = new VaultRadarClient({
    serviceUrl: base,
    arc: { privateKey: TEST_ARC_KEY },
    // Stands in for a real Gateway payment: opens the sealed request with the
    // service's own KEM secret (exactly what the real service does) to find the
    // client's ephemeral `reply_pk`, then seals a real, matching reply to it — so
    // `paid()`'s open/verify path runs for real, not against a canned plaintext body.
    arcPay: async (url, body) => {
      capturedUrl = url;
      capturedBody = body as Sealed;
      const opened = openSealedRequest(capturedBody, keys.kem.secretKey, keys.kem.kid);
      const sealedReply = seal({ vaults: [vault], reports: [report], attestations: [attestation] }, fromB64(opened.reply_pk));
      return { data: { sealed: sealedReply, receipt }, amount: 3000n, formattedAmount: "0.003", transaction: "arc-tx-1", status: 200 };
    },
    readPqHash: async () => keys.sig.pubHash,
  });

  const r = await c.scan([VAULT_ID], "arc");

  expect(capturedUrl).toBe(`${base}/arc/v1/scan/s`); // 1 vault -> the "s" bucket
  const opened = openSealedRequest(capturedBody!, keys.kem.secretKey, keys.kem.kid);
  expect(opened.payer).toBe(arcAddress(TEST_ARC_KEY));
  expect(r.rail).toBe("arc");
  expect(r.sealed).toBe(true);
  expect(r.txId).toBe("arc-tx-1");
  expect(r.receiptValid).toBe(true);
  expect(r.attestationsValid).toBe(true);
  expect(r.vaults[0].id).toBe(VAULT_ID);
});

test("an arcPay rejection is wrapped as a clear 'arc payment failed' error, not silently swallowed", async () => {
  const c = new VaultRadarClient({
    serviceUrl: base,
    arc: { privateKey: TEST_ARC_KEY },
    arcPay: async () => {
      // Mirrors GatewayClient.pay()'s own failure mode: it throws rather than
      // resolving with a non-200 `status`.
      throw new Error("Payment failed: insufficient funds");
    },
    readPqHash: async () => keys.sig.pubHash,
  });
  await expect(c.scan([VAULT_ID], "arc")).rejects.toThrow(/arc payment failed: Payment failed: insufficient funds/);
});

test("attestationsValid is false when two attestations name the same vault", async () => {
  // Two vaults came back but both attestations cover the first one: the count matches
  // and both signatures verify, yet the second vault is entirely unattested. Only a
  // bijection check catches this, which is why it gets its own test.
  const vaultB = { ...vault, id: "1:0x" + "b".repeat(40) } as const;
  const reportB = { ...report, vaultId: vaultB.id };
  const dupe = [VAULT_ID, VAULT_ID].map(id =>
    buildAttestation(
      { vaultId: id, chainId: "1", block: "10", timestamp: String(now - 5), sharePrice: vault.sharePrice, tvlUsd: vault.tvlUsd, source: "substreams:erc4626-vault-metrics" },
      keys.sig,
    ),
  );
  const body = { vaults: [vault, vaultB], reports: [report, reportB], attestations: dupe };
  const receipt = buildReceipt(
    {
      service: { erc8004: config.erc8004 },
      request_hash: requestHash({ vaults: [VAULT_ID, vaultB.id] }),
      response_hash: responseHash(body),
      sealed: false,
      sources: [],
      price: { amount: "2000", asset: config.hedera.usdcToken, rail: "hedera" },
      payment: { rail: "hedera", txId: "test-tx" },
      tier: "scan",
      hcs: { topicId: config.hedera.hcsTopicId ?? "" },
    },
    keys.sig,
  );
  const c = new VaultRadarClient({
    serviceUrl: base,
    hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
    payingFetch: async () =>
      new Response(JSON.stringify({ ...body, receipt }), { status: 200, headers: { "content-type": "application/json" } }),
    readPqHash: async () => keys.sig.pubHash,
  });
  const r = await c.scan([VAULT_ID, vaultB.id], "hedera", { seal: false });
  expect(r.receiptValid).toBe(true);
  expect(r.attestations).toHaveLength(2);
  expect(r.attestationsValid).toBe(false);
});

test("sealed is read off the observed response and agrees with the receipt's own signed sealed flag", async () => {
  // `sealed` must describe what actually came back on the wire, not what the client
  // asked for. The service signs its own view of the same fact into the receipt, so
  // asserting the two agree (both ways round) pins the reported value to the response.
  const sealedRun = await client().scan([VAULT_ID], "hedera");
  expect(sealedRun.sealed).toBe(true);
  expect(sealedRun.sealed).toBe(sealedRun.receipt.sealed);

  const clearRun = await client().scan([VAULT_ID], "hedera", { seal: false });
  expect(clearRun.sealed).toBe(false);
  expect(clearRun.sealed).toBe(clearRun.receipt.sealed);
});

test("receiptValid is false when the receipt's request_hash or response_hash does not cover what was exchanged", async () => {
  // A validly signed receipt that commits to a *different* request or response is not
  // a receipt for this purchase. Both hashes are hand-built wrong here, one at a time,
  // to prove each is checked independently of the signature.
  const attestation = buildAttestation(
    { vaultId: VAULT_ID, chainId: "1", block: "10", timestamp: String(now - 5), sharePrice: vault.sharePrice, tvlUsd: vault.tvlUsd, source: "substreams:erc4626-vault-metrics" },
    keys.sig,
  );
  const body = { vaults: [vault], reports: [report], attestations: [attestation] };
  const base402 = {
    service: { erc8004: config.erc8004 },
    sealed: false,
    sources: [],
    price: { amount: "1500", asset: config.hedera.usdcToken, rail: "hedera" as const },
    payment: { rail: "hedera" as const, txId: "test-tx" },
    tier: "scan" as const,
    hcs: { topicId: config.hedera.hcsTopicId ?? "" },
  };
  const mk = (receipt: ReturnType<typeof buildReceipt>) =>
    new VaultRadarClient({
      serviceUrl: base,
      hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
      payingFetch: async () =>
        new Response(JSON.stringify({ ...body, receipt }), { status: 200, headers: { "content-type": "application/json" } }),
      readPqHash: async () => keys.sig.pubHash,
    });

  // Control: both hashes correct -> valid.
  const good = buildReceipt({ ...base402, request_hash: requestHash({ vaults: [VAULT_ID] }), response_hash: responseHash(body) }, keys.sig);
  expect((await mk(good).scan([VAULT_ID], "hedera", { seal: false })).receiptValid).toBe(true);

  // Commits to a scan of a different vault.
  const wrongRequest = buildReceipt(
    { ...base402, request_hash: requestHash({ vaults: ["1:0x" + "c".repeat(40)] }), response_hash: responseHash(body) },
    keys.sig,
  );
  expect((await mk(wrongRequest).scan([VAULT_ID], "hedera", { seal: false })).receiptValid).toBe(false);

  // Commits to a response body that was never returned.
  const wrongResponse = buildReceipt(
    { ...base402, request_hash: requestHash({ vaults: [VAULT_ID] }), response_hash: responseHash({ vaults: [], reports: [], attestations: [] }) },
    keys.sig,
  );
  expect((await mk(wrongResponse).scan([VAULT_ID], "hedera", { seal: false })).receiptValid).toBe(false);
});
