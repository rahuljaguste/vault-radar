import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAttestation,
  buildReceipt,
  deriveSigningKeys,
  receiptHash,
  requestHash,
  responseHash,
  type Attestation,
  type Flag,
  type RiskReport,
  type UnifiedVault,
  type Verdict,
} from "@vaultradar/core";
import type { PaidResult } from "../src/client";
import { CLOCK_SKEW_S, applyAgeCheck, chooseRail, chooseTier, decide, loadPolicy, type Policy } from "../src/policy";

const now = Math.floor(Date.now() / 1000);

// Real ML-DSA-65 keys: every attestation and receipt below is genuinely signed, so
// the objects the policy functions read are the same shape the service emits. The
// policy layer never verifies signatures itself (that is the client's job), but
// building real ones keeps the fixtures from drifting away from the wire format.
const sig = deriveSigningKeys("cc".repeat(32));

function P(
  rail_preference: Policy["rail_preference"],
  privacy: Policy["privacy"] = "balanced",
  max_age_seconds = 900,
): Policy {
  return { budget: { usdc_hedera: "1.00", usdc_arc: "1.00" }, privacy, rail_preference, max_age_seconds };
}

type Entry = {
  vaultId: string;
  timestamp: string;
  verdict: Verdict;
  flags?: Flag[];
  block?: string;
  /** Omit the attestation entirely (models a service that returned fewer than one per vault). */
  noAttestation?: boolean;
  /** Omit the report's evidence entries, forcing citations to fall back to the attestation. */
  noEvidence?: boolean;
};

function vaultOf(id: string): UnifiedVault {
  const [chainId] = id.split(":");
  return {
    id, kind: "erc4626", protocol: "erc4626", chain: "ethereum", chainId: chainId!,
    asset: null, sharePrice: "1.0", tvlUsd: null, inputTokenBalance: null, depositLimit: null,
    history: [], sources: [], freshness: "fresh",
  };
}

function fakeResult(entries: Entry[], o: { receiptTxId?: string } = {}): PaidResult {
  const vaults = entries.map(e => vaultOf(e.vaultId));
  const reports: RiskReport[] = entries.map(e => ({
    vaultId: e.vaultId,
    flags: e.flags ?? [],
    score: e.verdict === "alert" ? 55 : e.verdict === "watch" ? 25 : 0,
    verdict: e.verdict,
    evidence: e.noEvidence
      ? []
      : [{
          source: "substreams:erc4626-vault-metrics",
          block: e.block ?? "123",
          timestamp: e.timestamp,
          ageSeconds: String(now - Number(e.timestamp)),
        }],
  }));
  const attestations: Attestation[] = entries
    .filter(e => !e.noAttestation)
    .map(e =>
      buildAttestation(
        {
          vaultId: e.vaultId, chainId: e.vaultId.split(":")[0]!, block: e.block ?? "123",
          timestamp: e.timestamp, sharePrice: "1.0", tvlUsd: null,
          source: "messari:erc4626",
        },
        sig,
      ),
    );
  const receipt = buildReceipt(
    {
      service: { erc8004: [{ chainId: "296", agentId: "7" }] },
      request_hash: requestHash({ vaults: entries.map(e => e.vaultId) }),
      response_hash: responseHash({ vaults, reports, attestations }),
      sealed: true,
      sources: [],
      price: { amount: "1500", asset: "0.0.429274", rail: "hedera" },
      payment: { rail: "hedera", txId: o.receiptTxId ?? "0.0.42@1700000000.0" },
      tier: "scan",
      hcs: { topicId: "0.0.99" },
    },
    sig,
  );
  return {
    rail: "hedera", tier: "scan", vaults, reports, attestations, receipt,
    receiptValid: true, attestationsValid: !entries.some(e => e.noAttestation),
    txId: "0.0.42@1700000000.0", priceUsd: "0.0015", sealed: true,
  };
}

test("cheapest picks the lower quote with balance and health", () => {
  expect(
    chooseRail(P("cheapest"), { hedera: "0.0015", arc: "0.003" }, { hedera: "1", arc: "1" }, { hedera: true, arc: true }),
  ).toMatchObject({ rail: "hedera" });
  expect(
    chooseRail(P("cheapest"), { hedera: "0.0015", arc: "0.003" }, { hedera: "0", arc: "1" }, { hedera: true, arc: true }),
  ).toMatchObject({ rail: "arc" });
  expect(
    chooseRail(P("cheapest"), { hedera: "0.0015", arc: null }, { hedera: "1", arc: "0" }, { hedera: false, arc: false }).rail,
  ).toBeNull();
});

