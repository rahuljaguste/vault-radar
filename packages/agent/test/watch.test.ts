import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultRadarClient } from "../src/client";
import type { Policy } from "../src/policy";
import { listRuns, type RunRecord } from "../src/runs";
import { pollHcs, runWatch, type WatchDeps } from "../src/watch";
import { ALERT_VAULT as ALERT, NOW as now, STALE_VAULT as STALE, TEST_TX_ID, UNUSED_HEDERA_KEY, startHarness } from "./harness";

const h = await startHarness();
const base = h.base;
const keys = h.keys;
const policy = h.policy;
const client = h.client;

function deps(over: Partial<WatchDeps> = {}): { deps: WatchDeps; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      client: client(),
      policy: policy(),
      balances: async () => ({ hedera: "5.00", arc: "0" }),
      health: async () => ({ hedera: true, arc: false }),
      now: () => now,
      out: line => lines.push(line),
      // Collapse the 3 s receipt-poll gaps so the suite stays fast; the poll itself
      // still runs for real against the in-process service.
      sleep: async () => {},
      fetchImpl: fetch,
      runId: () => "testrun",
      ...over,
    },
  };
}

const runsDir = () => mkdtempSync(join(tmpdir(), "vaultradar-watch-"));

test("watch runs discover -> quote -> scan -> decide, writes a RunRecord, and exits 0", async () => {
  const dir = runsDir();
  const { deps: d, lines } = deps();
  const out = await runWatch({ vaults: [ALERT], serviceUrl: base, runsDir: dir }, d);

  expect(out.exitCode).toBe(0);
  expect(out.message).toBeNull();
  expect(out.runPath).not.toBeNull();

  const saved = JSON.parse(readFileSync(out.runPath!, "utf8")) as RunRecord;
  // Exactly the RunRecord contract shared with packages/dashboard — no more, no less.
  expect(Object.keys(saved).sort()).toEqual(["decisions", "discovery", "id", "policy", "requests", "serviceUrl", "startedAt"]);
  expect(saved.id).toBe("testrun");
  expect(saved.serviceUrl).toBe(base);
  expect(saved.policy).toEqual(policy());
  expect(saved.discovery.cardSignatureValid).toBe(true);
  expect(saved.discovery.pubHash).toBe(keys.sig.pubHash);
  expect(saved.discovery.kid).toBe(keys.kem.kid);
  expect(saved.discovery.onChain).toEqual([{ chainId: "296", agentId: "7", matches: true }]);

  expect(saved.requests).toHaveLength(1);
  const req = saved.requests[0];
  expect(Object.keys(req).sort()).toEqual(
    ["priceUsd", "rail", "receipt", "receiptHash", "rejected", "sealed", "tier", "txId", "verdicts"].sort(),
  );
  expect(req.rail).toBe("hedera");
  expect(req.tier).toBe("scan");
  expect(req.sealed).toBe(true);
  expect(req.priceUsd).toBe("0.0015");
  expect(req.receipt.payment.txId).toBe(TEST_TX_ID);
  expect(req.receiptHash).toMatch(/^[0-9a-f]{64}$/);
  expect(req.verdicts).toEqual([{ vaultId: ALERT, verdict: "alert", score: 55, flags: req.verdicts[0].flags }]);
  expect(req.verdicts[0].flags.map(f => f.name)).toEqual(["share_price_drawdown_1h", "share_price_drawdown_24h"]);
  expect(req.rejected).toEqual([]);

  expect(saved.decisions).toHaveLength(1);
  expect(saved.decisions[0]).toMatchObject({ vaultId: ALERT, action: "withdraw" });
  expect(saved.decisions[0].citations).toEqual({
    block: "4242",
    source: "substreams:erc4626-vault-metrics",
    txId: null,
    receiptHash: req.receiptHash,
  });

  // The run is discoverable by the dashboard's own listing helper.
  expect(listRuns(dir).map(r => r.id)).toEqual(["testrun"]);

  // Output cites every piece of evidence per vault, plus the run path. Block and
  // sequence are matched as standalone tokens, not bare substrings — a 64-hex receipt
  // hash can contain any short digit run by chance.
  const text = lines.join("\n");
  expect(text).toContain(ALERT);
  expect(text).toContain("alert");
  expect(text).toContain("withdraw");
  expect(lines.some(l => /(^|\s)4242(\s|$)/.test(l))).toBe(true); // evidence block
  expect(text).toContain("substreams:erc4626-vault-metrics");
  expect(text).toContain(TEST_TX_ID); // payment tx id, from the signed receipt
  expect(text).toContain(req.receiptHash); // full hash, not just the truncated column
  expect(text).toContain("sequence 1234"); // HCS consensus sequence, polled from /v1/receipts/:hash
  expect(text).toContain(out.runPath!);
  // Never print or persist key material.
  expect(text).not.toContain(UNUSED_HEDERA_KEY);
  expect(readFileSync(out.runPath!, "utf8")).not.toContain(UNUSED_HEDERA_KEY);
});

