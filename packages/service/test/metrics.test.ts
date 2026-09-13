import { expect, test } from "bun:test";
import { deriveKemKeys, deriveSigningKeys } from "@vaultradar/core";
import { Metrics } from "../src/metrics";
import { loadConfig } from "../src/config";

const env = {
  PQ_SIG_SEED: "11".repeat(32), PQ_KEM_SEED: "22".repeat(64), GRAPH_STUDIO_API_KEY: "k",
  HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1", HEDERA_OPERATOR_KEY: "00",
  ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), HEDERA_HCS_TOPIC_ID: "0.0.9",
  ERC8004_HEDERA_AGENT_ID: "7",
};
const config = loadConfig(env);
const keys = { sig: deriveSigningKeys(env.PQ_SIG_SEED), kem: deriveKemKeys(env.PQ_KEM_SEED) };
const noIdentity = async () => null;

test("recordRequest buckets 2xx into the tier count, 4xx into rejected4xx, and counts unavailable verdicts", () => {
  const m = new Metrics();
  m.recordRequest("scan", 200, ["ok", "unavailable", "unavailable"]);
  m.recordRequest("scan", 422);
  m.recordRequest("table", 200);
  m.recordRequest("table", 502); // neither 2xx nor 4xx: counted in neither bucket

  expect(m.requests.scan).toBe(1);
  expect(m.requests.table).toBe(1);
  expect(m.requests.rejected4xx).toBe(1);
  expect(m.requests.unavailableVerdicts).toBe(2);
  expect(m.requests.lastRequestAt).not.toBeNull();
});

test("recordSettlement accumulates count and revenue independently per rail", () => {
  const m = new Metrics();
  m.recordSettlement("hedera", "1500");
  m.recordSettlement("hedera", "3000");
  m.recordSettlement("arc", "3000");

  expect(m.settlements.hedera.count).toBe(2);
  expect(m.settlements.hedera.revenueAtomic).toBe(4500n);
  expect(m.settlements.arc.count).toBe(1);
  expect(m.settlements.arc.revenueUsdMicros).toBe(3000);
});

// Finding 2, fix round 1: recordSettlement used to call BigInt(amount)/Number(amount)
// unguarded, so a malformed amount would throw. Both rails now call this from inside
// their own dedicated try/catch (see rails/hedera.ts and rails/arc.ts) specifically so
// a throw here can never suppress onSettled or an already-settled response — but the
// method itself is also fixed to never throw at all: bad input is now a no-op.
test("recordSettlement no-ops (does not throw, does not count) on a malformed amount, on either rail", () => {
  const m = new Metrics();
  expect(() => m.recordSettlement("hedera", "not-a-number")).not.toThrow();
  expect(() => m.recordSettlement("hedera", "12.5")).not.toThrow(); // decimal: hedera amounts are always atomic integers
  expect(() => m.recordSettlement("hedera", "-5")).not.toThrow(); // negative: never a valid atomic amount
  expect(() => m.recordSettlement("arc", "0.003")).not.toThrow(); // a dollar-decimal string, NOT what req.payment.amount actually sends (see ATOMIC_AMOUNT_RE's comment in metrics.ts), still must not throw
  expect(() => m.recordSettlement("arc", "")).not.toThrow();

  expect(m.settlements.hedera.count).toBe(0);
  expect(m.settlements.hedera.revenueAtomic).toBe(0n);
  expect(m.settlements.arc.count).toBe(0);
  expect(m.settlements.arc.revenueUsdMicros).toBe(0);
  expect(m.recordingErrors).toBe(5);
});

test("recordSettlement accepts a valid atomic integer amount after a prior malformed call", () => {
  const m = new Metrics();
  m.recordSettlement("arc", "not-a-number");
  m.recordSettlement("arc", "3000");
  expect(m.recordingErrors).toBe(1);
  expect(m.settlements.arc.count).toBe(1);
  expect(m.settlements.arc.revenueUsdMicros).toBe(3000);
});