test("a null quote, unhealthy rail, or balance below the quote all make a rail unusable", () => {
  const bal = { hedera: "1", arc: "1" };
  const up = { hedera: true, arc: true };
  // hedera quote missing (rail not configured) -> arc, even though arc costs more.
  expect(chooseRail(P("cheapest"), { hedera: null, arc: "0.003" }, bal, up)).toMatchObject({ rail: "arc" });
  // hedera facilitator down -> arc.
  expect(chooseRail(P("cheapest"), { hedera: "0.0015", arc: "0.003" }, bal, { hedera: false, arc: true })).toMatchObject({ rail: "arc" });
  // exactly enough balance is usable; a hair under is not.
  expect(chooseRail(P("cheapest"), { hedera: "0.0015", arc: null }, { hedera: "0.0015", arc: "0" }, up)).toMatchObject({ rail: "hedera" });
  expect(chooseRail(P("cheapest"), { hedera: "0.0015", arc: null }, { hedera: "0.0014", arc: "0" }, up).rail).toBeNull();
  expect(chooseRail(P("cheapest"), { hedera: null, arc: null }, bal, up)).toEqual({ rail: null, reason: "no_usable_rail" });
});

test("a quote above the policy's per-rail budget makes that rail unusable", () => {
  const quotes = { hedera: "0.0015", arc: "0.003" };
  const bal = { hedera: "1", arc: "1" };
  const up = { hedera: true, arc: true };
  // Plenty of USDC on hedera, but the policy only budgets 0.001 for it.
  const tightHedera: Policy = { ...P("cheapest"), budget: { usdc_hedera: "0.001", usdc_arc: "1.00" } };
  expect(chooseRail(tightHedera, quotes, bal, up)).toMatchObject({ rail: "arc" });
  // A zero budget on both rails blocks the purchase even with funds and health.
  const broke: Policy = { ...P("cheapest"), budget: { usdc_hedera: "0", usdc_arc: "0" } };
  expect(chooseRail(broke, quotes, bal, up)).toEqual({ rail: null, reason: "no_usable_rail" });
  // The budget binds the preferred rail too, and the fallback reason says so.
  const tightArc: Policy = { ...P("arc"), budget: { usdc_hedera: "1.00", usdc_arc: "0.001" } };
  expect(chooseRail(tightArc, quotes, bal, up)).toEqual({ rail: "hedera", reason: "preferred_rail_unusable" });
});

test("equal quotes tie-break to hedera", () => {
  expect(
    chooseRail(P("cheapest"), { hedera: "0.003", arc: "0.003" }, { hedera: "1", arc: "1" }, { hedera: true, arc: true }),
  ).toMatchObject({ rail: "hedera" });
});

test("a preferred rail is used when usable and falls back with reason preferred_rail_unusable", () => {
  const quotes = { hedera: "0.0015", arc: "0.003" };
  expect(chooseRail(P("arc"), quotes, { hedera: "1", arc: "1" }, { hedera: true, arc: true })).toMatchObject({ rail: "arc" });
  // Preferred arc is out of funds: fall back to hedera, and say why.
  expect(chooseRail(P("arc"), quotes, { hedera: "1", arc: "0" }, { hedera: true, arc: true })).toEqual({
    rail: "hedera",
    reason: "preferred_rail_unusable",
  });
  // Both unusable: no fallback to report.
  expect(chooseRail(P("hedera"), quotes, { hedera: "0", arc: "0" }, { hedera: true, arc: true })).toEqual({
    rail: null,
    reason: "no_usable_rail",
  });
});

test("tiers follow privacy", () => {
  expect(chooseTier(P("cheapest", "strict"))).toEqual({ tier: "table", seal: true });
  expect(chooseTier(P("cheapest", "balanced"))).toEqual({ tier: "scan", seal: true });
  expect(chooseTier(P("cheapest", "cheap"))).toEqual({ tier: "scan", seal: false });
});

test("age check rejects old attestations regardless of service freshness; decisions map verdicts", () => {
  const res = fakeResult([
    { vaultId: "1:0xa", timestamp: String(now - 10), verdict: "alert" },
    { vaultId: "1:0xb", timestamp: String(now - 5000), verdict: "ok" },
  ]);
  const age = applyAgeCheck(res, { ...P("hedera"), max_age_seconds: 900 }, now);
  expect(age.rejected.map(r => r.vaultId)).toEqual(["1:0xb"]);
  expect(age.rejected[0].ageSeconds).toBe(5000);
  expect(age.accepted.map(a => a.vaultId)).toEqual(["1:0xa"]);
  const d = decide(res, age);
  expect(d.find(x => x.vaultId === "1:0xa")!.action).toBe("withdraw");
  expect(d.find(x => x.vaultId === "1:0xb")!.action).toBe("insufficient data");
});

