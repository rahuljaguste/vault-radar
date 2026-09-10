import express from "express";
import cors from "cors";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import type { ServiceKeys } from "./keys";
import { buildAgentCard } from "./keys";
import type { DataProvider } from "./data/provider";
import type { HcsQueue } from "./hcs";
import { asyncHandler } from "./util/async";

// packages/service/src/wellknown.ts -> repo root is three levels up.
const SKILL_MD_PATH = join(import.meta.dir, "..", "..", "..", "skills", "vaultradar", "SKILL.md");

/** 64 lowercase hex chars — the sha256 hex format every receipt_hash/hashJson output uses. */
const RECEIPT_HASH_RE = /^[0-9a-f]{64}$/;

export type WellKnownDeps = {
  config: Config;
  keys: ServiceKeys;
  data: DataProvider;
  hcs: HcsQueue | null;
};

/**
 * Registers /.well-known/*, /v1/catalog, /v1/receipts/:hash, /health, /skill.md.
 * `cors()` is applied per-route (not via `router.use`) so it never runs for a
 * request that falls through to a route this router doesn't define — e.g. a
 * paid rail mounted on the same app after this — since Express invokes
 * `router.use` middleware for any path under the mount point regardless of
 * whether a later handler actually matches.
 */
export function mountWellKnown(app: express.Express, deps: WellKnownDeps): void {
  const { config, keys, data, hcs } = deps;
  const card = buildAgentCard(config, keys);
  const router = express.Router();
  const pub = cors();

  router.get("/health", pub, (_req, res) => {
    res.json({ ok: true, kid: keys.kem.kid, pubHash: keys.sig.pubHash });
  });

  router.get("/.well-known/agent.json", pub, (_req, res) => {
    res.json(card);
  });

  router.get("/.well-known/ucp", pub, (_req, res) => {
    res.json({
      ucp: {
        version: "2026-08-25",
        services: [{ name: "vaultradar.scan", transports: ["rest"], endpoint: card.endpoints.hedera.scan }],
        payment_handlers: [
          { type: "x402", network: "hedera:testnet" },
          { type: "x402", network: config.arc.network },
        ],
      },
    });
  });

  router.get("/.well-known/erc8004.json", pub, (_req, res) => {
    res.json({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "VaultRadar",
      description: card.description,
      image: null,
      services: [
        { name: "web", endpoint: config.publicUrl },
        { name: "x402", endpoint: card.endpoints.hedera.scan },
      ],
      x402Support: true,
      pq: { alg: "ML-DSA-65", pub_hash: keys.sig.pubHash },
    });
  });

  router.get("/v1/catalog", pub, asyncHandler(async (_req, res) => {
    res.json(await data.catalog());
  }));

  router.get("/v1/receipts/:hash", pub, asyncHandler(async (req, res) => {
    const hash = req.params.hash;
    if (!RECEIPT_HASH_RE.test(hash)) {
      res.status(400).json({ reason: "bad_hash" });
      return;
    }
    if (hcs) {
      res.json(await hcs.lookup(hash));
    } else {
      res.json({ receipt_hash: hash, topicId: config.hedera.hcsTopicId, sequence: null, consensus_timestamp: null, initial_transaction_id: null });
    }
  }));

  router.get("/skill.md", pub, (_req, res) => {
    if (!existsSync(SKILL_MD_PATH)) {
      res.status(404).json({ error: "skill not yet published" });
      return;
    }
    res.type("text/markdown").send(readFileSync(SKILL_MD_PATH, "utf8"));
  });

  app.use(router);
}
