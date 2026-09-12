### Task 14: Service skeleton, keys, well-known routes, catalog

**Files:**
- Create: `packages/service/package.json`, `packages/service/tsconfig.json`, `packages/service/src/config.ts`, `packages/service/src/keys.ts`, `packages/service/src/wellknown.ts`, `packages/service/src/app.ts`, `packages/service/src/main.ts`, `packages/service/test/wellknown.test.ts`
- Modify: `.env.example` (append service variables)

**Interfaces:**
- Produces: `loadConfig(env = process.env): Config` with `Config = { port: number; publicUrl: string; sigSeed: string; kemSeed: string; graphApiKey: string; databaseUrl: string | null; rpc: { "1": string; "8453": string }; hedera: { network: "testnet"; payToAccountId: string; operatorId: string; operatorKey: string; facilitatorUrl: string; usdcToken: string; hcsTopicId: string | null }; arc: { sellerAddress: string; facilitatorUrl: string; network: "eip155:5042002" }; erc8004: { chainId: string; agentId: string }[] }`; `ServiceKeys = { sig: ReturnType<typeof deriveSigningKeys>; kem: ReturnType<typeof deriveKemKeys> }`; `buildApp(deps: { config: Config; keys: ServiceKeys; data: DataProvider; hcs: HcsQueue | null; nonces: NonceStore; rails?: { hedera?: boolean; arc?: boolean } }): express.Express`; `buildAgentCard(config, keys)` returns the signed card; `DataProvider` is defined in Task 15 (import type only here; stub in tests).
- Routes: `GET /health` → `{ ok: true, kid, pubHash }`; `GET /.well-known/agent.json`; `GET /.well-known/ucp`; `GET /.well-known/erc8004.json`; `GET /v1/catalog`; `GET /v1/receipts/:hash` (Task 17 fills in HCS; here returns `{ receipt_hash, topicId, sequence: null }` if unknown).

- [ ] **Step 1: Package**

`packages/service/package.json`:

```json
{
  "name": "@vaultradar/service", "version": "0.1.0", "type": "module", "private": true,
  "scripts": { "start": "bun run src/main.ts", "dev": "bun --watch src/main.ts" },
  "dependencies": {
    "@vaultradar/core": "workspace:*", "express": "^4.21.0", "cors": "^2.8.5",
    "@x402/express": "2.25.0", "@x402/core": "2.25.0", "@x402/hedera": "2.25.0",
    "@circle-fin/x402-batching": "3.4.0", "@hashgraph/sdk": "^2.62.0", "viem": "^2.21.0", "pg": "^8.13.0"
  },
  "devDependencies": { "@types/express": "^4.17.21", "@types/cors": "^2.8.17" }
}
```

`.env.example` additions:

```
# Service
PORT=8787
PUBLIC_URL=http://localhost:8787
PQ_SIG_SEED=            # 32 bytes hex: openssl rand -hex 32
PQ_KEM_SEED=            # 64 bytes hex: openssl rand -hex 64
# Hedera testnet
HEDERA_NETWORK=testnet
HEDERA_PAYTO_ACCOUNT_ID=0.0.xxxxx
HEDERA_OPERATOR_ID=0.0.xxxxx
HEDERA_OPERATOR_KEY=            # ECDSA private key hex (DER or raw)
HEDERA_FACILITATOR_URL=https://api.testnet.blocky402.com
HEDERA_USDC_TOKEN=0.0.429274
HEDERA_HCS_TOPIC_ID=
# Arc testnet
ARC_SELLER_ADDRESS=0x...
ARC_FACILITATOR_URL=https://gateway-api-testnet.circle.com
# ERC-8004 (filled by scripts/identity.ts)
ERC8004_HEDERA_AGENT_ID=
ERC8004_ARC_AGENT_ID=
```

- [ ] **Step 2: Failing test**

