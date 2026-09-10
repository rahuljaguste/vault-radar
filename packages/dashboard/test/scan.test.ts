import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryNonceStore, type UnifiedVault } from "@vaultradar/core";
import { buildApp, loadConfig, loadKeys, makeScanHandler, type DataProvider, type HandlerDeps } from "@vaultradar/service";
import { VaultRadarClient, type Policy } from "@vaultradar/agent";
import { RateLimiter } from "../lib/ratelimit";
import { defaultPolicyPath, handleScan, redact } from "../lib/scan";
import type { RunRecord } from "../lib/types";

/**
 * Drives `handleScan` against a real in-process VaultRadar service, the way
 * `packages/agent/test/client.test.ts` does: `buildApp` mounts discovery, the
 * Hedera scan route is mounted raw with a fixed payer and tx id (standing in for
 * what the x402 middleware sets once payment clears), and the injected client
 * uses plain `fetch` as its paying fetch plus a stub on-chain key reader. No
 * Hedera signer is ever constructed and nothing is paid.
 *
 * The policy is a real file read by the agent's own `loadPolicy`, so these cover
 * the policy plumbing rather than a hand-built `Policy` object.
 */

const now = Math.floor(Date.now() / 1000);
const MAX_AGE = 900;

const OK_VAULT = "1:0x" + "a".repeat(40);
const ALERT_VAULT = "1:0x" + "b".repeat(40);
const WATCH_VAULT = "1:0x" + "c".repeat(40);
const STALE_VAULT = "1:0x" + "d".repeat(40);
const OLD_ATTESTATION_VAULT = "1:0x" + "e".repeat(40);
const UNKNOWN_VAULT = "1:0x" + "f".repeat(40);

/** A vault the risk model scores from its share-price history. */
function vault(id: string, opts: { history?: { ageSeconds: number; sharePrice: string }[]; freshness?: "fresh" | "stale"; sourceAge?: number } = {}): UnifiedVault {
  const sourceAge = opts.sourceAge ?? 5;
  return {
    id,
    kind: "erc4626",
    protocol: "erc4626",
    chain: "ethereum",
    chainId: "1",
    asset: null,
    sharePrice: "1.00",
    tvlUsd: null,
    inputTokenBalance: "100",
    depositLimit: null,
    history: (opts.history ?? []).map((h, i) => ({
      block: String(1000 - i),
      timestamp: String(now - h.ageSeconds),
      sharePrice: h.sharePrice,
      tvlUsd: null,
      netFlowAssets: null,
    })),
    sources: [
      {
        kind: "substreams",
        ref: "erc4626-vault-metrics",
        block: "1000",
        timestamp: String(now - sourceAge),
        ageSeconds: String(sourceAge),
        freshness: opts.freshness ?? "fresh",
      },
    ],
    freshness: opts.freshness ?? "fresh",
  };
}

// share price 1.00 now vs 1.10 an hour ago is a 9% drawdown: trips the 1h (+30)
// and 24h (+25) windows for a score of 55, which is an `alert`.
const ALERT_HISTORY = [
  { ageSeconds: 3700, sharePrice: "1.10" },
  { ageSeconds: 3600 * 24, sharePrice: "1.10" },
];
// Only the 24h window (+25), which is a `watch`.
const WATCH_HISTORY = [{ ageSeconds: 3600 * 24, sharePrice: "1.05" }];

const VAULTS: Record<string, UnifiedVault> = {
  [OK_VAULT]: vault(OK_VAULT),
  [ALERT_VAULT]: vault(ALERT_VAULT, { history: ALERT_HISTORY }),
  [WATCH_VAULT]: vault(WATCH_VAULT, { history: WATCH_HISTORY }),
  [STALE_VAULT]: vault(STALE_VAULT, { freshness: "stale" }),
  // Declared fresh by the provider but attested from well before the policy's
  // max-age bar, which is exactly the case the agent's own age check exists to catch.
  [OLD_ATTESTATION_VAULT]: vault(OLD_ATTESTATION_VAULT, { sourceAge: MAX_AGE + 600 }),
};

