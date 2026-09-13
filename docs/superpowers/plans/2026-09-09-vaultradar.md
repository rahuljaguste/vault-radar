# VaultRadar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship VaultRadar for ETHOnline 2026 by Saturday 2026-09-12 evening: an x402-metered cross-protocol vault-risk service on Messari standardized subgraphs plus a new ERC-4626 Substreams module, sold on Hedera (Blocky402) and Arc (Circle Gateway), consumed by a Claude Agent SDK risk agent, with ML-DSA-65 receipts and sealed requests and responses.

**Architecture:** A bun-workspaces monorepo. `packages/core` holds every pure piece (canonical JSON, PQ, receipts, unify, freshness, risk, pricing, standardized query layer, Postgres reader) with unit tests that need no network. `packages/service` wraps core in Express with two x402 rails, HCS commitments and ERC-8004 identity. `packages/agent` is the paying consumer. `packages/dashboard` is a thin Next.js UI. `substreams/erc4626-vault-metrics` is a Rust Substreams package composed from the Pinax `erc4626` module, sunk to Neon Postgres.

**Tech Stack:** bun 1.3, TypeScript 5, Express 4, `@x402/express` `@x402/core` `@x402/hedera` `@x402/fetch` 2.25.0, `@circle-fin/x402-batching` 3.4.0, `@noble/post-quantum` 0.7.1, `@noble/hashes`, `@hashgraph/sdk`, `viem`, `pg`, `@anthropic-ai/claude-agent-sdk`, Next.js 15, Rust stable + `substreams` CLI + `substreams-sink-sql`.

**Spec:** `docs/superpowers/specs/2026-09-05-vaultradar-design.md` (read it first; this plan argues from it).

## Global Constraints

- Deadline: Sunday 2026-09-13 12:00 EDT. Everything must be demoable by Saturday 2026-09-12 evening. Today is 2026-09-09.
- Start Fresh rules: no code from any prior project of the author; public libraries only. Commit after every task with a descriptive message; never squash.
- Pin `@x402/express`, `@x402/core`, `@x402/hedera`, `@x402/fetch` to exactly `2.25.0`; `@circle-fin/x402-batching` to `3.4.0`; `@noble/post-quantum` to `0.7.1`.
- All numerics that enter hashes or signatures are decimal strings. Canonical JSON = sorted keys, no whitespace, UTF-8.
- Freshness thresholds: Messari 3600 seconds, Substreams 300 seconds. Envelope timestamp window: 120 seconds. Nonce memory: 600 seconds. Handler cap: 60 seconds.
- Prices: Hedera scan `$0.001 + $0.0005 × count`; Arc scan buckets `s` (1-5) `$0.003`, `m` (6-20) `$0.01`, `l` (21-100) `$0.05`; `table` `$0.03` on both rails.
- Hedera testnet USDC is HTS token `0.0.429274` (6 decimals). Blocky402 testnet facilitator: `https://api.testnet.blocky402.com`. Circle Gateway testnet facilitator: `https://gateway-api-testnet.circle.com`. Arc testnet: `eip155:5042002`, RPC `https://rpc.testnet.arc.io`. Hedera testnet JSON-RPC: `https://testnet.hashio.io/api` (chain 296). ERC-8004 IdentityRegistry on both testnets: `0x8004A818BFB912233c491871b3d84c89A494BD9e`.
- Never log decrypted request bodies. Secrets only via environment variables listed in `.env.example`.
- Cut order if behind schedule (spec §10): HCS-14 UAID and Falcon are already cut; then the harness PR (already cut for the compressed window); then dashboard extras; then the Arc rail only if Task 19's live check fails by Thursday 2026-09-10 evening. Never cut `table`, receipts, sealing.

## Verified third-party API facts (do not re-derive)

- `@noble/post-quantum/ml-dsa.js`: `ml_dsa65.keygen(seed: Uint8Array(32))` → `{ secretKey, publicKey }`; `ml_dsa65.sign(msg, secretKey)` → `Uint8Array`; `ml_dsa65.verify(sig, msg, publicKey)` → `boolean`. Note the argument order.
- `@noble/post-quantum/hybrid.js`: `ml_kem768_x25519` is a KEM with `keygen(seed?)`, `encapsulate(publicKey)` → `{ cipherText, sharedSecret }`, `decapsulate(cipherText, secretKey)` → `Uint8Array`, and `lengths.seed` giving the required seed length.
- `@x402/express`: `paymentMiddleware(routes: RoutesConfig, server: x402ResourceServer)`; `RoutesConfig = Record<"POST /path", RouteConfig>`; `RouteConfig.accepts: PaymentOption | PaymentOption[]`; `PaymentOption = { scheme: "exact", payTo: string, network: "hedera:testnet", price: Price | ((ctx: HTTPRequestContext) => Price | Promise<Price>), maxTimeoutSeconds? }`; `Price = string | number | { asset: string, amount: string }`; `HTTPRequestContext = { adapter, path, method, paymentHeader?, routePattern? }`; `adapter.getHeader(name)`, `adapter.getBody()` (needs `express.json()` first). Middleware verifies before the handler and settles after a 2xx.
- `@x402/core/server`: `new HTTPFacilitatorClient({ url })`; `new x402ResourceServer(facilitator).register("hedera:testnet", new ExactHederaScheme())` where `ExactHederaScheme` comes from `@x402/hedera/exact/server`. `x402ResourceServer.onAfterVerify(hook)` receives `{ paymentPayload, requirements, result: { isValid, payer? } }`.
- `@x402/core/http`: `decodePaymentSignatureHeader(headerValue)` → `PaymentPayload` (`{ x402Version, scheme, network, payload: Record<string, unknown> }`).
- `@x402/hedera`: `createClientHederaSigner(accountId: string, privateKey: PrivateKey, config?)`; re-exports `PrivateKey`, `Client`, `TransferTransaction`, `TokenAssociateTransaction`, `TokenId`, `AccountId` from `@hiero-ledger/sdk`; `@x402/hedera/exact/client` exports `ExactHederaScheme(signer)`.
- `@x402/fetch`: `new x402Client().register("hedera:testnet", scheme)`; `wrapFetchWithPayment(fetch, client)`; `decodePaymentResponseHeader(value)` gives `{ transaction, network, payer? }` from the `PAYMENT-RESPONSE` header.
- `@circle-fin/x402-batching/server`: `createGatewayMiddleware({ sellerAddress, networks: ["eip155:5042002"], facilitatorUrl })` → `gateway.require("$0.003")` Express middleware; after verification `req.payment = { verified, payer, amount, network, transaction? }`.
- `@circle-fin/x402-batching/client`: `new GatewayClient({ chain: "arcTestnet", privateKey })`; `deposit("5")`; `pay(url, { method: "POST", body, headers })` → `{ data, amount, formattedAmount, transaction }`.
- ERC-8004 IdentityRegistry: `register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) returns (uint256 agentId)`, `setMetadata(uint256, string, bytes)`, `getMetadata(uint256, string) view returns (bytes)`, event `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`.
- Pinax `erc4626` Substreams package: `https://github.com/pinax-network/substreams-evm/raw/main/spkg/erc4626-v0.1.0.spkg`, module `map_events` (input `sf.ethereum.type.v2.Block`, output `proto:erc4626.v1.Events`). `Events.transactions[].logs[]` has `address` (vault), `ordinal`, `block_index`, and `oneof log { Deposit deposit = 10; Withdraw withdraw = 11 }`; `Deposit { sender, owner, assets: string, shares: string }`; `Withdraw { sender, receiver, owner, assets: string, shares: string }`.

## File structure

```
package.json                      bun workspaces root, scripts
tsconfig.base.json
.env.example
packages/core/
  package.json  tsconfig.json
  src/index.ts                    re-exports
  src/util/bytes.ts               hex/base64/utf8 helpers
  src/canonical.ts                canonicalize(), sha256Hex()
  src/pq/keys.ts                  deriveSigningKeys(), deriveKemKeys(), kid()
  src/pq/sign.ts                  signBytes(), verifyBytes(), signJson(), verifyJson()
  src/pq/seal.ts                  seal(), open(), Envelope type
  src/envelope.ts                 buildRequestEnvelope(), openRequestEnvelope(), checkEnvelope() (ts/nonce/payer/count)
  src/receipts.ts                 Receipt, Attestation types; buildReceipt(), receiptHash(), verifyReceipt(), buildAttestation(), verifyAttestation()
  src/unify/types.ts              UnifiedVault, Source, Freshness
  src/unify/freshness.ts          classifyFreshness()
  src/risk.ts                     computeRisk() → RiskReport
  src/pricing.ts                  hederaScanPrice(count), arcBucket(count), TABLE_PRICE
  src/standardized/deployments.json
  src/standardized/templates.ts   YIELD_VAULTS_QUERY, LENDING_MARKETS_QUERY
  src/standardized/gateway.ts     queryDeployment()
  src/standardized/map.ts         mapYieldVaults(), mapLendingMarkets()
  src/substreams/reader.ts        readErc4626Vaults()
  test/*.test.ts                  one test file per module
scripts/verify-deployments.ts     live gate; writes status into deployments.json
substreams/erc4626-vault-metrics/ Rust package (Tasks 11–13)
packages/service/
  src/config.ts                   env → Config (seeds, accounts, urls)
  src/keys.ts                     ServiceKeys from seeds, agent card builder
  src/data/provider.ts            DataProvider interface + LiveDataProvider (core standardized + reader)
  src/handlers/scan.ts            shared scan/table handler factory
  src/rails/hedera.ts             x402 middleware + payer capture
  src/rails/arc.ts                Circle middleware
  src/hcs.ts                      commitment queue, lookup
  src/wellknown.ts                agent.json, ucp, erc8004.json, catalog, receipts
  src/app.ts                      buildApp(deps)
  src/main.ts                     listen
  scripts/identity.ts             HCS topic + ERC-8004 registration
  scripts/hello-x402.ts           day-one paid request check
  Dockerfile  fly.toml
packages/agent/
  src/client.ts                   VaultRadarClient: discover, quote, scan, table, verify
  src/rails/hedera.ts             payingFetchHedera()
  src/rails/arc.ts                payArc()
  src/policy.ts                   choose rail/tier, budget, age check
  src/runs.ts                     persist runs/<id>.json
  src/tools.ts                    Claude Agent SDK tool definitions
  src/cli.ts                      watch / chat
packages/dashboard/               Next.js app (Task 24)
skills/vaultradar/SKILL.md
scripts/demo.sh
```

## Workstreams and order

Run in parallel where the dependency graph allows:

- **W1 core** (Tasks 1-10): sequential, no network. Start immediately.
- **W2 substreams** (Tasks 11-13): independent of W1 after Task 1. Needs The Graph Market token and Neon URL.
- **W3 service** (Tasks 14-20): needs Tasks 2-10.
- **W4 agent** (Tasks 21-23): needs Tasks 2-8; live tests need Task 16/19 deployed.
- **W5 dashboard** (Task 24): needs Task 14 shape; can start from fixtures.
- **W6 docs/video** (Tasks 25-26): last.

Day plan: Sept 9 → Tasks 1-10 and 11, plus `hello-x402` (Task 16 client half) as soon as the Hedera accounts exist. Sept 10 → Tasks 12-17, 21-22, Task 19 live check (go/no-go on Arc). Sept 11 → Tasks 18, 20, 23, 24, 25. Sept 12 → integration on live testnets, Task 26 video, submit.

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.env.example`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`
- Modify: `.gitignore` (add `runs/`, `packages/dashboard/.next/`, `substreams/**/target/`)

**Interfaces:**
- Produces: workspace name `@vaultradar/core` importable from sibling packages; `bun test` runs from the root.

- [ ] **Step 1: Root package.json and tsconfig**

```json
{
  "name": "vaultradar",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "bun test",
    "typecheck": "bun x tsc -p packages/core/tsconfig.json --noEmit && bun x tsc -p packages/service/tsconfig.json --noEmit && bun x tsc -p packages/agent/tsconfig.json --noEmit",
    "verify-deployments": "bun run scripts/verify-deployments.ts",
    "service": "bun run packages/service/src/main.ts",
    "agent": "bun run packages/agent/src/cli.ts"
  },
  "devDependencies": { "typescript": "^5.6.0", "@types/node": "^22.0.0", "bun-types": "latest" }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "resolveJsonModule": true, "types": ["bun-types"], "noEmit": true
  }
}
```

- [ ] **Step 2: Core package**

`packages/core/package.json`:

```json
{
  "name": "@vaultradar/core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@noble/post-quantum": "0.7.1",
    "@noble/hashes": "^1.7.0",
    "@noble/ciphers": "^1.2.0",
    "pg": "^8.13.0",
    "viem": "^2.21.0"
  },
  "devDependencies": { "@types/pg": "^8.11.0" }
}
```

`packages/core/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "../../scripts"] }`

`packages/core/src/index.ts`: `export const CORE_VERSION = "0.1.0";`

`packages/core/test/smoke.test.ts`:

```ts
import { expect, test } from "bun:test";
import { CORE_VERSION } from "../src/index";
test("core loads", () => { expect(CORE_VERSION).toBe("0.1.0"); });
```

- [ ] **Step 3: .env.example (initial; later tasks append)**

```
# The Graph
GRAPH_STUDIO_API_KEY=
# Substreams sink database (Neon)
DATABASE_URL=
# Chain heads for freshness
ETH_RPC_URL=https://ethereum-rpc.publicnode.com
BASE_RPC_URL=https://mainnet.base.org
```

- [ ] **Step 4: Install and run**

Run: `bun install && bun test`
Expected: `1 pass`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: bun workspace scaffold with core package and test runner"
```

### Task 2: Canonical JSON and hashing

**Files:**
- Create: `packages/core/src/util/bytes.ts`, `packages/core/src/canonical.ts`, `packages/core/test/canonical.test.ts`

**Interfaces:**
- Produces: `canonicalize(value: unknown): string`, `canonicalBytes(value: unknown): Uint8Array`, `sha256Hex(bytes: Uint8Array): string`, `hashJson(value: unknown): string` (sha256 hex of canonical bytes); `bytes.ts` exports `toHex`, `fromHex`, `toB64`, `fromB64`, `utf8`, `randomBytes`.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { canonicalize, hashJson } from "../src/canonical";

test("sorts keys recursively and strips whitespace", () => {
  expect(canonicalize({ b: 1, a: { d: "x", c: [3, { z: 1, y: 2 }] } }))
    .toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":"x"},"b":1}');
});
test("rejects non-integer numbers (numerics must be strings)", () => {
  expect(() => canonicalize({ a: 1.5 })).toThrow();
});
test("hash is stable across key order", () => {
  expect(hashJson({ a: "1", b: "2" })).toBe(hashJson({ b: "2", a: "1" }));
  expect(hashJson({ a: "1" })).toMatch(/^[0-9a-f]{64}$/);
});
test("undefined properties are dropped, null kept", () => {
  expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
});
```

- [ ] **Step 2: Run, expect failure**, `bun test packages/core/test/canonical.test.ts` → module not found.

- [ ] **Step 3: Implement**

`packages/core/src/util/bytes.ts`:

```ts
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
export const toHex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2) throw new Error("odd hex length");
  return Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
};
export const toB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
export const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
```

`packages/core/src/canonical.ts`:

```ts
import { sha256 } from "@noble/hashes/sha2";
import { toHex, utf8 } from "./util/bytes";

function enc(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("canonical JSON: non-integer number; use a decimal string");
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return "[" + v.map(x => enc(x === undefined ? null : x)).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + enc(o[k])).join(",") + "}";
  }
  throw new Error(`canonical JSON: unsupported type ${typeof v}`);
}
export const canonicalize = (v: unknown): string => enc(v);
export const canonicalBytes = (v: unknown): Uint8Array => utf8(canonicalize(v));
export const sha256Hex = (b: Uint8Array): string => toHex(sha256(b));
export const hashJson = (v: unknown): string => sha256Hex(canonicalBytes(v));
```

- [ ] **Step 4: Run, expect pass**, `bun test packages/core/test/canonical.test.ts` → 4 pass.

- [ ] **Step 5: Commit**, `git add -A && git commit -m "feat(core): canonical JSON and sha256 hashing"`

### Task 3: PQ keys from seeds and ML-DSA-65 signatures

**Files:**
- Create: `packages/core/src/pq/keys.ts`, `packages/core/src/pq/sign.ts`, `packages/core/test/pq-sign.test.ts`

**Interfaces:**
- Produces: `deriveSigningKeys(seedHex: string): { publicKey: Uint8Array; secretKey: Uint8Array; pubHash: string }` (deterministic, ML-DSA-65); `deriveKemKeys(seedHex: string): { publicKey; secretKey; kid: string }` (ML-KEM-768+X25519); `signJson(value, secretKey): string` (base64 signature over canonical bytes); `verifyJson(value, sigB64, publicKey): boolean`; `Sig = { alg: "ML-DSA-65"; pub_hash: string; value: string }`; `attachSig(obj, keys)` / `checkSig(obj, publicKey)` where `obj.sig` is excluded from the signed bytes.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { deriveSigningKeys, deriveKemKeys } from "../src/pq/keys";
import { attachSig, checkSig, signJson, verifyJson } from "../src/pq/sign";