test("an attestation dated further into the future than the clock-skew allowance is rejected", () => {
  // A bare `ageSeconds > max_age_seconds` test accepts any future timestamp as
  // arbitrarily fresh, which would let a misbehaving service step over the freshness
  // bar at will. Rejection happens in both directions.
  const ahead = fakeResult([{ vaultId: "1:0xa", timestamp: String(now + CLOCK_SKEW_S + 1), verdict: "alert" }]);
  const aheadAge = applyAgeCheck(ahead, P("hedera"), now);
  expect(aheadAge.accepted).toEqual([]);
  expect(aheadAge.rejected).toEqual([{ vaultId: "1:0xa", ageSeconds: -(CLOCK_SKEW_S + 1) }]);
  const aheadDecision = decide(ahead, aheadAge)[0];
  expect(aheadDecision.action).toBe("insufficient data");
  // The reason must say the timestamp is in the future, not report "-121s old".
  expect(aheadDecision.reason).toContain("in the future");
  expect(aheadDecision.reason).toContain(`${CLOCK_SKEW_S + 1}s`);
  // Reported as a future date, never as a negative age ("-121s old").
  expect(aheadDecision.reason).not.toContain(`-${CLOCK_SKEW_S + 1}`);
  expect(aheadDecision.reason).not.toContain("s old");

  // Inside the allowance, a slightly-ahead timestamp is ordinary clock skew.
  const skewed = fakeResult([{ vaultId: "1:0xa", timestamp: String(now + 60), verdict: "alert" }]);
  const skewedAge = applyAgeCheck(skewed, P("hedera"), now);
  expect(skewedAge.rejected).toEqual([]);
  expect(skewedAge.accepted.map(a => a.vaultId)).toEqual(["1:0xa"]);
  expect(decide(skewed, skewedAge)[0].action).toBe("withdraw");

  // And the old direction still rejects, one second past the bar.
  const p = P("hedera");
  const old = fakeResult([{ vaultId: "1:0xa", timestamp: String(now - (p.max_age_seconds + 1)), verdict: "alert" }]);
  const oldAge = applyAgeCheck(old, p, now);
  expect(oldAge.rejected).toEqual([{ vaultId: "1:0xa", ageSeconds: p.max_age_seconds + 1 }]);
  expect(decide(old, oldAge)[0].reason).toContain(`${p.max_age_seconds + 1}s old`);
});

test("citation txId falls back to the receipt's payment when the rail set no header", () => {
  // `PaidResult.txId` comes from the payment-response header, which only real x402
  // middleware sets; the signed receipt always carries the id the payer committed to.
  // Without the fallback a citation would read `txId: null` even though the payment is
  // right there in the receipt — and `watch` and the scan tool would print a tx id the
  // run file did not record.
  const res = { ...fakeResult([{ vaultId: "1:0xa", timestamp: String(now - 1), verdict: "ok" }], { receiptTxId: "0.0.42@1.0" }), txId: null };
  const d = decide(res, applyAgeCheck(res, P("hedera"), now));
  expect(res.receipt.payment.txId).toBe("0.0.42@1.0");
  expect(d[0].citations.txId).toBe("0.0.42@1.0");

  // A rail-level id still wins when present.
  const withHeader = fakeResult([{ vaultId: "1:0xa", timestamp: String(now - 1), verdict: "ok" }], { receiptTxId: "0.0.42@1.0" });
  expect(decide(withHeader, applyAgeCheck(withHeader, P("hedera"), now))[0].citations.txId).toBe("0.0.42@1700000000.0");
});

test("every verdict maps to its action and carries citations from the report's first evidence entry", () => {
  const res = fakeResult([
    { vaultId: "1:0xa", timestamp: String(now - 1), verdict: "alert", block: "100", flags: [{ name: "share_price_drawdown_1h", value: "0.01", threshold: "0.005", window: "1h" }] },
    { vaultId: "1:0xb", timestamp: String(now - 1), verdict: "watch", block: "101" },
    { vaultId: "1:0xc", timestamp: String(now - 1), verdict: "ok", block: "102" },
    { vaultId: "1:0xd", timestamp: String(now - 1), verdict: "unavailable", block: "103" },
  ]);
  const d = decide(res, applyAgeCheck(res, P("hedera"), now));
  expect(d.map(x => x.action)).toEqual(["withdraw", "rebalance", "hold", "insufficient data"]);
  expect(d[0].citations).toEqual({
    block: "100",
    source: "substreams:erc4626-vault-metrics",
    txId: "0.0.42@1700000000.0",
    receiptHash: receiptHash(res.receipt),
  });
  // The reason names the flags that drove the verdict.
  expect(d[0].reason).toContain("share_price_drawdown_1h");
  expect(d[2].reason).toContain("no flags");
});