const data: DataProvider = {
  catalog: async () => ({ protocols: [], erc4626Chains: ["1"] }),
  scan: async (ids: string[]) => ({
    vaults: ids.map((id) => VAULTS[id]).filter((v): v is UnifiedVault => v !== undefined),
    sources: [{ kind: "substreams", ref: "erc4626-vault-metrics", chainId: "1", block: "1000", timestamp: String(now - 5), ageSeconds: "5", freshness: "fresh" }],
  }),
  table: async () => ({ vaults: [VAULTS[OK_VAULT]], sources: [] }),
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

// The agent card bakes PUBLIC_URL into the endpoints the client follows, so the
// card's declared origin must be the origin the test server actually listens on.
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const config = loadConfig({
  PORT: String(port), PUBLIC_URL: base, PQ_SIG_SEED: "aa".repeat(32), PQ_KEM_SEED: "bb".repeat(64),
  GRAPH_STUDIO_API_KEY: "k", HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1",
  HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), HEDERA_HCS_TOPIC_ID: "0.0.99",
  ERC8004_HEDERA_AGENT_ID: "7",
});
const keys = loadKeys(config);
const app = await buildApp({ config, keys, data, hcs: null, nonces: new MemoryNonceStore(), rails: {} });
const scanDeps: HandlerDeps = {
  keys, config, data, nonces: new MemoryNonceStore(), rail: "hedera", tier: "scan",
  getPayer: () => "0.0.42", getTxId: () => "0.0.42@1700000000.000000001",
};
app.post("/hedera/v1/scan", makeScanHandler(scanDeps));
const server = app.listen(port);

const scratch = mkdtempSync(join(tmpdir(), "vaultradar-scan-"));
const runDir = join(scratch, "runs");
const BALANCED: Policy = {
  budget: { usdc_hedera: "1.00", usdc_arc: "1.00" },
  privacy: "balanced",
  rail_preference: "cheapest",
  max_age_seconds: MAX_AGE,
};

/** Writes a policy file and returns its path, so the real `loadPolicy` reads it. */
function policyFile(name: string, policy: unknown): string {
  const file = join(scratch, `${name}.json`);
  writeFileSync(file, JSON.stringify(policy, null, 2));
  return file;
}

const balancedPolicy = policyFile("balanced", BALANCED);

// Never parsed: every client below injects `payingFetch`, so `payingFetchHedera`
// and the Hedera key parser are never reached.
const UNUSED_KEY = "11".repeat(32);

type Deps = NonNullable<Parameters<typeof handleScan>[1]>;

function deps(over: Partial<Deps> = {}, onChainHash: string | null = keys.sig.pubHash): Deps {
  return {
    makeClient: (serviceUrl, hedera) =>
      new VaultRadarClient({ serviceUrl, hedera, payingFetch: fetch, readPqHash: async () => onChainHash }),
    runsDir: () => runDir,
    policyPath: () => balancedPolicy,
    limiter: new RateLimiter(),
    now: () => now,
    env: { AGENT_HEDERA_ACCOUNT_ID: "0.0.42", AGENT_HEDERA_KEY: UNUSED_KEY, SERVICE_URL: base },
    ...over,
  };
}

function post(vaults: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://dashboard.test/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ vaults }),
  });
}

function runFiles(): RunRecord[] {
  let files: string[];
  try {
    files = readdirSync(runDir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(runDir, f), "utf8")) as RunRecord);
}

beforeEach(() => {
  try {
    for (const f of readdirSync(runDir)) rmSync(join(runDir, f));
  } catch {
    // The directory is created by saveRun on the first purchase.
  }
});

