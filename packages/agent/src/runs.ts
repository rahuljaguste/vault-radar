import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Receipt } from "@vaultradar/core";

/**
 * A per-vault action the agent settled on for one run, with the evidence trail a
 * reader needs to check it: which block/source backed the verdict, the on-chain
 * payment that bought it, and the receipt hash that ties it back to a signed receipt.
 */
export type Decision = {
  vaultId: string;
  action: "hold" | "withdraw" | "rebalance" | "insufficient data";
  reason: string;
  citations: { block: string; source: string; txId: string | null; receiptHash: string };
};

/** One paid request the agent made during a run, plus the risk verdicts it bought and
 *  any attestations the run's own max-age policy rejected regardless of the service's
 *  freshness classification. */
export type RunRequest = {
  rail: "hedera" | "arc";
  tier: "scan" | "table";
  sealed: boolean;
  priceUsd: string | null;
  txId: string | null;
  receiptHash: string;
  receipt: Receipt;
  verdicts: {
    vaultId: string;
    verdict: "ok" | "watch" | "alert" | "unavailable";
    score: number;
    flags: { name: string; value: string; threshold: string; window: string }[];
  }[];
  rejected: { vaultId: string; ageSeconds: number }[];
};

/**
 * A full agent run persisted to `runs/<id>.json`: the policy it ran under, whether
 * discovery's card/key checks passed, every paid request it made, and the decisions it
 * reached. This is a cross-package contract with `packages/dashboard`
 * (`lib/types.ts`'s `RunRecord`) — keep the two in exact sync; do not add fields here
 * speculatively.
 */
export type RunRecord = {
  id: string;
  startedAt: string;
  serviceUrl: string;
  policy: {
    budget: { usdc_hedera: string; usdc_arc: string };
    privacy: "strict" | "balanced" | "cheap";
    rail_preference: "cheapest" | "hedera" | "arc";
    max_age_seconds: number;
  };
  discovery: {
    cardSignatureValid: boolean;
    pubHash: string;
    kid: string;
    onChain: { chainId: string; agentId: string; matches: boolean | null }[];
  };
  requests: RunRequest[];
  decisions: Decision[];
};

export type RunListEntry = { id: string; path: string; startedAt: string };

/**
 * Writes a run as pretty-printed JSON to `<dir>/<startedAt, ':' -> '-'>-<id>.json` and
 * returns the path written. Synchronous (matches the task interface) since a run is
 * written once, at the end of a CLI invocation, where blocking briefly costs nothing.
 * Contains no private keys or other secrets — `RunRecord` has no field for them.
 */
export function saveRun(dir: string, run: RunRecord): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fileName = `${run.startedAt.replace(/:/g, "-")}-${run.id}.json`;
  const filePath = join(dir, fileName);
  writeFileSync(filePath, JSON.stringify(run, null, 2) + "\n", "utf8");
  return filePath;
}

/**
 * Lists every run in `dir`, newest-filename-last (filenames sort chronologically since
 * they're prefixed with an ISO timestamp). `id`/`startedAt` are always read back out of
 * each file's contents rather than parsed from the filename, so a renamed or
 * hand-copied run file still lists correctly. A missing directory yields `[]`, and a
 * file that fails to parse is skipped rather than failing the whole listing.
 */
export function listRuns(dir: string): RunListEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const runs: RunListEntry[] = [];
  for (const file of files.filter(f => f.endsWith(".json")).sort()) {
    const filePath = join(dir, file);
    try {
      const run = JSON.parse(readFileSync(filePath, "utf8")) as RunRecord;
      runs.push({ id: run.id, path: filePath, startedAt: run.startedAt });
    } catch {
      // Skip unreadable/invalid run files instead of failing the whole listing.
    }
  }
  return runs;
}
