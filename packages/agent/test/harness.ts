import { createServer } from "node:net";
import { MemoryNonceStore, type UnifiedVault } from "@vaultradar/core";
import { buildApp, loadConfig, loadKeys, makeScanHandler, type DataProvider, type HandlerDeps } from "@vaultradar/service";
import { VaultRadarClient } from "../src/client";
import type { Policy } from "../src/policy";

/**
 * One in-process VaultRadar service plus the vault fixtures the agent tests buy from.
 * Shared by `watch.test.ts` and `tools.test.ts` so both exercise the real handlers,
 * the real sealing and the real receipt/attestation signing over loopback — no network,
 * no mocked service.
 */

export const NOW = Math.floor(Date.now() / 1000);
export const ALERT_VAULT = "1:0x" + "a".repeat(40);
export const STALE_VAULT = "1:0x" + "b".repeat(40);
export const OTHER_VAULT = "1:0x" + "c".repeat(40);
/** Never parsed: every client below injects `payingFetch`, so no Hedera signer is built. */
export const UNUSED_HEDERA_KEY = "11".repeat(32);
/** The tx id the stand-in payment middleware reports to the handler. */
export const TEST_TX_ID = "0.0.42@1700000000.0";
/** The HCS sequence the stubbed consensus lookup answers with. */
export const TEST_HCS_SEQUENCE = 1234;

function vaultOf(id: string, o: { sourceTs: number; sharePrice: string; history: { ts: number; sharePrice: string }[] }): UnifiedVault {
  return {
    id, kind: "erc4626", protocol: "erc4626", chain: "ethereum", chainId: "1",
    asset: null, sharePrice: o.sharePrice, tvlUsd: null, inputTokenBalance: "100", depositLimit: null,
    history: o.history.map(h => ({ block: "9", timestamp: String(h.ts), sharePrice: h.sharePrice, tvlUsd: null, netFlowAssets: null })),
    // `freshness: "fresh"` on every fixture on purpose: the service therefore computes a
    // real verdict for all of them, and anything the agent rejects it rejects on its own
    // max-age check against the attestation timestamp — not by echoing a service verdict.
    sources: [{ kind: "substreams", ref: "erc4626-vault-metrics", block: "4242", timestamp: String(o.sourceTs), ageSeconds: String(NOW - o.sourceTs), freshness: "fresh" }],
    freshness: "fresh",
  };
}

// A 5% share-price drop lands in both the 1h (+30) and 24h (+25) windows -> score 55
// -> verdict "alert" -> action "withdraw".
export const alertVault = vaultOf(ALERT_VAULT, {
  sourceTs: NOW - 5, sharePrice: "0.95",
  history: [{ ts: NOW - 3700, sharePrice: "1.00" }, { ts: NOW - 86400, sharePrice: "1.00" }],
});
/** Flat price -> verdict "ok"; its source is a minute old, which a 10 s policy rejects. */
export const staleVault = vaultOf(STALE_VAULT, { sourceTs: NOW - 60, sharePrice: "1.00", history: [] });
export const otherVault = vaultOf(OTHER_VAULT, { sourceTs: NOW - 5, sharePrice: "1.00", history: [] });

const byId: Record<string, UnifiedVault> = { [ALERT_VAULT]: alertVault, [STALE_VAULT]: staleVault, [OTHER_VAULT]: otherVault };

export const data: DataProvider = {
  catalog: async () => ({ protocols: [], erc4626Chains: ["1"] }),
  scan: async (ids: string[]) => ({
    vaults: ids.map(id => byId[id]).filter((v): v is UnifiedVault => !!v),
    sources: [{ ref: "erc4626-vault-metrics", chainId: "1", block: "4242", timestamp: String(NOW - 5) }],
  }),
  // The whole-protocol table deliberately includes a vault the caller never asked
  // about, so the strict-tier tests can show the agent narrowing locally. Only chain 1
  // is served — a table is per protocol *per chain*, and asking for any other chain
  // legitimately comes back empty, which is what a multi-chain vault list must cope with.
  table: async (_protocol: string, chainId: string) => ({
    vaults: chainId === "1" ? [alertVault, staleVault, otherVault] : [],
    sources: [{ ref: "erc4626-vault-metrics", chainId, block: "4242", timestamp: String(NOW - 5) }],
  }),
};

/**
 * Reserves a free port before building the config, because the agent card bakes
 * `PUBLIC_URL` into its endpoint URLs and `VaultRadarClient` follows those rather than
 * any URL the test knows out of band — so the card's declared origin must be the origin
 * the test server actually listens on.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

export type Harness = {
  base: string;
  keys: ReturnType<typeof loadKeys>;
  config: ReturnType<typeof loadConfig>;
  /** A Hedera-configured client that posts with plain `fetch` (no payment middleware). */
  client(): VaultRadarClient;
  policy(over?: Partial<Policy>): Policy;
};

export async function startHarness(): Promise<Harness> {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    PORT: String(port), PUBLIC_URL: base, PQ_SIG_SEED: "aa".repeat(32), PQ_KEM_SEED: "bb".repeat(64),
    GRAPH_STUDIO_API_KEY: "k", HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1",
    HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), HEDERA_HCS_TOPIC_ID: "0.0.99",
    ERC8004_HEDERA_AGENT_ID: "7",
  });
  const keys = loadKeys(config);
  const nonces = new MemoryNonceStore();
  // An HCS stub, so the receipt poll sees a real consensus sequence instead of the
  // `sequence: null` the service's no-HCS branch would return.
  const hcs = { lookup: async (hash: string) => ({ receipt_hash: hash, topicId: "0.0.99", sequence: TEST_HCS_SEQUENCE }) };
  const app = await buildApp({ config, keys, data, hcs, nonces, rails: {} });
  // The Hedera scan/table routes are mounted directly with a fixed payer and tx id,
  // standing in for what the real x402 middleware sets once payment has cleared.
  const scanDeps: HandlerDeps = {
    keys, config, data, nonces, rail: "hedera", tier: "scan",
    getPayer: () => "0.0.42", getTxId: () => TEST_TX_ID,
  };
  app.post("/hedera/v1/scan", makeScanHandler(scanDeps));
  app.post("/hedera/v1/table", makeScanHandler({ ...scanDeps, tier: "table" }));
  app.listen(port);

  return {
    base,
    keys,
    config,
    client: () =>
      new VaultRadarClient({
        serviceUrl: base,
        hedera: { accountId: "0.0.42", privateKey: UNUSED_HEDERA_KEY },
        payingFetch: fetch,
        readPqHash: async () => keys.sig.pubHash,
      }),
    policy: (over: Partial<Policy> = {}) => ({
      budget: { usdc_hedera: "1.00", usdc_arc: "1.00" },
      privacy: "balanced",
      rail_preference: "cheapest",
      max_age_seconds: 900,
      ...over,
    }),
  };
}