const SEED = "11".repeat(32);
test("signing keys are deterministic from seed", () => {
  const a = deriveSigningKeys(SEED), b = deriveSigningKeys(SEED);
  expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
  expect(a.pubHash).toMatch(/^[0-9a-f]{64}$/);
  expect(a.publicKey.length).toBe(1952);
});
test("kem keys derive with kid", () => {
  const k = deriveKemKeys("22".repeat(64));
  expect(k.kid).toMatch(/^[0-9a-f]{16}$/);
  expect(k.publicKey.length).toBeGreaterThan(1000);
});
test("sign/verify round trip and tamper detection", () => {
  const k = deriveSigningKeys(SEED);
  const sig = signJson({ a: "1" }, k.secretKey);
  expect(verifyJson({ a: "1" }, sig, k.publicKey)).toBe(true);
  expect(verifyJson({ a: "2" }, sig, k.publicKey)).toBe(false);
});
test("attachSig/checkSig exclude the sig field", () => {
  const k = deriveSigningKeys(SEED);
  const signed = attachSig({ x: "y" }, k);
  expect(signed.sig.alg).toBe("ML-DSA-65");
  expect(signed.sig.pub_hash).toBe(k.pubHash);
  expect(checkSig(signed, k.publicKey)).toBe(true);
  expect(checkSig({ ...signed, x: "z" }, k.publicKey)).toBe(false);
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

`packages/core/src/pq/keys.ts`:

```ts
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { fromHex, toHex, utf8 } from "../util/bytes";
import { sha256Hex } from "../canonical";

export const SIG_ALG = "ML-DSA-65" as const;
export const KEM_ALG = "ml-kem768-x25519" as const;

export function deriveSigningKeys(seedHex: string) {
  const seed = fromHex(seedHex);
  if (seed.length !== 32) throw new Error("PQ_SIG_SEED must be 32 bytes hex");
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  return { publicKey, secretKey, pubHash: sha256Hex(publicKey) };
}

export function deriveKemKeys(seedHex: string) {
  const master = fromHex(seedHex);
  if (master.length < 32) throw new Error("PQ_KEM_SEED must be at least 32 bytes hex");
  const need = ml_kem768_x25519.lengths.seed ?? 96;
  const seed = hkdf(sha256, master, utf8("vaultradar/kem/v1"), undefined, need);
  const { publicKey, secretKey } = ml_kem768_x25519.keygen(seed);
  return { publicKey, secretKey, kid: sha256Hex(publicKey).slice(0, 16) };
}
export const kidOf = (publicKey: Uint8Array) => sha256Hex(publicKey).slice(0, 16);
export { toHex };
```

`packages/core/src/pq/sign.ts`:

```ts
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { canonicalBytes } from "../canonical";
import { fromB64, toB64 } from "../util/bytes";
import { SIG_ALG } from "./keys";

export type Sig = { alg: typeof SIG_ALG; pub_hash: string; value: string };
export const signJson = (value: unknown, secretKey: Uint8Array): string =>
  toB64(ml_dsa65.sign(canonicalBytes(value), secretKey));
export const verifyJson = (value: unknown, sigB64: string, publicKey: Uint8Array): boolean => {
  try { return ml_dsa65.verify(fromB64(sigB64), canonicalBytes(value), publicKey); } catch { return false; }
};
export function attachSig<T extends object>(obj: T, keys: { secretKey: Uint8Array; pubHash: string }): T & { sig: Sig } {
  const { sig: _drop, ...body } = obj as T & { sig?: Sig };
  return { ...(body as T), sig: { alg: SIG_ALG, pub_hash: keys.pubHash, value: signJson(body, keys.secretKey) } };
}
export function checkSig(obj: { sig?: Sig } & object, publicKey: Uint8Array): boolean {
  if (!obj.sig || obj.sig.alg !== SIG_ALG) return false;
  const { sig, ...body } = obj;
  return verifyJson(body, sig.value, publicKey);
}
```

- [ ] **Step 4: Run, expect 4 pass.** If `ml_kem768_x25519.lengths.seed` is undefined at runtime, print `ml_kem768_x25519.lengths` once and hard-code the value it reports; remove the print.

- [ ] **Step 5: Commit**, `git add -A && git commit -m "feat(core): seeded ML-DSA-65 and hybrid KEM keys, JSON signatures"`

### Task 4: Seal and open (hybrid KEM + HKDF + AES-256-GCM)

**Files:**
- Create: `packages/core/src/pq/seal.ts`, `packages/core/test/pq-seal.test.ts`

**Interfaces:**
- Produces: `type Sealed = { v: 1; kem: "ml-kem768-x25519"; kid: string; ct: string; nonce: string; body: string }` (all base64 except `kid` hex); `seal(plain: unknown, recipientPk: Uint8Array): Sealed`; `open<T>(sealed: Sealed, secretKey: Uint8Array, expectKid?: string): T`; `deriveAead(sharedSecret)` internal.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { deriveKemKeys } from "../src/pq/keys";
import { open, seal } from "../src/pq/seal";

const k = deriveKemKeys("33".repeat(64));
test("round trip", () => {
  const s = seal({ hello: "world", n: "1" }, k.publicKey);
  expect(s.kem).toBe("ml-kem768-x25519");
  expect(s.kid).toBe(k.kid);
  expect(open(s, k.secretKey)).toEqual({ hello: "world", n: "1" });
});
test("tampered ciphertext fails", () => {
  const s = seal({ a: "b" }, k.publicKey);
  const bad = { ...s, body: s.body.slice(0, -4) + "AAAA" };
  expect(() => open(bad, k.secretKey)).toThrow();
});
test("wrong recipient fails", () => {
  const other = deriveKemKeys("44".repeat(64));
  const s = seal({ a: "b" }, k.publicKey);
  expect(() => open(s, other.secretKey)).toThrow();
});
test("kid mismatch rejected before decrypt", () => {
  const s = seal({ a: "b" }, k.publicKey);
  expect(() => open({ ...s, kid: "0000000000000000" }, k.secretKey, k.kid)).toThrow(/kid/);
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```ts
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { canonicalBytes } from "../canonical";
import { fromB64, fromUtf8, randomBytes, toB64, utf8 } from "../util/bytes";
import { KEM_ALG, kidOf } from "./keys";

export type Sealed = { v: 1; kem: typeof KEM_ALG; kid: string; ct: string; nonce: string; body: string };
const INFO = utf8("vaultradar/seal/v1");
const deriveAead = (ss: Uint8Array) => hkdf(sha256, ss, undefined, INFO, 32);

export function seal(plain: unknown, recipientPk: Uint8Array): Sealed {
  const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(recipientPk);
  const nonce = randomBytes(12);
  const body = gcm(deriveAead(sharedSecret), nonce).encrypt(canonicalBytes(plain));
  return { v: 1, kem: KEM_ALG, kid: kidOf(recipientPk), ct: toB64(cipherText), nonce: toB64(nonce), body: toB64(body) };
}
export function open<T = unknown>(s: Sealed, secretKey: Uint8Array, expectKid?: string): T {
  if (s.v !== 1 || s.kem !== KEM_ALG) throw new Error("unsupported envelope");
  if (expectKid && s.kid !== expectKid) throw new Error("kid mismatch");
  const ss = ml_kem768_x25519.decapsulate(fromB64(s.ct), secretKey);
  const plain = gcm(deriveAead(ss), fromB64(s.nonce)).decrypt(fromB64(s.body));
  return JSON.parse(fromUtf8(plain)) as T;
}
export function isSealed(x: unknown): x is Sealed {
  const s = x as Sealed;
  return !!s && s.v === 1 && s.kem === KEM_ALG && typeof s.ct === "string" && typeof s.nonce === "string" && typeof s.body === "string" && typeof s.kid === "string";
}
```

- [ ] **Step 4: Run, expect 4 pass.**

- [ ] **Step 5: Commit**, `git add -A && git commit -m "feat(core): hybrid PQ sealing with AES-256-GCM"`

### Task 5: Request envelope, replay checks, receipts, attestations

**Files:**
- Create: `packages/core/src/envelope.ts`, `packages/core/src/receipts.ts`, `packages/core/test/envelope.test.ts`, `packages/core/test/receipts.test.ts`

**Interfaces:**
- Produces (envelope): `type ScanRequest = { vaults: string[] }`; `type TableRequest = { protocol: string; chainId: string }`; `type SealedRequest<R> = { request: R; reply_pk: string /* b64 */; payer: string; ts: string /* unix seconds */; req_nonce: string /* hex 32 */ }`; `buildSealedRequest<R>(request: R, payer: string, servicePk: Uint8Array, now?: number): { sealed: Sealed; replySecret: Uint8Array; count: number }`; `openSealedRequest<R>(sealed: Sealed, kemSecret: Uint8Array, kid: string): SealedRequest<R>`; `checkSealedRequest(p: SealedRequest<unknown>, opts: { now: number; payer: string; count?: number; seen: NonceStore }): { ok: true } | { ok: false; reason: string }`; `class MemoryNonceStore implements NonceStore { has(n): boolean; add(n, expiresAt): void; sweep(now): void }`; `NonceStore` interface.
- Produces (receipts): `type SourceRef = { ref: string; chainId: string; block: string; timestamp: string }`; `type Receipt = { v: 1; service: { erc8004: { chainId: string; agentId: string }[] }; request_hash: string; response_hash: string; sealed: boolean; sources: SourceRef[]; price: { amount: string; asset: string; rail: "hedera" | "arc" }; payment: { rail: "hedera" | "arc"; txId: string }; tier: "scan" | "table"; issued_at: string; nonce: string; hcs: { topicId: string }; sig: Sig }`; `type Attestation = { v: 1; vaultId: string; chainId: string; block: string; timestamp: string; sharePrice: string; tvlUsd: string | null; source: string; sig: Sig }`; `buildReceipt(input: Omit<Receipt, "v" | "sig" | "nonce" | "issued_at"> & { issued_at?: string }, keys): Receipt`; `receiptHash(r: Receipt): string` (sha256 of canonical receipt without `sig`); `verifyReceipt(r: Receipt, pk: Uint8Array): boolean`; `buildAttestation(a: Omit<Attestation, "v" | "sig">, keys): Attestation`; `verifyAttestation(a, pk)`; `responseHash(body: { vaults; reports; attestations }): string`; `requestHash(request: unknown): string`.

- [ ] **Step 1: Failing tests (envelope)**

```ts
import { expect, test } from "bun:test";
import { deriveKemKeys } from "../src/pq/keys";
import { MemoryNonceStore, buildSealedRequest, checkSealedRequest, openSealedRequest } from "../src/envelope";

const svc = deriveKemKeys("55".repeat(64));
const now = 1_760_000_000;
test("seal → open → check passes with matching payer and count", () => {
  const { sealed, count } = buildSealedRequest({ vaults: ["1:0xabc", "1:0xdef"] }, "0.0.1234", svc.publicKey, now);
  expect(count).toBe(2);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);
  expect(p.request.vaults.length).toBe(2);
  expect(p.reply_pk.length).toBeGreaterThan(100);
  const seen = new MemoryNonceStore();
  expect(checkSealedRequest(p, { now: now + 5, payer: "0.0.1234", count: 2, seen })).toEqual({ ok: true });
  expect(checkSealedRequest(p, { now: now + 5, payer: "0.0.1234", count: 2, seen }).ok).toBe(false); // replayed nonce
});
test("rejects stale ts, payer mismatch, count mismatch", () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.1", svc.publicKey, now);
  const p = openSealedRequest<{ vaults: string[] }>(sealed, svc.secretKey, svc.kid);
  expect(checkSealedRequest(p, { now: now + 121, payer: "0.0.1", count: 1, seen: new MemoryNonceStore() })).toMatchObject({ ok: false, reason: "ts_window" });
  expect(checkSealedRequest(p, { now, payer: "0.0.2", count: 1, seen: new MemoryNonceStore() })).toMatchObject({ ok: false, reason: "payer_mismatch" });
  expect(checkSealedRequest(p, { now, payer: "0.0.1", count: 3, seen: new MemoryNonceStore() })).toMatchObject({ ok: false, reason: "count_mismatch" });
});
```

- [ ] **Step 2: Failing tests (receipts)**

```ts
import { expect, test } from "bun:test";
import { deriveSigningKeys } from "../src/pq/keys";
import { buildAttestation, buildReceipt, receiptHash, requestHash, responseHash, verifyAttestation, verifyReceipt } from "../src/receipts";

const keys = deriveSigningKeys("66".repeat(32));
const base = {
  service: { erc8004: [{ chainId: "296", agentId: "7" }] },
  request_hash: requestHash({ vaults: ["1:0xabc"] }),
  response_hash: responseHash({ vaults: [], reports: [], attestations: [] }),
  sealed: true, sources: [{ ref: "Qm123", chainId: "1", block: "100", timestamp: "1760000000" }],
  price: { amount: "1500", asset: "0.0.429274", rail: "hedera" as const },
  payment: { rail: "hedera" as const, txId: "0.0.5@1760000000.000000001" },
  tier: "scan" as const, hcs: { topicId: "0.0.99" },
};
test("receipt signs, verifies, hashes without sig", () => {
  const r = buildReceipt(base, keys);
  expect(verifyReceipt(r, keys.publicKey)).toBe(true);
  expect(r.nonce).toMatch(/^[0-9a-f]{32}$/);
  const h1 = receiptHash(r);
  expect(h1).toBe(receiptHash({ ...r, sig: { ...r.sig, value: "AAAA" } }));
  expect(verifyReceipt({ ...r, tier: "table" }, keys.publicKey)).toBe(false);
});
test("attestation signs and verifies", () => {
  const a = buildAttestation({ vaultId: "1:0xabc", chainId: "1", block: "100", timestamp: "1760000000", sharePrice: "1.0213", tvlUsd: null, source: "substreams:erc4626-vault-metrics" }, keys);
  expect(verifyAttestation(a, keys.publicKey)).toBe(true);
  expect(verifyAttestation({ ...a, sharePrice: "9" }, keys.publicKey)).toBe(false);
});
```

- [ ] **Step 3: Run both, expect failure.**

- [ ] **Step 4: Implement `envelope.ts`**

```ts
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { fromB64, randomBytes, toB64, toHex } from "./util/bytes";
import { Sealed, open, seal } from "./pq/seal";

export type ScanRequest = { vaults: string[] };
export type TableRequest = { protocol: string; chainId: string };
export type SealedRequest<R> = { request: R; reply_pk: string; payer: string; ts: string; req_nonce: string };
export interface NonceStore { has(n: string): boolean; add(n: string, expiresAt: number): void; sweep(now: number): void }
export class MemoryNonceStore implements NonceStore {
  private m = new Map<string, number>();
  has(n: string) { return this.m.has(n); }
  add(n: string, expiresAt: number) { this.m.set(n, expiresAt); }
  sweep(now: number) { for (const [k, t] of this.m) if (t <= now) this.m.delete(k); }
}
export const TS_WINDOW_S = 120, NONCE_TTL_S = 600;

export function buildSealedRequest<R extends object>(request: R, payer: string, servicePk: Uint8Array, now = Math.floor(Date.now() / 1000)) {
  const reply = ml_kem768_x25519.keygen();
  const plain: SealedRequest<R> = { request, reply_pk: toB64(reply.publicKey), payer, ts: String(now), req_nonce: toHex(randomBytes(16)) };
  const count = Array.isArray((request as { vaults?: unknown }).vaults) ? (request as ScanRequest).vaults.length : 0;
  return { sealed: seal(plain, servicePk), replySecret: reply.secretKey, count };
}
export function openSealedRequest<R>(sealed: Sealed, kemSecret: Uint8Array, kid: string): SealedRequest<R> {
  const p = open<SealedRequest<R>>(sealed, kemSecret, kid);
  if (typeof p.reply_pk !== "string" || typeof p.payer !== "string" || typeof p.ts !== "string" || !/^[0-9a-f]{32}$/.test(p.req_nonce)) throw new Error("malformed sealed request");
  fromB64(p.reply_pk);
  return p;
}
export function checkSealedRequest(p: SealedRequest<unknown>, o: { now: number; payer: string; count?: number; seen: NonceStore }): { ok: true } | { ok: false; reason: string } {
  const ts = Number(p.ts);
  if (!Number.isFinite(ts) || Math.abs(o.now - ts) > TS_WINDOW_S) return { ok: false, reason: "ts_window" };
  if (o.seen.has(p.req_nonce)) return { ok: false, reason: "nonce_replay" };
  if (p.payer !== o.payer) return { ok: false, reason: "payer_mismatch" };
  const vaults = (p.request as { vaults?: unknown }).vaults;
  if (o.count !== undefined && Array.isArray(vaults) && vaults.length !== o.count) return { ok: false, reason: "count_mismatch" };
  o.seen.sweep(o.now); o.seen.add(p.req_nonce, o.now + NONCE_TTL_S);
  return { ok: true };
}
```

- [ ] **Step 5: Implement `receipts.ts`**

```ts
import { hashJson } from "./canonical";
import { Sig, attachSig, checkSig } from "./pq/sign";
import { randomBytes, toHex } from "./util/bytes";

export type Rail = "hedera" | "arc";
export type SourceRef = { ref: string; chainId: string; block: string; timestamp: string };
export type Receipt = {
  v: 1; service: { erc8004: { chainId: string; agentId: string }[] };
  request_hash: string; response_hash: string; sealed: boolean; sources: SourceRef[];
  price: { amount: string; asset: string; rail: Rail }; payment: { rail: Rail; txId: string };
  tier: "scan" | "table"; issued_at: string; nonce: string; hcs: { topicId: string }; sig: Sig;
};
export type Attestation = { v: 1; vaultId: string; chainId: string; block: string; timestamp: string; sharePrice: string; tvlUsd: string | null; source: string; sig: Sig };
type Keys = { secretKey: Uint8Array; pubHash: string };

export const requestHash = (request: unknown) => hashJson(request);
export const responseHash = (body: { vaults: unknown; reports: unknown; attestations: unknown }) =>
  hashJson({ vaults: body.vaults, reports: body.reports, attestations: body.attestations });
export function buildReceipt(input: Omit<Receipt, "v" | "sig" | "nonce" | "issued_at"> & { issued_at?: string }, keys: Keys): Receipt {
  const body = { v: 1 as const, ...input, issued_at: input.issued_at ?? String(Math.floor(Date.now() / 1000)), nonce: toHex(randomBytes(16)) };
  return attachSig(body, keys);
}
export const receiptHash = (r: Receipt) => { const { sig: _s, ...rest } = r; return hashJson(rest); };
export const verifyReceipt = (r: Receipt, pk: Uint8Array) => checkSig(r, pk);
export const buildAttestation = (a: Omit<Attestation, "v" | "sig">, keys: Keys): Attestation => attachSig({ v: 1 as const, ...a }, keys);
export const verifyAttestation = (a: Attestation, pk: Uint8Array) => checkSig(a, pk);
```

- [ ] **Step 6: Run, expect all pass. Commit**, `git add -A && git commit -m "feat(core): sealed request envelope with replay checks; PQ-signed receipts and attestations"`

### Task 6: Unified vault types and freshness

**Files:**
- Create: `packages/core/src/unify/types.ts`, `packages/core/src/unify/freshness.ts`, `packages/core/test/freshness.test.ts`

**Interfaces:**
- Produces: `type Freshness = "fresh" | "stale" | "unavailable"`; `type SourceKind = "messari" | "substreams"`; `type Source = { kind: SourceKind; ref: string; block: string; timestamp: string; ageSeconds: string; freshness: Freshness }`; `type HistoryPoint = { block: string; timestamp: string; sharePrice: string; tvlUsd: string | null; netFlowAssets: string | null }`; `type UnifiedVault = { id: string; kind: "yield-vault" | "lending-market" | "erc4626"; protocol: string; chain: string; chainId: string; asset: { symbol: string; decimals: number } | null; sharePrice: string; tvlUsd: string | null; inputTokenBalance: string | null; depositLimit: string | null; history: HistoryPoint[]; sources: Source[]; freshness: Freshness }`; `classifyFreshness(kind: SourceKind, sourceTimestamp: number, headTimestamp: number, error?: boolean): Freshness`; `vaultFreshness(sources: Source[]): Freshness` (worst of sources; empty → unavailable); `THRESHOLDS = { messari: 3600, substreams: 300 }`.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { classifyFreshness, vaultFreshness } from "../src/unify/freshness";

test("messari within 3600s is fresh, beyond is stale, error is unavailable", () => {
  expect(classifyFreshness("messari", 1000, 4600)).toBe("fresh");
  expect(classifyFreshness("messari", 1000, 4601)).toBe("stale");
  expect(classifyFreshness("messari", 1000, 1001, true)).toBe("unavailable");
});
test("substreams threshold is 300s", () => {
  expect(classifyFreshness("substreams", 1000, 1300)).toBe("fresh");
  expect(classifyFreshness("substreams", 1000, 1301)).toBe("stale");
});
test("vault freshness is the worst source; no sources is unavailable", () => {
  const s = (f: "fresh" | "stale" | "unavailable") => ({ kind: "messari" as const, ref: "x", block: "1", timestamp: "1", ageSeconds: "0", freshness: f });
  expect(vaultFreshness([s("fresh"), s("stale")])).toBe("stale");
  expect(vaultFreshness([s("fresh"), s("unavailable")])).toBe("unavailable");
  expect(vaultFreshness([])).toBe("unavailable");
});
```

- [ ] **Step 2: Run, expect failure. Step 3: Implement**

`types.ts` holds exactly the types listed in Interfaces (no logic). `freshness.ts`:

```ts
import type { Freshness, Source, SourceKind } from "./types";
export const THRESHOLDS: Record<SourceKind, number> = { messari: 3600, substreams: 300 };
export function classifyFreshness(kind: SourceKind, sourceTs: number, headTs: number, error = false): Freshness {
  if (error) return "unavailable";
  return headTs - sourceTs <= THRESHOLDS[kind] ? "fresh" : "stale";
}
const RANK: Record<Freshness, number> = { fresh: 0, stale: 1, unavailable: 2 };
export function vaultFreshness(sources: Source[]): Freshness {
  if (!sources.length) return "unavailable";
  return sources.reduce<Freshness>((w, s) => (RANK[s.freshness] > RANK[w] ? s.freshness : w), "fresh");
}
```

- [ ] **Step 4: Run, expect pass. Commit**, `git add -A && git commit -m "feat(core): unified vault types and freshness classification"`

### Task 7: Risk engine

**Files:**
- Create: `packages/core/src/risk.ts`, `packages/core/test/risk.test.ts`

**Interfaces:**
- Produces: `type Flag = { name: "share_price_drawdown_1h" | "share_price_drawdown_24h" | "share_price_drawdown_7d" | "tvl_outflow_24h" | "deposit_limit_reached" | "stale_data"; value: string; threshold: string; window: string }`; `type Verdict = "ok" | "watch" | "alert" | "unavailable"`; `type RiskReport = { vaultId: string; flags: Flag[]; score: number; verdict: Verdict; evidence: { source: string; block: string; timestamp: string; ageSeconds: string }[] }`; `computeRisk(v: UnifiedVault, nowTs: number): RiskReport`.
- Rules (spec §5.3): drawdown = (latest - earliest-within-window)/earliest-within-window, negative means drop; thresholds 0.005/0.02/0.05; weights 30/25/20; the 1 h flag only evaluates if a history point at least 1 h and at most 2 h old exists, otherwise skipped; outflow = -(sum of netFlowAssets over 24 h)/current balance where available, else from tvl history; threshold 0.20, weight 25; deposit limit weight 10; score capped 100; `ok` < 20, `watch` 20-49, `alert` ≥ 50; any source not `fresh` → `stale_data` flag and verdict `unavailable`.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { computeRisk } from "../src/risk";
import type { UnifiedVault } from "../src/unify/types";

const now = 1_760_000_000;
const mk = (over: Partial<UnifiedVault>): UnifiedVault => ({
  id: "1:0xv", kind: "erc4626", protocol: "morpho", chain: "ethereum", chainId: "1", asset: { symbol: "USDC", decimals: 6 },
  sharePrice: "1.00", tvlUsd: "1000000", inputTokenBalance: "1000000000000", depositLimit: null,
  history: [], sources: [{ kind: "substreams", ref: "erc4626-vault-metrics", block: "1", timestamp: String(now - 10), ageSeconds: "10", freshness: "fresh" }],
  freshness: "fresh", ...over,
});
test("healthy vault is ok with score 0", () => {
  const r = computeRisk(mk({ history: [{ block: "0", timestamp: String(now - 86400), sharePrice: "0.99", tvlUsd: "1000000", netFlowAssets: "0" }] }), now);
  expect(r.verdict).toBe("ok"); expect(r.score).toBe(0);
});
test("3% 24h drawdown → watch (25)", () => {
  const r = computeRisk(mk({ sharePrice: "0.97", history: [{ block: "0", timestamp: String(now - 86000), sharePrice: "1.00", tvlUsd: null, netFlowAssets: "0" }] }), now);
  expect(r.flags.map(f => f.name)).toEqual(["share_price_drawdown_24h"]);
  expect(r.score).toBe(25); expect(r.verdict).toBe("watch");
});
test("drawdown 24h plus 25% outflow → alert", () => {
  const r = computeRisk(mk({ sharePrice: "0.97", inputTokenBalance: "1000", history: [
    { block: "0", timestamp: String(now - 86000), sharePrice: "1.00", tvlUsd: null, netFlowAssets: "-250" },
  ] }), now);
  expect(r.score).toBe(50); expect(r.verdict).toBe("alert");
});
test("1h flag skipped without hourly data, fires with it", () => {
  const withHourly = mk({ sharePrice: "0.99", history: [{ block: "0", timestamp: String(now - 3700), sharePrice: "1.00", tvlUsd: null, netFlowAssets: "0" }] });
  expect(computeRisk(withHourly, now).flags[0]?.name).toBe("share_price_drawdown_1h");
});
test("stale source → unavailable regardless of numbers", () => {
  const r = computeRisk(mk({ freshness: "stale", sources: [{ kind: "messari", ref: "Qm", block: "1", timestamp: String(now - 9999), ageSeconds: "9999", freshness: "stale" }] }), now);
  expect(r.verdict).toBe("unavailable");
  expect(r.flags.some(f => f.name === "stale_data")).toBe(true);
  expect(r.evidence[0].ageSeconds).toBe("9999");
});
test("deposit limit reached adds 10", () => {
  const r = computeRisk(mk({ inputTokenBalance: "100", depositLimit: "100" }), now);
  expect(r.score).toBe(10); expect(r.flags[0].name).toBe("deposit_limit_reached");
});
```

- [ ] **Step 2: Run, expect failure. Step 3: Implement**

```ts
import type { UnifiedVault } from "./unify/types";
export type FlagName = "share_price_drawdown_1h" | "share_price_drawdown_24h" | "share_price_drawdown_7d" | "tvl_outflow_24h" | "deposit_limit_reached" | "stale_data";
export type Flag = { name: FlagName; value: string; threshold: string; window: string };
export type Verdict = "ok" | "watch" | "alert" | "unavailable";
export type RiskReport = { vaultId: string; flags: Flag[]; score: number; verdict: Verdict; evidence: { source: string; block: string; timestamp: string; ageSeconds: string }[] };

const WINDOWS: { name: FlagName; min: number; max: number; threshold: number; weight: number; label: string }[] = [
  { name: "share_price_drawdown_1h", min: 3600, max: 7200, threshold: 0.005, weight: 30, label: "1h" },
  { name: "share_price_drawdown_24h", min: 3600 * 20, max: 3600 * 30, threshold: 0.02, weight: 25, label: "24h" },
  { name: "share_price_drawdown_7d", min: 86400 * 6, max: 86400 * 8, threshold: 0.05, weight: 20, label: "7d" },
];
const num = (s: string | null | undefined) => (s == null ? null : Number(s));
const fmt = (n: number) => n.toFixed(6);

export function computeRisk(v: UnifiedVault, nowTs: number): RiskReport {
  const evidence = v.sources.map(s => ({ source: `${s.kind}:${s.ref}`, block: s.block, timestamp: s.timestamp, ageSeconds: s.ageSeconds }));
  const flags: Flag[] = [];
  if (v.freshness !== "fresh") {
    flags.push({ name: "stale_data", value: v.freshness, threshold: "fresh", window: "now" });
    return { vaultId: v.id, flags, score: 0, verdict: "unavailable", evidence };
  }
  const cur = num(v.sharePrice)!;
  let score = 0;
  for (const w of WINDOWS) {
    const pts = v.history.filter(h => { const age = nowTs - Number(h.timestamp); return age >= w.min && age <= w.max; });
    if (!pts.length) continue;
    const ref = num(pts.sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0].sharePrice)!;
    const drop = (ref - cur) / ref;
    if (drop >= w.threshold) { flags.push({ name: w.name, value: fmt(drop), threshold: fmt(w.threshold), window: w.label }); score += w.weight; }
  }
  const bal = num(v.inputTokenBalance);
  const flows = v.history.filter(h => nowTs - Number(h.timestamp) <= 86400 && h.netFlowAssets != null).map(h => Number(h.netFlowAssets));
  if (bal && flows.length) {
    const out = -flows.reduce((a, b) => a + b, 0) / bal;
    if (out >= 0.2) { flags.push({ name: "tvl_outflow_24h", value: fmt(out), threshold: "0.200000", window: "24h" }); score += 25; }
  }
  const lim = num(v.depositLimit);
  if (lim && bal != null && bal >= lim) { flags.push({ name: "deposit_limit_reached", value: v.inputTokenBalance!, threshold: v.depositLimit!, window: "now" }); score += 10; }
  score = Math.min(100, score);
  const verdict: Verdict = score >= 50 ? "alert" : score >= 20 ? "watch" : "ok";
  return { vaultId: v.id, flags, score, verdict, evidence };
}
```

- [ ] **Step 4: Run, expect 6 pass. Commit**, `git add -A && git commit -m "feat(core): risk engine with unavailable-on-stale rule"`

### Task 8: Pricing

**Files:**
- Create: `packages/core/src/pricing.ts`, `packages/core/test/pricing.test.ts`

**Interfaces:**
- Produces: `hederaScanPriceUsd(count: number): string` (e.g. `"0.0035"` for 5), `hederaScanPriceAtomic(count): string` (USDC 6 decimals, e.g. `"3500"`), `arcBucket(count): "s" | "m" | "l"`, `ARC_BUCKET_PRICE = { s: "0.003", m: "0.01", l: "0.05" }`, `TABLE_PRICE_USD = "0.03"`, `MAX_SCAN = 100`, `clampCount(raw: unknown): number | null` (integer 1..100 else null).

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from "bun:test";
import { ARC_BUCKET_PRICE, arcBucket, clampCount, hederaScanPriceAtomic, hederaScanPriceUsd } from "../src/pricing";
test("hedera price is 0.001 + 0.0005n", () => {
  expect(hederaScanPriceUsd(1)).toBe("0.0015"); expect(hederaScanPriceUsd(20)).toBe("0.011");
  expect(hederaScanPriceAtomic(1)).toBe("1500"); expect(hederaScanPriceAtomic(20)).toBe("11000");
});
test("arc buckets", () => {
  expect(arcBucket(1)).toBe("s"); expect(arcBucket(5)).toBe("s"); expect(arcBucket(6)).toBe("m"); expect(arcBucket(20)).toBe("m"); expect(arcBucket(21)).toBe("l");
  expect(ARC_BUCKET_PRICE.l).toBe("0.05");
});
test("clampCount", () => {
  expect(clampCount("3")).toBe(3); expect(clampCount(0)).toBeNull(); expect(clampCount("101")).toBeNull(); expect(clampCount("x")).toBeNull();
});
```

- [ ] **Step 2: Implement**

```ts
export const MAX_SCAN = 100;
export const TABLE_PRICE_USD = "0.03";
export const ARC_BUCKET_PRICE = { s: "0.003", m: "0.01", l: "0.05" } as const;
export function clampCount(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_SCAN ? n : null;
}
export function hederaScanPriceAtomic(count: number): string { return String(1000 + 500 * count); }
export function hederaScanPriceUsd(count: number): string {
  const atomic = 1000 + 500 * count; return (atomic / 1e6).toString();
}
export const arcBucket = (count: number): "s" | "m" | "l" => (count <= 5 ? "s" : count <= 20 ? "m" : "l");
```

- [ ] **Step 3: Run, expect pass. Commit**, `git add -A && git commit -m "feat(core): metered pricing for Hedera and bucketed Arc routes"`

### Task 9: Standardized subgraph layer and deployment verification gate

**Files:**
- Create: `packages/core/src/standardized/deployments.json`, `packages/core/src/standardized/templates.ts`, `packages/core/src/standardized/gateway.ts`, `packages/core/src/standardized/map.ts`, `packages/core/test/standardized-map.test.ts`, `packages/core/test/fixtures/yield-vaults.json`, `packages/core/test/fixtures/lending-markets.json`, `scripts/verify-deployments.ts`

**Interfaces:**
- Produces: `type Deployment = { protocol: string; chain: string; chainId: string; schema: "yield-aggregator" | "lending"; subgraphId: string; deploymentId: string | null; status: "live" | "stale" | "down" | "unverified"; headLagSeconds: number | null; verifiedAt: string | null }`; `DEPLOYMENTS: Deployment[]` (from JSON); `queryDeployment<T>(d: Deployment, query: string, apiKey: string, variables?): Promise<{ data: T; meta: { block: string; timestamp: string; hasIndexingErrors: boolean } }>`; `YIELD_VAULTS_QUERY`, `LENDING_MARKETS_QUERY` (strings, both selecting `_meta`); `mapYieldVaults(d, data, headTs): UnifiedVault[]`, `mapLendingMarkets(d, data, headTs): UnifiedVault[]`; `fetchStandardized(deployments, apiKey, heads: Record<chainId, number>, fetchImpl?): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>` where a failing deployment yields zero vaults but is recorded as a `down` source.

- [ ] **Step 1: Registry JSON**

Start with these entries (subgraph IDs from Messari's manifest; `deploymentId` filled by the verify script):

```json
[
  { "protocol": "aave-v3", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "aave-v3", "chain": "base", "chainId": "8453", "schema": "lending", "subgraphId": "D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "compound-v3", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "spark", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "morpho-aave-v3", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "FKe6ANnWmGPE6hajGLoTgPrVF2jYPHiRu2Jwcg9ZmG9A", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "euler", "chain": "ethereum", "chainId": "1", "schema": "lending", "subgraphId": "95nyAWFFaiz6gykko3HtBCyhRuP5vZzuKYsZiLxHxLhr", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "yearn-v2", "chain": "ethereum", "chainId": "1", "schema": "yield-aggregator", "subgraphId": "FDLuaz69DbMADuBjJDEcLnTuPnjhZqNbFVrkNiBLGkEg", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null },
  { "protocol": "yearn-v2", "chain": "arbitrum", "chainId": "42161", "schema": "yield-aggregator", "subgraphId": "G3JZhmKKHC4mydRzD6kSz5fCWve5WDYYCyTFSJyv3SD5", "deploymentId": null, "status": "unverified", "headLagSeconds": null, "verifiedAt": null }
]
```

Add more yield-aggregator entries (Convex, Aura, Arrakis, Gamma) by looking up their network subgraph IDs in `https://github.com/messari/subgraphs/blob/master/deployment/deployment.json` (search the protocol name, take `services.decentralized-network.query-id`). Skip any without a network ID.

- [ ] **Step 2: Templates** (confirm field names with introspection in Step 5; adjust only if the gateway rejects a field)

```ts
export const META = `_meta { block { number timestamp } hasIndexingErrors }`;
export const YIELD_VAULTS_QUERY = `query($first: Int!) { ${META}
  vaults(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id name inputToken { id symbol decimals } outputToken { id symbol }
    pricePerShare outputTokenPriceUSD totalValueLockedUSD inputTokenBalance outputTokenSupply depositLimit
    hourlySnapshots: hourlySnapshots(first: 24, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp pricePerShare totalValueLockedUSD inputTokenBalance }
    dailySnapshots: dailySnapshots(first: 8, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp pricePerShare totalValueLockedUSD inputTokenBalance }
  } }`;
export const LENDING_MARKETS_QUERY = `query($first: Int!) { ${META}
  markets(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id name inputToken { id symbol decimals } outputToken { id symbol }
    exchangeRate totalValueLockedUSD totalDepositBalanceUSD totalBorrowBalanceUSD inputTokenBalance
    hourlySnapshots(first: 24, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp exchangeRate totalValueLockedUSD totalDepositBalanceUSD hourlyDepositUSD hourlyWithdrawUSD }
    dailySnapshots(first: 8, orderBy: timestamp, orderDirection: desc) { blockNumber timestamp exchangeRate totalValueLockedUSD totalDepositBalanceUSD dailyDepositUSD dailyWithdrawUSD }
  } }`;
```

If `hourlySnapshots`/`dailySnapshots` are not fields on `Vault`/`Market` in the introspected schema, replace with top-level queries `vaultHourlySnapshots(where: { vault_in: $ids }, ...)` and group by vault id in the mapper.

- [ ] **Step 3: Gateway client**

```ts
import type { Deployment } from "./types";
export type Meta = { block: string; timestamp: string; hasIndexingErrors: boolean };
export function gatewayUrl(d: Deployment): string {
  return d.deploymentId ? `https://gateway.thegraph.com/api/deployments/id/${d.deploymentId}` : `https://gateway.thegraph.com/api/subgraphs/id/${d.subgraphId}`;
}
export async function queryDeployment<T>(d: Deployment, query: string, apiKey: string, variables: Record<string, unknown> = { first: 50 }, fetchImpl: typeof fetch = fetch, timeoutMs = 20000): Promise<{ data: T; meta: Meta }> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(gatewayUrl(d), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query, variables }), signal: ctl.signal });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const j = (await res.json()) as { data?: T & { _meta: { block: { number: number; timestamp: number }; hasIndexingErrors: boolean } }; errors?: { message: string }[] };
    if (j.errors?.length || !j.data) throw new Error(`graphql: ${j.errors?.map(e => e.message).join("; ") ?? "no data"}`);
    const m = j.data._meta;
    return { data: j.data, meta: { block: String(m.block.number), timestamp: String(m.block.timestamp), hasIndexingErrors: m.hasIndexingErrors } };
  } finally { clearTimeout(t); }
}
```

Put `Deployment` in `packages/core/src/standardized/types.ts` and load JSON in `registry.ts`: `export const DEPLOYMENTS = deployments as Deployment[];`.

- [ ] **Step 4: Failing mapper tests with fixtures**

Create `test/fixtures/yield-vaults.json` with one vault (id `0xabc...`, `pricePerShare: "1.05"`, two hourly snapshots and two daily snapshots) and `_meta`; `lending-markets.json` similarly with `exchangeRate`. Test:

```ts
import { expect, test } from "bun:test";
import yieldFx from "./fixtures/yield-vaults.json";
import lendFx from "./fixtures/lending-markets.json";
import { mapLendingMarkets, mapYieldVaults } from "../src/standardized/map";
const d = (schema: "yield-aggregator" | "lending") => ({ protocol: "p", chain: "ethereum", chainId: "1", schema, subgraphId: "S", deploymentId: "Qm1", status: "live" as const, headLagSeconds: 0, verifiedAt: null });
test("yield vault maps to UnifiedVault with history and source", () => {
  const [v] = mapYieldVaults(d("yield-aggregator"), yieldFx, Number(yieldFx._meta.block.timestamp) + 10);
  expect(v.kind).toBe("yield-vault"); expect(v.sharePrice).toBe("1.05"); expect(v.id).toMatch(/^1:0x/);
  expect(v.history.length).toBe(4); expect(v.sources[0]).toMatchObject({ kind: "messari", ref: "Qm1", freshness: "fresh" });
});
test("lending market uses exchangeRate and net flow from withdraw−deposit", () => {
  const [m] = mapLendingMarkets(d("lending"), lendFx, Number(lendFx._meta.block.timestamp) + 10);
  expect(m.kind).toBe("lending-market"); expect(m.sharePrice).toBe(lendFx.markets[0].exchangeRate);
  expect(m.history[0].netFlowAssets).not.toBeNull();
});
```

- [ ] **Step 5: Implement `map.ts`**

```ts
import type { Deployment } from "./types";
import type { HistoryPoint, Source, UnifiedVault } from "../unify/types";
import { classifyFreshness, vaultFreshness } from "../unify/freshness";
type Meta = { block: { number: number | string; timestamp: number | string }; hasIndexingErrors: boolean };
const s = (x: unknown) => (x == null ? null : String(x));
function source(d: Deployment, meta: Meta, headTs: number): Source {
  const ts = Number(meta.block.timestamp);
  return { kind: "messari", ref: d.deploymentId ?? d.subgraphId, block: String(meta.block.number), timestamp: String(ts), ageSeconds: String(Math.max(0, headTs - ts)), freshness: classifyFreshness("messari", ts, headTs, meta.hasIndexingErrors) };
}
export function mapYieldVaults(d: Deployment, data: any, headTs: number): UnifiedVault[] {
  const src = source(d, data._meta, headTs);
  return (data.vaults ?? []).map((v: any): UnifiedVault => {
    const pts = [...(v.hourlySnapshots ?? []), ...(v.dailySnapshots ?? [])];
    const history: HistoryPoint[] = pts.map((h: any, i: number, arr: any[]) => {
      const prev = arr[i + 1];
      const flow = prev && h.inputTokenBalance != null && prev.inputTokenBalance != null ? String(BigInt(h.inputTokenBalance) - BigInt(prev.inputTokenBalance)) : null;
      return { block: String(h.blockNumber), timestamp: String(h.timestamp), sharePrice: String(h.pricePerShare ?? v.pricePerShare), tvlUsd: s(h.totalValueLockedUSD), netFlowAssets: flow };
    });
    return { id: `${d.chainId}:${String(v.id).toLowerCase()}`, kind: "yield-vault", protocol: d.protocol, chain: d.chain, chainId: d.chainId,
      asset: v.inputToken ? { symbol: v.inputToken.symbol, decimals: Number(v.inputToken.decimals) } : null,
      sharePrice: String(v.pricePerShare ?? "1"), tvlUsd: s(v.totalValueLockedUSD), inputTokenBalance: s(v.inputTokenBalance), depositLimit: s(v.depositLimit),
      history, sources: [src], freshness: vaultFreshness([src]) };
  });
}
export function mapLendingMarkets(d: Deployment, data: any, headTs: number): UnifiedVault[] {
  const src = source(d, data._meta, headTs);
  return (data.markets ?? []).map((m: any): UnifiedVault => {
    const pts = [...(m.hourlySnapshots ?? []), ...(m.dailySnapshots ?? [])];
    const history: HistoryPoint[] = pts.map((h: any) => {
      const dep = Number(h.hourlyDepositUSD ?? h.dailyDepositUSD ?? 0), wd = Number(h.hourlyWithdrawUSD ?? h.dailyWithdrawUSD ?? 0);
      return { block: String(h.blockNumber), timestamp: String(h.timestamp), sharePrice: String(h.exchangeRate ?? m.exchangeRate ?? "1"), tvlUsd: s(h.totalValueLockedUSD), netFlowAssets: (dep - wd).toFixed(2) };
    });
    return { id: `${d.chainId}:${String(m.id).toLowerCase()}`, kind: "lending-market", protocol: d.protocol, chain: d.chain, chainId: d.chainId,
      asset: m.inputToken ? { symbol: m.inputToken.symbol, decimals: Number(m.inputToken.decimals) } : null,
      sharePrice: String(m.exchangeRate ?? "1"), tvlUsd: s(m.totalValueLockedUSD), inputTokenBalance: s(m.totalDepositBalanceUSD), depositLimit: null,
      history, sources: [src], freshness: vaultFreshness([src]) };
  });
}
```

Note for lending: `inputTokenBalance` is set to `totalDepositBalanceUSD` and net flow is in USD so the outflow ratio stays consistent (USD/USD).

Then `fetchStandardized` in `standardized/index.ts`: for each deployment with `status !== "down"`, pick the query by schema, call `queryDeployment`, map, collect `SourceRef`s; on error push a source ref with `block: "0"` and mark nothing (vaults empty) but include `{ ref, chainId, block: "0", timestamp: "0" }` in `sources` and log the error message without the body.

- [ ] **Step 6: Verification gate script `scripts/verify-deployments.ts`**

```ts
import { DEPLOYMENTS } from "../packages/core/src/standardized/registry";
import { queryDeployment } from "../packages/core/src/standardized/gateway";
import { writeFileSync } from "node:fs";
const key = process.env.GRAPH_STUDIO_API_KEY!; if (!key) throw new Error("GRAPH_STUDIO_API_KEY missing");
const Q = `{ _meta { block { number timestamp } hasIndexingErrors deployment } }`;
const now = Math.floor(Date.now() / 1000);
const out = [];
for (const d of DEPLOYMENTS) {
  try {
    const { meta, data } = await queryDeployment<{ _meta: { deployment: string } }>(d, Q, key, {});
    const lag = now - Number(meta.timestamp);
    out.push({ ...d, deploymentId: data._meta.deployment, headLagSeconds: lag, status: meta.hasIndexingErrors ? "down" : lag <= 3600 ? "live" : "stale", verifiedAt: String(now) });
    console.log(`${d.protocol}/${d.chain}: ${out.at(-1)!.status} lag=${lag}s deployment=${data._meta.deployment}`);
  } catch (e) { out.push({ ...d, status: "down", headLagSeconds: null, verifiedAt: String(now) }); console.log(`${d.protocol}/${d.chain}: down (${(e as Error).message})`); }
}
writeFileSync("packages/core/src/standardized/deployments.json", JSON.stringify(out, null, 2) + "\n");
console.log(`live: ${out.filter(x => x.status === "live").length} / ${out.length}`);
```

Run: `GRAPH_STUDIO_API_KEY=... bun run verify-deployments`. Record the live count in `docs/verification-log.md` with the date. Note: `_meta.deployment` returns the `Qm...` deployment hash; subsequent queries pin it.

- [ ] **Step 7: Run unit tests (offline), expect pass. Commit**, `git add -A && git commit -m "feat(core): Messari standardized query layer, mappers, deployment verification gate"`

### Task 10: Substreams sink reader

**Files:**
- Create: `packages/core/src/substreams/reader.ts`, `packages/core/test/reader.test.ts`

**Interfaces:**
- Produces: `type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: any[] }>`; `readErc4626Vaults(q: SqlQuery, chainId: string, vaults: string[] | null, headTs: number): Promise<UnifiedVault[]>`; `readSinkCursorBlock(q, chainId): Promise<{ block: string; timestamp: string } | null>`; `makePgQuery(databaseUrl): SqlQuery` (uses `pg.Pool`).
- Tables (Task 13 defines them): `vault_latest(chain_id, vault, block, timestamp, share_price, total_assets, total_supply, net_deposited_assets, depositor_count, last_event_block)`, `vault_metrics(chain_id, vault, block, timestamp, share_price, net_flow_assets, total_assets)`, `vault_meta(chain_id, vault, asset, asset_symbol, asset_decimals, share_decimals)`, plus the sink's own `cursors(id, cursor, block_num, block_id)` table.

- [ ] **Step 1: Failing test with a fake query**

```ts
import { expect, test } from "bun:test";
import { readErc4626Vaults } from "../src/substreams/reader";
const now = 1_760_000_000;
const fake = async (text: string) => {
  if (text.includes("FROM cursors")) return { rows: [{ block_num: "1000", timestamp: String(now - 60) }] };
  if (text.includes("FROM vault_latest")) return { rows: [{ chain_id: "1", vault: "0xabc", block: "990", timestamp: String(now - 100), share_price: "1.02", total_assets: "5000", total_supply: "4900", net_deposited_assets: "4000", depositor_count: "12", last_event_block: "990", asset_symbol: "USDC", asset_decimals: "6" }] };
  if (text.includes("FROM vault_metrics")) return { rows: [{ block: "900", timestamp: String(now - 4000), share_price: "1.01", net_flow_assets: "-100", total_assets: "5100" }] };
  return { rows: [] };
};
test("reader builds erc4626 UnifiedVault with substreams source from cursor", async () => {
  const [v] = await readErc4626Vaults(fake, "1", ["0xabc"], now);
  expect(v.kind).toBe("erc4626"); expect(v.id).toBe("1:0xabc"); expect(v.sharePrice).toBe("1.02");
  expect(v.sources[0]).toMatchObject({ kind: "substreams", block: "1000", freshness: "fresh" });
  expect(v.history[0].netFlowAssets).toBe("-100"); expect(v.asset).toEqual({ symbol: "USDC", decimals: 6 });
});
```

- [ ] **Step 2: Implement**

```ts
import { Pool } from "pg";
import type { HistoryPoint, Source, UnifiedVault } from "../unify/types";
import { classifyFreshness, vaultFreshness } from "../unify/freshness";
export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: any[] }>;
export const SINK_REF = "substreams:erc4626-vault-metrics";
export function makePgQuery(databaseUrl: string): SqlQuery { const pool = new Pool({ connectionString: databaseUrl, max: 4 }); return (text, params) => pool.query(text, params); }
export async function readSinkCursorBlock(q: SqlQuery, chainId: string) {
  const { rows } = await q(`SELECT c.block_num, m.timestamp FROM cursors c LEFT JOIN LATERAL (SELECT timestamp FROM vault_metrics WHERE chain_id=$1 ORDER BY block DESC LIMIT 1) m ON true WHERE c.id LIKE $2 LIMIT 1`, [chainId, `%${chainId}%`]);
  return rows[0] ? { block: String(rows[0].block_num), timestamp: String(rows[0].timestamp) } : null;
}
export async function readErc4626Vaults(q: SqlQuery, chainId: string, vaults: string[] | null, headTs: number): Promise<UnifiedVault[]> {
  const cur = await readSinkCursorBlock(q, chainId);
  const src: Source = cur
    ? { kind: "substreams", ref: "erc4626-vault-metrics", block: cur.block, timestamp: cur.timestamp, ageSeconds: String(Math.max(0, headTs - Number(cur.timestamp))), freshness: classifyFreshness("substreams", Number(cur.timestamp), headTs) }
    : { kind: "substreams", ref: "erc4626-vault-metrics", block: "0", timestamp: "0", ageSeconds: String(headTs), freshness: "unavailable" };
  const { rows } = await q(`SELECT l.*, m.asset_symbol, m.asset_decimals FROM vault_latest l LEFT JOIN vault_meta m ON m.chain_id=l.chain_id AND m.vault=l.vault WHERE l.chain_id=$1 ${vaults ? "AND l.vault = ANY($2)" : ""} ORDER BY l.total_assets DESC NULLS LAST LIMIT 100`, vaults ? [chainId, vaults.map(v => v.toLowerCase())] : [chainId]);
  const out: UnifiedVault[] = [];
  for (const r of rows) {
    const h = await q(`SELECT block, timestamp, share_price, net_flow_assets, total_assets FROM vault_metrics WHERE chain_id=$1 AND vault=$2 AND timestamp >= $3 ORDER BY block DESC LIMIT 500`, [chainId, r.vault, String(headTs - 8 * 86400)]);
    const history: HistoryPoint[] = h.rows.map((x: any) => ({ block: String(x.block), timestamp: String(x.timestamp), sharePrice: String(x.share_price), tvlUsd: null, netFlowAssets: x.net_flow_assets == null ? null : String(x.net_flow_assets) }));
    out.push({ id: `${chainId}:${String(r.vault).toLowerCase()}`, kind: "erc4626", protocol: "erc4626", chain: chainId === "1" ? "ethereum" : chainId === "8453" ? "base" : chainId, chainId,
      asset: r.asset_symbol ? { symbol: r.asset_symbol, decimals: Number(r.asset_decimals) } : null,
      sharePrice: String(r.share_price), tvlUsd: null, inputTokenBalance: r.total_assets == null ? null : String(r.total_assets), depositLimit: null,
      history, sources: [src], freshness: vaultFreshness([src]) });
  }
  return out;
}
```

The cursor table name and columns come from `substreams-sink-sql` (`cursors` with `id`, `cursor`, `block_num`, `block_id`); confirm after Task 13 with `\d cursors` and adjust the query if the sink version differs.

- [ ] **Step 3: Run, expect pass. Export everything from `packages/core/src/index.ts`. Commit**, `git add -A && git commit -m "feat(core): Substreams sink reader with cursor-based freshness"`

### Task 11: Substreams module, scaffold and `map_vault_events`

**Files:**
- Create: `substreams/erc4626-vault-metrics/{Cargo.toml,substreams.yaml,build.rs,rust-toolchain.toml,proto/vaultradar/v1/vault.proto,abi/erc4626.json,src/lib.rs,src/pb/mod.rs}`; `docs/one-prompt.md`

**Interfaces:**
- Produces: module `map_vault_events` (input `erc4626:map_events` + `sf.ethereum.type.v2.Block`; output `proto:vaultradar.v1.VaultEvents`) with `VaultEvent { vault: string(hex), block: u64, timestamp: u64, kind: "deposit"|"withdraw", sender, owner, assets: string, shares: string, implied_share_price: string, tx_hash: string, log_index: u32 }`.

- [ ] **Step 1: Install tooling**

```bash
brew install streamingfast/tap/substreams   # or: curl -L https://github.com/streamingfast/substreams/releases/latest/download/substreams_darwin_arm64.tar.gz | tar xz && mv substreams ~/.cargo/bin/
rustup target add wasm32-unknown-unknown
substreams --version
```

Get a Substreams API token from https://thegraph.market (Substreams → API key) and export `SUBSTREAMS_API_TOKEN`. Endpoints: Ethereum `mainnet.eth.streamingfast.io:443`, Base `base-mainnet.streamingfast.io:443` (confirm both on the Market page).

- [ ] **Step 2: One-prompt attempt (recorded, optional but cheap)**

Install the skills once: `claude plugin marketplace add streamingfast/substreams-skills && claude plugin install substreams-dev@streamingfast-substreams`. In a fresh Claude Code session inside `substreams/`, give exactly one prompt (save it to `docs/one-prompt.md`): "Create a Substreams package `erc4626-vault-metrics` for Ethereum mainnet that imports the Pinax erc4626 package from https://github.com/pinax-network/substreams-evm/raw/main/spkg/erc4626-v0.1.0.spkg, maps its Deposit and Withdraw events to a VaultEvent proto with implied share price = assets/shares, and emits a SQL sink `db_out` with a `vault_events` table." Commit whatever it produces as `chore(substreams): one-prompt generation (unreviewed)` and record the screen. Then continue with the steps below on top of it, fixing as needed. If the skills are not installed within 10 minutes, skip this step.

- [ ] **Step 3: Manifest and Cargo**

`substreams.yaml`:

```yaml
specVersion: v0.1.0
package:
  name: erc4626_vault_metrics
  version: v0.1.0
  url: https://github.com/<you>/vaultradar
  doc: ERC-4626 vault share price, flows and depositor metrics composed from the Pinax erc4626 events package.
