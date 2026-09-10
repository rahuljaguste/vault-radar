import express from "express";
import type { NonceStore, Receipt } from "@vaultradar/core";
import type { Config } from "./config";
import type { ServiceKeys } from "./keys";
import type { DataProvider } from "./data/provider";
import type { HcsQueue } from "./hcs";
import { mountWellKnown } from "./wellknown";

export type BuildAppDeps = {
  config: Config;
  keys: ServiceKeys;
  data: DataProvider;
  hcs: HcsQueue | null;
  nonces: NonceStore;
  rails?: { hedera?: boolean; arc?: boolean };
  /**
   * Extra settlement observer for the Hedera rail — composed with `hcs.enqueue` below
   * (both run; neither replaces the other) rather than overriding it, so a caller that
   * needs its own settlement hook (chiefly hedera-rail.test.ts) can still observe
   * settlement directly without losing the production HCS-enqueue behavior, and without
   * main.ts ever needing to wire hcs.enqueue itself (which would double-enqueue if it
   * also set this field).
   */
  onSettled?: (receipt: Receipt, txId: string) => void;
  /** Overrides where /skill.md reads from (forwarded to mountWellKnown). Defaults to the
   * repo's own SKILL.md; tests point this at a non-existent path to exercise the 404 branch. */
  skillPath?: string;
};

/**
 * Builds the express app. Async because the payment rails (Task 16: Hedera x402,
 * Task 19: Arc x402) are loaded via dynamic import only when enabled, so this
 * skeleton never fails to boot on a missing `./rails/*` module.
 */
export async function buildApp(deps: BuildAppDeps): Promise<express.Express> {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  mountWellKnown(app, deps);

  if (deps.rails?.hedera) {
    const { mountHederaRail } = await import("./rails/hedera");
    const onSettled = (receipt: Receipt, txId: string) => {
      deps.hcs?.enqueue(receipt);
      deps.onSettled?.(receipt, txId);
    };
    const hederaDeps = { ...deps, onSettled };
    mountHederaRail(app, hederaDeps);
  }
  if (deps.rails?.arc) {
    // @ts-expect-error Task 19 adds ./rails/arc.ts; this errors again (and must be removed) once it lands
    const { mountArcRail } = await import("./rails/arc");
    mountArcRail(app, deps);
  }

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