test("citations fall back to the attestation when the report carries no evidence", () => {
  const res = fakeResult([{ vaultId: "1:0xa", timestamp: String(now - 1), verdict: "ok", block: "777", noEvidence: true }]);
  const d = decide(res, applyAgeCheck(res, P("hedera"), now));
  expect(d[0].citations.block).toBe("777");
  expect(d[0].citations.source).toBe("messari:erc4626");
});

test("a vault with no attestation at all is insufficient data, not a hold", () => {
  // A service that returns a report but no matching attestation has given us
  // unattested data; the age check can't vouch for it, so it can't be acted on.
  const res = fakeResult([{ vaultId: "1:0xa", timestamp: String(now - 1), verdict: "ok", noAttestation: true }]);
  const age = applyAgeCheck(res, P("hedera"), now);
  expect(age.accepted).toEqual([]);
  expect(age.rejected).toEqual([]);
  const d = decide(res, age);
  expect(d[0].action).toBe("insufficient data");
  expect(d[0].reason).toContain("no attestation");
});

test("an unparseable attestation timestamp is treated as maximally stale, not as fresh", () => {
  const res = fakeResult([{ vaultId: "1:0xa", timestamp: "not-a-number", verdict: "alert" }]);
  const age = applyAgeCheck(res, P("hedera"), now);
  expect(age.rejected.map(r => r.vaultId)).toEqual(["1:0xa"]);
  expect(Number.isFinite(age.rejected[0].ageSeconds)).toBe(true);
  expect(decide(res, age)[0].action).toBe("insufficient data");
});

test("loadPolicy validates, applies defaults, and reads the shipped example", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultradar-policy-"));
  const minimal = join(dir, "minimal.json");
  writeFileSync(minimal, JSON.stringify({ budget: { usdc_hedera: "1.00", usdc_arc: "1.00" } }));
  expect(loadPolicy(minimal)).toEqual({
    budget: { usdc_hedera: "1.00", usdc_arc: "1.00" },
    privacy: "balanced",
    rail_preference: "cheapest",
    max_age_seconds: 900,
    // Pins nothing unless the file says so: the anchor checks then establish that the key
    // is registered under *an* agent id, and the pin is what would make it *this* service.
    expected_erc8004: [],
  });

  const example = loadPolicy(join(import.meta.dir, "..", "policy.example.json"));
  expect(example).toEqual({
    budget: { usdc_hedera: "1.00", usdc_arc: "1.00" },
    privacy: "balanced",
    rail_preference: "cheapest",
    // Generous enough for a source that indexes finalized blocks only: Ethereum's finality
    // lag alone is 14-19 minutes, so a 15-minute bar refuses every on-chain attestation.
    max_age_seconds: 2400,
    expected_erc8004: [],
  });

  // The strict-tier example `scripts/demo.sh` step 4 runs with. It must load, and it must
  // actually select the table tier — an example policy that quietly behaved like the
  // balanced one would make the demo's privacy claim untrue.
  const strict = loadPolicy(join(import.meta.dir, "..", "policy.strict.json"));
  expect(strict).toEqual({
    budget: { usdc_hedera: "1.00", usdc_arc: "1.00" },
    privacy: "strict",
    rail_preference: "cheapest",
    max_age_seconds: 2400,
    expected_erc8004: [],
  });
  expect(chooseTier(strict)).toEqual({ tier: "table", seal: true });
});

test("loadPolicy rejects an unknown privacy tier and a non-numeric budget with a clear message", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultradar-policy-bad-"));
  const badPrivacy = join(dir, "privacy.json");
  writeFileSync(badPrivacy, JSON.stringify({ budget: { usdc_hedera: "1", usdc_arc: "1" }, privacy: "paranoid" }));
  expect(() => loadPolicy(badPrivacy)).toThrow(/privacy/);

  const badBudget = join(dir, "budget.json");
  writeFileSync(badBudget, JSON.stringify({ budget: { usdc_hedera: "lots", usdc_arc: "1" } }));
  expect(() => loadPolicy(badBudget)).toThrow(/usdc_hedera/);

  const missing = join(dir, "nope.json");
  expect(() => loadPolicy(missing)).toThrow(/policy/);
});
