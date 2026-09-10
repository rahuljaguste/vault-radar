import express from "express";
import type { NonceStore, Receipt } from "@vaultradar/core";
import type { Config } from "./config";
import type { ServiceKeys } from "./keys";
import type { DataProvider } from "./data/provider";
import type { HcsSink } from "./hcs";
import { mountWellKnown } from "./wellknown";
import { Metrics } from "./metrics";
import { mountAdmin } from "./admin";
import { readPqHash } from "./erc8004";

export type BuildAppDeps = {
  config: Config;
  keys: ServiceKeys;
  data: DataProvider;
  hcs: HcsSink | null;
  nonces: NonceStore;
  rails?: { hedera?: boolean; arc?: boolean };
  /**
   * Extra settlement observer for whichever rail(s) are mounted — composed with
   * `hcs.enqueue` below, once per rail (both run; neither replaces the other) rather
   * than overriding it, so a caller that needs its own settlement hook (chiefly
   * hedera-rail.test.ts and arc-rail.test.ts) can still observe settlement directly
   * without losing the production HCS-enqueue behavior, and without main.ts ever
   * needing to wire hcs.enqueue itself (which would double-enqueue if it also set this
   * field). A settled request only ever passes through one rail, so this composition
   * being duplicated per rail below never double-fires for the same receipt.
   */
  onSettled?: (receipt: Receipt, txId: string) => void;
  /** Overrides where /skill.md reads from (forwarded to mountWellKnown). Defaults to the
   * repo's own SKILL.md; tests point this at a non-existent path to exercise the 404 branch. */
  skillPath?: string;
  /**
   * Overrides the `Metrics` instance `buildApp` threads into both rails and the admin
   * endpoint. Defaults to a fresh `new Metrics()`. main.ts constructs its own and passes
   * it both here *and* into `LiveDataProvider`'s constructor (so deployment/head
   * outcomes land in the same instance `mountAdmin` reads from) — tests that only
   * exercise a single rail or the admin route in isolation can omit this and get a
   * throwaway instance instead.
   */
  metrics?: Metrics;
  /** Overrides the identity-check function `mountAdmin` uses for each configured
   * ERC-8004 entry. Defaults to the real `readPqHash` from `./erc8004`; tests inject a
   * fake to avoid real chain RPC. */
  readPqHash?: typeof readPqHash;
};

/**
 * Builds the express app. Async because the payment rails (Task 16: Hedera x402,
 * Task 19: Arc x402) are loaded via dynamic import only when enabled, so this
 * skeleton never fails to boot on a missing `./rails/*` module.
 */
export async function buildApp(deps: BuildAppDeps): Promise<express.Express> {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  const metrics = deps.metrics ?? new Metrics();

  // Shared by both rails below (each mounts at most once, so this never double-fires
  // for the same receipt — see BuildAppDeps.onSettled's own comment for the full
  // reasoning); hoisted into one closure rather than declared identically twice.
  const onSettled = (receipt: Receipt, txId: string) => {
    deps.hcs?.enqueue(receipt);
    deps.onSettled?.(receipt, txId);
  };

  mountWellKnown(app, deps);

  if (deps.rails?.hedera) {
    const { mountHederaRail } = await import("./rails/hedera");
    mountHederaRail(app, { ...deps, metrics, onSettled });
  }
  if (deps.rails?.arc) {
    const { mountArcRail } = await import("./rails/arc");
    mountArcRail(app, { ...deps, metrics, onSettled });
  }

  mountAdmin(app, {
    config: deps.config,
    metrics,
    hcs: deps.hcs,
    keys: deps.keys,
    data: deps.data,
    readPqHash: deps.readPqHash ?? readPqHash,
    rails: deps.rails,
  });

  // Final error handler: catches anything forwarded via next(err), including from
  // asyncHandler-wrapped routes and future rails. Logs only the message — never the
  // request/response body, headers, or config/keys — and always replies with a
  // generic body so no internal detail reaches the client.
  const onError: express.ErrorRequestHandler = (err, _req, res, _next) => {
    console.error("request failed:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: "internal_error" });
  };
  app.use(onError);

  return app;
}
