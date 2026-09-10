import type { Express, Request, Response } from "express";
import cors from "cors";
import type { Config } from "./config";
import type { Metrics } from "./metrics";
import type { HcsQueue } from "./hcs";
import type { ServiceKeys } from "./keys";
import type { DataProvider } from "./data/provider";
import type { readPqHash as ReadPqHashFn } from "./erc8004";
import { errBody } from "./util/http";
import { asyncHandler } from "./util/async";

export type AdminDeps = {
  config: Config;
  metrics: Metrics;
  hcs: HcsQueue | null;
  keys: ServiceKeys;
  data: DataProvider;
  /** Injected so tests can supply a fake without touching real chain RPC; production
   * wiring (app.ts) defaults this to the real `readPqHash` from `./erc8004`. */
  readPqHash: typeof ReadPqHashFn;
  /** Same rail-enablement flags `buildApp` already computes — see `metrics.ts`'s
   * `SnapshotDeps.rails` for why this is threaded through rather than re-derived. */
  rails?: { hedera?: boolean; arc?: boolean };
};

/**
 * Registers `GET /v1/admin/metrics` (bearer-token gated, spec §13.1) and the free,
 * CORS-enabled `GET /v1/vaults?chainId=` (Task 28's portfolio-view stretch item).
 * Bundled into one mount function because both are thin: the metrics route is a bearer
 * check plus `metrics.snapshot()`, and vaults is a bearer-free pass-through to
 * `data.vaultList()` — neither warranted its own file, and `/v1/vaults` has nowhere
 * more natural to live than alongside the other operator/read-only surface.
 */
export function mountAdmin(app: Express, deps: AdminDeps): void {
  app.get(
    "/v1/admin/metrics",
    asyncHandler(async (req: Request, res: Response) => {
      // Checked before the token comparison: with no ADMIN_TOKEN configured, *no*
      // request can ever be correctly authorized, so telling the truth (503, the
      // endpoint is off) is more useful than a 401 that implies a correct token exists.
      if (!deps.config.adminToken) {
        res.status(503).json({ reason: "admin_disabled" });
        return;
      }
      const auth = req.header("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || token !== deps.config.adminToken) {
        res.status(401).json(errBody("unauthorized"));
        return;
      }
      const snapshot = await deps.metrics.snapshot({ config: deps.config, hcs: deps.hcs, keys: deps.keys, readPqHash: deps.readPqHash, rails: deps.rails });
      res.json(snapshot);
    }),
  );

  app.get(
    "/v1/vaults",
    cors(),
    asyncHandler(async (req: Request, res: Response) => {
      const chainId = typeof req.query.chainId === "string" ? req.query.chainId : "";
      if (!chainId) {
        res.status(400).json(errBody("bad_chain_id"));
        return;
      }
      const vaults = (await deps.data.vaultList?.(chainId)) ?? [];
      res.json({ chainId, vaults });
    }),
  );
}
