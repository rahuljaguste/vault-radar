import { expect, test } from "bun:test";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { deriveKemKeys, deriveSigningKeys, checkSig, MemoryNonceStore } from "@vaultradar/core";
const env = { PORT: "0", PUBLIC_URL: "http://svc.test", PQ_SIG_SEED: "77".repeat(32), PQ_KEM_SEED: "88".repeat(64), GRAPH_STUDIO_API_KEY: "k",
  HEDERA_PAYTO_ACCOUNT_ID: "0.0.1", HEDERA_OPERATOR_ID: "0.0.1", HEDERA_OPERATOR_KEY: "00", ARC_SELLER_ADDRESS: "0x" + "1".repeat(40), ERC8004_HEDERA_AGENT_ID: "7" };
const config = loadConfig(env); const keys = { sig: deriveSigningKeys(env.PQ_SIG_SEED), kem: deriveKemKeys(env.PQ_KEM_SEED) };
const data = { catalog: async () => ({ protocols: [{ protocol: "aave-v3", chain: "ethereum", status: "live", vaultCount: 3 }], erc4626Chains: ["1"] }), scan: async () => { throw new Error("n/a"); }, table: async () => { throw new Error("n/a"); } };
const app = await buildApp({ config, keys, data, hcs: null, nonces: new MemoryNonceStore(), rails: {} });
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
test("health reports kid and pubHash", async () => {
  const res = await fetch(base() + "/health");
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(await res.json()).toEqual({ ok: true, kid: keys.kem.kid, pubHash: keys.sig.pubHash });
});
test("receipts route falls back to a null-sequence stub when hcs is not wired up", async () => {
  const body = await (await fetch(base() + "/v1/receipts/deadbeef")).json();
  expect(body).toEqual({ receipt_hash: "deadbeef", topicId: config.hedera.hcsTopicId, sequence: null });
});
test("skill.md 404s until Task 25 publishes it", async () => {
  const res = await fetch(base() + "/skill.md");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "skill not yet published" });
});