imports:
  erc4626: https://github.com/pinax-network/substreams-evm/raw/main/spkg/erc4626-v0.1.0.spkg
  sql: https://github.com/streamingfast/substreams-sink-sql/releases/download/protodefs-v1.0.7/substreams-sink-sql-protodefs-v1.0.7.spkg
protobuf:
  files: [vaultradar/v1/vault.proto]
  importPaths: [./proto]
binaries:
  default:
    type: wasm/rust-v1
    file: ./target/wasm32-unknown-unknown/release/erc4626_vault_metrics.wasm
network: mainnet
modules:
  - name: map_vault_events
    kind: map
    initialBlock: 23300000
    inputs:
      - source: sf.ethereum.type.v2.Block
      - map: erc4626:map_events
    output:
      type: proto:vaultradar.v1.VaultEvents
```

`initialBlock`: set to (current Ethereum head - 200000) at the time you run this; for Base use a second manifest `substreams.base.yaml` with `network: base` and `initialBlock` = head - 1200000.

`Cargo.toml`:

```toml
[package]
name = "erc4626_vault_metrics"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib"]
[dependencies]
substreams = "0.6"
substreams-ethereum = "0.10"
prost = "0.13"
prost-types = "0.13"
hex = "0.4"
num-bigint = "0.4"
num-traits = "0.2"
[build-dependencies]
substreams-ethereum = "0.10"
[profile.release]
lto = true
opt-level = "s"
strip = "debuginfo"
```

`build.rs`: `fn main() { substreams_ethereum::Abigen::new("ERC4626", "abi/erc4626.json").unwrap().generate().unwrap().write_to_file("src/abi/erc4626.rs").unwrap(); }`

`abi/erc4626.json` (minimal):

```json
[
 {"type":"function","name":"asset","inputs":[],"outputs":[{"name":"","type":"address"}],"stateMutability":"view"},
 {"type":"function","name":"totalAssets","inputs":[],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
 {"type":"function","name":"totalSupply","inputs":[],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
 {"type":"function","name":"decimals","inputs":[],"outputs":[{"name":"","type":"uint8"}],"stateMutability":"view"},
 {"type":"function","name":"symbol","inputs":[],"outputs":[{"name":"","type":"string"}],"stateMutability":"view"}
]
```

`proto/vaultradar/v1/vault.proto`:

```proto
syntax = "proto3";
package vaultradar.v1;
message VaultEvents { repeated VaultEvent events = 1; }
message VaultEvent {
  string vault = 1; uint64 block = 2; uint64 timestamp = 3; string kind = 4;
  string sender = 5; string owner = 6; string assets = 7; string shares = 8;
  string implied_share_price = 9; string tx_hash = 10; uint32 log_index = 11;
}
message VaultMetricsList { repeated VaultMetrics metrics = 1; }
message VaultMetrics {
  string vault = 1; uint64 block = 2; uint64 timestamp = 3; string share_price = 4; string share_price_source = 5;
  string total_assets = 6; string total_supply = 7; string net_deposited_assets = 8; string net_flow_assets = 9;
  uint64 depositor_count = 10; uint64 last_event_block = 11;
}
message VaultMeta { string vault = 1; string asset = 2; string asset_symbol = 3; uint32 asset_decimals = 4; uint32 share_decimals = 5; }
message NewDepositors { repeated string keys = 1; }
```

- [ ] **Step 4: Generate protobuf bindings**

Run: `substreams protogen substreams.yaml --exclude-paths="sf/substreams,google"` → writes `src/pb/...` including `erc4626.v1` (Pinax) and `vaultradar.v1`. Add `src/pb/mod.rs` as generated. Add `mod abi;` with `pub mod erc4626;` in `src/abi/mod.rs`.

- [ ] **Step 5: `map_vault_events`**

`src/lib.rs`:

```rust
mod abi; mod pb;
use pb::erc4626::v1::{Events, log::Log as PinaxLog};
use pb::vaultradar::v1::{VaultEvent, VaultEvents};
use substreams_ethereum::pb::eth::v2::Block;
use num_bigint::BigUint; use num_traits::Zero;

fn hex0x(b: &[u8]) -> String { format!("0x{}", hex::encode(b)) }
/// assets/shares as a decimal string with 18 fractional digits; "0" when shares is zero.
fn ratio(assets: &str, shares: &str) -> String {
    let a = assets.parse::<BigUint>().unwrap_or_default(); let s = shares.parse::<BigUint>().unwrap_or_default();
    if s.is_zero() { return "0".into(); }
    let scaled = a * BigUint::from(10u128.pow(18)) / s;
    let t = scaled.to_string();
    if t.len() <= 18 { format!("0.{}{}", "0".repeat(18 - t.len()), t) } else { let (i, f) = t.split_at(t.len() - 18); format!("{i}.{f}") }
}

#[substreams::handlers::map]
fn map_vault_events(block: Block, events: Events) -> Result<VaultEvents, substreams::errors::Error> {
    let ts = block.timestamp_seconds(); let mut out = vec![];
    for tx in events.transactions {
        for log in tx.logs {
            let (kind, sender, owner, assets, shares) = match log.log {
                Some(PinaxLog::Deposit(d)) => ("deposit", d.sender, d.owner, d.assets, d.shares),
                Some(PinaxLog::Withdraw(w)) => ("withdraw", w.sender, w.owner, w.assets, w.shares),
                None => continue,
            };
            out.push(VaultEvent { vault: hex0x(&log.address), block: block.number, timestamp: ts, kind: kind.into(),
                sender: hex0x(&sender), owner: hex0x(&owner), implied_share_price: ratio(&assets, &shares),
                assets, shares, tx_hash: hex0x(&tx.hash), log_index: log.block_index });
        }
    }
    Ok(VaultEvents { events: out })
}
```

- [ ] **Step 6: Build and run against The Graph Market**

```bash
cargo build --target wasm32-unknown-unknown --release
substreams run -e mainnet.eth.streamingfast.io:443 substreams.yaml map_vault_events -s 23300000 -t +50
```

Expected: JSON output with events whose `implied_share_price` is near 1.0 for stable vaults. If the Pinax import fails to resolve, download the spkg to `deps/erc4626-v0.1.0.spkg` and reference it by relative path.

- [ ] **Step 7: Commit**, `git add -A && git commit -m "feat(substreams): erc4626-vault-metrics scaffold with map_vault_events composed from Pinax erc4626"`

### Task 12: Substreams module, stores, eth_call refresh, `map_vault_metrics`

**Files:**
- Modify: `substreams/erc4626-vault-metrics/{substreams.yaml,src/lib.rs}`

**Interfaces:**
- Produces: modules `store_vault_meta` (set-if-not-exists, key `meta:<vault>`, value proto `VaultMeta`), `store_depositor_seen` (set-if-not-exists, key `<vault>:<owner>`), `map_new_depositors` (deltas of `store_depositor_seen` → `NewDepositors{keys}`), `store_depositor_count` (add int64, key `<vault>`), `store_vault_flows` (add bigint, keys `dep:<vault>`, `wd:<vault>`), `store_last_call` (set, key `<vault>` → `<block>|<total_assets>|<total_supply>|<share_price>`), `map_vault_metrics` (output `VaultMetricsList`).

- [ ] **Step 1: Manifest additions**

```yaml
  - name: store_vault_meta
    kind: store
    updatePolicy: set_if_not_exists
    valueType: proto:vaultradar.v1.VaultMeta
    inputs: [{ map: map_vault_events }]
  - name: store_depositor_seen
    kind: store
    updatePolicy: set_if_not_exists
    valueType: string
    inputs: [{ map: map_vault_events }]
  - name: map_new_depositors
    kind: map
    inputs: [{ store: store_depositor_seen, mode: deltas }]
    output: { type: proto:vaultradar.v1.NewDepositors }
  - name: store_depositor_count
    kind: store
    updatePolicy: add
    valueType: int64
    inputs: [{ map: map_new_depositors }]
  - name: store_vault_flows
    kind: store
    updatePolicy: add
    valueType: bigint
    inputs: [{ map: map_vault_events }]
  - name: store_last_call
    kind: store
    updatePolicy: set
    valueType: string
    inputs: [{ map: map_vault_events }, { store: store_last_call }]
  - name: map_vault_metrics
    kind: map
    inputs:
      - map: map_vault_events
      - store: store_vault_meta
      - store: store_depositor_count
      - store: store_vault_flows
      - store: store_last_call
    output: { type: proto:vaultradar.v1.VaultMetricsList }
```

- [ ] **Step 2: Store handlers and eth_call**

```rust
use substreams::store::{StoreAddBigInt, StoreAddInt64, StoreGet, StoreGetBigInt, StoreGetInt64, StoreGetProto, StoreGetString, StoreNew, StoreSet, StoreSetIfNotExists, StoreSetIfNotExistsProto, StoreSetIfNotExistsString, StoreSetString, Deltas, DeltaString};
use substreams::scalar::BigInt;
use substreams_ethereum::rpc::RpcBatch;
use pb::vaultradar::v1::{NewDepositors, VaultMeta, VaultMetrics, VaultMetricsList};
use abi::erc4626::functions as f;
const CALL_EVERY: u64 = 300;

fn addr(v: &str) -> Vec<u8> { hex::decode(v.trim_start_matches("0x")).unwrap_or_default() }

#[substreams::handlers::store]
fn store_vault_meta(events: VaultEvents, s: StoreSetIfNotExistsProto<VaultMeta>) {
    let mut seen = std::collections::HashSet::new();
    for e in events.events { if !seen.insert(e.vault.clone()) { continue; }
        let v = addr(&e.vault);
        let r = RpcBatch::new().add(f::Asset {}, v.clone()).add(f::Decimals {}, v.clone()).execute();
        let Ok(r) = r else { continue };
        let asset = RpcBatch::decode::<_, f::Asset>(&r.responses[0]).unwrap_or_default();
        let share_dec = RpcBatch::decode::<_, f::Decimals>(&r.responses[1]).unwrap_or(18u8.into());
        let a = RpcBatch::new().add(f::Symbol {}, asset.clone()).add(f::Decimals {}, asset.clone()).execute();
        let (sym, adec) = match a { Ok(a) => (RpcBatch::decode::<_, f::Symbol>(&a.responses[0]).unwrap_or_default(), RpcBatch::decode::<_, f::Decimals>(&a.responses[1]).unwrap_or(18u8.into())), Err(_) => (String::new(), 18u8.into()) };
        s.set_if_not_exists(0, format!("meta:{}", e.vault), &VaultMeta { vault: e.vault.clone(), asset: hex0x(&asset), asset_symbol: sym, asset_decimals: adec.to_u64() as u32, share_decimals: share_dec.to_u64() as u32 });
    }
}
#[substreams::handlers::store]
fn store_depositor_seen(events: VaultEvents, s: StoreSetIfNotExistsString) {
    for e in events.events.iter().filter(|e| e.kind == "deposit") { s.set_if_not_exists(0, format!("{}:{}", e.vault, e.owner), &"1".to_string()); }
}
#[substreams::handlers::map]
fn map_new_depositors(deltas: Deltas<DeltaString>) -> Result<NewDepositors, substreams::errors::Error> {
    Ok(NewDepositors { keys: deltas.deltas.into_iter().filter(|d| d.operation == substreams::pb::substreams::store_delta::Operation::Create).map(|d| d.key).collect() })
}
#[substreams::handlers::store]
fn store_depositor_count(n: NewDepositors, s: StoreAddInt64) { for k in n.keys { let vault = k.split(':').next().unwrap_or("").to_string(); s.add(0, vault, 1); } }
#[substreams::handlers::store]
fn store_vault_flows(events: VaultEvents, s: StoreAddBigInt) {
    for e in events.events { let amt = BigInt::from_str(&e.assets).unwrap_or(BigInt::zero());
        let key = if e.kind == "deposit" { format!("dep:{}", e.vault) } else { format!("wd:{}", e.vault) }; s.add(0, key, &amt); }
}
#[substreams::handlers::store]
fn store_last_call(events: VaultEvents, prev: StoreGetString, s: StoreSetString) {
    let mut done = std::collections::HashSet::new();
    for e in events.events { if !done.insert(e.vault.clone()) { continue; }
        let last_block = prev.get_last(&e.vault).and_then(|v| v.split('|').next().and_then(|b| b.parse::<u64>().ok())).unwrap_or(0);
        if e.block.saturating_sub(last_block) < CALL_EVERY { continue; }
        let v = addr(&e.vault);
        let Ok(r) = RpcBatch::new().add(f::TotalAssets {}, v.clone()).add(f::TotalSupply {}, v).execute() else { continue };
        let ta = RpcBatch::decode::<_, f::TotalAssets>(&r.responses[0]).unwrap_or_default();
        let tsup = RpcBatch::decode::<_, f::TotalSupply>(&r.responses[1]).unwrap_or_default();
        let price = ratio(&ta.to_string(), &tsup.to_string());
        s.set(0, e.vault.clone(), &format!("{}|{}|{}|{}", e.block, ta, tsup, price));
    }
}
#[substreams::handlers::map]
fn map_vault_metrics(events: VaultEvents, _meta: StoreGetProto<VaultMeta>, counts: StoreGetInt64, flows: StoreGetBigInt, last: StoreGetString) -> Result<VaultMetricsList, substreams::errors::Error> {
    let mut by_vault: std::collections::BTreeMap<String, Vec<&VaultEvent>> = Default::default();
    for e in &events.events { by_vault.entry(e.vault.clone()).or_default().push(e); }
    let mut out = vec![];
    for (vault, evs) in by_vault {
        let dep = flows.get_last(format!("dep:{vault}")).unwrap_or(BigInt::zero()); let wd = flows.get_last(format!("wd:{vault}")).unwrap_or(BigInt::zero());
        let net_flow: BigInt = evs.iter().fold(BigInt::zero(), |acc, e| { let a = BigInt::from_str(&e.assets).unwrap_or(BigInt::zero()); if e.kind == "deposit" { acc + a } else { acc - a } });
        let lc = last.get_last(&vault); let parts: Vec<String> = lc.map(|s| s.split('|').map(String::from).collect()).unwrap_or_default();
        let (src, price, ta, tsup) = if parts.len() == 4 && parts[0].parse::<u64>().unwrap_or(0) == evs[0].block { ("call", parts[3].clone(), parts[1].clone(), parts[2].clone()) } else { ("event", evs.last().unwrap().implied_share_price.clone(), String::new(), String::new()) };
        out.push(VaultMetrics { vault: vault.clone(), block: evs[0].block, timestamp: evs[0].timestamp, share_price: price, share_price_source: src.into(),
            total_assets: ta, total_supply: tsup, net_deposited_assets: (dep - wd).to_string(), net_flow_assets: net_flow.to_string(),
            depositor_count: counts.get_last(&vault).unwrap_or(0) as u64, last_event_block: evs[0].block });
    }
    Ok(VaultMetricsList { metrics: out })
}
```

Compile errors around store trait names are expected on first build: consult `substreams` 0.6 docs (`substreams::store`) and fix the imports; the logic above is the contract.

- [ ] **Step 3: Run**

`substreams run -e mainnet.eth.streamingfast.io:443 substreams.yaml map_vault_metrics -s <initialBlock> -t +400` → metrics with `share_price_source: "call"` appearing for vaults touched after 300 blocks.

- [ ] **Step 4: Commit**, `git add -A && git commit -m "feat(substreams): vault stores, eth_call share-price refresh, map_vault_metrics"`

### Task 13: Substreams module, SQL sink, Neon, publish

**Files:**
- Create: `substreams/erc4626-vault-metrics/schema.sql`, `substreams/erc4626-vault-metrics/README.md`
- Modify: `substreams.yaml` (add `db_out`), `src/lib.rs`

- [ ] **Step 1: schema.sql**

```sql
CREATE TABLE IF NOT EXISTS vault_metrics (
  chain_id TEXT NOT NULL, vault TEXT NOT NULL, block BIGINT NOT NULL, timestamp BIGINT NOT NULL,
  share_price NUMERIC NOT NULL, share_price_source TEXT NOT NULL, total_assets NUMERIC, total_supply NUMERIC,
  net_deposited_assets NUMERIC, net_flow_assets NUMERIC, depositor_count BIGINT, last_event_block BIGINT,
  PRIMARY KEY (chain_id, vault, block));
CREATE TABLE IF NOT EXISTS vault_latest (
  chain_id TEXT NOT NULL, vault TEXT NOT NULL, block BIGINT NOT NULL, timestamp BIGINT NOT NULL,
  share_price NUMERIC NOT NULL, total_assets NUMERIC, total_supply NUMERIC, net_deposited_assets NUMERIC,
  depositor_count BIGINT, last_event_block BIGINT, PRIMARY KEY (chain_id, vault));
CREATE TABLE IF NOT EXISTS vault_meta (
  chain_id TEXT NOT NULL, vault TEXT NOT NULL, asset TEXT, asset_symbol TEXT, asset_decimals INT, share_decimals INT,
  PRIMARY KEY (chain_id, vault));
CREATE INDEX IF NOT EXISTS vault_metrics_ts ON vault_metrics (chain_id, vault, timestamp DESC);
```

- [ ] **Step 2: `db_out` module**

Manifest:

```yaml
  - name: db_out
    kind: map
    inputs:
      - params: string
      - map: map_vault_metrics
      - store: store_vault_meta
        mode: deltas
    output: { type: proto:sf.substreams.sink.database.v1.DatabaseChanges }
params:
  db_out: "1"
sink:
  module: db_out
  type: sf.substreams.sink.sql.v1.Service
  config:
    schema: "./schema.sql"
    engine: postgres
```

Handler (chain id from params):

```rust
use substreams_database_change::pb::database::DatabaseChanges; use substreams_database_change::tables::Tables;
#[substreams::handlers::map]
fn db_out(chain_id: String, m: VaultMetricsList, meta: Deltas<substreams::store::DeltaProto<VaultMeta>>) -> Result<DatabaseChanges, substreams::errors::Error> {
    let mut t = Tables::new();
    for x in m.metrics {
        t.create_row("vault_metrics", [("chain_id", chain_id.clone()), ("vault", x.vault.clone()), ("block", x.block.to_string())])
            .set("timestamp", x.timestamp).set("share_price", &x.share_price).set("share_price_source", &x.share_price_source)
            .set("total_assets", &x.total_assets).set("total_supply", &x.total_supply).set("net_deposited_assets", &x.net_deposited_assets)
            .set("net_flow_assets", &x.net_flow_assets).set("depositor_count", x.depositor_count).set("last_event_block", x.last_event_block);
        t.update_row("vault_latest", [("chain_id", chain_id.clone()), ("vault", x.vault.clone())])
            .set("block", x.block).set("timestamp", x.timestamp).set("share_price", &x.share_price).set("total_assets", &x.total_assets)
            .set("total_supply", &x.total_supply).set("net_deposited_assets", &x.net_deposited_assets).set("depositor_count", x.depositor_count).set("last_event_block", x.last_event_block);
    }
    for d in meta.deltas { let v = d.new_value;
        t.create_row("vault_meta", [("chain_id", chain_id.clone()), ("vault", v.vault.clone())]).set("asset", &v.asset).set("asset_symbol", &v.asset_symbol).set("asset_decimals", v.asset_decimals).set("share_decimals", v.share_decimals); }
    Ok(t.to_database_changes())
}
```

Add `substreams-database-change = "2"` to Cargo. Empty strings for `total_assets`/`total_supply` must be written as NULL: skip `.set` when the string is empty.

- [ ] **Step 3: Sink to Neon**

```bash
brew install streamingfast/tap/substreams-sink-sql
substreams build          # produces erc4626-vault-metrics-v0.1.0.spkg
substreams-sink-sql setup "$DATABASE_URL" ./erc4626-vault-metrics-v0.1.0.spkg
substreams-sink-sql run "$DATABASE_URL" ./erc4626-vault-metrics-v0.1.0.spkg -e mainnet.eth.streamingfast.io:443 --params db_out=1 --final-blocks-only
```

Run Base with the Base manifest and `--params db_out=8453` into the same database. Keep both sinks running on the service host (Task 20 adds them to the Fly machine as background processes, or run them from your laptop for the demo). Verify: `psql "$DATABASE_URL" -c "SELECT chain_id, count(*) FROM vault_latest GROUP BY 1"` and `\d cursors`; adjust Task 10's cursor query if the table differs.

Hosted sink (preferred if it works within 30 minutes): on thegraph.market, Hosted Sinks → New → upload/point at the published package → Postgres → paste the Neon URL → deploy. Either path consumes live data through The Graph Market.

- [ ] **Step 4: Publish**

`substreams registry login` (GitHub) then `substreams registry publish ./erc4626-vault-metrics-v0.1.0.spkg`. Record the substreams.dev URL in `substreams/erc4626-vault-metrics/README.md` with: what the package does, module graph, how it composes Pinax `erc4626`, how to sink it, and the `initialBlock` policy.

- [ ] **Step 5: Commit**, `git add -A && git commit -m "feat(substreams): SQL sink, Neon deployment, package published to substreams.dev"`

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

- [ ] **Step 4: Run, expect pass. Commit**, `git add -A && git commit -m "feat(service): skeleton, seeded keys, signed agent card, UCP and ERC-8004 files, catalog"`

### Task 15: Scan and table handlers with data provider

**Files:**
- Create: `packages/service/src/data/provider.ts`, `packages/service/src/handlers/scan.ts`, `packages/service/test/handlers.test.ts`

**Interfaces:**
- Produces: `interface DataProvider { catalog(): Promise<Catalog>; scan(vaultIds: string[]): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }>; table(protocol: string, chainId: string): Promise<{ vaults: UnifiedVault[]; sources: SourceRef[] }> }`; `class LiveDataProvider implements DataProvider` (constructor `(config, deps?: { fetchImpl?, sql?: SqlQuery | null })`; uses `fetchStandardized` for all live deployments filtered by chain, `readErc4626Vaults` when `sql`, chain head via viem `getBlock({ blockTag: "latest" })` cached 15 s per chain); `makeScanHandler(deps: { keys; config; data; nonces; rail: "hedera" | "arc"; tier: "scan" | "table"; getPayer: (req) => string | null; getTxId: (req, res) => string | null })` returns an Express handler implementing spec §5.4/§5.5: accepts either a sealed envelope (`req.body` passes `isSealed`) or clear `{ vaults }` / `{ protocol, chainId }`; runs checks; computes `reports = vaults.map(v => computeRisk(v, now))`; `attestations` per vault from its first source; `receipt` via `buildReceipt`; sealed response when sealed; sets `res.locals.receipt` for the HCS hook; 60 s cap via `Promise.race` → 504.
- Payment tx id: for the Hedera rail the settlement happens after the handler, so the receipt's `payment.txId` cannot be known inside the handler. Rule: the handler writes `payment: { rail, txId: "pending" }`, and the rail (Task 16) fills `txId` by re-signing? No: receipts must be final when signed. Resolution: the receipt's `payment.txId` is the **payment identifier the payer already committed to**: on Hedera the client-signed transaction id (parsed from the `PAYMENT-SIGNATURE` payload before settlement); on Arc the `req.payment.transaction` when present else the EIP-3009 nonce. Both identify the payment on-chain after settlement. `getTxId` implements this per rail.

- [ ] **Step 1: Failing tests (handler with stub provider, no payment middleware)**

```ts
import { expect, test } from "bun:test";
import express from "express";
import { buildSealedRequest, deriveKemKeys, deriveSigningKeys, MemoryNonceStore, open, verifyReceipt, verifyAttestation, requestHash } from "@vaultradar/core";
import { makeScanHandler } from "../src/handlers/scan";
import { loadConfig } from "../src/config";
const env = { PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "77".repeat(32), PQ_KEM_SEED: "88".repeat(64), GRAPH_STUDIO_API_KEY: "k", HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1", HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), HEDERA_HCS_TOPIC_ID: "0.0.99" };
const config = loadConfig(env); const keys = { sig: deriveSigningKeys(env.PQ_SIG_SEED), kem: deriveKemKeys(env.PQ_KEM_SEED) };
const now = Math.floor(Date.now() / 1000);
const vault = { id: "1:0xabc", kind: "erc4626", protocol: "erc4626", chain: "ethereum", chainId: "1", asset: null, sharePrice: "1.01", tvlUsd: null, inputTokenBalance: "100", depositLimit: null, history: [], sources: [{ kind: "substreams", ref: "erc4626-vault-metrics", block: "10", timestamp: String(now - 5), ageSeconds: "5", freshness: "fresh" }], freshness: "fresh" } as const;
const data = { catalog: async () => ({ protocols: [], erc4626Chains: ["1"] }), scan: async (ids: string[]) => ({ vaults: ids.includes("1:0xabc") ? [vault] : [], sources: [{ ref: "erc4626-vault-metrics", chainId: "1", block: "10", timestamp: String(now - 5) }] }), table: async () => ({ vaults: [vault], sources: [] }) };
const app = express(); app.use(express.json());
app.post("/scan", makeScanHandler({ keys, config, data, nonces: new MemoryNonceStore(), rail: "hedera", tier: "scan", getPayer: () => "0.0.1234", getTxId: () => "0.0.1234@1.000" }));
const srv = app.listen(0); const url = () => `http://127.0.0.1:${(srv.address() as any).port}/scan`;
test("sealed scan returns sealed body and verifiable receipt", async () => {
  const { sealed, replySecret } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.1234", keys.kem.publicKey);
  const res = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify(sealed) });
  expect(res.status).toBe(200); const j = await res.json();
  expect(j.sealed).toBeDefined(); expect(verifyReceipt(j.receipt, keys.sig.publicKey)).toBe(true);
  expect(j.receipt.request_hash).toBe(requestHash({ vaults: ["1:0xabc"] })); expect(j.receipt.sealed).toBe(true);
  const body = open<any>(j.sealed, replySecret); expect(body.vaults[0].id).toBe("1:0xabc"); expect(body.reports[0].verdict).toBe("ok");
  expect(verifyAttestation(body.attestations[0], keys.sig.publicKey)).toBe(true);
});
test("payer mismatch → 422", async () => {
  const { sealed } = buildSealedRequest({ vaults: ["1:0xabc"] }, "0.0.9999", keys.kem.publicKey);
  const res = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify(sealed) });
  expect(res.status).toBe(422); expect((await res.json()).reason).toBe("payer_mismatch");
});
test("clear request works and receipt says sealed:false", async () => {
  const res = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify({ vaults: ["1:0xabc"] }) });
  const j = await res.json(); expect(j.vaults[0].id).toBe("1:0xabc"); expect(j.receipt.sealed).toBe(false);
});
```

- [ ] **Step 2: Implement `handlers/scan.ts`**

```ts
import type { Request, Response } from "express";
import { buildAttestation, buildReceipt, checkSealedRequest, computeRisk, isSealed, openSealedRequest, requestHash, responseHash, seal, fromB64, clampCount, type NonceStore, type ScanRequest, type TableRequest, type SourceRef, hederaScanPriceAtomic, TABLE_PRICE_USD, arcBucket, ARC_BUCKET_PRICE } from "@vaultradar/core";
import type { DataProvider } from "../data/provider"; import type { ServiceKeys } from "../keys"; import type { Config } from "../config";
export type HandlerDeps = { keys: ServiceKeys; config: Config; data: DataProvider; nonces: NonceStore; rail: "hedera" | "arc"; tier: "scan" | "table"; getPayer: (req: Request) => string | null; getTxId: (req: Request, res: Response) => string | null };
const HANDLER_CAP_MS = 60_000;
export function makeScanHandler(d: HandlerDeps) {
  return async (req: Request, res: Response) => {
    const now = Math.floor(Date.now() / 1000);
    const sealedIn = isSealed(req.body);
    let request: ScanRequest | TableRequest; let replyPk: Uint8Array | null = null;
    if (sealedIn) {
      let p; try { p = openSealedRequest<ScanRequest | TableRequest>(req.body, d.keys.kem.secretKey, d.keys.kem.kid); } catch { return res.status(422).json({ reason: "envelope_open_failed" }); }
      const payer = d.getPayer(req); if (!payer) return res.status(422).json({ reason: "payer_unknown" });
      const count = d.tier === "scan" ? clampCount(req.header("x-vr-count")) ?? undefined : undefined;
      const chk = checkSealedRequest(p, { now, payer, count, seen: d.nonces }); if (!chk.ok) return res.status(422).json({ reason: chk.reason });
      request = p.request; replyPk = fromB64(p.reply_pk);
    } else { request = req.body; }
    if (d.tier === "scan") { const v = (request as ScanRequest).vaults; if (!Array.isArray(v) || !v.length || v.length > 100 || !v.every(x => /^\d+:0x[0-9a-f]{40}$/i.test(x))) return res.status(422).json({ reason: "bad_vaults" }); }
    else { const t = request as TableRequest; if (typeof t.protocol !== "string" || typeof t.chainId !== "string") return res.status(422).json({ reason: "bad_table_request" }); }
    const work = d.tier === "scan" ? d.data.scan((request as ScanRequest).vaults.map(x => x.toLowerCase())) : d.data.table((request as TableRequest).protocol, (request as TableRequest).chainId);
    let result; try { result = await Promise.race([work, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("cap")), HANDLER_CAP_MS))]); }
    catch (e) { return res.status((e as Error).message === "cap" ? 504 : 502).json({ reason: (e as Error).message === "cap" ? "handler_cap" : "upstream_failed" }); }
    const reports = result.vaults.map(v => computeRisk(v, now));
    const attestations = result.vaults.map(v => { const s = v.sources[0]; return buildAttestation({ vaultId: v.id, chainId: v.chainId, block: s?.block ?? "0", timestamp: s?.timestamp ?? "0", sharePrice: v.sharePrice, tvlUsd: v.tvlUsd, source: s ? `${s.kind}:${s.ref}` : "none" }, d.keys.sig); });
    const body = { vaults: result.vaults, reports, attestations };
    const count = d.tier === "scan" ? (request as ScanRequest).vaults.length : 0;
    const amount = d.rail === "hedera" ? (d.tier === "scan" ? hederaScanPriceAtomic(count) : String(Math.round(Number(TABLE_PRICE_USD) * 1e6))) : (d.tier === "scan" ? ARC_BUCKET_PRICE[arcBucket(count)] : TABLE_PRICE_USD);
    const receipt = buildReceipt({ service: { erc8004: d.config.erc8004 }, request_hash: requestHash(request), response_hash: responseHash(body), sealed: sealedIn,
      sources: result.sources as SourceRef[], price: { amount, asset: d.rail === "hedera" ? d.config.hedera.usdcToken : "USDC", rail: d.rail },
      payment: { rail: d.rail, txId: d.getTxId(req, res) ?? "unknown" }, tier: d.tier, hcs: { topicId: d.config.hedera.hcsTopicId ?? "" } }, d.keys.sig);
    res.locals.receipt = receipt;
    return res.status(200).json(replyPk ? { sealed: seal(body, replyPk), receipt } : { ...body, receipt });
  };
}
```

- [ ] **Step 3: Implement `data/provider.ts`** with `LiveDataProvider`: `catalog()` from the registry (`status`, count of cached vaults per deployment, refreshed every 5 minutes) plus `erc4626Chains` from `sql ? ["1", "8453"] : []`; `scan(ids)`: group ids by chain; for each chain run `fetchStandardized` over live deployments of that chain (cache results 60 s) and filter by id, plus `readErc4626Vaults(sql, chainId, addresses)`; merge by id preferring the entry with a `fresh` source and concatenating `sources`; `table(protocol, chainId)`: if `protocol === "erc4626"` → `readErc4626Vaults(sql, chainId, null)`, else all vaults from the matching deployments. Chain head: `createPublicClient({ transport: http(rpcUrl) }).getBlock()` → `Number(block.timestamp)`, cached 15 s; on failure use `now` and mark heads as failed so freshness becomes `stale` (pass `headTs = Number.MAX_SAFE_INTEGER` to force stale).

- [ ] **Step 4: Run tests, expect pass. Commit**, `git add -A && git commit -m "feat(service): sealed scan/table handlers, attestations, receipts, live data provider"`

### Task 16: Hedera rail via Blocky402, payer capture, hello-x402 client

**Files:**
- Create: `packages/service/src/rails/hedera.ts`, `packages/service/scripts/hello-x402.ts`, `packages/service/test/hedera-rail.live.test.ts`
- Modify: `packages/service/src/app.ts` (mount when `rails.hedera`)

**Interfaces:**
- Produces: `mountHederaRail(app, deps: { config; keys; data; nonces; onSettled?: (receipt, txId) => void })` registering `POST /hedera/v1/scan` (USDC, dynamic price), `POST /hedera/v1/scan-hbar` (HBAR tinybars, dynamic), `POST /hedera/v1/table` (USDC flat); `hederaPayerFromRequest(req): string | null` and `hederaTxIdFromRequest(req): string | null`.

- [ ] **Step 1: Rail implementation**

```ts
import type { Express, Request } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { Transaction } from "@x402/hedera";
import { clampCount, hederaScanPriceUsd, isSealed, TABLE_PRICE_USD } from "@vaultradar/core";
import { makeScanHandler, type HandlerDeps } from "../handlers/scan";

