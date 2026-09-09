import { MemoryNonceStore } from "@vaultradar/core";
import { loadConfig } from "./config";
import { loadKeys } from "./keys";
import { buildApp } from "./app";
import type { DataProvider } from "./data/provider";

// TODO(Task 15): replace with LiveDataProvider once packages/service/src/data/live.ts exists.
const placeholderData: DataProvider = {
  catalog: async () => ({ protocols: [], erc4626Chains: [] }),
  scan: async () => { throw new Error("scan: DataProvider not yet implemented (Task 15)"); },
  table: async () => { throw new Error("table: DataProvider not yet implemented (Task 15)"); },
};

async function main() {
  const config = loadConfig();
  const keys = loadKeys(config);
  const app = await buildApp({
    config,
    keys,
    data: placeholderData,
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
