import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TABLE_PRICE_USD, hederaScanPriceAtomic, hederaScanPriceUsd } from "@vaultradar/core";
import { RUN_ID_RE, isValidRunId } from "../lib/runs";
import type { RunRecord } from "../lib/types";

test("RUN_ID_RE accepts plain filename-safe ids", () => {
  for (const id of ["demo-run-1", "run_2026-09-09", "abc123", "a.b-c_9"]) {
    expect(RUN_ID_RE.test(id)).toBe(true);
  }
});

test("RUN_ID_RE rejects separators, but allows the bare '..' token on its own (by character class alone)", () => {
  for (const id of ["../../etc/passwd", "a/b", "a\\b", "a b", ""]) {
    expect(RUN_ID_RE.test(id)).toBe(false);
  }
  // "." is a permitted character (for ids like "run.v1"), so the regex alone
  // can't distinguish "..", which is why route handlers use isValidRunId, not
  // RUN_ID_RE, to reject requests.
  expect(RUN_ID_RE.test("..")).toBe(true);
});

test("isValidRunId rejects path traversal, separators, and the bare '.'/'..' tokens", () => {
  for (const id of ["../../etc/passwd", "a/b", "a\\b", "..", ".", "a b", ""]) {
    expect(isValidRunId(id)).toBe(false);
  }
});

test("isValidRunId accepts plain filename-safe ids", () => {
  for (const id of ["demo-run-1", "run_2026-09-09", "abc123", "a.b-c_9"]) {
    expect(isValidRunId(id)).toBe(true);
  }
});

test("public/demo-run.json parses and matches the RunRecord contract's top-level shape", () => {
  const raw = readFileSync(path.join(import.meta.dir, "..", "public", "demo-run.json"), "utf8");
  const run = JSON.parse(raw) as RunRecord;

  for (const key of ["id", "startedAt", "serviceUrl", "policy", "discovery", "requests", "decisions"] as const) {
    expect(run).toHaveProperty(key);
  }
  expect(typeof run.id).toBe("string");
  expect(Array.isArray(run.requests)).toBe(true);
  expect(run.requests.length).toBeGreaterThan(0);
  expect(Array.isArray(run.decisions)).toBe(true);

  // Every rail named must be one the service offers. The fixture is a recording of one real
  // purchase and so names only the rail it used, which is why this does not require both —
  // a fixture edited to satisfy that would be a fixture that no longer matches a run.
  const rails = run.requests.map((r) => r.rail);
  expect(rails.length).toBeGreaterThan(0);
  for (const rail of rails) expect(["hedera", "arc"]).toContain(rail);

  const verdicts = run.requests.flatMap((r) => r.verdicts.map((v) => v.verdict));
  expect(verdicts.length).toBeGreaterThan(0);
  for (const v of verdicts) expect(["ok", "watch", "alert", "unavailable"]).toContain(v);

  for (const req of run.requests) {
    expect(typeof req.receiptHash).toBe("string");
    expect(req.receipt.sig).toHaveProperty("value");
  }
  for (const decision of run.decisions) {
    expect(decision.citations).toHaveProperty("receiptHash");
  }
});

// The demo run is served on `/runs/demo-run-1` beside an agent card quoting live prices
// from the same shared table, so a stale figure in the fixture reads as the service
// contradicting itself. It went stale once already: the fixture kept 0.03 after the table
// tier moved to 0.06. Pin it to the constants rather than to a literal.
test("public/demo-run.json quotes the prices the shared pricing table currently charges", () => {
  const raw = readFileSync(path.join(import.meta.dir, "..", "public", "demo-run.json"), "utf8");
  const run = JSON.parse(raw) as RunRecord;

  for (const req of run.requests) {
    // The union of the two lists, not their sum. A vault the run both scored and refused as
    // too old appears in both — it was still requested, and the price is per vault requested
    // — so adding the lengths double-counts it and expects a price nobody was charged.
    const covered = new Set([...req.verdicts.map((v) => v.vaultId), ...req.rejected.map((r) => r.vaultId)]).size;
    const expected = req.tier === "table" ? TABLE_PRICE_USD : hederaScanPriceUsd(covered);
    // The run records the price twice in two units, and both are checked: `priceUsd` is the
    // decimal the buyer was quoted, and the signed receipt carries the atomic amount the rail
    // actually charged, because that is what a receipt has to state.
    const expectedAtomic = req.tier === "table" ? String(Math.round(Number(TABLE_PRICE_USD) * 1e6)) : hederaScanPriceAtomic(covered);
    expect(req.priceUsd).toBe(expected);
    expect(req.receipt.price.amount).toBe(expectedAtomic);
  }
});

test("isValidRunId accepts the demo run's own id (list -> detail navigation stays consistent)", () => {
  const raw = readFileSync(path.join(import.meta.dir, "..", "public", "demo-run.json"), "utf8");
  const run = JSON.parse(raw) as RunRecord;
  expect(isValidRunId(run.id)).toBe(true);
});