// Finding 3, fix round 1: the HBAR-priced /hedera/v1/scan-hbar route settles in
// tinybars, not USDC-atomic units — summing those into the same revenueAtomic counter
// as every other Hedera route (all USDC) would silently misrepresent revenue.
test("an HBAR-priced settlement (asset 0.0.0) increments hedera.count but leaves revenueAtomic unchanged", () => {
  const m = new Metrics();
  m.recordSettlement("hedera", "5000000", "0.0.0"); // 0.05 HBAR in tinybars
  expect(m.settlements.hedera.count).toBe(1);
  expect(m.settlements.hedera.revenueAtomic).toBe(0n);

  // A subsequent USDC-asset settlement still accumulates normally, on top of the
  // HBAR settlement's count.
  m.recordSettlement("hedera", "1500", config.hedera.usdcToken);
  expect(m.settlements.hedera.count).toBe(2);
  expect(m.settlements.hedera.revenueAtomic).toBe(1500n);
});

test("a Hedera settlement with no asset argument (or the USDC asset) still accumulates revenueAtomic, unchanged from before the HBAR exclusion", () => {
  const m = new Metrics();
  m.recordSettlement("hedera", "1500"); // no asset passed at all
  m.recordSettlement("hedera", "1500", config.hedera.usdcToken);
  expect(m.settlements.hedera.count).toBe(2);
  expect(m.settlements.hedera.revenueAtomic).toBe(3000n);
});

test("snapshot() produces every field, with string numerics throughout", async () => {
  const m = new Metrics({ now: () => 1000, fetchImpl: async () => new Response("{}", { status: 200 }) });
  m.recordSettlement("arc", "3000");
  const snap = await m.snapshot({ config, hcs: null, keys, readPqHash: noIdentity, rails: { hedera: true, arc: true } });

  for (const numeric of [snap.uptimeSeconds, snap.startedAt, snap.hcs.pending, snap.hcs.submitted, snap.hcs.failed, snap.settlements.hedera.count, snap.settlements.hedera.revenueAtomic, snap.settlements.arc.count, snap.settlements.arc.revenueUsd, snap.requests.scan, snap.requests.table, snap.requests.rejected4xx, snap.requests.unavailableVerdicts]) {
    expect(typeof numeric).toBe("string");
  }
  expect(snap.settlements.arc.revenueUsd).toBe("0.003");
  expect(snap.requests.lastRequestAt).toBeNull(); // no recordRequest call happened
  expect(snap.rails.hedera).toMatchObject({ enabled: true, facilitatorUrl: config.hedera.facilitatorUrl, healthy: true });
  expect(snap.rails.arc).toMatchObject({ enabled: true, facilitatorUrl: config.arc.facilitatorUrl, healthy: true });
  expect(typeof snap.rails.hedera.checkedAt).toBe("string");
  expect(snap.hcs).toEqual({ enabled: false, topicId: config.hedera.hcsTopicId, pending: "0", submitted: "0", failed: "0", lastSequence: null });
  expect(snap.keys).toEqual({ sigPubHash: keys.sig.pubHash, kemKid: keys.kem.kid });
  expect(snap.deployments).toEqual([]);
  expect(snap.heads).toEqual({});
  expect(snap.identity).toEqual([{ chainId: "296", agentId: "7", onChainPubHash: null, matches: false }]);
});

test("uptimeSeconds is monotonic across two snapshots as the injected clock advances", async () => {
  let t = 1000;
  const m = new Metrics({ now: () => t });
  const snap1 = await m.snapshot({ config, hcs: null, keys, readPqHash: noIdentity, rails: {} });
  t += 15;
  const snap2 = await m.snapshot({ config, hcs: null, keys, readPqHash: noIdentity, rails: {} });
  expect(Number(snap2.uptimeSeconds)).toBeGreaterThanOrEqual(Number(snap1.uptimeSeconds));
  expect(Number(snap2.uptimeSeconds) - Number(snap1.uptimeSeconds)).toBe(15);
});

test("a disabled rail is reported unhealthy without ever calling the injected fetch", async () => {
  let calls = 0;
  const m = new Metrics({ fetchImpl: async () => { calls++; return new Response("{}", { status: 200 }); } });
  const snap = await m.snapshot({ config, hcs: null, keys, readPqHash: noIdentity, rails: { hedera: false, arc: false } });
  expect(snap.rails.hedera.healthy).toBe(false);
  expect(snap.rails.arc.healthy).toBe(false);
  expect(calls).toBe(0);
});