type Decoded = { payer: string | null; txId: string | null };
const cache = new WeakMap<Request, Decoded>();
export function decodeHederaPayment(req: Request): Decoded {
  const hit = cache.get(req); if (hit) return hit;
  let out: Decoded = { payer: null, txId: null };
  try {
    const h = req.header("payment-signature") ?? req.header("x-payment"); if (!h) return out;
    const p = decodePaymentSignatureHeader(h) as { payload: Record<string, unknown> };
    const b64 = (p.payload.transaction ?? p.payload.signedTransaction) as string | undefined; if (!b64) return out;
    const tx = Transaction.fromBytes(Buffer.from(b64, "base64")) as any;
    const txId = tx.transactionId?.toString?.() ?? null;
    let payer: string | null = null;
    const tokenTransfers = tx.tokenTransfers ?? tx._tokenTransfers; // Map<TokenId, Map<AccountId, Long>>
    for (const [, accts] of tokenTransfers ?? []) for (const [acct, amt] of accts) if (amt.toNumber?.() < 0 || Number(amt) < 0) payer = acct.toString();
    if (!payer) for (const [acct, amt] of tx.hbarTransfers ?? []) if (Number(amt.toTinybars?.() ?? amt) < 0) payer = acct.toString();
    out = { payer, txId };
  } catch { /* leave nulls */ }
  cache.set(req, out); return out;
}
export const hederaPayerFromRequest = (req: Request) => decodeHederaPayment(req).payer;
export const hederaTxIdFromRequest = (req: Request) => decodeHederaPayment(req).txId;

