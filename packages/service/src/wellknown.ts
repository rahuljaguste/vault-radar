import express from "express";
import cors from "cors";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import type { ServiceKeys } from "./keys";
import { buildAgentCard } from "./keys";
import type { DataProvider } from "./data/provider";

/** Minimal shape Task 17's HcsQueue must satisfy for receipt lookups. */
export interface HcsLookup {
  lookup(hash: string): Promise<unknown>;
}

// packages/service/src/wellknown.ts -> repo root is three levels up.
const SKILL_MD_PATH = join(import.meta.dir, "..", "..", "..", "skills", "vaultradar", "SKILL.md");

export type WellKnownDeps = {
  config: Config;
  keys: ServiceKeys;
  data: DataProvider;
  hcs: HcsLookup | null;
};

/** Registers /.well-known/*, /v1/catalog, /v1/receipts/:hash, /health, /skill.md. CORS applies only to this router. */
export function mountWellKnown(app: express.Express, deps: WellKnownDeps): void {
  const { config, keys, data, hcs } = deps;
  const card = buildAgentCard(config, keys);
  const router = express.Router();
  router.use(cors());

  router.get("/health", (_req, res) => {
    res.json({ ok: true, kid: keys.kem.kid, pubHash: keys.sig.pubHash });
  });

  router.get("/.well-known/agent.json", (_req, res) => {
    res.json(card);
  });

  router.get("/.well-known/ucp", (_req, res) => {
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

  router.get("/.well-known/erc8004.json", (_req, res) => {
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

  router.get("/v1/catalog", async (_req, res) => {
    res.json(await data.catalog());
  });

  router.get("/v1/receipts/:hash", async (req, res) => {
    const hash = req.params.hash;
    if (hcs) {
      res.json(await hcs.lookup(hash));
    } else {
      res.json({ receipt_hash: hash, topicId: config.hedera.hcsTopicId, sequence: null });
    }
  });

  router.get("/skill.md", (_req, res) => {
    if (!existsSync(SKILL_MD_PATH)) {
      res.status(404).json({ error: "skill not yet published" });
      return;
    }
    res.type("text/markdown").send(readFileSync(SKILL_MD_PATH, "utf8"));
  });

  app.use(router);
}
