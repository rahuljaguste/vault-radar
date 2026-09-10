import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRunsForVaults, getRun, listRuns, runsDir } from "../lib/runs";
import type { RunRecord } from "../lib/types";

/**
 * These exercise the reader against a real directory of run files, including the
 * filename shape `saveRun` in `packages/agent/src/runs.ts` actually produces
 * (`<startedAt with ':' -> '-'>-<id>.json`) rather than a bare `<id>.json`.
 */

const dir = mkdtempSync(join(tmpdir(), "vaultradar-dashboard-runs-"));
const savedRunsDir = process.env.RUNS_DIR;
const savedDemo = process.env.DEMO;

const VAULT_A = "1:0x" + "a".repeat(40);
const VAULT_B = "8453:0x" + "b".repeat(40);
const VAULT_C = "1:0x" + "c".repeat(40);

function run(id: string, startedAt: string, vaults: string[]): RunRecord {
  return {
    id,
    startedAt,
    serviceUrl: "http://localhost:8787",
    policy: { budget: { usdc_hedera: "1", usdc_arc: "1" }, privacy: "balanced", rail_preference: "cheapest", max_age_seconds: 900 },
    discovery: { cardSignatureValid: true, pubHash: "ab".repeat(32), kid: "kid-1", onChain: [] },
    requests: [
      {
        rail: "hedera",
        tier: "scan",
        sealed: true,
        priceUsd: "0.0015",
        txId: "0.0.42@1.0",
        receiptHash: "cd".repeat(32),
        // A complete, well-formed Receipt with a placeholder signature: nothing under
        // test reads it, but a half-built one would make the fixture misleading.
        receipt: {
          v: 1,
          service: { erc8004: [] },
          request_hash: "11".repeat(32),
          response_hash: "22".repeat(32),
          sealed: true,
          sources: [],
          price: { amount: "1500", asset: "0.0.429274", rail: "hedera" },
          payment: { rail: "hedera", txId: "0.0.42@1.0" },
          tier: "scan",
          issued_at: "1789000000",
          nonce: "33".repeat(16),
          hcs: { topicId: "0.0.99" },
          sig: { alg: "ML-DSA-65", pub_hash: "ab".repeat(32), value: "placeholder" },
        },
        verdicts: vaults.map((vaultId) => ({ vaultId, verdict: "watch" as const, score: 42, flags: [] })),
        rejected: [],
      },
    ],
    decisions: vaults.map((vaultId) => ({
      vaultId,
      action: "rebalance" as const,
      reason: "test",
      citations: { block: "10", source: "substreams:test", txId: "0.0.42@1.0", receiptHash: "cd".repeat(32) },
    })),
  };
}

/** Writes a run the same way `saveRun` names it. */
function write(record: RunRecord): void {
  writeFileSync(join(dir, `${record.startedAt.replace(/:/g, "-")}-${record.id}.json`), JSON.stringify(record, null, 2));
}

beforeAll(() => {
  process.env.RUNS_DIR = dir;
  delete process.env.DEMO;
  write(run("older", "2026-09-09T10:00:00.000Z", [VAULT_A]));
  write(run("newer", "2026-09-10T10:00:00.000Z", [VAULT_A, VAULT_B]));
  // A file that is not valid JSON must be skipped, not fail the whole listing.
  writeFileSync(join(dir, "2026-09-11T10-00-00.000Z-broken.json"), "{ not json");
});

beforeEach(() => {
  process.env.RUNS_DIR = dir;
});

afterAll(() => {
  if (savedRunsDir === undefined) delete process.env.RUNS_DIR;
  else process.env.RUNS_DIR = savedRunsDir;
  if (savedDemo === undefined) delete process.env.DEMO;
  else process.env.DEMO = savedDemo;
  rmSync(dir, { recursive: true, force: true });
});

test("RUNS_DIR overrides the default location and is resolved to an absolute path", () => {
  expect(runsDir()).toBe(dir);
});

test("an unset RUNS_DIR falls back to the repo root's runs/ directory", () => {
  delete process.env.RUNS_DIR;
  expect(runsDir().endsWith(join("runs"))).toBe(true);
  expect(runsDir()).not.toBe(dir);
});

test("listRuns reads every valid run and skips the unparseable one", () => {
  return listRuns().then((runs) => {
    expect(runs.map((r) => r.id).sort()).toEqual(["newer", "older"]);
    expect(runs.every((r) => r.requestCount === 1)).toBe(true);
  });
});

test("getRun resolves an id written as <startedAt>-<id>.json, which is what saveRun produces", async () => {
  const found = await getRun("newer");
  expect(found?.id).toBe("newer");
  expect(found?.startedAt).toBe("2026-09-10T10:00:00.000Z");
});

test("getRun returns null for an id no file carries, and for an invalid id", async () => {
  expect(await getRun("does-not-exist")).toBeNull();
  expect(await getRun("..")).toBeNull();
  expect(await getRun("../../etc/passwd")).toBeNull();
});

test("getRun prefers the file whose own id field matches, not merely a filename suffix", async () => {
  // `prefix-target` ends with `-target.json` once saveRun names it, so a plain
  // `endsWith` guess would hand back the wrong run for the id `target`.
  write(run("prefix-target", "2026-09-12T10:00:00.000Z", [VAULT_C]));
  write(run("target", "2026-09-13T10:00:00.000Z", [VAULT_C]));
  expect((await getRun("target"))?.startedAt).toBe("2026-09-13T10:00:00.000Z");
  expect((await getRun("prefix-target"))?.startedAt).toBe("2026-09-12T10:00:00.000Z");
});

test("findRunsForVaults returns only runs covering a requested vault, newest first", async () => {
  const matches = await findRunsForVaults([VAULT_A]);
  expect(matches.map((m) => m.id)).toEqual(["newer", "older"]);
  expect(matches[0].matched).toEqual([VAULT_A]);
  expect(matches[0].verdicts).toEqual([{ vaultId: VAULT_A, verdict: "watch", score: 42 }]);
  expect(matches[0].actions).toEqual([{ vaultId: VAULT_A, action: "rebalance" }]);
});

test("findRunsForVaults reports only the asked-for vaults, not every vault in the run", async () => {
  const matches = await findRunsForVaults([VAULT_B]);
  expect(matches.map((m) => m.id)).toEqual(["newer"]);
  expect(matches[0].matched).toEqual([VAULT_B]);
  expect(matches[0].verdicts.map((v) => v.vaultId)).toEqual([VAULT_B]);
});

test("findRunsForVaults matches case-insensitively, since pasted addresses may be checksum-cased", async () => {
  const upper = VAULT_A.toUpperCase().replace("0X", "0x");
  const matches = await findRunsForVaults([upper]);
  expect(matches.map((m) => m.id)).toEqual(["newer", "older"]);
});

test("findRunsForVaults returns [] for an empty list and for a vault nobody scanned", async () => {
  expect(await findRunsForVaults([])).toEqual([]);
  expect(await findRunsForVaults(["999:0x" + "f".repeat(40)])).toEqual([]);
});
