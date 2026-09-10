import { MemoryNonceStore, makePgQuery } from "@vaultradar/core";
import { loadConfig } from "./config";
import { loadKeys } from "./keys";
import { buildApp } from "./app";
import { LiveDataProvider } from "./data/provider";

async function main() {
  const config = loadConfig();
  const keys = loadKeys(config);
  const data = new LiveDataProvider(config, {
    sql: config.databaseUrl ? makePgQuery(config.databaseUrl) : null,
  });
  const app = await buildApp({
    config,
    keys,
    data,
    hcs: null, // TODO(Task 17): wire the HCS queue for receipt lookups.
    nonces: new MemoryNonceStore(),
    rails: {}, // TODO(Task 16/19): enable once rails/hedera.ts and rails/arc.ts exist.
  });
  app.listen(config.port, () => {
    console.log(`VaultRadar service listening on :${config.port} (${config.publicUrl})`);
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
