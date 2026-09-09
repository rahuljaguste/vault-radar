import { expect, test } from "bun:test";
import yieldFx from "./fixtures/yield-vaults.json";
import { fetchStandardized } from "../src/standardized";
import type { Deployment } from "../src/standardized/types";

const dep = (over: Partial<Deployment>): Deployment => ({
  protocol: "p", chain: "ethereum", chainId: "1", schema: "yield-aggregator", subgraphId: "Sok",
  deploymentId: null, status: "live", headLagSeconds: 0, verifiedAt: null, ...over,
});

test("fetchStandardized aggregates vaults from successes and records a down source ref on failure", async () => {
  const ok = dep({ subgraphId: "Sok" });
  const bad = dep({ subgraphId: "Sbad", chain: "base", chainId: "8453" });
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("Sok")) {
      return { ok: true, status: 200, json: async () => ({ data: yieldFx }) } as Response;
    }
    return { ok: false, status: 500, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  let result: Awaited<ReturnType<typeof fetchStandardized>>;
  try {
    result = await fetchStandardized(
      [ok, bad],
      "test-api-key",
      { "1": Number(yieldFx._meta.block.timestamp) + 10, "8453": Number(yieldFx._meta.block.timestamp) + 10 },
      fetchImpl,
    );
  } finally {
    console.error = originalError;
  }

  expect(result.vaults.length).toBe(yieldFx.vaults.length);
  expect(result.sources.length).toBe(2);

  const okSource = result.sources.find(s => s.chainId === "1");
  expect(okSource).toMatchObject({ ref: "Sok", chainId: "1" });
  expect(okSource?.block).not.toBe("0");

  const badSource = result.sources.find(s => s.chainId === "8453");
  expect(badSource).toEqual({ ref: "Sbad", chainId: "8453", block: "0", timestamp: "0" });

  expect(errors.length).toBe(1);
  const loggedMessage = String(errors[0]);
  expect(loggedMessage).not.toContain("<html");
});

test("deployments marked down are skipped entirely", async () => {
  const down = dep({ subgraphId: "Sdown", status: "down" });
  const fetchImpl = (async () => {
    throw new Error("should not be called for a down deployment");
  }) as unknown as typeof fetch;
  const result = await fetchStandardized([down], "test-api-key", { "1": 1760000000 }, fetchImpl);
  expect(result.vaults).toEqual([]);
  expect(result.sources).toEqual([]);
});