export function mountHederaRail(app: Express, deps: Omit<HandlerDeps, "rail" | "tier" | "getPayer" | "getTxId">) {
  const c = deps.config;
  const facilitator = new HTTPFacilitatorClient({ url: c.hedera.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register("hedera:testnet", new ExactHederaScheme());
  const validateEnvelope = (ctx: any) => { const b = ctx.adapter.getBody(); if (b && typeof b === "object" && ("ct" in b || "kem" in b) && !isSealed(b)) throw new Error("malformed sealed envelope"); };
  const scanPrice = (ctx: any) => { validateEnvelope(ctx); const n = clampCount(ctx.adapter.getHeader("x-vr-count")); if (!n) throw new Error("X-VR-Count must be 1..100"); return `$${hederaScanPriceUsd(n)}`; };
  const hbarPrice = (ctx: any) => { validateEnvelope(ctx); const n = clampCount(ctx.adapter.getHeader("x-vr-count")); if (!n) throw new Error("X-VR-Count must be 1..100"); return { asset: "0.0.0", amount: String(n * 1_000_000) }; }; // 0.01 HBAR per vault, in tinybars (demo rate for the HBAR variant)
  const common = { scheme: "exact", network: "hedera:testnet", payTo: c.hedera.payToAccountId, maxTimeoutSeconds: 120 } as const;
  app.use(paymentMiddleware({
    "POST /hedera/v1/scan": { accepts: [{ ...common, price: scanPrice }], description: "VaultRadar sealed scan (metered per vault)" },
    "POST /hedera/v1/scan-hbar": { accepts: [{ ...common, price: hbarPrice }], description: "VaultRadar scan priced in HBAR" },
    "POST /hedera/v1/table": { accepts: [{ ...common, price: `$${TABLE_PRICE_USD}` }], description: "VaultRadar whole-protocol table (privacy tier)" },
  }, server));
  const h = (tier: "scan" | "table") => makeScanHandler({ ...deps, rail: "hedera", tier, getPayer: hederaPayerFromRequest, getTxId: hederaTxIdFromRequest });
  app.post("/hedera/v1/scan", h("scan")); app.post("/hedera/v1/scan-hbar", h("scan")); app.post("/hedera/v1/table", h("table"));
}
```

The `price` function receiving `HTTPRequestContext` is confirmed in the type facts. The Hedera payload field name (`transaction` vs another key) must be confirmed once: run `hello-x402` (below) with `DEBUG_X402=1` which logs `Object.keys(payload)` (never the value) in `decodeHederaPayment`, then remove the fallback that is not needed. The USDC default asset for `$` prices on `hedera:testnet` is `0.0.429274` (from the `@x402/hedera` default asset table).

- [ ] **Step 2: Payment tx id after settlement**

Register an after-settle hook for the HCS commitment (Task 17 consumes it): `server.onAfterSettle?.(ctx => ...)` if present on `x402ResourceServer` in 2.25.0; otherwise wrap `res.json` in `app.use` before the payment middleware to read the `PAYMENT-RESPONSE` header the middleware sets on the response (`res.getHeader("payment-response")`), decode with `decodePaymentResponseHeader` from `@x402/core/http`, and call `deps.onSettled?.(res.locals.receipt, settled.transaction)`. Implement the `res.json` wrapper path; it needs no hook API.

- [ ] **Step 3: hello-x402 client script (day-one de-risk)**

```ts
// packages/service/scripts/hello-x402.ts — pays one sealed scan on the running service
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { buildSealedRequest, fromB64, open, verifyReceipt } from "@vaultradar/core";
const base = process.env.SERVICE_URL ?? "http://localhost:8787";
const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
const signer = createClientHederaSigner(process.env.AGENT_HEDERA_ACCOUNT_ID!, PrivateKey.fromStringECDSA(process.env.AGENT_HEDERA_KEY!), { network: "testnet" } as any);
const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer));
const payFetch = wrapFetchWithPayment(fetch, client);
const { sealed, replySecret } = buildSealedRequest({ vaults: [process.env.VAULT ?? "1:0x0000000000000000000000000000000000000000"] }, process.env.AGENT_HEDERA_ACCOUNT_ID!, fromB64(card.pq.kem.public_key));
const res = await payFetch(card.endpoints.hedera.scan, { method: "POST", headers: { "content-type": "application/json", "x-vr-count": "1" }, body: JSON.stringify(sealed) });
console.log("status", res.status, "payment-response", res.headers.get("payment-response") ? decodePaymentResponseHeader(res.headers.get("payment-response")!) : null);
const j = await res.json(); if (res.status !== 200) { console.log(j); process.exit(1); }
console.log("receipt ok:", verifyReceipt(j.receipt, fromB64(card.pq.sig.public_key)), "receipt txId:", j.receipt.payment.txId);
console.log("opened:", JSON.stringify(open(j.sealed, replySecret)).slice(0, 300));
```

Prerequisites (spec §12): both accounts associated with `0.0.429274` (`TokenAssociateTransaction` via a tiny `scripts/associate.ts`, or through the Hedera portal), agent account holds testnet USDC from `faucet.circle.com`. Run the service with `HEDERA_*` set, then:

`SERVICE_URL=http://localhost:8787 AGENT_HEDERA_ACCOUNT_ID=0.0.x AGENT_HEDERA_KEY=... bun run packages/service/scripts/hello-x402.ts`

