import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRun, listRuns } from "../lib/runs";

/**
 * What the hosted deployment serves.
 *
 * Before the recordings under `public/runs/` existed, a deployment with no runs directory of
 * its own served exactly one file, `public/demo-run.json`. That made the `no data` state
 * unreachable on the deployed site: a scan where every vault was refused as stale was in
 * every local checkout's `runs/` and on no deployment, so the one page a judge loads could
 * not show it.
 */

/** Point the reader at an empty runs directory, i.e. the deployed situation. */
function withEmptyRunsDir<T>(fn: () => Promise<T>): Promise<T> {
  const empty = mkdtempSync(join(tmpdir(), "vaultradar-bundled-"));
  const saved = process.env.RUNS_DIR;
  process.env.RUNS_DIR = empty;
  return fn().finally(() => {
    if (saved === undefined) delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = saved;
    rmSync(empty, { recursive: true, force: true });
  });
}

test("a deployment with no runs directory serves every committed recording, not just the fixture", async () => {
  await withEmptyRunsDir(async () => {
    const runs = await listRuns();
    const ids = runs.map((r) => r.id);

    // `/docs/flow` deep-links to `/runs/demo-run-1`, so the fixture has to keep resolving even
    // though it is no longer the only thing served.
    expect(ids).toContain("demo-run-1");
    // And the recordings have to be there too, or this test would pass on the old behaviour.
    expect(ids.length).toBeGreaterThan(1);

    // Every listed run resolves, or the runs table links to a 404.
    for (const id of ids) expect(await getRun(id)).not.toBeNull();

    // One row per run. The same purchase committed twice — once as a file, once as the
    // fixture — would list as two scans of the same vaults at the same instant.
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(runs.map((r) => r.startedAt)).size).toBe(runs.length);
  });
});

test("the recordings include a refused scan, which is the state the fixture cannot show", async () => {
  await withEmptyRunsDir(async () => {
    const states = new Set<string>();
    for (const summary of await listRuns()) {
      const run = await getRun(summary.id);
      for (const req of run?.requests ?? []) for (const v of req.verdicts) states.add(v.verdict);
    }
    // Without this the deployed site can only ever show a run that went well, and a reader
    // has no way to see what a refusal looks like.
    expect(states.has("unavailable")).toBe(true);
    expect(states.has("ok")).toBe(true);
  });
});

test("an id nothing recorded is still null, with recordings present", async () => {
  await withEmptyRunsDir(async () => {
    expect(await getRun("no-such-run")).toBeNull();
    expect(await getRun("../../etc/passwd")).toBeNull();
  });
});