```ts
import { expect, test } from "bun:test";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { deriveKemKeys, deriveSigningKeys, checkSig, MemoryNonceStore } from "@vaultradar/core";
const env = { PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "77".repeat(32), PQ_KEM_SEED: "88".repeat(64), GRAPH_STUDIO_API_KEY: "k",
  HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1", HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), ERC8004_HEDERA_AGENT_ID: "7" };
const config = loadConfig(env); const keys = { sig: deriveSigningKeys(env.PQ_SIG_SEED), kem: deriveKemKeys(env.PQ_KEM_SEED) };
const data = { catalog: async () => ({ protocols: [{ protocol: "aave-v3", chain: "ethereum", status: "live", vaultCount: 3 }], erc4626Chains: ["1"] }), scan: async () => { throw new Error("n/a"); }, table: async () => { throw new Error("n/a"); } };
const app = buildApp({ config, keys, data, hcs: null, nonces: new MemoryNonceStore(), rails: {} });
const srv = app.listen(0); const base = () => `http://127.0.0.1:${(srv.address() as any).port}`;
test("agent card is signed and carries keys and prices", async () => {
  const card = await (await fetch(base() + "/.well-known/agent.json")).json();
  expect(card.pq.sig.alg).toBe("ML-DSA-65"); expect(card.pq.kem.kid).toBe(keys.kem.kid);
  expect(card.endpoints.hedera.scan).toBe("http://svc.test/hedera/v1/scan");
  expect(checkSig(card, keys.sig.publicKey)).toBe(true);
  expect(card.erc8004[0]).toEqual({ chainId: "296", agentId: "7" });
});
test("ucp and erc8004 files exist; catalog lists protocols", async () => {
  expect((await (await fetch(base() + "/.well-known/ucp")).json()).ucp.version).toBeDefined();
  const reg = await (await fetch(base() + "/.well-known/erc8004.json")).json();
  expect(reg.pq.pub_hash).toBe(keys.sig.pubHash);
  expect((await (await fetch(base() + "/v1/catalog")).json()).protocols[0].protocol).toBe("aave-v3");
});
```

- [ ] **Step 3: Implement config, keys, wellknown, app**

`config.ts`: read the variables listed above with defaults for URLs; throw on missing seeds; `erc8004` built from the two agent-id variables when present (`chainId` `"296"` for Hedera, `"5042002"` for Arc).

`keys.ts`:

```ts
import { deriveKemKeys, deriveSigningKeys, attachSig, toB64, hederaScanPriceUsd, ARC_BUCKET_PRICE, TABLE_PRICE_USD } from "@vaultradar/core";
import type { Config } from "./config";
export type ServiceKeys = { sig: ReturnType<typeof deriveSigningKeys>; kem: ReturnType<typeof deriveKemKeys> };
export const loadKeys = (c: Config): ServiceKeys => ({ sig: deriveSigningKeys(c.sigSeed), kem: deriveKemKeys(c.kemSeed) });
export function buildAgentCard(c: Config, k: ServiceKeys) {
  const u = c.publicUrl.replace(/\/$/, "");
  const card = {
    name: "VaultRadar", version: "0.1.0", description: "Cross-protocol vault risk, metered over x402, sealed with PQ KEM, receipts signed with ML-DSA-65.",
    pq: { sig: { alg: "ML-DSA-65", public_key: toB64(k.sig.publicKey), pub_hash: k.sig.pubHash }, kem: { alg: "ml-kem768-x25519", public_key: toB64(k.kem.publicKey), kid: k.kem.kid } },
    erc8004: c.erc8004, hcs: { topicId: c.hedera.hcsTopicId },
    endpoints: { hedera: { scan: `${u}/hedera/v1/scan`, scanHbar: `${u}/hedera/v1/scan-hbar`, table: `${u}/hedera/v1/table`, network: "hedera:testnet", asset: c.hedera.usdcToken },
                 arc: { scan: { s: `${u}/arc/v1/scan/s`, m: `${u}/arc/v1/scan/m`, l: `${u}/arc/v1/scan/l` }, table: `${u}/arc/v1/table`, network: c.arc.network } },
    prices: { hedera_scan: "0.001 + 0.0005 * count USD", hedera_scan_examples: { "1": hederaScanPriceUsd(1), "10": hederaScanPriceUsd(10) }, arc_scan_buckets: ARC_BUCKET_PRICE, table: TABLE_PRICE_USD },
    limits: { max_vaults: 100, ts_window_seconds: 120 }, docs: `${u}/skill.md`,
  };
  return attachSig(card, k.sig);
}
```

`wellknown.ts` registers: `/.well-known/agent.json` (card), `/.well-known/ucp` → `{ ucp: { version: "2026-08-25", services: [{ name: "vaultradar.scan", transports: ["rest"], endpoint: card.endpoints.hedera.scan }], payment_handlers: [{ type: "x402", network: "hedera:testnet" }, { type: "x402", network: c.arc.network }] } }`, `/.well-known/erc8004.json` → `{ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "VaultRadar", description: card.description, image: null, services: [{ name: "web", endpoint: c.publicUrl }, { name: "x402", endpoint: card.endpoints.hedera.scan }], x402Support: true, pq: { alg: "ML-DSA-65", pub_hash: k.sig.pubHash } }`, `/v1/catalog` → `data.catalog()`, `/v1/receipts/:hash` → `hcs ? await hcs.lookup(hash) : { receipt_hash: hash, topicId: c.hedera.hcsTopicId, sequence: null }`, `/health`. Apply `cors()` only to these routes. Serve `skills/vaultradar/SKILL.md` at `/skill.md`.

`app.ts` builds the express app: `app.use(express.json({ limit: "256kb" }))` first, then wellknown, then (Task 16/19) rails when `rails.hedera`/`rails.arc` are true. `main.ts` loads config, keys, `LiveDataProvider` (Task 15), HCS queue (Task 17), and listens.

- [ ] **Step 4: Run, expect pass. Commit** — `git add -A && git commit -m "feat(service): skeleton, seeded keys, signed agent card, UCP and ERC-8004 files, catalog"`

