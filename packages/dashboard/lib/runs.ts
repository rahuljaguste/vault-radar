import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunRecord } from "./types";

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

// packages/dashboard/lib/runs.ts -> repo root's `runs/` is two levels above `process.cwd()`
// when Next.js is started from `packages/dashboard` (the documented way to run this app).
function runsDir(): string {
  return path.resolve(process.cwd(), "..", "..", "runs");
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

export async function listRuns(): Promise<RunSummary[]> {
  const files = await listRunFiles();
  if (files.length === 0) {
    const demo = await readDemoRun();
    return demo ? [{ id: demo.id, startedAt: demo.startedAt, requestCount: demo.requests.length }] : [];
  }
  const runs: RunSummary[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(runsDir(), file), "utf8");
      const run = JSON.parse(raw) as RunRecord;
      runs.push({ id: run.id, startedAt: run.startedAt, requestCount: run.requests.length });
    } catch {
      // Skip unreadable/invalid run files rather than failing the whole list.
    }
  }
  return runs;
}

export async function getRun(id: string): Promise<RunRecord | null> {
  if (!isValidRunId(id)) return null;
  const files = await listRunFiles();
  if (files.length === 0) {
    const demo = await readDemoRun();
    return demo && demo.id === id ? demo : null;
  }
  const file = files.find((f) => f === `${id}.json` || f.replace(/\.json$/, "") === id);
  if (!file) return null;
  try {
    const raw = await fs.readFile(path.join(runsDir(), file), "utf8");
    return JSON.parse(raw) as RunRecord;
  } catch {
    return null;
  }
}