afterAll(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- policy */

test("the shipped default policy path points at the agent's example policy", () => {
  expect(defaultPolicyPath().endsWith(join("packages", "agent", "policy.example.json"))).toBe(true);
});

test("the agent's own loadPolicy is what reads the file, so its errors surface as a 503", async () => {
  const res = await handleScan(post([OK_VAULT]), deps({ policyPath: () => join(scratch, "absent.json") }));
  expect(res.status).toBe(503);
  expect((await res.json()).error).toContain("the agent policy could not be loaded");
  expect(runFiles()).toHaveLength(0);
});

test("an invalid policy is a 503 naming the offending field, not a silent default budget", async () => {
  const bad = policyFile("bad", { budget: { usdc_hedera: "free", usdc_arc: "1.00" } });
  const res = await handleScan(post([OK_VAULT]), deps({ policyPath: () => bad }));
  expect(res.status).toBe(503);
  expect((await res.json()).error).toContain("budget.usdc_hedera");
});

test("a strict privacy policy is refused rather than silently downgraded to a scan", async () => {
  // `chooseTier` maps strict to the table tier, which hides the holding from the
  // vendor. Serving it as a scan would disclose exactly what the policy protects.
  const strict = policyFile("strict", { ...BALANCED, privacy: "strict" });
  const res = await handleScan(post([OK_VAULT]), deps({ policyPath: () => strict }));
  expect(res.status).toBe(503);
  expect((await res.json()).error).toContain("whole protocol tables");
  expect(runFiles()).toHaveLength(0);
});

test("a cheap privacy policy sends the request in the clear, as chooseTier dictates", async () => {
  const cheap = policyFile("cheap", { ...BALANCED, privacy: "cheap" });
  const res = await handleScan(post([OK_VAULT]), deps({ policyPath: () => cheap }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.requests[0].sealed).toBe(false);
  expect(runFiles()[0].policy.privacy).toBe("cheap");
});

test("400 when the quote exceeds the policy's hedera budget, before anything is paid", async () => {
  const broke = policyFile("broke", { ...BALANCED, budget: { usdc_hedera: "0.001", usdc_arc: "1.00" } });
  const res = await handleScan(post([OK_VAULT, WATCH_VAULT]), deps({ policyPath: () => broke }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(
    "the quote of 0.002 USD for 2 vaults exceeds the policy's hedera budget of 0.001 USD",
  );
  expect(runFiles()).toHaveLength(0);
});

test("the budget gate does not consume the rate-limit window", async () => {
  const broke = policyFile("broke2", { ...BALANCED, budget: { usdc_hedera: "0.001", usdc_arc: "1.00" } });
  const limiter = new RateLimiter();
  expect((await handleScan(post([OK_VAULT]), deps({ policyPath: () => broke, limiter }))).status).toBe(400);
  expect((await handleScan(post([OK_VAULT]), deps({ limiter }))).status).toBe(200);
});

/* ------------------------------------------------------------------- happy path */

test("a paid scan returns verdicts, decisions, the tx id and the receipt hash", async () => {
  const res = await handleScan(post([OK_VAULT]), deps());
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.runId).toMatch(/^web-[0-9a-f]{12}$/);
  expect(body.priceUsd).toBe("0.0015");
  expect(body.receiptHash).toMatch(/^[0-9a-f]{64}$/);
  // `payingFetch: fetch` means no x402 `payment-response` header, so the tx id comes
  // from the service-signed receipt instead of the header.
  expect(body.txId).toBe("0.0.42@1700000000.000000001");

  expect(body.requests).toHaveLength(1);
  const request = body.requests[0];
  expect(request.rail).toBe("hedera");
  expect(request.tier).toBe("scan");
  expect(request.sealed).toBe(true);
  expect(request.receiptHash).toBe(body.receiptHash);
  expect(request.verdicts).toEqual([{ vaultId: OK_VAULT, verdict: "ok", score: 0, flags: [] }]);
  expect(request.rejected).toEqual([]);

  expect(body.decisions).toHaveLength(1);
  expect(body.decisions[0].vaultId).toBe(OK_VAULT);
  expect(body.decisions[0].action).toBe("hold");
  expect(body.decisions[0].citations.receiptHash).toBe(body.receiptHash);
  expect(body.decisions[0].citations.source).toBe("substreams:erc4626-vault-metrics");
  expect(body.decisions[0].citations.block).toBe("1000");
});

test("the run is written to RUNS_DIR with the RunRecord shape and the policy that was loaded", async () => {
  const res = await handleScan(post([OK_VAULT]), deps());
  const body = await res.json();

  const runs = runFiles();
  expect(runs).toHaveLength(1);
  const run = runs[0];
  expect(run.id).toBe(body.runId);
  expect(run.serviceUrl).toBe(base);
  expect(new Date(run.startedAt).toISOString()).toBe(run.startedAt);
  // Verbatim the policy file, so the record says what the purchase actually ran under.
  expect(run.policy).toEqual(BALANCED);
  expect(run.discovery.cardSignatureValid).toBe(true);
  expect(run.discovery.pubHash).toBe(keys.sig.pubHash);
  expect(run.discovery.kid).toBe(keys.kem.kid);
  expect(run.discovery.onChain).toEqual([{ chainId: "296", agentId: "7", matches: true }]);
  expect(run.requests[0].receipt.sig.alg).toBe("ML-DSA-65");
  expect(run.decisions[0].action).toBe("hold");
});

test("the run file contains no key material and no account id", async () => {
  await handleScan(post([OK_VAULT]), deps());
  const raw = readdirSync(runDir).map((f) => readFileSync(join(runDir, f), "utf8")).join("");
  expect(raw).not.toContain(UNUSED_KEY);
  // The paying account id appears nowhere in the record; the receipt's payment
  // reference is the service's own tx id, which is public.
  expect(raw).not.toContain('"0.0.42"');
});

test("every verdict maps to its action: alert to withdraw, watch to rebalance, ok to hold", async () => {
  const res = await handleScan(post([ALERT_VAULT, WATCH_VAULT, OK_VAULT]), deps());
  expect(res.status).toBe(200);
  const body = await res.json();

  const verdicts = Object.fromEntries(body.requests[0].verdicts.map((v: { vaultId: string; verdict: string }) => [v.vaultId, v.verdict]));
  expect(verdicts).toEqual({ [ALERT_VAULT]: "alert", [WATCH_VAULT]: "watch", [OK_VAULT]: "ok" });

  const actions = Object.fromEntries(body.decisions.map((d: { vaultId: string; action: string }) => [d.vaultId, d.action]));
  expect(actions).toEqual({ [ALERT_VAULT]: "withdraw", [WATCH_VAULT]: "rebalance", [OK_VAULT]: "hold" });

  const alert = body.requests[0].verdicts.find((v: { vaultId: string }) => v.vaultId === ALERT_VAULT);
  expect(alert.flags.map((f: { name: string }) => f.name).sort()).toEqual(["share_price_drawdown_1h", "share_price_drawdown_24h"]);
  expect(body.decisions.find((d: { vaultId: string }) => d.vaultId === ALERT_VAULT).reason).toContain("share_price_drawdown_1h");
});

test("a vault the service reports unavailable becomes insufficient data, not an action", async () => {
  const res = await handleScan(post([STALE_VAULT]), deps());
  const body = await res.json();
  expect(body.requests[0].verdicts[0].verdict).toBe("unavailable");
  expect(body.decisions[0].action).toBe("insufficient data");
  expect(body.decisions[0].reason).toContain("verdict unavailable");
});

test("an attestation older than the policy's max age is rejected and blocks any action on that vault", async () => {
  const res = await handleScan(post([OLD_ATTESTATION_VAULT, OK_VAULT]), deps());
  const body = await res.json();

  expect(body.requests[0].rejected).toEqual([{ vaultId: OLD_ATTESTATION_VAULT, ageSeconds: MAX_AGE + 600 }]);
  const stale = body.decisions.find((d: { vaultId: string }) => d.vaultId === OLD_ATTESTATION_VAULT);
  expect(stale.action).toBe("insufficient data");
  // Wording comes from the agent's own `decide`, which this route now uses directly.
  expect(stale.reason).toContain("beyond the policy's max age");
  // The fresh vault in the same purchase is unaffected.
  expect(body.decisions.find((d: { vaultId: string }) => d.vaultId === OK_VAULT).action).toBe("hold");
});

test("a tighter policy max age rejects a vault the default policy accepts", async () => {
  const strictAge = policyFile("strict-age", { ...BALANCED, max_age_seconds: 1 });
  const res = await handleScan(post([OK_VAULT]), deps({ policyPath: () => strictAge }));
  const body = await res.json();
  expect(body.requests[0].rejected).toEqual([{ vaultId: OK_VAULT, ageSeconds: 5 }]);
  expect(body.decisions[0].action).toBe("insufficient data");
});

test("a vault the service does not know simply does not appear, and the rest still answers", async () => {
  const res = await handleScan(post([OK_VAULT, UNKNOWN_VAULT]), deps());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.requests[0].verdicts.map((v: { vaultId: string }) => v.vaultId)).toEqual([OK_VAULT]);
  expect(body.decisions.map((d: { vaultId: string }) => d.vaultId)).toEqual([OK_VAULT]);
});

/* --------------------------------------------------------------- failures */

test("503 with the documented error when the agent keys are absent", async () => {
  for (const env of [
    {},
    { AGENT_HEDERA_ACCOUNT_ID: "0.0.42" },
    { AGENT_HEDERA_KEY: UNUSED_KEY },
    { AGENT_HEDERA_ACCOUNT_ID: "   ", AGENT_HEDERA_KEY: "   " },
  ]) {
    const res = await handleScan(post([OK_VAULT]), deps({ env }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "agent keys not configured" });
  }
  expect(runFiles()).toHaveLength(0);
});

test("the keys check runs before the body is read, so a misconfigured deploy never looks like a bad request", async () => {
  const bad = new Request("http://dashboard.test/api/scan", { method: "POST", body: "not json" });
  const res = await handleScan(bad, deps({ env: {} }));
  expect(res.status).toBe(503);
});

test("400 on a body that is not JSON", async () => {
  const res = await handleScan(new Request("http://dashboard.test/api/scan", { method: "POST", body: "{oops" }), deps());
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("request body must be JSON");
});

test("400 when vaults is missing or not a list of strings", async () => {
  for (const vaults of [undefined, 42, [1, 2], [OK_VAULT, 7], {}, null]) {
    const res = await handleScan(post(vaults), deps());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("expected a JSON body");
  }
});

test("400 with the parser's own message on a malformed vault id", async () => {
  const res = await handleScan(post(["not-a-vault"]), deps());
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("it has no ':' separating the chain id from the address");
  expect(runFiles()).toHaveLength(0);
});

test("400 on an empty list and on more than 100 vaults", async () => {
  expect((await handleScan(post([]), deps())).status).toBe(400);
  const many = Array.from({ length: 101 }, (_, i) => `1:0x${i.toString(16).padStart(40, "0")}`);
  const res = await handleScan(post(many), deps());
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("The maximum for one scan is 100");
});

test("a vaults string is accepted as well as an array, since that is what a textarea holds", async () => {
  const res = await handleScan(post(`${OK_VAULT}\n${WATCH_VAULT}`), deps());
  expect(res.status).toBe(200);
  expect((await res.json()).requests[0].verdicts).toHaveLength(2);
});

test("429 on a second scan inside the window, with a retry-after header, and no second run written", async () => {
  const shared = deps({ limiter: new RateLimiter() });
  expect((await handleScan(post([OK_VAULT]), shared)).status).toBe(200);

  const res = await handleScan(post([OK_VAULT]), shared);
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe("30");
  expect((await res.json()).error).toContain("one paid scan per 30 seconds");
  expect(runFiles()).toHaveLength(1);
});

test("the rate limit is per client address, so two callers do not block each other", async () => {
  const shared = deps({ limiter: new RateLimiter() });
  expect((await handleScan(post([OK_VAULT], { "x-forwarded-for": "1.1.1.1" }), shared)).status).toBe(200);
  expect((await handleScan(post([OK_VAULT], { "x-forwarded-for": "2.2.2.2" }), shared)).status).toBe(200);
  expect((await handleScan(post([OK_VAULT], { "x-forwarded-for": "1.1.1.1" }), shared)).status).toBe(429);
});

test("a rejected request does not consume the rate-limit window", async () => {
  const shared = deps({ limiter: new RateLimiter() });
  expect((await handleScan(post(["garbage"]), shared)).status).toBe(400);
  expect((await handleScan(post([OK_VAULT]), shared)).status).toBe(200);
});

test("502 and no payment when the service's on-chain key hash does not match its card", async () => {
  const res = await handleScan(post([OK_VAULT]), deps({}, "0".repeat(64)));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("on-chain ERC-8004 key hash does not match");
  expect(runFiles()).toHaveLength(0);
});

test("502 when the service cannot be reached at all", async () => {
  const unreachable = `http://127.0.0.1:${await freePort()}`;
  const res = await handleScan(post([OK_VAULT]), deps({ env: { AGENT_HEDERA_ACCOUNT_ID: "0.0.42", AGENT_HEDERA_KEY: UNUSED_KEY, SERVICE_URL: unreachable } }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("could not reach or verify the service");
  expect(runFiles()).toHaveLength(0);
});

test("502 when the paid scan itself fails, with the key redacted from the message", async () => {
  const res = await handleScan(
    post([OK_VAULT]),
    deps({
      makeClient: (serviceUrl, hedera) =>
        new VaultRadarClient({
          serviceUrl,
          hedera,
          readPqHash: async () => keys.sig.pubHash,
          // A rail that answers with the key in its error text is the worst case this
          // has to survive; nothing may echo it back to the caller.
          payingFetch: async () => {
            throw new Error(`socket hang up while signing with ${UNUSED_KEY}`);
          },
        }),
    }),
  );
  expect(res.status).toBe(502);
  const error: string = (await res.json()).error;
  expect(error).toContain("the paid scan failed");
  expect(error).not.toContain(UNUSED_KEY);
  expect(error).toContain("[redacted]");
});

test("a client that cannot be constructed is a 503, not a crash", async () => {
  const res = await handleScan(
    post([OK_VAULT]),
    deps({
      makeClient: () => {
        throw new Error(`invalid private key ${UNUSED_KEY}`);
      },
    }),
  );
  expect(res.status).toBe(503);
  const error: string = (await res.json()).error;
  expect(error).toBe("the agent payment key could not be loaded");
  expect(error).not.toContain(UNUSED_KEY);
});

/* ----------------------------------------------------------------- redact */

test("redact removes every form of a secret and bounds the message length", () => {
  const key = "ab".repeat(32);
  expect(redact(new Error(`failed with ${key}`), [key])).toBe("failed with [redacted]");
  expect(redact(new Error(`failed with 0x${key}`), [key])).toBe("failed with [redacted]");
  expect(redact(new Error(`failed with ${key}`), [`0x${key}`])).toBe("failed with [redacted]");
  // Too short to be a key, and redacting it would mangle unrelated text.
  expect(redact(new Error("failed with 0.0.42"), ["0.0.42"])).toBe("failed with 0.0.42");
  expect(redact(new Error("x".repeat(500)), [])).toHaveLength(303);
  expect(redact("a plain string", [])).toBe("a plain string");
});
