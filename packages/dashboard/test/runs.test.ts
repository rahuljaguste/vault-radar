import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TABLE_PRICE_USD, hederaScanPriceUsd } from "@vaultradar/core";
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

  const rails = run.requests.map((r) => r.rail);
  expect(rails).toContain("hedera");
  expect(rails).toContain("arc");

  const verdicts = run.requests.flatMap((r) => r.verdicts.map((v) => v.verdict));
  expect(verdicts).toContain("alert");
  expect(verdicts).toContain("ok");

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
    const covered = req.verdicts.length + req.rejected.length;
    const expected = req.tier === "table" ? TABLE_PRICE_USD : hederaScanPriceUsd(covered);
    expect(req.priceUsd).toBe(expected);
    expect(req.receipt.price.amount).toBe(expected);
  }
});

test("isValidRunId accepts the demo run's own id (list -> detail navigation stays consistent)", () => {
  const raw = readFileSync(path.join(import.meta.dir, "..", "public", "demo-run.json"), "utf8");
  const run = JSON.parse(raw) as RunRecord;
  expect(isValidRunId(run.id)).toBe(true);
});
