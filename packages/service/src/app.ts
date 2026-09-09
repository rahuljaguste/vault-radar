import express from "express";
import type { NonceStore } from "@vaultradar/core";
import type { Config } from "./config";
import type { ServiceKeys } from "./keys";
import type { DataProvider } from "./data/provider";
import { mountWellKnown, type HcsLookup } from "./wellknown";

export type BuildAppDeps = {
  config: Config;
  keys: ServiceKeys;
  data: DataProvider;
  hcs: HcsLookup | null;
  nonces: NonceStore;
  rails?: { hedera?: boolean; arc?: boolean };
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
    // @ts-expect-error Task 16 adds ./rails/hedera.ts; this errors again (and must be removed) once it lands
    const { mountHederaRail } = await import("./rails/hedera");
    mountHederaRail(app, deps);
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
