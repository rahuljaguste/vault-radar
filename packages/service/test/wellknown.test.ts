import { expect, test } from "bun:test";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { HcsQueue } from "../src/hcs";
import { buildReceipt, deriveKemKeys, deriveSigningKeys, checkSig, receiptHash, MemoryNonceStore } from "@vaultradar/core";
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
test("receipts route rejects a hash that is not 64 lowercase hex chars", async () => {
  for (const bad of ["deadbeef", "F".repeat(64), "z".repeat(64), "a".repeat(63)]) {
    const res = await fetch(base() + "/v1/receipts/" + bad);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "bad_hash" });
  }
});

test("receipts route falls back to a null-sequence stub when hcs is not wired up", async () => {
  const hash = "a".repeat(64);
  const body = await (await fetch(base() + "/v1/receipts/" + hash)).json();
  expect(body).toEqual({ receipt_hash: hash, topicId: config.hedera.hcsTopicId, sequence: null, consensus_timestamp: null, initial_transaction_id: null });
});

test("receipts route hits a wired HcsQueue for a committed receipt and misses for an unknown one", async () => {
  const submit = async () => ({ sequence: "7", consensusTimestamp: "1700000000.000000000", transactionId: "0.0.1@1700000000.000000000" });
  const noNetwork = async () => new Response(JSON.stringify({ messages: [], links: { next: null } }), { status: 200 });
  const hcs = new HcsQueue({ submit, topicId: "0.0.9", fetchImpl: noNetwork });
  const receipt = buildReceipt(
    {
      service: { erc8004: [] }, request_hash: "a".repeat(64), response_hash: "b".repeat(64),
      sealed: false, sources: [], price: { amount: "1", asset: "x", rail: "hedera" },
      payment: { rail: "hedera", txId: "t" }, tier: "scan", hcs: { topicId: "0.0.9" },
    },
    keys.sig,
  );
  const hash = receiptHash(receipt);
  hcs.enqueue(receipt);
  await new Promise(res => setTimeout(res, 20)); // let the queue's own drain loop settle

  const appWithHcs = await buildApp({ config, keys, data, hcs, nonces: new MemoryNonceStore(), rails: {} });
  const srv2 = appWithHcs.listen(0);
  try {
    const port = (srv2.address() as any).port;
    const hit = await (await fetch(`http://127.0.0.1:${port}/v1/receipts/${hash}`)).json();
    expect(hit).toEqual({ receipt_hash: hash, topicId: "0.0.9", sequence: "7", consensus_timestamp: "1700000000.000000000", initial_transaction_id: "0.0.1@1700000000.000000000" });

    const missHash = "f".repeat(64);
    const miss = await (await fetch(`http://127.0.0.1:${port}/v1/receipts/${missHash}`)).json();
    expect(miss).toEqual({ receipt_hash: missHash, topicId: "0.0.9", sequence: null, consensus_timestamp: null, initial_transaction_id: null });
  } finally {
    srv2.close();
  }
});
test("skill.md 404s until Task 25 publishes it", async () => {
  const res = await fetch(base() + "/skill.md");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "skill not yet published" });
});
test("CORS is scoped to the public routes only, not the whole app", async () => {
  const known = await fetch(base() + "/v1/catalog");
  expect(known.headers.get("access-control-allow-origin")).toBe("*");

  // No hedera rail is mounted (rails: {}), so this 404s today — but even once Task 16
  // mounts a real rail here, that route must never inherit this router's CORS headers.
  const unknown = await fetch(base() + "/hedera/v1/scan", { method: "POST" });
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get("access-control-allow-origin")).toBeNull();
});
test("GET /v1/catalog returns 500 with a generic body when the provider rejects, instead of hanging", async () => {
  const failingData = {
    catalog: async () => { throw new Error("boom"); },
    scan: async () => { throw new Error("n/a"); },
    table: async () => { throw new Error("n/a"); },
  };
  const failingApp = await buildApp({ config, keys, data: failingData, hcs: null, nonces: new MemoryNonceStore(), rails: {} });
  const failingSrv = failingApp.listen(0);
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const failingBase = `http://127.0.0.1:${(failingSrv.address() as any).port}`;
    const res = await fetch(failingBase + "/v1/catalog");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  } finally {
    console.error = originalError;
    failingSrv.close();
  }
  expect(errors.length).toBe(1);
  expect(String(errors[0])).toContain("boom");
});