test("pollHcs retries up to three times with the configured gap and reports 'no sequence yet' rather than failing", async () => {
  let calls = 0;
  const gaps: number[] = [];
  const late = async () => {
    calls += 1;
    // Not published yet on the first two polls, then a sequence appears.
    const sequence = calls >= 3 ? 77 : null;
    return new Response(JSON.stringify({ receipt_hash: "h", topicId: "0.0.99", sequence }), { status: 200 });
  };
  const got = await pollHcs(base, "deadbeef", { fetchImpl: late as unknown as typeof fetch, sleep: async ms => void gaps.push(ms) });
  expect(calls).toBe(3);
  expect(gaps).toEqual([3000, 3000]);
  expect(got).toEqual({ topicId: "0.0.99", sequence: 77 });

  // Never published, and an unreachable service, both come back as a null sequence.
  const never = async () => new Response(JSON.stringify({ topicId: "0.0.99", sequence: null }), { status: 200 });
  expect(await pollHcs(base, "deadbeef", { fetchImpl: never as unknown as typeof fetch, sleep: async () => {} }))
    .toEqual({ topicId: "0.0.99", sequence: null });
  const down = async () => {
    throw new Error("ECONNREFUSED");
  };
  expect(await pollHcs(base, "deadbeef", { fetchImpl: down as unknown as typeof fetch, sleep: async () => {} }))
    .toEqual({ topicId: null, sequence: null });
});

test("an attestation older than the policy's max age yields 'insufficient data' even though the service calls it fresh", async () => {
  const dir = runsDir();
  // The service reports `freshness: "fresh"` and a real verdict for this vault; only
  // the agent's own 10 s bar rejects it.
  const { deps: d, lines } = deps({ policy: policy({ max_age_seconds: 10 }) });
  const out = await runWatch({ vaults: [STALE], serviceUrl: base, runsDir: dir }, d);

  expect(out.exitCode).toBe(0);
  const saved = JSON.parse(readFileSync(out.runPath!, "utf8")) as RunRecord;
  expect(saved.requests[0].verdicts[0].verdict).toBe("ok"); // the service said ok
  expect(saved.requests[0].rejected).toEqual([{ vaultId: STALE, ageSeconds: 60 }]);
  expect(saved.decisions).toHaveLength(1);
  expect(saved.decisions[0].action).toBe("insufficient data");
  expect(saved.decisions[0].reason).toContain("60s old");
  expect(lines.join("\n")).toContain("insufficient data");
});

test("strict privacy buys the whole table and narrows to the requested vaults locally", async () => {
  const dir = runsDir();
  const { deps: d } = deps({ policy: policy({ privacy: "strict" }) });
  const out = await runWatch({ vaults: [ALERT], serviceUrl: base, runsDir: dir }, d);

  expect(out.exitCode).toBe(0);
  const saved = JSON.parse(readFileSync(out.runPath!, "utf8")) as RunRecord;
  expect(saved.requests[0].tier).toBe("table");
  expect(saved.requests[0].sealed).toBe(true);
  expect(saved.requests[0].priceUsd).toBe("0.03");
  // The table carried three vaults; only the requested one is reported on.
  expect(saved.requests[0].verdicts.map(v => v.vaultId)).toEqual([ALERT]);
  expect(saved.decisions.map(x => x.vaultId)).toEqual([ALERT]);
});