test("rail health probe reports healthy:false without throwing when the probe fails, and caches for 30s", async () => {
  let t = 0;
  let calls = 0;
  const m = new Metrics({ now: () => t, fetchImpl: async () => { calls++; throw new Error("network down"); } });

  const snap1 = await m.snapshot({ config, hcs: null, keys, readPqHash: noIdentity, rails: { hedera: true, arc: false } });
  expect(snap1.rails.hedera.healthy).toBe(false);
  expect(calls).toBe(1);

  t += 10; // still within the 30s TTL
  await m.snapshot({ config, hcs: null, keys, readPqHash: noIdentity, rails: { hedera: true, arc: false } });
  expect(calls).toBe(1);

  t += 25; // 35s since the first probe: past the TTL
  await m.snapshot({ config, hcs: null, keys, readPqHash: noIdentity, rails: { hedera: true, arc: false } });
  expect(calls).toBe(2);
});

test("a non-2xx probe response is reported unhealthy", async () => {
  const m = new Metrics({ fetchImpl: async () => new Response("nope", { status: 500 }) });
  const snap = await m.snapshot({ config, hcs: null, keys, readPqHash: noIdentity, rails: { hedera: true, arc: true } });
  expect(snap.rails.hedera.healthy).toBe(false);
  expect(snap.rails.arc.healthy).toBe(false);
});

test("identity matches the service's own pubHash and is cached for 10 minutes", async () => {
  let t = 0;
  let calls = 0;
  const readPqHash = async () => {
    calls++;
    return keys.sig.pubHash;
  };
  const m = new Metrics({ now: () => t });

  const snap1 = await m.snapshot({ config, hcs: null, keys, readPqHash, rails: {} });
  expect(snap1.identity).toEqual([{ chainId: "296", agentId: "7", onChainPubHash: keys.sig.pubHash, matches: true }]);
  expect(calls).toBe(1);

  t += 60; // within the 10-minute TTL
  await m.snapshot({ config, hcs: null, keys, readPqHash, rails: {} });
  expect(calls).toBe(1);

  t += 600; // past the TTL
  await m.snapshot({ config, hcs: null, keys, readPqHash, rails: {} });
  expect(calls).toBe(2);
});

test("a mismatched or unreadable on-chain hash reports matches:false without throwing", async () => {
  const mismatched = new Metrics();
  const snapMismatch = await mismatched.snapshot({ config, hcs: null, keys, readPqHash: async () => "f".repeat(64), rails: {} });
  expect(snapMismatch.identity[0]).toEqual({ chainId: "296", agentId: "7", onChainPubHash: "f".repeat(64), matches: false });

  const throwing = new Metrics();
  const snapThrown = await throwing.snapshot({ config, hcs: null, keys, readPqHash: async () => { throw new Error("rpc down"); }, rails: {} });
  expect(snapThrown.identity[0]).toEqual({ chainId: "296", agentId: "7", onChainPubHash: null, matches: false });
});

test("recordDeployment and recordHead surface in the snapshot, replacing rather than accumulating per key", () => {
  const m = new Metrics({ now: () => 500 });
  m.recordDeployment({ protocol: "aave-v3", chain: "ethereum", chainId: "1" }, { ok: false, lagSeconds: null, error: "query_failed" });
  m.recordDeployment({ protocol: "aave-v3", chain: "ethereum", chainId: "1" }, { ok: true, lagSeconds: 42, error: null });
  m.recordHead("1", { ts: 1700000000, block: 123 }, true);

  return m.snapshot({ config, hcs: null, keys, readPqHash: noIdentity, rails: {} }).then(snap => {
    expect(snap.deployments).toEqual([{ protocol: "aave-v3", chain: "ethereum", chainId: "1", status: "ok", headLagSeconds: "42", lastQueriedAt: "500", lastError: null }]);
    expect(snap.heads).toEqual({ "1": { ts: "1700000000", block: "123", ok: true, checkedAt: "500" } });
  });
});

test("the HCS status reflects a wired queue's stats() and enabled:true", async () => {
  const fakeHcs = { stats: () => ({ pending: 2, submitted: 5, failed: 1, lastSequence: "9" }) } as any;
  const m = new Metrics();
  const snap = await m.snapshot({ config, hcs: fakeHcs, keys, readPqHash: noIdentity, rails: {} });
  expect(snap.hcs).toEqual({ enabled: true, topicId: config.hedera.hcsTopicId, pending: "2", submitted: "5", failed: "1", lastSequence: "9" });
});
