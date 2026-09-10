import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import {
  ARC_BUCKET_PRICE,
  MemoryNonceStore,
  TABLE_PRICE_USD,
  attachSig,
  buildAttestation,
  buildReceipt,
  deriveSigningKeys,
  fromB64,
  hederaScanPriceAtomic,
  openSealedRequest,
  requestHash,
  responseHash,
  seal,
  toB64,
  type Sealed,
} from "@vaultradar/core";
import { buildApp, loadConfig, loadKeys, makeScanHandler, type DataProvider, type HandlerDeps } from "@vaultradar/service";
import { VaultRadarClient } from "../src/client";
import { readPqHashOnChain } from "../src/erc8004";
import { arcAddress, payArcWith } from "../src/rails/arc";
import { HEDERA_TESTNET_CAIP2, maxAcceptableAtomic, overQuoteReason, payingFetchHedera, quoteCeilingPolicy } from "../src/rails/hedera";
import { listRuns, saveRun, type RunRecord } from "../src/runs";
import { identityRefusal } from "../src/watch";

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

/**
 * A client whose discovery sees exactly `card`, so a card no honest service would serve
 * (one whose advertised key hash is not the hash of the key beside it) can be driven
 * through `discover` without standing up a second server. Only `fetchImpl` is replaced;
 * everything `discover` then does to the response is the real code path.
 */