test("cheap privacy sends a clear request", async () => {
  const dir = runsDir();
  const { deps: d } = deps({ policy: policy({ privacy: "cheap" }) });
  const out = await runWatch({ vaults: [ALERT], serviceUrl: base, runsDir: dir }, d);
  expect(out.exitCode).toBe(0);
  const saved = JSON.parse(readFileSync(out.runPath!, "utf8")) as RunRecord;
  expect(saved.requests[0].sealed).toBe(false);
});

test("no usable rail exits 2 with a message naming the quote, balance and health of each rail", async () => {
  const dir = runsDir();
  const { deps: d, lines } = deps({
    balances: async () => ({ hedera: "0", arc: "0" }),
    health: async () => ({ hedera: true, arc: true }),
  });
  const out = await runWatch({ vaults: [ALERT], serviceUrl: base, runsDir: dir }, d);

  expect(out.exitCode).toBe(2);
  expect(out.message).toContain("no usable rail");
  const text = lines.join("\n") + (out.message ?? "");
  expect(text).toContain("hedera");
  expect(text).toContain("balance");
  // Nothing was bought, so the saved run has no requests and no decisions.
  const saved = JSON.parse(readFileSync(out.runPath!, "utf8")) as RunRecord;
  expect(saved.requests).toEqual([]);
  expect(saved.decisions).toEqual([]);
});

test("an explicitly requested rail that is unusable exits 2 instead of silently falling back", async () => {
  const dir = runsDir();
  const { deps: d } = deps();
  // arc has no balance and no healthy facilitator in the default deps.
  const out = await runWatch({ vaults: [ALERT], serviceUrl: base, runsDir: dir, rail: "arc" }, d);
  expect(out.exitCode).toBe(2);
  expect(out.message).toContain("arc");
});

test("a forced rail overrides a contrary policy preference when it is usable", async () => {
  const dir = runsDir();
  const { deps: d } = deps({ policy: policy({ rail_preference: "arc" }) });
  const out = await runWatch({ vaults: [ALERT], serviceUrl: base, runsDir: dir, rail: "hedera" }, d);
  expect(out.exitCode).toBe(0);
  const saved = JSON.parse(readFileSync(out.runPath!, "utf8")) as RunRecord;
  expect(saved.requests[0].rail).toBe("hedera");
});

test("an on-chain key-hash mismatch exits 2 before any payment is made", async () => {
  const dir = runsDir();
  const mismatching = new VaultRadarClient({
    serviceUrl: base,
    hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
    // Any paid request would throw if it were ever reached.
    payingFetch: async () => {
      throw new Error("paid request must not happen after a key-hash mismatch");
    },
    readPqHash: async () => "0".repeat(64),
  });
  const { deps: d } = deps({ client: mismatching });
  const out = await runWatch({ vaults: [ALERT], serviceUrl: base, runsDir: dir }, d);
  expect(out.exitCode).toBe(2);
  expect(out.message).toMatch(/on-chain/i);
  const saved = JSON.parse(readFileSync(out.runPath!, "utf8")) as RunRecord;
  expect(saved.discovery.onChain[0].matches).toBe(false);
  expect(saved.requests).toEqual([]);
});

test("a verification failure on the paid response exits 2 and records the request without decisions", async () => {
  const dir = runsDir();
  // A service that answers with a body whose receipt covers a different request: the
  // signature verifies, the hashes do not, so nothing may be acted on.
  const tampering = new VaultRadarClient({
    serviceUrl: base,
    hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
    payingFetch: async (url, init) => {
      const res = await fetch(url, init);
      const body = (await res.json()) as { receipt: { request_hash: string } };
      body.receipt.request_hash = "0".repeat(64);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
    readPqHash: async () => keys.sig.pubHash,
  });
  const { deps: d } = deps({ client: tampering, policy: policy({ privacy: "cheap" }) });
  const out = await runWatch({ vaults: [ALERT], serviceUrl: base, runsDir: dir }, d);

  expect(out.exitCode).toBe(2);
  expect(out.message).toMatch(/receipt/i);
  const saved = JSON.parse(readFileSync(out.runPath!, "utf8")) as RunRecord;
  expect(saved.requests).toHaveLength(1); // the failed purchase is still auditable
  expect(saved.decisions).toEqual([]); // but produced no actions
});