Expected: `status 200`, a `payment-response` with a Hedera transaction id, `receipt ok: true`. Open HashScan testnet, search the transaction id, confirm the USDC transfer. Paste the HashScan URL into `docs/verification-log.md`.

- [ ] **Step 4: Live test (env-gated)**

`hedera-rail.live.test.ts`: skipped unless `LIVE=1`; spins up the app with real config and `LiveDataProvider`, runs the same flow as the script, asserts 200 and a verified receipt.

- [ ] **Step 5: Commit**, `git add -A && git commit -m "feat(service): Hedera x402 rail via Blocky402 with metered pricing and payer capture; hello-x402 client"`

### Task 17: HCS commitments and receipt lookup

**Files:**
- Create: `packages/service/src/hcs.ts`, `packages/service/test/hcs.test.ts`
- Modify: `packages/service/src/app.ts`, `packages/service/src/rails/hedera.ts` (call `onSettled`)

**Interfaces:**
- Produces: `class HcsQueue { constructor(deps: { submit: (message: string) => Promise<{ sequence: string; consensusTimestamp: string }>; topicId: string }); enqueue(receipt: Receipt): void; lookup(receiptHash: string): Promise<LookupResult>; pending(): number }`; `LookupResult = { receipt_hash: string; topicId: string; sequence: string | null; consensus_timestamp: string | null; initial_transaction_id: string | null }`; `makeHederaSubmit(config): (message) => Promise<...>` using `@hashgraph/sdk` `TopicMessageSubmitTransaction`; `mirrorLookup(topicId, receiptHash)` scanning `https://testnet.mirrornode.hedera.com/api/v1/topics/{id}/messages?limit=100&order=desc` and reassembling chunks by `chunk_info.initial_transaction_id`.
- Message format (spec §5.5): `{ v: 1, receipt_hash, sig: receipt.sig, issued_at }` as canonical JSON (about 4.6 KB → 5 chunks).

- [ ] **Step 1: Failing test with a fake submit**

```ts
import { expect, test } from "bun:test";
import { HcsQueue } from "../src/hcs";
import { buildReceipt, deriveSigningKeys, receiptHash } from "@vaultradar/core";
const keys = deriveSigningKeys("99".repeat(32));
const r = buildReceipt({ service: { erc8004: [] }, request_hash: "a".repeat(64), response_hash: "b".repeat(64), sealed: true, sources: [], price: { amount: "1", asset: "x", rail: "hedera" }, payment: { rail: "hedera", txId: "t" }, tier: "scan", hcs: { topicId: "0.0.5" } }, keys);
test("enqueue submits once, retries on failure, lookup returns sequence", async () => {
  let calls = 0; const submit = async (m: string) => { calls++; if (calls === 1) throw new Error("boom"); expect(JSON.parse(m).receipt_hash).toBe(receiptHash(r)); return { sequence: "42", consensusTimestamp: "1.000" }; };
  const q = new HcsQueue({ submit, topicId: "0.0.5", retryMs: 5 });
  q.enqueue(r); await new Promise(res => setTimeout(res, 50));
  expect(calls).toBe(2);
  expect(await q.lookup(receiptHash(r))).toMatchObject({ sequence: "42", topicId: "0.0.5" });
  expect((await q.lookup("f".repeat(64))).sequence).toBeNull();
});
```

- [ ] **Step 2: Implement**

```ts
import { Client, PrivateKey, TopicMessageSubmitTransaction, TopicId } from "@hashgraph/sdk";
import { canonicalize, receiptHash, type Receipt } from "@vaultradar/core";
import type { Config } from "./config";
export type LookupResult = { receipt_hash: string; topicId: string; sequence: string | null; consensus_timestamp: string | null; initial_transaction_id: string | null };
type Submit = (message: string) => Promise<{ sequence: string; consensusTimestamp: string; transactionId?: string }>;
export class HcsQueue {
  private done = new Map<string, LookupResult>(); private q: Receipt[] = []; private running = false; private retryMs: number;
  constructor(private deps: { submit: Submit; topicId: string; retryMs?: number }) { this.retryMs = deps.retryMs ?? 2000; }
  pending() { return this.q.length; }
  enqueue(r: Receipt) { this.q.push(r); void this.drain(); }
  private async drain() { if (this.running) return; this.running = true;
    while (this.q.length) { const r = this.q[0]; const h = receiptHash(r);
      try { const res = await this.deps.submit(canonicalize({ v: 1, receipt_hash: h, sig: r.sig, issued_at: r.issued_at }));
        this.done.set(h, { receipt_hash: h, topicId: this.deps.topicId, sequence: res.sequence, consensus_timestamp: res.consensusTimestamp, initial_transaction_id: res.transactionId ?? null }); this.q.shift(); }
      catch { await new Promise(res => setTimeout(res, this.retryMs)); } }
    this.running = false; }
  async lookup(h: string): Promise<LookupResult> { return this.done.get(h) ?? { receipt_hash: h, topicId: this.deps.topicId, sequence: null, consensus_timestamp: null, initial_transaction_id: null }; }
}
export function makeHederaSubmit(c: Config): Submit {
  const client = Client.forTestnet().setOperator(c.hedera.operatorId, PrivateKey.fromStringECDSA(c.hedera.operatorKey));
  return async (message) => {
    const tx = await new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(c.hedera.hcsTopicId!)).setMessage(message).execute(client);
    const rc = await tx.getReceipt(client);
    return { sequence: rc.topicSequenceNumber?.toString() ?? "0", consensusTimestamp: (await tx.getRecord(client)).consensusTimestamp.toString(), transactionId: tx.transactionId.toString() };
  };
}
```

Wire: `main.ts` constructs `HcsQueue` only when `HEDERA_HCS_TOPIC_ID` is set; `mountHederaRail(..., { onSettled: (receipt) => hcs.enqueue(receipt) })` and the Arc rail (Task 19) the same. `wellknown.ts` `/v1/receipts/:hash` delegates to `hcs.lookup`; when the in-memory map misses (after a restart) fall back to `mirrorLookup` which pages the mirror node and matches `receipt_hash` inside reassembled messages.

- [ ] **Step 3: Run, expect pass. Commit**, `git add -A && git commit -m "feat(service): HCS commitment queue with retry and receipt lookup"`

### Task 18: Identity bootstrap (HCS topic, ERC-8004 with on-chain PQ key hash)

**Files:**
- Create: `packages/service/scripts/identity.ts`, `packages/service/src/erc8004.ts`

**Interfaces:**
- Produces: `ERC8004_ABI` (viem ABI fragments for `register(string,(string,bytes)[])`, `setMetadata`, `getMetadata`, event `Registered`); `readPqHash(chainId, agentId, rpcUrl): Promise<string | null>` (decodes `getMetadata(agentId, "pq.sig.pubhash")` bytes as UTF-8 hex string); `CHAINS = { "296": { rpc: "https://testnet.hashio.io/api", registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" }, "5042002": { rpc: "https://rpc.testnet.arc.io", registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" } }`.

- [ ] **Step 1: ABI and reader (`erc8004.ts`)**

```ts
import { createPublicClient, http, hexToString, type Address } from "viem";
export const ERC8004_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }, { name: "metadata", type: "tuple[]", components: [{ name: "metadataKey", type: "string" }, { name: "metadataValue", type: "bytes" }] }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "setMetadata", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "metadataKey", type: "string" }, { name: "metadataValue", type: "bytes" }], outputs: [] },
  { type: "function", name: "getMetadata", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }, { name: "metadataKey", type: "string" }], outputs: [{ name: "", type: "bytes" }] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string", indexed: false }, { name: "owner", type: "address", indexed: true }] },
] as const;
export const CHAINS: Record<string, { rpc: string; registry: Address; name: string }> = {
  "296": { rpc: "https://testnet.hashio.io/api", registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", name: "hedera-testnet" },
  "5042002": { rpc: "https://rpc.testnet.arc.io", registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", name: "arc-testnet" },
};
export const PQ_KEY = "pq.sig.pubhash";
export async function readPqHash(chainId: string, agentId: string, rpcUrl = CHAINS[chainId]?.rpc): Promise<string | null> {
  const c = CHAINS[chainId]; if (!c) return null;
  const client = createPublicClient({ transport: http(rpcUrl) });
  try { const b = await client.readContract({ address: c.registry, abi: ERC8004_ABI, functionName: "getMetadata", args: [BigInt(agentId), PQ_KEY] }); return b && b !== "0x" ? hexToString(b) : null; } catch { return null; }
}
```

- [ ] **Step 2: Bootstrap script**

```ts
// bun run packages/service/scripts/identity.ts  (needs HEDERA_* for the topic, DEPLOYER_KEY_HEDERA / DEPLOYER_KEY_ARC evm private keys, PUBLIC_URL, PQ_SIG_SEED)
import { createWalletClient, createPublicClient, http, stringToHex, decodeEventLog, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Client, PrivateKey, TopicCreateTransaction } from "@hashgraph/sdk";
import { deriveSigningKeys } from "@vaultradar/core";
import { CHAINS, ERC8004_ABI, PQ_KEY } from "../src/erc8004";
const pubHash = deriveSigningKeys(process.env.PQ_SIG_SEED!).pubHash;
const agentURI = `${process.env.PUBLIC_URL!.replace(/\/$/, "")}/.well-known/erc8004.json`;
if (!process.env.HEDERA_HCS_TOPIC_ID) {
  const client = Client.forTestnet().setOperator(process.env.HEDERA_OPERATOR_ID!, PrivateKey.fromStringECDSA(process.env.HEDERA_OPERATOR_KEY!));
  const rc = await (await new TopicCreateTransaction().setTopicMemo("VaultRadar receipt commitments v1").execute(client)).getReceipt(client);
  console.log("HEDERA_HCS_TOPIC_ID=" + rc.topicId!.toString());
}
for (const [chainId, key] of [["296", process.env.DEPLOYER_KEY_HEDERA], ["5042002", process.env.DEPLOYER_KEY_ARC]] as const) {
  if (!key) { console.log(`skip ${chainId}: no deployer key`); continue; }
  const c = CHAINS[chainId]; const chain = defineChain({ id: Number(chainId), name: c.name, nativeCurrency: { name: "native", symbol: chainId === "296" ? "HBAR" : "USDC", decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } });
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http(c.rpc) }); const pub = createPublicClient({ chain, transport: http(c.rpc) });
  const hash = await wallet.writeContract({ address: c.registry, abi: ERC8004_ABI, functionName: "register", args: [agentURI, [{ metadataKey: PQ_KEY, metadataValue: stringToHex(pubHash) }]], gas: 400_000n });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  const ev = rcpt.logs.map(l => { try { return decodeEventLog({ abi: ERC8004_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find(e => e?.eventName === "Registered") as any;
  console.log(`${c.name}: agentId=${ev?.args?.agentId?.toString()} tx=${hash}`);
  console.log(`ERC8004_${chainId === "296" ? "HEDERA" : "ARC"}_AGENT_ID=${ev?.args?.agentId?.toString()}`);
}
```

