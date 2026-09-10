import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunMatch, RunRecord } from "./types";

/** Run ids are plain filename-safe tokens: letters, digits, dot, underscore, hyphen. */
export const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * `RUN_ID_RE` alone allows the bare tokens "." and "..", since "." is a
 * permitted character — it's meant for realistic ids like "run.v1", not as a
 * traversal segment. Reject those two exact tokens on top of the regex so
 * "no path traversal" holds even if a future caller joins `id` straight into
 * a filesystem path instead of matching it against a directory listing.
 */
export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id) && id !== "." && id !== "..";
}

export type RunSummary = { id: string; startedAt: string; requestCount: number };

export type { RunMatch } from "./types";

/**
 * The monorepo root, two levels above `process.cwd()` when Next.js is started
 * from `packages/dashboard` (the documented way to run this app). Repo-relative
 * settings such as `POLICY_PATH` are resolved against it.
 */
export function repoRoot(): string {
  return path.resolve(process.cwd(), "..", "..");
}

/**
 * Where run files live. `RUNS_DIR` wins when set (both the reader here and the
 * `/api/scan` writer read this same function, so they can never disagree about
 * the directory, and the agent CLI reads the same variable); otherwise the repo
 * root's `runs/`.
 */
export function runsDir(): string {
  const fromEnv = process.env.RUNS_DIR?.trim();
  if (fromEnv) return path.resolve(repoRoot(), fromEnv);
  return path.join(repoRoot(), "runs");
}

function demoRunPath(): string {
  return path.resolve(process.cwd(), "public", "demo-run.json");
}

async function readDemoRun(): Promise<RunRecord | null> {
  try {
    const raw = await fs.readFile(demoRunPath(), "utf8");
    return JSON.parse(raw) as RunRecord;
  } catch {
    return null;
  }
}

/** Real run filenames, sorted, or `[]` when demo mode is forced or the directory is missing/empty. */
async function listRunFiles(): Promise<string[]> {
  if (process.env.DEMO === "1") return [];
  try {
    const entries = await fs.readdir(runsDir());
    return entries.filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/** One run file, or `null` if it is unreadable or not valid JSON. */
async function readRunFile(file: string): Promise<RunRecord | null> {
  try {
    const raw = await fs.readFile(path.join(runsDir(), file), "utf8");
    return JSON.parse(raw) as RunRecord;
  } catch {
    // Skip unreadable/invalid run files rather than failing the whole operation.
    return null;
  }
}

/** Every run, newest last, falling back to the bundled demo run. */
async function readAllRuns(): Promise<RunRecord[]> {
  const files = await listRunFiles();
  if (files.length === 0) {
    const demo = await readDemoRun();
    return demo ? [demo] : [];
  }
  const runs: RunRecord[] = [];
  for (const file of files) {
    const run = await readRunFile(file);
    if (run) runs.push(run);
  }
  return runs;
}

export async function listRuns(): Promise<RunSummary[]> {
  const runs = await readAllRuns();
  return runs.map((run) => ({ id: run.id, startedAt: run.startedAt, requestCount: run.requests.length }));
}

export async function getRun(id: string): Promise<RunRecord | null> {
  if (!isValidRunId(id)) return null;
  const files = await listRunFiles();
  if (files.length === 0) {
    const demo = await readDemoRun();
    return demo && demo.id === id ? demo : null;
  }
  // `saveRun` (packages/agent/src/runs.ts) names files `<startedAt>-<id>.json`, so
  // the id is a suffix of the stem, not the whole stem — matching only `<id>.json`
  // would 404 every run the agent actually writes. A run hand-copied to `<id>.json`
  // still resolves. Either way the `id` *inside* the file is authoritative, since
  // that is what `listRuns` linked to, so a filename guess is only accepted once
  // confirmed and a full scan is the fallback.
  const candidates = files.filter((f) => f === `${id}.json` || f.endsWith(`-${id}.json`));
  for (const file of candidates) {
    const run = await readRunFile(file);
    if (run && run.id === id) return run;
  }
  for (const file of files) {
    const run = await readRunFile(file);
    if (run && run.id === id) return run;
  }
  return null;
}

/** Every vault id a run mentions, lowercased: scanned, rejected, or decided on. */
function vaultIdsIn(run: RunRecord): Set<string> {
  const ids = new Set<string>();
  for (const req of run.requests ?? []) {
    for (const v of req.verdicts ?? []) ids.add(v.vaultId.toLowerCase());
    for (const r of req.rejected ?? []) ids.add(r.vaultId.toLowerCase());
  }
  for (const d of run.decisions ?? []) ids.add(d.vaultId.toLowerCase());
  return ids;
}

/**
 * Prior runs that covered any of `vaults`, newest first. Ids are compared
 * lowercased on both sides, matching `parseVaultList`'s normalisation, so a
 * checksum-cased address pasted into `/portfolio` still finds its history.
 */
export async function findRunsForVaults(vaults: string[]): Promise<RunMatch[]> {
  const wanted = new Set(vaults.map((v) => v.toLowerCase()));
  if (wanted.size === 0) return [];

  const matches: RunMatch[] = [];
  for (const run of await readAllRuns()) {
    const present = vaultIdsIn(run);
    const matched = [...wanted].filter((v) => present.has(v));
    if (matched.length === 0) continue;
    matches.push({
      id: run.id,
      startedAt: run.startedAt,
      matched,
      verdicts: (run.requests ?? []).flatMap((req) =>
        (req.verdicts ?? [])
          .filter((v) => wanted.has(v.vaultId.toLowerCase()))
          .map((v) => ({ vaultId: v.vaultId, verdict: v.verdict, score: v.score })),
      ),
      actions: (run.decisions ?? [])
        .filter((d) => wanted.has(d.vaultId.toLowerCase()))
        .map((d) => ({ vaultId: d.vaultId, action: d.action })),
    });
  }
  // Newest first: `startedAt` is ISO-8601 UTC, so a string compare is a time compare.
  return matches.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}