function clientServing(card: unknown, readPqHash: () => Promise<string | null>) {
  return new VaultRadarClient({
    serviceUrl: base,
    hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
    payingFetch: fetch,
    readPqHash,
    fetchImpl: (async () =>
      new Response(JSON.stringify(card), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
}

test("discover verifies the card and compares on-chain hash", async () => {
  const d = await client().discover();
  expect(d.cardSignatureValid).toBe(true);
  expect(d.keyBindingValid).toBe(true);
  expect(d.onChain).toEqual([{ chainId: "296", agentId: "7", matches: true }]);
});

test("a readPqHash returning a different hash yields matches: false", async () => {
  const d = await client(async () => "0".repeat(64)).discover();
  expect(d.onChain[0].matches).toBe(false);
});

test("an on-chain hash in upper-case hex still matches: registry hex casing is not meaning", async () => {
  const d = await client(async () => keys.sig.pubHash.toUpperCase()).discover();
  expect(d.onChain[0].matches).toBe(true);
  expect(d.keyBindingValid).toBe(true);
});

// The substitution the ERC-8004 anchor exists to stop (spec §3, threat 5). The card is
// signed by key B — correctly, so `cardSignatureValid` is true — but advertises the
// *legitimate* service's key hash in `pq.sig.pub_hash`, which is also what the chain
// returns. Comparing the chain against the card's claim would call that a match and the
// agent would pin B; comparing it against the hash of the key the card actually shipped
// is what makes it a mismatch.
test("a card signed by one key but advertising another key's hash is a mismatch, not a match", async () => {
  const attacker = deriveSigningKeys("cd".repeat(32));
  const legitimate = await (await fetch(`${base}/.well-known/agent.json`)).json();
  const substituted = attachSig(
    {
      ...legitimate,
      pq: { ...legitimate.pq, sig: { ...legitimate.pq.sig, public_key: toB64(attacker.publicKey), pub_hash: keys.sig.pubHash } },
    },
    attacker,
  );

  const d = await clientServing(substituted, async () => keys.sig.pubHash).discover();
  // The envelope signature is genuinely valid: it was made by the key the card ships.
  expect(d.cardSignatureValid).toBe(true);
  // But the hash it advertises is not that key's hash, and the chain's pin is not either.
  expect(d.keyBindingValid).toBe(false);
  expect(d.onChain).toEqual([{ chainId: "296", agentId: "7", matches: false }]);
  expect(identityRefusal(d)).toContain("claims a key hash that is not the hash of the key it published");
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

// --- paying no more than the quote -------------------------------------------------
//
// Two independent halves of the same rule. Before payment, a payment policy registered on
// the x402 client refuses to sign for more than the agent quoted. After payment, the price
// the signed receipt states is checked against the same quote, so `priceUsd` is a figure
// the service committed to rather than the agent's own arithmetic restated.

/** A payment requirement as a VaultRadar Hedera route's 402 would carry it. */
const requirement = (amount: string) => ({
  scheme: "exact",
  network: HEDERA_TESTNET_CAIP2,
  asset: "0.0.429274",
  amount,
  payTo: "0.0.1",
  maxTimeoutSeconds: 120,
  extra: {},
});

test("the quote ceiling policy refuses any requirement above the quote, and bounds nothing without one", () => {
  // @x402/core applies policies before the selector picks a requirement, and before the
  // scheme is asked for a payload — so a throw here is a refusal to sign.
  const quote = hederaScanPriceAtomic(1); // "1500", a one-vault scan
  const policy = quoteCeilingPolicy(() => quote);

  // The quote itself and the top of the 1% band both pass, and pass through untouched.
  expect(policy(2, [requirement("1500")] as never)).toHaveLength(1);
  expect(policy(2, [requirement("1515")] as never)).toHaveLength(1);

  // One unit above the band is refused, and the error names both numbers.
  expect(() => policy(2, [requirement("1516")] as never)).toThrow(/refusing to pay/);
  expect(() => policy(2, [requirement("10000000")] as never)).toThrow(
    /demanded 10000000 atomic units for a request quoted at 1500/,
  );
  // One bad option among several is enough: the policy refuses rather than quietly
  // selecting the affordable one, since a service offering both is not behaving.
  expect(() => policy(2, [requirement("1500"), requirement("10000000")] as never)).toThrow(/refusing to pay/);
  // An unreadable amount is refused rather than coerced to a number.
  expect(() => policy(2, [requirement("lots")] as never)).toThrow(/unreadable amount/);

  // With no quote for the request in flight there is no bound to apply, and the policy
  // must not invent one.
  expect(quoteCeilingPolicy(() => null)(2, [requirement("10000000")] as never)).toHaveLength(1);
});

test("the paying fetch registers the quote ceiling, so an over-quote 402 never reaches the signer", async () => {
  // End to end through `payingFetchHedera`, with a fake server that answers 402 demanding
  // far more than the one-vault price. The payment is refused while the payload is being
  // created, which is strictly before any transfer is signed or sent.
  let posts = 0;
  // Encoded by @x402/core's own encoder, so the client parses exactly what a real
  // resource server would send — the refusal has to come from the policy, not from a
  // malformed 402.
  const paymentRequired = encodePaymentRequiredHeader({
    x402Version: 2,
    error: "payment required",
    resource: { url: "http://127.0.0.1/hedera/v1/scan", method: "POST" },
    // $0.90 against a $0.0015 quote: 600 times the price, and deliberately *under*
    // @x402/core's own default $1-per-payment spend control, which would otherwise be the
    // thing that refuses this. Inside that band the quote ceiling is the only defence,
    // which is exactly the gap this policy exists to close.
    accepts: [requirement("900000")],
  } as never);
  const listening = Bun.serve({
    port: 0,
    fetch: () => {
      posts++;
      return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": paymentRequired } });
    },
  });
  try {
    // A real (throwaway) ECDSA key, so the signer is genuinely constructed — the refusal
    // has to come from the policy, not from a key that could not be parsed.
    const paying = payingFetchHedera("0.0.42", "11".repeat(32), () => hederaScanPriceAtomic(1));
    await expect(
      paying(`http://127.0.0.1:${listening.port}/hedera/v1/scan`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vr-count": "1" },
        body: JSON.stringify({ vaults: [VAULT_ID] }),
      }),
    ).rejects.toThrow(/refusing to pay/);
    // Exactly one request: the unpaid probe. The paid retry never happened.
    expect(posts).toBe(1);
  } finally {
    await listening.stop(true);
  }
});

test("on Arc the quote ceiling refuses an over-quote 402 through Circle's own pre-signing hook", async () => {
  // Arc had no pre-payment ceiling at all: `payArc` handed the demanded amount straight to
  // Circle's client, which signed an authorization for it, and the mismatch surfaced only in
  // the receipt check — after Circle had already settled. @x402/core's default $1 spend
  // control does not exist on this rail, so there was no bound whatsoever.
  //
  // Driven through a stub standing in for `GatewayClient`: it records the hook the rail
  // registers and fires it exactly where Circle does (inside payload creation, before
  // anything is signed), raising Circle's own `Payment creation aborted: <reason>`.
  const quote = String(Math.round(Number(ARC_BUCKET_PRICE.s) * 1e6)); // "3000"
  let signed = false;
  const stub = (demandedAtomic: string) => {
    let hook: ((c: { selectedRequirements: { amount: string } }) => Promise<void | { abort: true; reason: string }>) | null = null;
    return {
      onBeforePaymentCreation(h: typeof hook) {
        hook = h;
        return this;
      },
      async pay(_url: string, _options: unknown) {
        const verdict = hook ? await hook({ selectedRequirements: { amount: demandedAtomic } }) : undefined;
        if (verdict && "abort" in verdict) throw new Error(`Payment creation aborted: ${verdict.reason}`);
        signed = true;
        return { data: {}, amount: BigInt(demandedAtomic), formattedAmount: "x", transaction: "arc-tx", status: 200 };
      },
    };
  };

  // The bucket price itself, and the top of the 1% band, both go through and are signed.
  for (const ok of ["3000", "3030"]) {
    signed = false;
    await payArcWith(stub(ok) as never, "http://svc.test/arc/v1/scan/s", { vaults: [] }, {}, quote);
    expect(signed).toBe(true);
  }

  // One unit above the band is refused, before signing, with both numbers in the message.
  signed = false;
  await expect(payArcWith(stub("3031") as never, "http://svc.test/arc/v1/scan/s", { vaults: [] }, {}, quote)).rejects.toThrow(
    /Payment creation aborted: refusing to pay/,
  );
  expect(signed).toBe(false);
  await expect(payArcWith(stub("900000") as never, "http://svc.test/arc/v1/scan/s", { vaults: [] }, {}, quote)).rejects.toThrow(
    /demanded 900000 atomic units for a request quoted at 3000/,
  );
  expect(signed).toBe(false);

  // No quote supplied: no hook is registered, so nothing is bounded (and nothing throws).
  signed = false;
  await payArcWith(stub("900000") as never, "http://svc.test/arc/v1/scan/s", { vaults: [] }, {});
  expect(signed).toBe(true);

  // A quote of zero is a quote, and the two falsy strings that express it are exactly where
  // the ceiling matters most: a service demanding anything at all for a free request must be
  // refused. Registering the hook on truthiness skipped both.
  for (const zeroQuote of ["0", ""]) {
    signed = false;
    await expect(
      payArcWith(stub("1") as never, "http://svc.test/arc/v1/scan/s", { vaults: [] }, {}, zeroQuote),
    ).rejects.toThrow(/Payment creation aborted: refusing to pay/);
    expect(signed).toBe(false);
  }
  // And a demand of zero against a zero quote is still within band, so it is not refused.
  signed = false;
  await payArcWith(stub("0") as never, "http://svc.test/arc/v1/scan/s", { vaults: [] }, {}, "0");
  expect(signed).toBe(true);
});

test("the Arc hook and the Hedera policy refuse on the same band, with the same wording", () => {
  // One rule, two rails. Drifting bands would mean a payment the agent refuses on Hedera and
  // pays on Arc, which is exactly what a shared `overQuoteReason` prevents.
  expect(overQuoteReason("3030", "3000")).toBeNull();
  expect(overQuoteReason("3031", "3000")).toContain("demanded 3031 atomic units");
  expect(maxAcceptableAtomic("3000")).toBe(BigInt(3030));

  const fromHedera = (() => {
    try {
      quoteCeilingPolicy(() => "3000")(2, [requirement("3031")] as never);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  })();
  expect(fromHedera).toContain(overQuoteReason("3031", "3000")!);
});

test("the Arc client passes the request's quote into the rail, so the ceiling is the right one", async () => {
  // The quote has to reach the hook per request, not be fixed at construction: a scan of one
  // vault and a table purchase have different ceilings on the same client.
  const seen: (string | undefined)[] = [];
  const c = new VaultRadarClient({
    serviceUrl: base,
    arc: { privateKey: TEST_ARC_KEY },
    arcPay: async (_url, _body, _headers, quoteAtomic) => {
      seen.push(quoteAtomic);
      // Throwing keeps this test about the plumbing; the sealed round trip is covered above.
      throw new Error("stop here");
    },
    readPqHash: async () => keys.sig.pubHash,
  });
  await expect(c.scan([VAULT_ID], "arc")).rejects.toThrow(/arc payment failed/);
  await expect(c.table("erc4626", "1", "arc")).rejects.toThrow(/arc payment failed/);
  expect(seen).toEqual([
    String(Math.round(Number(ARC_BUCKET_PRICE.s) * 1e6)), // one vault -> the "s" bucket
    String(Math.round(Number(TABLE_PRICE_USD) * 1e6)),
  ]);
});

test("a receipt whose price does not match the quote fails receiptValid, and priceUsd comes from the receipt", async () => {
  const attestation = buildAttestation(
    { vaultId: VAULT_ID, chainId: "1", block: "10", timestamp: String(now - 5), sharePrice: vault.sharePrice, tvlUsd: vault.tvlUsd, source: "substreams:erc4626-vault-metrics" },
    keys.sig,
  );
  const body = { vaults: [vault], reports: [report], attestations: [attestation] };
  const common = {
    service: { erc8004: config.erc8004 },
    request_hash: requestHash({ vaults: [VAULT_ID] }),
    response_hash: responseHash(body),
    sealed: false,
    sources: [],
    payment: { rail: "hedera" as const, txId: "test-tx" },
    tier: "scan" as const,
    hcs: { topicId: config.hedera.hcsTopicId ?? "" },
  };
  const withAmount = (amount: string) =>
    new VaultRadarClient({
      serviceUrl: base,
      hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
      payingFetch: async () =>
        new Response(
          JSON.stringify({
            ...body,
            receipt: buildReceipt({ ...common, price: { amount, asset: config.hedera.usdcToken, rail: "hedera" } }, keys.sig),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      readPqHash: async () => keys.sig.pubHash,
    });

  // Control: the real one-vault price. Valid, and priceUsd is derived from the receipt's
  // own atomic amount rather than recomputed locally.
  const ok = await withAmount(hederaScanPriceAtomic(1)).scan([VAULT_ID], "hedera", { seal: false });
  expect(ok.receiptValid).toBe(true);
  expect(ok.priceUsd).toBe("0.0015");

  // Ten dollars for a request quoted at a seventh of a cent: correctly signed, commits to
  // the right request and response, and still not a receipt for this purchase.
  const overcharged = await withAmount("10000000").scan([VAULT_ID], "hedera", { seal: false });
  expect(overcharged.receiptValid).toBe(false);
  expect(overcharged.priceUsd).toBe("10");

  // Understating the price fails too: the number is cited in run records, so a receipt
  // that disagrees with the quote in either direction is not trusted.
  const undercharged = await withAmount("1").scan([VAULT_ID], "hedera", { seal: false });
  expect(undercharged.receiptValid).toBe(false);

  // An amount that is not a number at all leaves priceUsd null rather than NaN.
  const garbled = await withAmount("free").scan([VAULT_ID], "hedera", { seal: false });
  expect(garbled.receiptValid).toBe(false);
  expect(garbled.priceUsd).toBeNull();
});

test("on the arc rail both the receipt's price and the Gateway's reported amount are checked against the quote", async () => {
  const attestation = buildAttestation(
    { vaultId: VAULT_ID, chainId: "1", block: "10", timestamp: String(now - 5), sharePrice: vault.sharePrice, tvlUsd: vault.tvlUsd, source: "substreams:erc4626-vault-metrics" },
    keys.sig,
  );
  const body = { vaults: [vault], reports: [report], attestations: [attestation] };
  const mk = (receiptAmount: string, paid: bigint) =>
    new VaultRadarClient({
      serviceUrl: base,
      arc: { privateKey: TEST_ARC_KEY },
      // `as any` on `data` only: the `vault` fixture above is `as const`, so its
      // `history: readonly []` doesn't satisfy `UnifiedVault` structurally — the same cast
      // every other fixture in this file uses for the same reason.
      arcPay: async () => ({
        data: {
          ...body,
          receipt: buildReceipt(
            {
              service: { erc8004: config.erc8004 },
              request_hash: requestHash({ vaults: [VAULT_ID] }),
              response_hash: responseHash(body),
              sealed: false,
              sources: [],
              // Arc receipts carry the USD decimal string, not an atomic amount.
              price: { amount: receiptAmount, asset: "USDC", rail: "arc" },
              payment: { rail: "arc", txId: "arc-tx-1" },
              tier: "scan",
              hcs: { topicId: config.hedera.hcsTopicId ?? "" },
            },
            keys.sig,
          ),
        } as any,
        amount: paid,
        formattedAmount: String(Number(paid) / 1e6),
        transaction: "arc-tx-1",
        status: 200,
      }),
      readPqHash: async () => keys.sig.pubHash,
    });

  // Control: the "s" bucket price in both places.
  const ok = await mk(ARC_BUCKET_PRICE.s, 3000n).scan([VAULT_ID], "arc", { seal: false });
  expect(ok.receiptValid).toBe(true);
  expect(ok.priceUsd).toBe(ARC_BUCKET_PRICE.s);

  // The receipt says the bucket price but Circle reports authorizing ten times as much.
  const overpaid = await mk(ARC_BUCKET_PRICE.s, 30000n).scan([VAULT_ID], "arc", { seal: false });
  expect(overpaid.receiptValid).toBe(false);

  // Circle reports the right amount but the receipt names a different price.
  const mislabelled = await mk("0.05", 3000n).scan([VAULT_ID], "arc", { seal: false });
  expect(mislabelled.receiptValid).toBe(false);
  expect(mislabelled.priceUsd).toBe("0.05");
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