Hedera EVM notes: the deployer must be an ECDSA account with an EVM alias (the Hedera portal's ECDSA accounts have one); Hashio needs explicit gas. Arc notes: gas is paid in native USDC; fund the deployer from `faucet.circle.com` (Arc Testnet). Put the printed ids into `.env` and redeploy the service so the agent card and registration file carry them.

- [ ] **Step 3: Verify the anchor**

`bun -e 'import { readPqHash } from "./packages/service/src/erc8004"; console.log(await readPqHash("296", process.env.ERC8004_HEDERA_AGENT_ID!))'` → prints the pub hash equal to `/.well-known/erc8004.json`'s `pq.pub_hash`. Record both explorer links in `docs/verification-log.md`.

- [ ] **Step 4: Commit**, `git add -A && git commit -m "feat(service): ERC-8004 registration with on-chain PQ key hash; HCS topic bootstrap"`

### Task 19: Arc rail via Circle Gateway (go/no-go by Thursday evening)

**Files:**
- Create: `packages/service/src/rails/arc.ts`, `packages/service/scripts/hello-arc.ts`
- Modify: `packages/service/src/app.ts`

**Interfaces:**
- Produces: `mountArcRail(app, deps)` registering `POST /arc/v1/scan/s|m|l` and `POST /arc/v1/table` with `gateway.require(price)`; `arcPayerFromRequest(req) = req.payment?.payer ?? null`; `arcTxIdFromRequest(req) = req.payment?.transaction ?? "gateway-batch"`; the scan handler additionally validates that the bucket matches `X-VR-Count` (`s` 1-5, `m` 6-20, `l` 21-100) and returns 422 `bucket_mismatch` otherwise.

- [ ] **Step 1: Rail**

```ts
import type { Express, Request } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { ARC_BUCKET_PRICE, TABLE_PRICE_USD, arcBucket, clampCount } from "@vaultradar/core";
import { makeScanHandler, type HandlerDeps } from "../handlers/scan";
type PReq = Request & { payment?: { verified: boolean; payer: string; amount: string; network: string; transaction?: string } };
export const arcPayerFromRequest = (req: Request) => (req as PReq).payment?.payer ?? null;
export const arcTxIdFromRequest = (req: Request) => (req as PReq).payment?.transaction ?? "gateway-batch";
export function mountArcRail(app: Express, deps: Omit<HandlerDeps, "rail" | "tier" | "getPayer" | "getTxId">) {
  const gateway = createGatewayMiddleware({ sellerAddress: deps.config.arc.sellerAddress, networks: [deps.config.arc.network], facilitatorUrl: deps.config.arc.facilitatorUrl });
  const scan = makeScanHandler({ ...deps, rail: "arc", tier: "scan", getPayer: arcPayerFromRequest, getTxId: arcTxIdFromRequest });
  const table = makeScanHandler({ ...deps, rail: "arc", tier: "table", getPayer: arcPayerFromRequest, getTxId: arcTxIdFromRequest });
  for (const b of ["s", "m", "l"] as const) {
    app.post(`/arc/v1/scan/${b}`, gateway.require(`$${ARC_BUCKET_PRICE[b]}`), (req, res, next) => {
      const n = clampCount(req.header("x-vr-count")); if (!n || arcBucket(n) !== b) return res.status(422).json({ reason: "bucket_mismatch" });
      return scan(req, res).catch(next);
    });
  }
  app.post("/arc/v1/table", gateway.require(`$${TABLE_PRICE_USD}`), (req, res, next) => table(req, res).catch(next));
}
```

Because Circle's middleware settles after the handler as well, the `onSettled` HCS commitment for Arc is triggered from the `res.json` wrapper of Task 16 step 2 when `res.locals.receipt` exists and the status is 200 (regardless of rail).

- [ ] **Step 2: hello-arc client**

```ts
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { buildSealedRequest, fromB64, open, verifyReceipt } from "@vaultradar/core";
const base = process.env.SERVICE_URL ?? "http://localhost:8787";
const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
const gw = new GatewayClient({ chain: "arcTestnet", privateKey: process.env.AGENT_ARC_KEY as `0x${string}` });
if (process.env.DEPOSIT) console.log(await gw.deposit(process.env.DEPOSIT));
const { sealed, replySecret } = buildSealedRequest({ vaults: [process.env.VAULT ?? "1:0x0000000000000000000000000000000000000000"] }, gw.account.address, fromB64(card.pq.kem.public_key));
const r = await gw.pay<any>(card.endpoints.arc.scan.s, { method: "POST", body: sealed, headers: { "x-vr-count": "1" } });
console.log("paid", r.formattedAmount, "tx", r.transaction, "receipt ok", verifyReceipt(r.data.receipt, fromB64(card.pq.sig.public_key)));
console.log(JSON.stringify(open(r.data.sealed, replySecret)).slice(0, 300));
```

Run with `DEPOSIT=2` once (USDC from `faucet.circle.com` on Arc testnet; Arc gas is USDC too). Expected: `paid 0.003`, a transaction hash on `https://testnet.arcscan.app`, `receipt ok true`. Confirm the payer the middleware reports equals `gw.account.address` (the handler's payer check passes).

- [ ] **Step 3: Go/no-go**

If this does not succeed by Thursday 2026-09-10 21:00 local after at most two hours of debugging, disable the Arc rail (`rails.arc=false`), drop Arc from the partner picks, and keep the dashboard minimal. Record the decision in `docs/verification-log.md`.

- [ ] **Step 4: Commit**, `git add -A && git commit -m "feat(service): Arc rail via Circle Gateway nanopayments with bucketed pricing; hello-arc client"`

### Task 20: Deploy the service

**Files:**
- Create: `packages/service/Dockerfile`, `fly.toml`, `docs/deploy.md`

- [ ] **Step 1: Dockerfile**

```dockerfile
FROM oven/bun:1.3 AS base
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/service/package.json packages/service/
RUN bun install --frozen-lockfile
COPY packages/core packages/core
COPY packages/service packages/service
COPY skills skills
EXPOSE 8787
CMD ["bun", "run", "packages/service/src/main.ts"]
```

`fly.toml`: app name `vaultradar`, `internal_port = 8787`, `[http_service] force_https = true, auto_stop_machines = false, min_machines_running = 1`, region `iad`.

- [ ] **Step 2: Deploy**

```bash
fly launch --no-deploy --copy-config
fly secrets set PQ_SIG_SEED=… PQ_KEM_SEED=… GRAPH_STUDIO_API_KEY=… DATABASE_URL=… HEDERA_PAYTO_ACCOUNT_ID=… HEDERA_OPERATOR_ID=… HEDERA_OPERATOR_KEY=… HEDERA_HCS_TOPIC_ID=… ARC_SELLER_ADDRESS=… ERC8004_HEDERA_AGENT_ID=… ERC8004_ARC_AGENT_ID=… PUBLIC_URL=https://vaultradar.fly.dev
fly deploy
curl https://vaultradar.fly.dev/health
```

Then re-run `hello-x402` and `hello-arc` against the public URL (the registration `agentURI` must point at this URL; if you registered with a different URL, call `setAgentURI` or re-register). The Substreams sinks keep running from your laptop (or a second Fly machine) into Neon.

- [ ] **Step 3: Commit**, `git add -A && git commit -m "chore(service): Dockerfile and Fly deployment"`

### Task 21: Agent client library (discover, quote, pay on both rails, verify, persist)

**Files:**
- Create: `packages/agent/package.json`, `packages/agent/tsconfig.json`, `packages/agent/src/client.ts`, `packages/agent/src/rails/hedera.ts`, `packages/agent/src/rails/arc.ts`, `packages/agent/src/runs.ts`, `packages/agent/test/client.test.ts`

**Interfaces:**
- Produces: `class VaultRadarClient { constructor(opts: { serviceUrl: string; hedera?: { accountId: string; privateKey: string }; arc?: { privateKey: `0x${string}` }; fetchImpl?: typeof fetch; readPqHash?: (chainId, agentId) => Promise<string | null> }); discover(): Promise<Discovery>; quote(count: number): Promise<{ hedera: string | null; arc: string | null }>; scan(vaults: string[], rail: Rail, opts?: { seal?: boolean }): Promise<PaidResult>; table(protocol: string, chainId: string, rail: Rail): Promise<PaidResult> }`; `Discovery = { card: AgentCard; sigPk: Uint8Array; kemPk: Uint8Array; cardSignatureValid: boolean; onChain: { chainId: string; agentId: string; matches: boolean | null }[] }`; `PaidResult = { rail; tier; vaults; reports; attestations; receipt; receiptValid: boolean; attestationsValid: boolean; txId: string | null; priceUsd: string | null; sealed: boolean }`; `payingFetchHedera(accountId, key)` → wrapped fetch; `payArc(key, url, body, headers)` → `{ data, transaction, formattedAmount }`; `saveRun(dir, run: RunRecord): string` writing `runs/<iso>-<short>.json`; `RunRecord = { id; startedAt; policy; discovery summary; requests: PaidResult[]; decisions: Decision[] }` (`Decision` defined in Task 22).

- [ ] **Step 1: Package**

```json
{ "name": "@vaultradar/agent", "version": "0.1.0", "type": "module", "private": true,
  "scripts": { "watch": "bun run src/cli.ts watch", "chat": "bun run src/cli.ts chat" },
  "dependencies": { "@vaultradar/core": "workspace:*", "@x402/fetch": "2.25.0", "@x402/core": "2.25.0", "@x402/hedera": "2.25.0", "@circle-fin/x402-batching": "3.4.0", "@anthropic-ai/claude-agent-sdk": "^0.3.0", "viem": "^2.21.0", "zod": "^3.23.0" } }
```

The Circle starter kit (`circlefin/agent-stack-starter-kits`, Claude Agent SDK variant) is the reference for wallet setup and the terminal chat loop; copy its `bun` project conventions and the `/wallets`, `/balance` command style into Task 23's CLI, and cite it in the README. Do not vendor its code wholesale; the agent's tools here are VaultRadar-specific.

- [ ] **Step 2: Failing tests (against an in-process service with stub data and no payment middleware)**

Spin up `buildApp` from `@vaultradar/service` with `rails: {}` plus the raw handlers mounted at `/hedera/v1/scan` using `getPayer: () => "0.0.42"`; then:

```ts
test("discover verifies the card and compares on-chain hash", async () => {
  const c = new VaultRadarClient({ serviceUrl: base(), readPqHash: async () => keys.sig.pubHash });
  const d = await c.discover(); expect(d.cardSignatureValid).toBe(true); expect(d.onChain[0].matches).toBe(true);
});
test("scan without payment middleware still round-trips sealing and verification", async () => {
  const c = new VaultRadarClient({ serviceUrl: base(), hedera: { accountId: "0.0.42", privateKey: TEST_KEY }, fetchImpl: fetch /* unpaid fetch since no middleware */ });
  (c as any).payingFetch = async (url: string, init: RequestInit) => fetch(url, init);
  const r = await c.scan(["1:0xabc"], "hedera"); expect(r.receiptValid).toBe(true); expect(r.attestationsValid).toBe(true); expect(r.sealed).toBe(true); expect(r.vaults[0].id).toBe("1:0xabc");
});
```

- [ ] **Step 3: Implement**

`rails/hedera.ts`:

```ts
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
export function payingFetchHedera(accountId: string, privateKey: string) {
  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), { network: "testnet" } as any);
  const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer));
  return wrapFetchWithPayment(fetch, client);
}
export function txIdFromResponse(res: Response): string | null { const h = res.headers.get("payment-response"); if (!h) return null; try { return (decodePaymentResponseHeader(h) as any).transaction ?? null; } catch { return null; } }
```

`rails/arc.ts`: `payArc(privateKey, url, body, headers)` → `new GatewayClient({ chain: "arcTestnet", privateKey }).pay(url, { method: "POST", body, headers })`; export `arcAddress(privateKey)` via `privateKeyToAccount`.

`client.ts`:

```ts
import { buildSealedRequest, checkSig, fromB64, open, verifyAttestation, verifyReceipt, arcBucket, hederaScanPriceUsd, ARC_BUCKET_PRICE, TABLE_PRICE_USD } from "@vaultradar/core";
import { payingFetchHedera, txIdFromResponse } from "./rails/hedera"; import { payArc, arcAddress } from "./rails/arc";
export class VaultRadarClient {
  private disc: Discovery | null = null; private payingFetch: ((u: string, i: RequestInit) => Promise<Response>) | null = null;
  constructor(private o: Opts) { if (o.hedera) this.payingFetch = payingFetchHedera(o.hedera.accountId, o.hedera.privateKey); }
  async discover(): Promise<Discovery> {
    const card = await (await (this.o.fetchImpl ?? fetch)(`${this.o.serviceUrl}/.well-known/agent.json`)).json();
    const sigPk = fromB64(card.pq.sig.public_key), kemPk = fromB64(card.pq.kem.public_key);
    const cardSignatureValid = checkSig(card, sigPk);
    const onChain = await Promise.all((card.erc8004 ?? []).map(async (e: { chainId: string; agentId: string }) => { const h = this.o.readPqHash ? await this.o.readPqHash(e.chainId, e.agentId) : null; return { ...e, matches: h == null ? null : h === card.pq.sig.pub_hash }; }));
    this.disc = { card, sigPk, kemPk, cardSignatureValid, onChain }; return this.disc;
  }
  async quote(count: number) { return { hedera: this.o.hedera ? hederaScanPriceUsd(count) : null, arc: this.o.arc ? ARC_BUCKET_PRICE[arcBucket(count)] : null }; }
  private payerFor(rail: Rail) { return rail === "hedera" ? this.o.hedera!.accountId : arcAddress(this.o.arc!.privateKey); }
  private async paid(rail: Rail, tier: "scan" | "table", url: string, request: object, count: number, doSeal: boolean): Promise<PaidResult> {
    const d = this.disc ?? (await this.discover());
    const env = doSeal ? buildSealedRequest(request, this.payerFor(rail), d.kemPk) : null;
    const body = env ? env.sealed : request; const headers: Record<string, string> = { "content-type": "application/json", ...(tier === "scan" ? { "x-vr-count": String(count) } : {}) };
    let json: any, txId: string | null = null;
    if (rail === "hedera") { const res = await (this.payingFetch ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body) }); txId = txIdFromResponse(res); json = await res.json(); if (res.status !== 200) throw new Error(`service ${res.status}: ${JSON.stringify(json)}`); }
    else { const r = await payArc(this.o.arc!.privateKey, url, body, headers); txId = r.transaction; json = r.data; }
    const opened = json.sealed && env ? open<any>(json.sealed, env.replySecret) : json;
    const attestations = opened.attestations ?? [];
    return { rail, tier, vaults: opened.vaults, reports: opened.reports, attestations, receipt: json.receipt,
      receiptValid: verifyReceipt(json.receipt, d.sigPk), attestationsValid: attestations.every((a: any) => verifyAttestation(a, d.sigPk)), txId, priceUsd: rail === "hedera" ? (tier === "scan" ? hederaScanPriceUsd(count) : TABLE_PRICE_USD) : (tier === "scan" ? ARC_BUCKET_PRICE[arcBucket(count)] : TABLE_PRICE_USD), sealed: !!env };
  }
  scan(vaults: string[], rail: Rail, opts: { seal?: boolean } = {}) {
    const d = this.disc!; const url = rail === "hedera" ? d.card.endpoints.hedera.scan : d.card.endpoints.arc.scan[arcBucket(vaults.length)];
    return this.paid(rail, "scan", url, { vaults }, vaults.length, opts.seal ?? true);
  }
  table(protocol: string, chainId: string, rail: Rail) { const d = this.disc!; return this.paid(rail, "table", rail === "hedera" ? d.card.endpoints.hedera.table : d.card.endpoints.arc.table, { protocol, chainId }, 0, true); }
}
```

`runs.ts`: `saveRun(dir, run)` writes pretty JSON to `runs/<startedAt ISO with colons replaced>-<id>.json`, returns the path; `listRuns(dir)`.

- [ ] **Step 4: Run tests, expect pass. Commit**, `git add -A && git commit -m "feat(agent): VaultRadar client with discovery verification, sealed paid scans on Hedera and Arc"`

### Task 22: Policy: rail and tier selection, budget, independent age check, decisions

**Files:**
- Create: `packages/agent/src/policy.ts`, `packages/agent/test/policy.test.ts`, `packages/agent/policy.example.json`

**Interfaces:**
- Produces: `type Policy = { budget: { usdc_hedera: string; usdc_arc: string }; privacy: "strict" | "balanced" | "cheap"; rail_preference: "cheapest" | "hedera" | "arc"; max_age_seconds: number }`; `loadPolicy(path): Policy`; `chooseRail(p: Policy, quotes: { hedera: string | null; arc: string | null }, balances: { hedera: string; arc: string }, health: { hedera: boolean; arc: boolean }): { rail: Rail; reason: string } | { rail: null; reason: string }`; `chooseTier(p: Policy): { tier: "scan" | "table"; seal: boolean }` (`strict` → table; `balanced` → sealed scan; `cheap` → clear scan); `applyAgeCheck(result: PaidResult, p: Policy, now: number): { accepted: Attestation[]; rejected: { vaultId: string; ageSeconds: number }[] }`; `decide(result: PaidResult, age: ReturnType<typeof applyAgeCheck>): Decision[]` with `Decision = { vaultId: string; action: "hold" | "withdraw" | "rebalance" | "insufficient data"; reason: string; citations: { block: string; source: string; txId: string | null; receiptHash: string } }`; mapping: `alert` → `withdraw`; `watch` → `rebalance`; `ok` → `hold`; `unavailable` or rejected attestation → `insufficient data`.

- [ ] **Step 1: Failing tests**

```ts
test("cheapest picks the lower quote with balance and health", () => {
  expect(chooseRail(P("cheapest"), { hedera: "0.0015", arc: "0.003" }, { hedera: "1", arc: "1" }, { hedera: true, arc: true })).toMatchObject({ rail: "hedera" });
  expect(chooseRail(P("cheapest"), { hedera: "0.0015", arc: "0.003" }, { hedera: "0", arc: "1" }, { hedera: true, arc: true })).toMatchObject({ rail: "arc" });
  expect(chooseRail(P("cheapest"), { hedera: "0.0015", arc: null }, { hedera: "1", arc: "0" }, { hedera: false, arc: false }).rail).toBeNull();
});
test("tiers follow privacy", () => { expect(chooseTier(P("cheapest", "strict"))).toEqual({ tier: "table", seal: true }); expect(chooseTier(P("cheapest", "cheap"))).toEqual({ tier: "scan", seal: false }); });
test("age check rejects old attestations regardless of service freshness; decisions map verdicts", () => {
  const res = fakeResult([{ vaultId: "1:0xa", timestamp: String(now - 10), verdict: "alert" }, { vaultId: "1:0xb", timestamp: String(now - 5000), verdict: "ok" }]);
  const age = applyAgeCheck(res, { ...P("hedera"), max_age_seconds: 900 }, now);
  expect(age.rejected.map(r => r.vaultId)).toEqual(["1:0xb"]);
  const d = decide(res, age); expect(d.find(x => x.vaultId === "1:0xa")!.action).toBe("withdraw"); expect(d.find(x => x.vaultId === "1:0xb")!.action).toBe("insufficient data");
});
```

- [ ] **Step 2: Implement** per the interface; `chooseRail` for `"cheapest"` sorts candidate rails by numeric quote, filtering out rails with `health=false`, `quote=null`, or `balance < quote`; for `"hedera"`/`"arc"` returns that rail if usable else falls back to the other with reason `"preferred_rail_unusable"`. `applyAgeCheck` uses `now - Number(a.timestamp) > p.max_age_seconds`. `decide` builds citations from the report's first evidence entry and `receiptHash(result.receipt)`.

- [ ] **Step 3: Run, expect pass. Commit**, `git add -A && git commit -m "feat(agent): policy-driven rail/tier selection, independent age check, decisions with citations"`

### Task 23: Claude Agent SDK loop, tools, CLI

**Files:**
- Create: `packages/agent/src/tools.ts`, `packages/agent/src/cli.ts`, `packages/agent/src/balances.ts`

**Interfaces:**
- Produces: tools exposed to the model via the Claude Agent SDK (`tool()` + `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk`): `vaultradar_discover` (no input) → discovery summary; `vaultradar_quote` (`count`) → quotes plus balances plus the policy's rail choice; `vaultradar_scan` (`vaults: string[]`) → runs `chooseTier`/`chooseRail`, pays, verifies, applies the age check, returns `{ decisions, reports, receipt_hash, tx_id, rail, tier, sealed, rejected }` and appends to the run; `vaultradar_table` (`protocol, chainId`); `vaultradar_verify_receipt` (`receipt` JSON). CLI: `bun run agent watch --vaults 1:0x...,1:0x... --policy policy.json [--service URL]` (non-interactive: runs discover → quote → scan → prints decisions and citations, saves run); `bun run agent chat` (interactive loop with the SDK, `/wallets`, `/balance`, `/policy` commands in the Circle starter-kit style).
- Env: `ANTHROPIC_API_KEY`, `SERVICE_URL`, `AGENT_HEDERA_ACCOUNT_ID`, `AGENT_HEDERA_KEY`, `AGENT_ARC_KEY`, `POLICY_PATH`.
- Balances: Hedera USDC via mirror node `GET /api/v1/accounts/{id}/tokens?token.id=0.0.429274`; Arc Gateway balance via `GatewayClient.getGatewayBalance` (name per the installed types; fall back to `getBalances`). Health: `GET /health` on the service plus a HEAD to each facilitator's `/supported` (Blocky402) and Gateway `/v1/x402/supported` (or the equivalent listed in the Circle docs); treat a non-2xx as unhealthy.

- [ ] **Step 1: Tools**

Follow the Claude Agent SDK docs for custom tools (`tool(name, description, zodSchema, handler)`, `createSdkMcpServer({ name, tools })`, and `query({ prompt, options: { mcpServers, allowedTools, systemPrompt } })`). System prompt (verbatim in code):

"You are VaultRadar's risk-monitor agent. You buy vault risk data with x402 micropayments under a policy. Never invent numbers. A verdict of unavailable, or an attestation older than the policy's max age, means 'insufficient data'. Every recommendation must cite block numbers, the data source, the payment transaction id and the receipt hash from the tool results. Prefer the cheapest rail unless the policy says otherwise, and the privacy tier the policy requires."

- [ ] **Step 2: `watch` mode** prints a table per vault: id, verdict, score, flags, action, block, source, txId, receipt hash, HCS sequence (polled from `/v1/receipts/:hash` up to 3 times with 3 s gaps). Also prints the run file path. This is the video's main terminal segment.

- [ ] **Step 3: Live check** against the deployed service: `SERVICE_URL=https://vaultradar.fly.dev bun run agent watch --vaults <two live ids> --policy packages/agent/policy.example.json`. Expected: one paid request, decisions printed, run saved. Repeat with `privacy: "strict"` to show a `table` purchase, and with a stale Messari deployment's vault to show `insufficient data`.

- [ ] **Step 4: Commit**, `git add -A && git commit -m "feat(agent): Claude Agent SDK tools, watch and chat CLI"`

### Task 24: Dashboard (minimal, satisfies Arc's frontend requirement)

**Files:**
- Create: `packages/dashboard/` via `bun create next-app@latest packages/dashboard --ts --app --no-tailwind --eslint --src-dir=false --import-alias "@/*"` then: `app/page.tsx`, `app/runs/[id]/page.tsx`, `app/verify/page.tsx`, `app/api/runs/route.ts`, `app/api/runs/[id]/route.ts`, `lib/service.ts`, `public/demo-run.json`

**Interfaces:**
- Consumes: `GET {SERVICE_URL}/v1/catalog`, `GET {SERVICE_URL}/v1/receipts/:hash`, `GET {SERVICE_URL}/.well-known/agent.json`; run files from `../../runs` via the two API routes (server-side `fs`), falling back to `public/demo-run.json` when the directory is empty or `DEMO=1`.
- Pages: `/` shows the agent card summary (name, ERC-8004 ids with explorer links, PQ key hashes, prices), the catalog table (protocol, chain, status, lag), and the list of runs; `/runs/[id]` shows each paid request: rail, tier, sealed flag, price, tx id linked to HashScan (`https://hashscan.io/testnet/transaction/{txId}`) or Arcscan (`https://testnet.arcscan.app/tx/{hash}`), receipt hash, HCS sequence fetched live from `/v1/receipts/:hash`, and per-vault decisions with flags and citations; `/verify` has a textarea for a receipt JSON and runs `verifyReceipt` in the browser against the card's public key (import `@vaultradar/core` client-side; the noble library is browser-safe).
- Explorer links: HashScan transaction ids use the `0.0.x@seconds.nanos` form converted to `0.0.x-seconds-nanos`.

- [ ] **Step 1: Scaffold and API routes**

`app/api/runs/route.ts` lists `runs/*.json` (name, startedAt, request count); `app/api/runs/[id]/route.ts` returns one file. Both read from `path.join(process.cwd(), "..", "..", "runs")` and fall back to `public/demo-run.json`.

- [ ] **Step 2: Pages**

Plain React server components with `fetch(SERVICE_URL, { cache: "no-store" })`. Use a small shared `<Table>` component; no styling beyond a stylesheet with a monospace font and zebra rows. Every number displayed comes from the JSON as a string; do not reformat share prices beyond trimming to 8 decimals.

- [ ] **Step 3: Demo run**

After Task 23's live check, copy a sanitized run (remove nothing sensitive; runs contain no keys) to `public/demo-run.json`.

- [ ] **Step 4: Run** `cd packages/dashboard && SERVICE_URL=https://vaultradar.fly.dev bun run dev` → verify `/`, `/runs/<id>`, `/verify` render with live data. Deploy to Vercel (`vercel --prod`) or run locally for the video; record the URL in the README.

- [ ] **Step 5: Commit**, `git add -A && git commit -m "feat(dashboard): catalog, runs with payments per rail and HCS sequences, receipt verifier"`

### Task 25: README, SKILL.md, demo script, verification log

**Files:**
- Create: `README.md`, `skills/vaultradar/SKILL.md`, `scripts/demo.sh`, `docs/verification-log.md` (already accumulating), `docs/standards-leverage.md`
- Modify: `.env.example` (final), `docs/architecture.md` (link PNGs; regenerate after any endpoint rename)

- [ ] **Step 1: README sections, in this order**

1. One-paragraph pitch and the three partner tracks with a table "what to look at" (file paths and live URLs).
2. Architecture: embed `docs/architecture.png` and `docs/payment-flow.png`; link `docs/architecture.md`.
3. Payment flow on Hedera and on Arc (from spec §6), with the HashScan and Arcscan links of real settled requests from `docs/verification-log.md`.
4. "What the standards made easier": one query template across N Messari deployments (list them with status), the ERC-4626 module composed from Pinax and reused on two chains, published package URL, one-prompt record link.
5. Freshness and the refusal rule, with the demonstrated stale case.
6. Privacy and PQ: sealed requests and responses, privacy tier, receipts and attestations, HCS commitments, on-chain key anchor, and the boundary statement from spec §3 verbatim.
7. Run it: prerequisites (spec §12), env, `bun install`, `bun test`, service, agent `watch`, dashboard, Substreams sink commands.
8. Prize mapping (spec §2 table) and the honest scope notes (harness PR not submitted; HCS-14 not implemented).
9. License, session link.

- [ ] **Step 2: SKILL.md** (installable by any agent; also served at `/skill.md`)

Frontmatter `name: vaultradar`, `description: Buy cross-protocol vault risk data over x402 with sealed requests and verify PQ-signed receipts`. Body: when to use; discovery (`/.well-known/agent.json`, verify the ML-DSA signature, compare `pq.sig.pub_hash` with ERC-8004 `getMetadata(agentId, "pq.sig.pubhash")`); how to seal a request (envelope fields, `X-VR-Count`); the 402 flow per rail with the exact package names; how to open the response and verify receipts; the freshness rule an agent must apply itself; price table; error codes (400/422/504 and their reasons); example `curl` for a clear-mode quote (unpaid 402) so a reader sees the `PAYMENT-REQUIRED` header.

- [ ] **Step 3: `scripts/demo.sh`**

Sequential: print the card (jq the endpoints and key hashes) → curl unpaid POST to show the 402 header decoded (`base64 -d`) → `bun run agent watch ...` on Hedera → `bun run agent watch ... --policy strict` (table tier) → `hello-arc` → `curl /v1/receipts/<hash>` showing the HCS sequence → mirror node URL of the topic. Each step echoes a heading. This is the video script.

- [ ] **Step 4: Commit**, `git add -A && git commit -m "docs: README, SKILL.md, demo script, standards leverage, verification log"`

### Task 26: Video and submission (Saturday 2026-09-12)

- [ ] **Step 1: Storyboard (target 3:30, hard cap 4:00, no AI voiceover, 720p+)**

| Time | Segment |
|---|---|
| 0:00-0:20 | Problem: agents act on stale, siloed vault data, and buying data leaks the portfolio. |
| 0:20-1:00 | Standards: one query across Messari deployments (show `verify-deployments` output and a scan spanning three protocols); the ERC-4626 module on substreams.dev running on two chains; 10 s of the one-prompt recording. |
| 1:00-2:00 | Hedera: `demo.sh` shows the 402 with the metered price, the paid request, HashScan transfer, HCS message with the receipt hash; agent card and on-chain `pq.sig.pubhash`. |
| 2:00-2:40 | Agent reasoning: decisions with citations; strict policy buys the table tier; stale deployment → insufficient data. |
| 2:40-3:10 | Arc: `hello-arc` payment, Arcscan link, dashboard showing both rails and the receipt verifier. |
| 3:10-3:30 | Recap: what is reusable (package, SKILL.md, service), boundary statement, links. |

- [ ] **Step 2: Submission checklist**

Public repo with continuous history; video uploaded (2-4 min); partner picks: The Graph, Hedera, Arc (drop Arc if Task 19 failed); project description pasted from README section 1; live URLs (service, dashboard, substreams.dev package, HashScan and Arcscan transactions, HCS topic); `docs/verification-log.md` complete; ETHGlobal form submitted before 12:00 EDT Sunday; keep a copy of the submission text in `docs/submission.md`.

---

## Plan self-review notes

- Spec coverage: §5.1 → Task 9; §5.2 → Tasks 11-13; §5.3 → Tasks 6-7; §5.4 → Tasks 3-5; §5.5 → Tasks 14-19; §5.6 → Tasks 21-23; §5.7 → Task 24; §5.8 (harness PR) → deliberately cut for the compressed window (Global Constraints); §6-§7 → Tasks 15-17; §8 → tests inside each task plus live checks in 16, 19, 23; §9 → Tasks 20, 25, 26; §12 → prerequisites referenced in Tasks 16, 18, 19.
- Type names used across tasks: `UnifiedVault`, `Source`, `SourceRef`, `Receipt`, `Attestation`, `Sealed`, `SealedRequest`, `NonceStore`, `RiskReport`, `DataProvider`, `HandlerDeps`, `PaidResult`, `Policy`, `Decision` are each defined once in the task that introduces them and imported by name afterwards.
- Known uncertainties an implementer must confirm at the marked steps: the Hedera payment payload field name (Task 16), the sink cursor table shape (Tasks 10/13), Messari snapshot field names (Task 9), the `substreams` store trait imports (Task 12), the Circle Gateway balance method name (Task 23).

---

## Added 2026-09-10: dashboard user and admin views (spec §13)

### Task 27: Service metrics endpoint and settlement tracking

**Files:**
- Create: `packages/service/src/metrics.ts`, `packages/service/src/admin.ts`, `packages/service/test/metrics.test.ts`, `packages/service/test/admin.test.ts`
- Modify: `packages/service/src/handlers/scan.ts` (count requests, verdicts, 4xx), `packages/service/src/rails/hedera.ts` and `src/rails/arc.ts` (record settlements through the existing `onSettled` hooks), `packages/service/src/hcs.ts` (expose counters), `packages/service/src/data/provider.ts` (record per-deployment outcomes and heads), `packages/service/src/app.ts` (mount admin router; construct `Metrics`), `packages/service/src/config.ts` (`ADMIN_TOKEN`), `.env.example`

**Interfaces:**
- Produces: `class Metrics { requests: { scan; table; rejected4xx; unavailableVerdicts; lastRequestAt }; settlements: { hedera: { count; revenueAtomic }; arc: { count; revenueUsd } }; recordRequest(tier, status, verdicts?); recordSettlement(rail, amount); recordDeployment(ref, outcome); recordHead(chainId, head, ok); snapshot(deps): Promise<AdminMetrics> }`; `mountAdmin(app, { config, metrics, hcs, keys, data, readPqHash })` registering `GET /v1/admin/metrics` with the bearer check; the JSON shape from spec §13.1 exactly.

- [ ] **Step 1: Failing tests**, `metrics.test.ts`: counters increment; `snapshot()` produces every field with string numerics and `uptimeSeconds` monotonic; `admin.test.ts`: `GET /v1/admin/metrics` without token → 401 `{ reason: "unauthorized" }`; with token → 200 and a body matching the shape (zod schema in the test); rail health probe uses an injected fetch and reports `healthy: false` on a failed probe without throwing.
- [ ] **Step 2: Implement**, `Metrics` as a plain class with a `startedAt`; handlers call `metrics.recordRequest`; rails call `metrics.recordSettlement` from their settlement hooks (Hedera: `onAfterSettle` with the requirement's atomic amount; Arc: `req.payment.amount`); `HcsQueue` gains `stats()` `{ pending, submitted, failed, lastSequence }`; `LiveDataProvider` records each deployment's last outcome and each chain head; `mountAdmin` assembles the snapshot with 30 s cached health probes and a 10 min cached identity check via `readPqHash`.
- [ ] **Step 3: Run tests and typecheck; commit**, `git commit -m "feat(service): admin metrics endpoint with settlement, HCS, freshness and identity status"`

### Task 28: Dashboard user view (portfolio) and admin view

**Files:**
- Create: `packages/dashboard/app/portfolio/page.tsx`, `packages/dashboard/app/portfolio/ScanForm.tsx` (client component), `packages/dashboard/app/api/scan/route.ts`, `packages/dashboard/app/admin/page.tsx`, `packages/dashboard/lib/scan.ts`, `packages/dashboard/lib/admin.ts`, `packages/dashboard/test/scan.test.ts`
- Modify: `packages/dashboard/app/layout.tsx` (nav links), `packages/dashboard/app/globals.css` (status colours, form styles), `packages/dashboard/README.md` (replace boilerplate), `.env.example` (`ADMIN_TOKEN`, dashboard `AGENT_*` note)

**Interfaces:**
- Consumes: `VaultRadarClient` from `@vaultradar/agent` (server-side only, inside the API route), `runWatch`-equivalent helpers (`chooseRail`, `chooseTier`, `applyAgeCheck`, `decide`, `saveRun`, `listRuns`), and `GET /v1/admin/metrics` per spec §13.1.
- Produces: `POST /api/scan` `{ vaults: string[] }` → `{ runId, requests, decisions, txId, receiptHash, priceUsd }` or `{ error }` with 400 (bad input), 429 (rate limit), 503 (agent keys missing). Rate limit: one paid scan per client IP per 30 s (in-memory). Never returns key material.

- [ ] **Step 1: Failing tests**, vault-list parsing and validation (`<chainId>:0x<40 hex>` per line, max 100, dedupe, lowercase); rate limiter; the `/api/scan` route against the in-process service harness (stub provider, raw handlers, `payingFetch: fetch`, injected `readPqHash`) returning decisions and writing a run file; 503 when keys are missing.
- [ ] **Step 2: Implement `/portfolio`**, textarea plus "Scan now" (disabled while running), results table with colour-coded verdicts, decisions with citations, transaction and receipt links, and a "history" section listing prior runs that include any of the entered vaults (from `listRuns` plus run contents). When `AGENT_HEDERA_KEY` is absent, show a notice and link to the demo run.
- [ ] **Step 3: Implement `/admin`**, server component fetching the metrics with the bearer token from `ADMIN_TOKEN`; sections per spec §13.1; auto-refresh every 15 s via a small client component; a clear "counters reset on restart" note; 401/unreachable states rendered inline.
- [ ] **Step 4: Stretch (only if promised items are green and reviewed)**, wallet address input discovering ERC-4626 positions via `balanceOf` multicall over a new free service endpoint `GET /v1/vaults?chainId=` (Task 27 adds it if trivial); otherwise leave the input as vault list only.
- [ ] **Step 5: Tests, typecheck, `next build`; commit**, `git commit -m "feat(dashboard): portfolio user view with server-side paid scans; admin metrics view"`

Ordering: Task 27 runs in the service worktree after Task 19 (Arc rail) so both rails' settlement hooks exist; Task 28's portfolio view and the admin page's static shell can start in the dashboard worktree immediately against the §13.1 contract, with the admin page wired to the live endpoint after Task 27 merges.

---

## Added 2026-09-10: hardening from external review (verified findings)

### Task 29: Hardening the paid paths and verification chain

**Files:**
- Modify: `packages/dashboard/lib/ratelimit.ts`, `packages/dashboard/lib/scan.ts`, `packages/dashboard/app/verify/page.tsx`, `packages/dashboard/lib/service.ts`, `packages/dashboard/lib/runs.ts`, `packages/service/src/handlers/scan.ts`, `packages/service/src/rails/arc.ts`, `packages/service/src/rails/hedera.ts`, `packages/service/src/hcs.ts`, `packages/core/src/pq/sign.ts`, `packages/core/src/pricing.ts`, `packages/core/src/standardized/gateway.ts`, `packages/core/src/standardized/index.ts`, `packages/agent/src/client.ts`, `packages/agent/src/rails/hedera.ts`, `scripts/verify-deployments.ts`, `scripts/demo.sh`, `substreams/erc4626-vault-metrics/substreams.yaml` and `substreams.base.yaml`, `.env.example`
- Create: `packages/agent/policy.strict.json`, `packages/dashboard/lib/spend.ts`

**Interfaces:**
- Produces: `SpendLedger` (dashboard, in-memory): `{ canSpend(microUsd): boolean; record(microUsd): void; snapshot(): { spentMicroUsd, capMicroUsd, windowStartedAt } }` with `DASHBOARD_SPEND_CAP_USD` (default `1.00`) per rolling 24 h and `DASHBOARD_MAX_SCANS_PER_HOUR` (default `20`) global; optional `SCAN_ACCESS_TOKEN` (when set, `POST /api/scan` requires `Authorization: Bearer <token>`); `TRUST_PROXY=1` enables `x-forwarded-for`, otherwise the client key is the socket address or `"unknown"`.
- Produces: service handler rule: in clear mode for the scan tier, `X-VR-Count` must equal `vaults.length` (422 `count_mismatch`, before any data work; Arc pre-middleware enforces it before payment for clear bodies).
- Produces: `checkSig` additionally requires `sig.pub_hash === sha256Hex(publicKey)`; agent x402 client registers a payment policy that rejects any requirement whose amount exceeds the local quote by more than 1 percent, and `PaidResult.priceUsd` comes from `receipt.price` with a mismatch against the quote failing `receiptValid`.
- Produces: `TABLE_PRICE_USD = "0.06"` (never cheaper than a scan of up to 100 vaults); Messari page size `first: 200`; `verify-deployments` sets `deploymentId` only when null and otherwise compares, marking `status: "repointed"` on mismatch and never overwriting; `/verify` page verifies the card signature and, when the card lists ERC-8004 ids, reads `pq.sig.pubhash` on-chain via a public RPC and shows the match state; dashboard saves a run record (with any tx id) before returning 502 on post-payment failure; `lib/service.ts` fetches time out at 10 s; `HcsQueue.done` capped at 10 000 entries (oldest evicted) and a receipt that fails 5 submits moves to the back of the queue; Pinax import pinned to a commit-hash URL; `policy.strict.json` = example policy with `privacy: "strict"`; `demo.sh` exits with a clear message when `VAULTS` is unset or still a fill marker.

- [ ] **Step 1: Tests first** for each rule above (dashboard spend ledger and access token; service clear-mode count on both rails; core `checkSig` pub-hash binding; agent payment policy rejecting an over-quote requirement and receipt price mismatch; pricing crossover property `hederaScanPriceUsd(100) < TABLE_PRICE_USD`; verify script compare/repoint with a fake gateway; HCS cap and rotation).
- [ ] **Step 2: Implement** in the order listed, smallest blast radius first; keep the §13.1 metrics shape unchanged.
- [ ] **Step 3: Run** `bun test`, `bun run typecheck`, `bun run --cwd packages/dashboard build`; commit in two or three commits by package.
