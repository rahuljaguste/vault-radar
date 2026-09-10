import { MemoryNonceStore, makePgQuery } from "@vaultradar/core";
import { loadConfig } from "./config";
import { loadKeys } from "./keys";
import { buildApp } from "./app";
import { LiveDataProvider } from "./data/provider";
import { HcsQueue, makeHederaSubmit } from "./hcs";

async function main() {
  const config = loadConfig();
  const keys = loadKeys(config);
  const data = new LiveDataProvider(config, {
    sql: config.databaseUrl ? makePgQuery(config.databaseUrl) : null,
  });

  // HcsQueue's own enqueue call is wired automatically inside buildApp/app.ts whenever
  // `hcs` is non-null — main.ts only needs to construct it, not pass an onSettled hook
  // itself (doing both would double-submit every receipt).
  const hcs = config.hedera.hcsTopicId
    ? new HcsQueue({ submit: makeHederaSubmit(config), topicId: config.hedera.hcsTopicId })
    : null;

  const rails = { hedera: Boolean(config.hedera.payToAccountId), arc: Boolean(config.arc.sellerAddress) };

  const app = await buildApp({ config, keys, data, hcs, nonces: new MemoryNonceStore(), rails });

  app.listen(config.port, () => {
    const enabledRails = Object.entries(rails).filter(([, on]) => on).map(([name]) => name);
    console.log(
      `VaultRadar service listening on :${config.port} (${config.publicUrl}) — ` +
      `rails: ${enabledRails.length ? enabledRails.join(",") : "none"}; hcs: ${hcs ? "enabled" : "disabled"}`,
    );
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
